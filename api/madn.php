<?php
// Online-API für „Mensch ärgere dich nicht“. Wie bei Trumpf fragt der Browser regelmäßig den Stand ab.
// Der Server würfelt, prüft jeden Zug und spielt KI-Plätze sowie Spieler, die zu lange brauchen.
declare(strict_types=1);

require __DIR__ . '/madn-engine.php';

const MADN_SEAT_ORDER = [0, 2, 1, 3];   // zwei Spieler sitzen sich gegenüber
const MADN_AI_STEP_MS = 1900;           // so lange zwischen zwei KI-Aktionen (Würfeln, Ziehen); der 3D-Würfel rollt so lange
const MADN_TURN_MS = 30000;             // so lange hat ein Mensch für einen Wurf oder Zug
const MADN_OFFLINE_TURN_MS = 4000;      // wer offline ist, wird nach kurzer Zeit automatisch gespielt
const MADN_ONLINE_MS = 12000;           // ohne Abfrage gilt ein Spieler danach als offline
const MADN_LOBBY_TIMEOUT_MS = 30000;    // in der Lobby fliegt man danach raus
const MADN_MAX_CATCHUP = 400;           // so viele Schritte holt der Server höchstens auf einmal nach
const MADN_ROOM_TTL_S = 86400;

function madn_respond(array $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function madn_clean_name($value): string
{
    $value = is_scalar($value) ? (string) $value : '';
    $value = trim((string) preg_replace('/\s+/u', ' ', $value));
    return function_exists('mb_substr') ? mb_substr($value, 0, 16, 'UTF-8') : substr($value, 0, 16);
}

class MadnRoom
{
    /** @var array */
    public $data;
    /** @var int */
    public $now;
    /** @var bool */
    public $dirty = false;

    public function __construct(array $data, int $now)
    {
        $this->data = $data;
        $this->now = $now;
    }

    public static function fresh(int $now): array
    {
        return ['version' => 1, 'status' => 'lobby', 'hostId' => null, 'seats' => [null, null, null, null], 'game' => null, 'deadline' => null, 'createdAt' => $now];
    }

    public function touch(): void
    {
        $this->data['version']++;
        $this->dirty = true;
    }

    public function seatByToken(string $token): ?int
    {
        if ($token === '') {
            return null;
        }
        foreach ($this->data['seats'] as $index => $seat) {
            if ($seat && ($seat['token'] ?? '') !== '' && hash_equals($seat['token'], $token)) {
                return $index;
            }
        }
        return null;
    }

    public function markSeen(int $seat): void
    {
        $entry = &$this->data['seats'][$seat];
        $wasOffline = $this->now - ($entry['lastSeen'] ?? 0) > MADN_ONLINE_MS;
        if ($this->now - ($entry['lastSeen'] ?? 0) > 2000) {
            $entry['lastSeen'] = $this->now;
            $this->dirty = true; // nur speichern, die Version ändert sich dadurch nicht
        }
        if ($wasOffline) {
            $this->touch();
            $this->scheduleTurn(); // wieder da: volle Zugzeit
        }
    }

    public function online(?array $seat): bool
    {
        return $seat !== null && ($seat['type'] === 'ai' || $this->now - ($seat['lastSeen'] ?? 0) <= MADN_ONLINE_MS);
    }

    public function humans(): array
    {
        return array_keys(array_filter($this->data['seats'], static fn($s) => $s && $s['type'] === 'human'));
    }

    public function freeSeat(): ?int
    {
        foreach (MADN_SEAT_ORDER as $index) {
            if ($this->data['seats'][$index] === null) {
                return $index;
            }
        }
        return null;
    }

    public function addHuman(int $seat, string $name): array
    {
        $entry = ['id' => bin2hex(random_bytes(8)), 'token' => bin2hex(random_bytes(24)), 'name' => $name, 'type' => 'human', 'lastSeen' => $this->now];
        $this->data['seats'][$seat] = $entry;
        if ($this->data['hostId'] === null) {
            $this->data['hostId'] = $entry['id'];
        }
        $this->touch();
        return $entry;
    }

    public function isHost(?int $seat): bool
    {
        return $seat !== null && $this->data['seats'][$seat]['id'] === $this->data['hostId'];
    }

    private function passHost(): void
    {
        $humans = $this->humans();
        $hostStillHere = false;
        foreach ($humans as $index) {
            $hostStillHere = $hostStillHere || $this->data['seats'][$index]['id'] === $this->data['hostId'];
        }
        if (!$hostStillHere) {
            $this->data['hostId'] = $humans ? $this->data['seats'][$humans[0]]['id'] : null;
        }
    }

    /** Spieler verlässt den Raum. In der Lobby wird der Platz frei, in der Partie übernimmt die KI. */
    public function leave(int $seat): void
    {
        if ($this->data['status'] === 'lobby') {
            $this->data['seats'][$seat] = null;
        } else {
            $this->data['seats'][$seat]['type'] = 'ai';
            $this->data['seats'][$seat]['token'] = '';
            $this->data['seats'][$seat]['name'] .= ' (KI)';
            foreach ($this->data['game']['players'] as &$player) {
                if ($player['seat'] === $seat) {
                    $player['type'] = 'ai';
                    $player['name'] = $this->data['seats'][$seat]['name'];
                }
            }
            unset($player);
            $this->scheduleTurn();
        }
        $this->passHost();
        $this->touch();
    }

    public function empty(): bool
    {
        return !$this->humans();
    }

    public function start(): void
    {
        $seats = array_map(static fn($s) => $s ? ['name' => $s['name'], 'type' => $s['type']] : null, $this->data['seats']);
        $this->data['game'] = madn_create_game($seats);
        $this->data['status'] = 'playing';
        $this->scheduleTurn();
        $this->touch();
    }

    /** Zeitpunkt, zu dem der Server für den aktuellen Spieler handelt. */
    public function scheduleTurn(?int $base = null): void
    {
        $game = $this->data['game'];
        if (!$game || $game['phase'] === 'over') {
            $this->data['deadline'] = null;
            return;
        }
        $seat = $this->data['seats'][madn_current_seat($game)];
        if ($seat['type'] === 'ai') {
            $this->data['deadline'] = ($base ?? $this->now) + MADN_AI_STEP_MS;
        } else {
            $this->data['deadline'] = $this->now + ($this->online($seat) ? MADN_TURN_MS : MADN_OFFLINE_TURN_MS);
        }
    }

    public function apply(array $next): void
    {
        $this->data['game'] = $next;
        $this->scheduleTurn();
        $this->touch();
    }

    /** Ein automatischer Schritt (KI oder abgelaufene Zeit): würfeln oder ziehen. */
    private function autoStep(): void
    {
        $game = $this->data['game'];
        if ($game['phase'] === 'roll') {
            $next = madn_roll($game, random_int(1, 6));
        } else {
            $choice = madn_choose_move($game);
            $next = $choice ? madn_move($game, $choice['index']) : $game;
        }
        $base = $this->data['deadline'];
        $this->data['game'] = $next;
        $this->scheduleTurn($base);
        $this->touch();
    }

    public function tick(): void
    {
        if ($this->data['status'] === 'lobby') {
            foreach ($this->data['seats'] as $index => $seat) {
                if ($seat && $seat['type'] === 'human' && $this->now - ($seat['lastSeen'] ?? 0) > MADN_LOBBY_TIMEOUT_MS) {
                    $this->data['seats'][$index] = null;
                    $this->passHost();
                    $this->touch();
                }
            }
            return;
        }
        for ($i = 0; $i < MADN_MAX_CATCHUP; $i++) {
            $game = $this->data['game'];
            if (!$game || $game['phase'] === 'over' || $this->data['deadline'] === null || $this->now < $this->data['deadline']) {
                break;
            }
            $this->autoStep();
        }
        if ($this->data['deadline'] !== null && $this->data['deadline'] < $this->now) {
            $this->scheduleTurn(); // zu viel nachzuholen: ab jetzt im normalen Takt weiter
        }
    }

    public function publicStateFor(int $self): array
    {
        $seats = [];
        foreach ($this->data['seats'] as $index => $seat) {
            $seats[] = $seat === null ? null : [
                'name' => $seat['name'],
                'type' => $seat['type'],
                'online' => $this->online($seat),
                'host' => $seat['id'] === $this->data['hostId']
            ];
        }
        return [
            'status' => $this->data['status'],
            'selfSeat' => $self,
            'isHost' => $this->isHost($self),
            'seats' => $seats,
            'game' => $this->data['game'],
            'deadline' => $this->data['deadline']
        ];
    }
}

// ---------------------------------------------------------------------------------------------

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    madn_respond(['ok' => false, 'message' => 'Nur POST erlaubt.'], 405);
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$raw = file_get_contents('php://input', false, null, 0, 4001);
$input = is_string($raw) && strlen($raw) <= 4000 ? json_decode($raw, true) : null;
if (!is_array($input)) {
    madn_respond(['ok' => false, 'message' => 'Ungültige Anfrage.'], 400);
}
$action = is_string($input['action'] ?? null) ? $input['action'] : '';
$token = is_string($input['token'] ?? null) ? $input['token'] : '';
$now = (int) floor(microtime(true) * 1000);

$dataDir = getenv('TRUMPF_DATA_DIR') ?: __DIR__ . '/data';
if (!is_dir($dataDir) && !@mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
    madn_respond(['ok' => false, 'message' => 'Datenordner kann nicht angelegt werden.'], 500);
}
$guard = $dataDir . '/.htaccess';
if (!is_file($guard)) {
    @file_put_contents($guard, "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n");
}

$roomCode = strtoupper(is_string($input['room'] ?? null) ? trim($input['room']) : '');
$roomCode = preg_match('/^[A-Z0-9]{4,8}$/', $roomCode) ? $roomCode : '';
$name = madn_clean_name($input['name'] ?? '');

if ($action === 'create') {
    if ($name === '') {
        madn_respond(['ok' => false, 'message' => 'Bitte gib einen Namen ein.']);
    }
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $gc = fopen($dataDir . '/madn_create.lock', 'c');
    if ($gc === false || !flock($gc, LOCK_EX)) {
        madn_respond(['ok' => false, 'message' => 'Server ist gerade beschäftigt.'], 503);
    }
    foreach (glob($dataDir . '/madn_*.json') ?: [] as $old) {
        if (@filemtime($old) < time() - MADN_ROOM_TTL_S) {
            @unlink($old);
            @unlink(substr($old, 0, -5) . '.lock');
        }
    }
    do {
        $roomCode = '';
        for ($i = 0; $i < 5; $i++) {
            $roomCode .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
    } while (is_file($dataDir . '/madn_' . $roomCode . '.json'));
    file_put_contents($dataDir . '/madn_' . $roomCode . '.json', json_encode(MadnRoom::fresh($now)));
    flock($gc, LOCK_UN);
    fclose($gc);
}

$roomFile = $dataDir . '/madn_' . $roomCode . '.json';
if ($roomCode === '' || !is_file($roomFile)) {
    if ($action === 'join') {
        madn_respond(['ok' => false, 'message' => 'Diesen Raum gibt es nicht.']);
    }
    madn_respond(['ok' => false, 'code' => 'not_joined', 'message' => 'Der Raum existiert nicht mehr.']);
}

$lock = fopen($dataDir . '/madn_' . $roomCode . '.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX)) {
    madn_respond(['ok' => false, 'message' => 'Server ist gerade beschäftigt.'], 503);
}
$stored = json_decode((string) file_get_contents($roomFile), true);
$room = new MadnRoom(is_array($stored) ? $stored : MadnRoom::fresh($now), $now);

$self = $room->seatByToken($token);
if ($self !== null) {
    $room->markSeen($self);
}
$room->tick();
$self = $room->seatByToken($token);

$reply = ['ok' => true];
$fail = static fn(string $message) => ['ok' => false, 'message' => $message];
$deleteRoom = false;
$status = $room->data['status'];
$game = $room->data['game'];
$myTurn = $self !== null && $status === 'playing' && $game && $game['phase'] !== 'over' && madn_current_seat($game) === $self;

switch ($action) {
    case 'create':
    case 'join':
        if ($self !== null) {
            break; // schon drin (z. B. nach Neuladen)
        }
        if ($name === '') {
            $reply = $fail('Bitte gib einen Namen ein.');
        } elseif ($status !== 'lobby') {
            $reply = $fail('In diesem Raum läuft schon eine Partie.');
        } elseif (($seat = $room->freeSeat()) === null) {
            $reply = $fail('Der Raum ist voll.');
        } else {
            $entry = $room->addHuman($seat, $name);
            $self = $seat;
            $reply['token'] = $entry['token'];
        }
        break;

    case 'leave':
        if ($self !== null) {
            $room->leave($self);
            $self = null;
            $deleteRoom = $room->empty();
        }
        break;

    case 'addAi':
    case 'removeAi':
        $seat = $input['seat'] ?? null;
        if (!$room->isHost($self) || $status !== 'lobby') {
            $reply = $fail('Nur der Gastgeber kann Plätze in der Lobby ändern.');
        } elseif (!is_int($seat) || $seat < 0 || $seat > 3) {
            $reply = $fail('Ungültiger Platz.');
        } elseif ($action === 'addAi' && $room->data['seats'][$seat] === null) {
            $room->data['seats'][$seat] = ['id' => bin2hex(random_bytes(8)), 'token' => '', 'name' => 'KI ' . MADN_COLOR_NAMES[$seat], 'type' => 'ai'];
            $room->touch();
        } elseif ($action === 'removeAi' && ($room->data['seats'][$seat]['type'] ?? '') === 'ai') {
            $room->data['seats'][$seat] = null;
            $room->touch();
        }
        break;

    case 'start':
    case 'again':
        $count = count(array_filter($room->data['seats']));
        if (!$room->isHost($self)) {
            $reply = $fail('Nur der Gastgeber kann starten.');
        } elseif ($action === 'start' && $status !== 'lobby') {
            $reply = $fail('Die Partie läuft schon.');
        } elseif ($action === 'again' && ($game['phase'] ?? '') !== 'over') {
            $reply = $fail('Die Partie läuft noch.');
        } elseif ($count < 2) {
            $reply = $fail('Es braucht mindestens zwei Spieler. Füge sonst eine KI hinzu.');
        } else {
            $room->start();
        }
        break;

    case 'lobby':
        // nach dem Ende zurück in die Lobby, um Plätze zu ändern
        if (!$room->isHost($self) || ($game['phase'] ?? '') !== 'over') {
            $reply = $fail('Nur der Gastgeber kann nach der Partie zurück in die Lobby.');
        } else {
            $room->data['status'] = 'lobby';
            $room->data['game'] = null;
            $room->data['deadline'] = null;
            foreach ($room->data['seats'] as $index => $seat) {
                if ($seat && $seat['type'] === 'ai' && substr($seat['name'], -5) === ' (KI)') {
                    $room->data['seats'][$index] = null; // verlassene Plätze werden wieder frei
                }
            }
            $room->touch();
        }
        break;

    case 'roll':
        if (!$myTurn || $game['phase'] !== 'roll') {
            $reply = $fail('Du bist gerade nicht mit Würfeln dran.');
        } else {
            $room->apply(madn_roll($game, random_int(1, 6)));
        }
        break;

    case 'move':
        $index = $input['piece'] ?? null;
        $legal = $myTurn ? array_column(madn_legal_moves($game), 'index') : [];
        if (!is_int($index) || !in_array($index, $legal, true)) {
            $reply = $fail('Dieser Zug ist nicht möglich.');
        } else {
            $room->apply(madn_move($game, $index));
        }
        break;

    case 'state':
        if ($self !== null && isset($input['since']) && $input['since'] === $room->data['version']) {
            $reply['unchanged'] = true;
        }
        break;

    default:
        $reply = $fail('Unbekannte Aktion.');
}

if ($deleteRoom) {
    @unlink($roomFile);
} elseif ($room->dirty) {
    $tmp = $roomFile . '.tmp';
    file_put_contents($tmp, json_encode($room->data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    rename($tmp, $roomFile);
}
flock($lock, LOCK_UN);
fclose($lock);

if ($self === null && $reply['ok'] && $action !== 'leave') {
    $reply = ['ok' => false, 'code' => 'not_joined', 'message' => 'Du bist nicht mehr in diesem Raum.'];
}
$reply['serverNow'] = $now;
$reply['room'] = $roomCode;
$reply['version'] = $room->data['version'];
if ($self !== null && empty($reply['unchanged'])) {
    $reply['state'] = $room->publicStateFor($self);
}
madn_respond($reply);
