<?php
// Spiel-API: ersetzt den Node/Socket.IO-Server. Der Browser fragt regelmäßig den Spielstand ab (Polling).
declare(strict_types=1);

require __DIR__ . '/engine.php';

const TURN_DURATION_MS = 30000;
const REVEAL_DURATION_MS = 6000;
const MAX_PLAYERS = 4;
const CARD_COUNT_OPTIONS = [8, 16, 32];
const ONLINE_TIMEOUT_MS = 15000;   // danach gilt ein Spieler als offline
const LOBBY_TIMEOUT_MS = 20000;    // in der Lobby fliegen inaktive Spieler raus
const IDLE_RESET_MS = 300000;      // laufende Partie ohne jeden Spieler wird nach 5 Minuten zurückgesetzt
const LAST_SEEN_REFRESH_MS = 3000;
const PAUSE_END_MS = 60000;        // weniger als 2 Spieler online: nach 1 Minute endet die Partie
const DEV_SESSION_ID = '123456';   // feste Session für die Entwicklung (nur lokal, siehe dev_session_enabled)
const BOT_THINK_MS = 1500;         // so lange „überlegt“ der Test-Bot, bevor er eine Kategorie wählt

function cleanName($value): string
{
    $value = is_scalar($value) ? (string) $value : '';
    $mb = function_exists('mb_substr');
    $value = $mb ? mb_substr($value, 0, 100, 'UTF-8') : substr($value, 0, 100);
    $value = trim((string) preg_replace('/\s+/u', ' ', $value));
    return $mb ? mb_substr($value, 0, 20, 'UTF-8') : substr($value, 0, 20);
}

/**
 * Entwicklungsmodus: Die feste Session DEV_SESSION_ID mit einem Test-Bot gibt es nur lokal (localhost / 127.0.0.1)
 * oder wenn TRUMPF_DEV_SESSION=1 gesetzt ist. TRUMPF_DEV_SESSION=0 schaltet sie überall aus. Auf dem echten Server
 * (andere Domain) ist sie aus.
 */
function dev_session_enabled(): bool
{
    $flag = getenv('TRUMPF_DEV_SESSION');
    if ($flag !== false && $flag !== '') {
        return $flag === '1';
    }
    $host = strtolower((string) preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
    return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true);
}

/** Frischer Raum für die Dev-Session: schon ein Bot als Mitspieler, damit man alleine starten kann. */
function dev_room_data(): array
{
    $room = TrumpfRoom::fresh();
    $room['players'][] = [
        'id' => bin2hex(random_bytes(16)),
        'token' => bin2hex(random_bytes(24)),
        'name' => 'Test-Bot',
        'connected' => true,
        'lastSeen' => (int) floor(microtime(true) * 1000),
        'hand' => [],
        'bot' => true,
    ];
    return $room;
}

/** Der Bot wählt die Kategorie, in der seine Karte im Vergleich zu allen Karten am stärksten ist. */
function bot_category(string $cardId): string
{
    $deck = trumpf_load_deck();
    $card = $deck[$cardId] ?? null;
    if ($card === null) {
        return (string) array_key_first(TRUMPF_CATEGORIES);
    }
    $best = (string) array_key_first(TRUMPF_CATEGORIES);
    $bestScore = -1;
    foreach (TRUMPF_CATEGORIES as $key => $rule) {
        $worse = 0;
        foreach ($deck as $other) {
            $worse += ($rule['direction'] === 'low' ? $other[$key] > $card[$key] : $other[$key] < $card[$key]) ? 1 : 0;
        }
        if ($worse > $bestScore) {
            $bestScore = $worse;
            $best = $key;
        }
    }
    return $best;
}

function respond(array $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

class TrumpfRoom
{
    /** @var array */
    public $data;
    /** @var bool */
    public $dirty = false;
    /** @var int */
    public $now;

    public function __construct(array $data, int $now)
    {
        $this->data = $data;
        $this->now = $now;
    }

    public static function fresh(): array
    {
        return [
            'version' => 1,
            'status' => 'lobby',
            'players' => [],
            'hostId' => null,
            'cardsPerPlayer' => 32,
            'game' => null,
            'idleSince' => null,
        ];
    }

    /** Aenderung, die alle Clients sehen müssen. */
    public function touch(): void
    {
        $this->data['version']++;
        $this->dirty = true;
    }

    public function playerIndexByToken(string $token): ?int
    {
        if ($token === '') {
            return null;
        }
        foreach ($this->data['players'] as $index => $player) {
            if (hash_equals($player['token'], $token)) {
                return $index;
            }
        }
        return null;
    }

    public function markSeen(int $index): void
    {
        $player = &$this->data['players'][$index];
        if (!$player['connected']) {
            $player['connected'] = true;
            $player['lastSeen'] = $this->now;
            $this->touch();
        } elseif ($this->now - $player['lastSeen'] >= LAST_SEEN_REFRESH_MS) {
            $player['lastSeen'] = $this->now;
            $this->dirty = true;
        }
    }

    public function transferHost(): void
    {
        $players = $this->data['players'];
        $hostIndex = trumpf_player_index($players, $this->data['hostId']);
        $host = $hostIndex !== null ? $players[$hostIndex] : null;
        if ($host !== null && $host['connected'] && empty($host['bot'])) {
            return;
        }
        // Ein Bot soll nie Host sein, solange ein Mensch da ist (sonst könnte niemand starten).
        $newHost = null;
        foreach ($players as $player) {
            if ($player['connected'] && empty($player['bot'])) {
                $newHost = $player['id'];
                break;
            }
        }
        if ($newHost === null) {
            if ($host !== null && $host['connected']) {
                return;
            }
            foreach ($players as $player) {
                if ($player['connected']) {
                    $newHost = $player['id'];
                    break;
                }
            }
            if ($newHost === null && $players) {
                $newHost = $players[0]['id'];
            }
        }
        if ($newHost !== $this->data['hostId']) {
            $this->data['hostId'] = $newHost;
            $this->touch();
        }
    }

    /** Anwesenheit, Lobby-Aufräumen und abgelaufene Zeiten – läuft bei jeder Anfrage. */
    public function tick(): void
    {
        foreach ($this->data['players'] as $index => $player) {
            if (!empty($player['bot'])) {
                $this->data['players'][$index]['lastSeen'] = $this->now; // Bots sind immer online
            }
        }
        foreach ($this->data['players'] as $index => $player) {
            $online = ($this->now - $player['lastSeen']) <= ONLINE_TIMEOUT_MS;
            if ($player['connected'] !== $online) {
                $this->data['players'][$index]['connected'] = $online;
                $this->touch();
            }
        }

        if ($this->data['status'] === 'lobby') {
            $kept = [];
            foreach ($this->data['players'] as $player) {
                if (($this->now - $player['lastSeen']) <= LOBBY_TIMEOUT_MS) {
                    $kept[] = $player;
                }
            }
            if (count($kept) !== count($this->data['players'])) {
                $this->data['players'] = $kept;
                $this->touch();
            }
        }
        $this->transferHost();
        $this->checkIdle();
        $paused = $this->updatePresence();

        for ($step = 0; !$paused && $step < 6 && $this->data['game'] !== null; $step++) {
            $game = $this->data['game'];
            if ($game['phase'] === 'choosing' && $game['turnEndsAt'] !== null) {
                $botIndex = trumpf_player_index($this->data['players'], $game['activePlayerId']);
                $botCard = $botIndex === null ? null : ($this->data['players'][$botIndex]['hand'][0] ?? null);
                if (
                    $botCard !== null
                    && !empty($this->data['players'][$botIndex]['bot'])
                    && $this->now >= $game['turnEndsAt'] - TURN_DURATION_MS + BOT_THINK_MS
                ) {
                    try {
                        $this->revealCards($game['activePlayerId'], bot_category((string) $botCard));
                    } catch (TrumpfError $error) {
                        break;
                    }
                    continue;
                }
            }
            if ($game['phase'] === 'choosing' && $game['turnEndsAt'] !== null && $this->now >= $game['turnEndsAt']) {
                $chooserIndex = trumpf_player_index($this->data['players'], $game['activePlayerId']);
                $cardId = $chooserIndex === null ? null : ($this->data['players'][$chooserIndex]['hand'][0] ?? null);
                if ($cardId === null) {
                    break;
                }
                try {
                    $this->revealCards($game['activePlayerId'], trumpf_automatic_category($cardId));
                } catch (TrumpfError $error) {
                    break;
                }
                continue;
            }
            if ($game['phase'] === 'revealed' && $game['revealEndsAt'] !== null && $this->now >= $game['revealEndsAt']) {
                if (trumpf_next_round($this->data['game'], $this->data['players'])) {
                    $this->armTurn();
                    $this->touch();
                    continue;
                }
                break;
            }
            break;
        }
    }

    /**
     * Offline-Spieler setzen aus. Bleiben weniger als 2 Spieler online, pausiert die Partie und
     * endet nach PAUSE_END_MS, falls niemand zurückkommt. Gibt true zurück, solange pausiert wird.
     */
    private function updatePresence(): bool
    {
        if ($this->data['status'] !== 'playing' || $this->data['game'] === null) {
            return false;
        }
        foreach ($this->data['players'] as $index => $player) {
            $away = !$player['connected'];
            if (($player['away'] ?? false) !== $away) {
                $this->data['players'][$index]['away'] = $away;
                $this->touch();
            }
        }

        $game = $this->data['game'];
        if (count(trumpf_playable($this->data['players'])) >= 2) {
            if ($game['pausedUntil'] !== null) {
                // Mitspieler sind zurück: weiter geht es mit frischer Zeit.
                $this->data['game']['pausedUntil'] = null;
                if ($game['phase'] === 'revealed') {
                    $this->data['game']['revealEndsAt'] = $this->now + REVEAL_DURATION_MS;
                }
                $this->armTurn();
                $this->touch();
            } elseif ($game['phase'] === 'choosing') {
                $this->passTurnIfAway();
            }
            return false;
        }

        if ($game['phase'] === 'finished') {
            return false;
        }
        if ($game['pausedUntil'] === null) {
            $this->data['game']['pausedUntil'] = $this->now + PAUSE_END_MS;
            $this->data['game']['turnEndsAt'] = null;
            $this->data['game']['revealEndsAt'] = null;
            $this->touch();
            return true;
        }
        if ($this->now >= $game['pausedUntil']) {
            $this->endAbandoned();
            return false;
        }
        return true;
    }

    /** Ist der aktive Spieler offline, rückt der nächste Online-Spieler sofort nach. */
    private function passTurnIfAway(): void
    {
        $players = $this->data['players'];
        $current = trumpf_player_index($players, $this->data['game']['activePlayerId']);
        if ($current !== null && trumpf_can_play($players[$current])) {
            return;
        }
        $count = count($players);
        for ($step = 1; $step <= $count; $step++) {
            $candidate = (($current ?? -1) + $step) % $count;
            if (trumpf_can_play($players[$candidate])) {
                $this->data['game']['activePlayerId'] = $players[$candidate]['id'];
                $this->armTurn();
                $this->touch();
                return;
            }
        }
    }

    /** Niemand ist zurückgekommen: die Partie endet, vorn liegt der, der noch da ist (sonst wer die meisten Karten hat). */
    private function endAbandoned(): void
    {
        $winner = null;
        $online = trumpf_playable($this->data['players']);
        if (count($online) === 1) {
            $winner = $this->data['players'][$online[0]]['id'];
        } else {
            $most = -1;
            foreach ($this->data['players'] as $player) {
                if (count($player['hand']) > $most) {
                    $most = count($player['hand']);
                    $winner = $player['id'];
                }
            }
        }
        trumpf_finish($this->data['game'], $winner);
        $this->data['game']['result']['reason'] = 'abandoned';
        $this->data['game']['pausedUntil'] = null;
        $this->data['status'] = 'finished';
        $this->touch();
    }

    private function checkIdle(): void
    {
        if ($this->data['status'] === 'lobby') {
            return;
        }
        $anyone = false;
        foreach ($this->data['players'] as $player) {
            $anyone = $anyone || $player['connected'];
        }
        if ($anyone) {
            if ($this->data['idleSince'] !== null) {
                $this->data['idleSince'] = null;
                $this->dirty = true;
            }
        } elseif ($this->data['idleSince'] === null) {
            $this->data['idleSince'] = $this->now;
            $this->dirty = true;
        } elseif ($this->now - $this->data['idleSince'] > IDLE_RESET_MS) {
            $version = $this->data['version'];
            $this->data = self::fresh();
            $this->data['version'] = $version;
            $this->touch();
        }
    }

    public function armTurn(): void
    {
        if ($this->data['game'] !== null && $this->data['game']['phase'] === 'choosing') {
            $this->data['game']['turnEndsAt'] = $this->now + TURN_DURATION_MS;
        }
    }

    public function revealCards(string $playerId, string $category): void
    {
        trumpf_choose_category($this->data['game'], $this->data['players'], $playerId, $category);
        if ($this->data['game']['phase'] === 'finished') {
            $this->data['status'] = 'finished';
        } else {
            $this->data['game']['revealEndsAt'] = $this->now + REVEAL_DURATION_MS;
        }
        $this->touch();
    }

    public function beginGame(): void
    {
        foreach ($this->data['players'] as $index => $player) {
            $this->data['players'][$index]['away'] = false;
        }
        $this->data['game'] = trumpf_start_game($this->data['players'], (int) $this->data['cardsPerPlayer']);
        $this->data['status'] = 'playing';
        $this->armTurn();
        $this->touch();
    }

    private function expand(string $cardId): array
    {
        return trumpf_load_deck()[$cardId];
    }

    /** Zustand aus Sicht eines Spielers: fremde Hände bleiben geheim. */
    public function publicStateFor(int $index): array
    {
        $data = $this->data;
        $self = $data['players'][$index];
        $game = $data['game'];

        $players = [];
        foreach ($data['players'] as $entry) {
            $count = count($entry['hand']);
            $players[] = [
                'id' => $entry['id'],
                'name' => $entry['name'],
                'isHost' => $entry['id'] === $data['hostId'],
                'connected' => $entry['connected'],
                'cardCount' => $count,
                'eliminated' => $data['status'] !== 'lobby' && $count === 0,
            ];
        }

        $gameState = null;
        if ($game !== null) {
            $tableCards = [];
            if ($game['phase'] !== 'choosing') {
                foreach ($game['tableCards'] as $entry) {
                    $tableCards[] = ['playerId' => $entry['playerId'], 'card' => $this->expand($entry['cardId'])];
                }
            }
            $hand = array_map(function ($cardId) {
                return $this->expand($cardId);
            }, $self['hand']);
            $gameState = [
                'phase' => $game['phase'],
                'round' => $game['round'],
                'cardsPerPlayer' => $game['cardsPerPlayer'],
                'activePlayerId' => $game['activePlayerId'],
                'category' => $game['category'],
                'tableCards' => $tableCards,
                'result' => $game['result'],
                'potCount' => count($game['pot']),
                'winnerId' => $game['winnerId'],
                'turnEndsAt' => $game['turnEndsAt'],
                'revealEndsAt' => $game['revealEndsAt'],
                'pausedUntil' => $game['pausedUntil'] ?? null,
                'ownCard' => $hand[0] ?? null,
                'ownHand' => $hand,
            ];
        }

        return [
            'selfId' => $self['id'],
            'status' => $data['status'],
            'hostId' => $data['hostId'],
            'maxPlayers' => MAX_PLAYERS,
            'cardsPerPlayer' => (int) $data['cardsPerPlayer'],
            'cardCountOptions' => CARD_COUNT_OPTIONS,
            'categories' => TRUMPF_CATEGORIES,
            'players' => $players,
            'game' => $gameState,
        ];
    }
}

// ---------------------------------------------------------------------------------------------

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(['ok' => false, 'message' => 'Nur POST erlaubt.'], 405);
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$raw = file_get_contents('php://input', false, null, 0, 20001);
if ($raw === false || strlen($raw) > 20000) {
    respond(['ok' => false, 'message' => 'Anfrage zu groß.'], 413);
}
$input = json_decode($raw, true);
if (!is_array($input)) {
    respond(['ok' => false, 'message' => 'Ungültige Anfrage.'], 400);
}
$action = is_string($input['action'] ?? null) ? $input['action'] : '';
if ($action === 'ping') {
    respond(['ok' => true]);
}
if ($action === 'cards') {
    // Alle Fahrzeugkarten für die Sammlung (öffentlich, ohne Spielstand).
    respond(['ok' => true, 'categories' => TRUMPF_CATEGORIES, 'cards' => array_values(trumpf_load_deck())]);
}
$token = is_string($input['token'] ?? null) ? $input['token'] : '';

$dataDir = getenv('TRUMPF_DATA_DIR') ?: __DIR__ . '/data';
if (!is_dir($dataDir) && !@mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
    respond(['ok' => false, 'message' => 'Datenordner kann nicht angelegt werden.'], 500);
}
$guard = $dataDir . '/.htaccess';
if (!is_file($guard)) {
    @file_put_contents(
        $guard,
        "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n"
    );
}

$roomCode = strtoupper(is_string($input['room'] ?? null) ? trim($input['room']) : '');
$roomCode = preg_match('/^[A-Z0-9]{4,8}$/', $roomCode) ? $roomCode : '';
$creating = $action === 'join' && !empty($input['create']);

if ($creating) {
    // Neue Session: eindeutigen Code vergeben, alte Sessions (> 24 h) aufräumen.
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $gc = fopen($dataDir . '/create.lock', 'c');
    if ($gc === false || !flock($gc, LOCK_EX)) {
        respond(['ok' => false, 'message' => 'Spielstand ist gerade gesperrt.'], 503);
    }
    foreach (glob($dataDir . '/room_*.json') ?: [] as $old) {
        if (@filemtime($old) < time() - 86400) {
            @unlink($old);
            @unlink(substr($old, 0, -5) . '.lock');
        }
    }
    do {
        $roomCode = '';
        for ($i = 0; $i < 5; $i++) {
            $roomCode .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
    } while (is_file($dataDir . '/room_' . $roomCode . '.json'));
    file_put_contents($dataDir . '/room_' . $roomCode . '.json', json_encode(TrumpfRoom::fresh()));
    flock($gc, LOCK_UN);
    fclose($gc);
}

$devRoom = $roomCode === DEV_SESSION_ID && dev_session_enabled();
if ($devRoom && !is_file($dataDir . '/room_' . $roomCode . '.json')) {
    file_put_contents($dataDir . '/room_' . $roomCode . '.json', json_encode(dev_room_data()));
}

if ($roomCode === '' || !is_file($dataDir . '/room_' . $roomCode . '.json')) {
    if ($action === 'join') {
        respond(['ok' => false, 'message' => 'Diese Session-ID gibt es nicht.']);
    }
    respond(['ok' => false, 'code' => 'not_joined', 'message' => 'Du bist nicht mehr in der Lobby.', 'version' => 0]);
}

$lock = fopen($dataDir . '/room_' . $roomCode . '.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX)) {
    respond(['ok' => false, 'message' => 'Spielstand ist gerade gesperrt.'], 503);
}
$roomFile = $dataDir . '/room_' . $roomCode . '.json';
$stored = is_file($roomFile) ? json_decode((string) file_get_contents($roomFile), true) : null;
$room = new TrumpfRoom(is_array($stored) ? $stored : TrumpfRoom::fresh(), (int) floor(microtime(true) * 1000));

$selfIndex = $room->playerIndexByToken($token);
if ($selfIndex !== null) {
    $room->markSeen($selfIndex);
}
$room->tick();
// tick() kann Spieler entfernen, daher Index neu bestimmen.
$selfIndex = $room->playerIndexByToken($token);

$reply = ['ok' => true];
$fail = static function (string $message) {
    return ['ok' => false, 'message' => $message];
};
$isHost = static function () use ($room, &$selfIndex): bool {
    return $selfIndex !== null && $room->data['players'][$selfIndex]['id'] === $room->data['hostId'];
};

try {
    switch ($action) {
        case 'join':
            $name = cleanName($input['name'] ?? '');
            if ($selfIndex !== null) {
                if ($name !== '' && $room->data['status'] === 'lobby') {
                    $room->data['players'][$selfIndex]['name'] = $name;
                }
                $room->transferHost();
                $room->touch();
                $reply += ['token' => $room->data['players'][$selfIndex]['token'], 'reconnected' => true];
                break;
            }
            if ($room->data['status'] !== 'lobby' && $selfIndex === null) {
                // Spielt niemand mehr mit (alle offline), ist der alte Stand verwaist: neue Lobby statt Sperre.
                $anyoneOnline = false;
                foreach ($room->data['players'] as $entry) {
                    $anyoneOnline = $anyoneOnline || ($entry['connected'] && empty($entry['bot']));
                }
                if (!$anyoneOnline) {
                    $version = $room->data['version'];
                    $room->data = $devRoom ? dev_room_data() : TrumpfRoom::fresh();
                    $room->data['version'] = $version;
                    $room->touch();
                }
            }
            if ($room->data['status'] !== 'lobby') {
                $reply = $fail('Das Spiel läuft bereits. Warte auf die nächste Partie.');
            } elseif ($name === '') {
                $reply = $fail('Bitte gib einen Spielernamen ein.');
            } elseif (count($room->data['players']) >= MAX_PLAYERS) {
                $reply = $fail('Die Lobby ist bereits voll.');
            } else {
                $taken = false;
                foreach ($room->data['players'] as $entry) {
                    $taken = $taken || trumpf_lower($entry['name']) === trumpf_lower($name);
                }
                if ($taken) {
                    $reply = $fail('Dieser Name ist bereits vergeben.');
                    break;
                }
                $newToken = bin2hex(random_bytes(24));
                $room->data['players'][] = [
                    'id' => bin2hex(random_bytes(16)),
                    'token' => $newToken,
                    'name' => $name,
                    'connected' => true,
                    'lastSeen' => $room->now,
                    'hand' => [],
                ];
                $selfIndex = count($room->data['players']) - 1;
                if ($room->data['hostId'] === null) {
                    $room->data['hostId'] = $room->data['players'][$selfIndex]['id'];
                }
                $room->transferHost(); // ein Bot als Host wird sofort durch den Menschen ersetzt
                $room->touch();
                $reply += ['token' => $newToken, 'reconnected' => false];
            }
            break;

        case 'leave':
            if ($selfIndex !== null && $room->data['status'] === 'lobby') {
                array_splice($room->data['players'], $selfIndex, 1);
                $selfIndex = null;
                $room->transferHost();
                $room->touch();
            }
            break;

        case 'start':
            if (!$isHost()) {
                $reply = $fail('Nur der Host kann das Spiel starten.');
            } elseif ($room->data['status'] !== 'lobby') {
                $reply = $fail('Das Spiel wurde bereits gestartet.');
            } elseif (count($room->data['players']) < 2) {
                $reply = $fail('Zum Starten werden mindestens zwei Spieler benötigt.');
            } else {
                $room->beginGame();
            }
            break;

        case 'choose':
            if ($selfIndex === null || $room->data['status'] !== 'playing') {
                $reply = $fail('Du bist aktuell in keinem laufenden Spiel.');
            } else {
                $category = is_string($input['category'] ?? null) ? $input['category'] : '';
                $room->revealCards($room->data['players'][$selfIndex]['id'], $category);
            }
            break;

        case 'setCards':
            $count = $input['count'] ?? null;
            if (!$isHost()) {
                $reply = $fail('Nur der Host kann die Kartenzahl festlegen.');
            } elseif ($room->data['status'] !== 'lobby') {
                $reply = $fail('Die Kartenzahl kann nur in der Lobby geändert werden.');
            } elseif (!is_numeric($count) || !in_array((int) $count, CARD_COUNT_OPTIONS, true)) {
                $reply = $fail('Wähle 8, 16 oder 32 Karten pro Spieler.');
            } else {
                $room->data['cardsPerPlayer'] = (int) $count;
                $room->touch();
            }
            break;

        case 'again':
            $connected = array_values(array_filter($room->data['players'], static function ($entry) {
                return $entry['connected'];
            }));
            if (!$isHost()) {
                $reply = $fail('Nur der Host kann die nächste Partie starten.');
            } elseif ($room->data['status'] !== 'finished') {
                $reply = $fail('Die aktuelle Partie ist noch nicht beendet.');
            } elseif (count($connected) < 2) {
                $reply = $fail('Für eine neue Partie müssen mindestens zwei Spieler verbunden sein.');
            } else {
                $room->data['players'] = $connected;
                $selfIndex = $room->playerIndexByToken($token);
                $room->beginGame();
            }
            break;

        case 'state':
            if ($selfIndex === null) {
                $reply = ['ok' => false, 'code' => 'not_joined', 'message' => 'Du bist nicht mehr in der Lobby.'];
            } elseif (isset($input['since']) && $input['since'] === $room->data['version']) {
                $reply += ['unchanged' => true];
            }
            break;

        default:
            $reply = $fail('Unbekannte Aktion.');
    }
} catch (TrumpfError $error) {
    $reply = $fail($error->getMessage());
}

if ($room->dirty) {
    $tmp = $roomFile . '.tmp';
    file_put_contents($tmp, json_encode($room->data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    rename($tmp, $roomFile);
}

$reply['version'] = $room->data['version'];
$reply['room'] = $roomCode;
if (empty($reply['unchanged']) && ($reply['code'] ?? '') !== 'not_joined') {
    $reply['state'] = $selfIndex === null ? null : $room->publicStateFor($selfIndex) + ['sessionId' => $roomCode];
}
respond($reply);
