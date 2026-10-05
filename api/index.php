<?php
// Spiel-API: ersetzt den Node/Socket.IO-Server. Der Browser fragt regelmäßig den Spielstand ab (Polling).
declare(strict_types=1);

require __DIR__ . '/engine.php';
require __DIR__ . '/accounts.php';

const TURN_DURATION_MS = 45000;
const REVEAL_DURATION_MS = 7000;
const READY_GRACE_MS = 1200;       // sind alle bereit, geht es nach dieser Zeit weiter (Zeit für die Einsammel-Animation)
const MAX_PLAYERS = 4;
const CARD_COUNT_OPTIONS = [8, 16, 32];
const ONLINE_TIMEOUT_MS = 15000;   // danach gilt ein Spieler als offline
const LOBBY_TIMEOUT_MS = 20000;    // in der Lobby fliegen inaktive Spieler raus
const IDLE_RESET_MS = 300000;      // laufende Partie ohne jeden Spieler wird nach 5 Minuten zurückgesetzt
const LAST_SEEN_REFRESH_MS = 3000;
const PAUSE_END_MS = 60000;        // weniger als 2 Spieler online: nach 1 Minute endet die Partie
const CHAT_MAX_LENGTH = 200;
const CHAT_HISTORY = 60;          // so viele Nachrichten bleiben im Raum gespeichert
const CHAT_MIN_GAP_MS = 700;      // mindestens so lange zwischen zwei Nachrichten desselben Spielers
const AI_LEVELS = ['easy', 'medium', 'hard'];
const AI_NAMES = ['easy' => 'KI Leicht', 'medium' => 'KI Mittel', 'hard' => 'KI Schwer'];

function cleanName($value): string
{
    $value = is_scalar($value) ? (string) $value : '';
    $mb = function_exists('mb_substr');
    $value = $mb ? mb_substr($value, 0, 100, 'UTF-8') : substr($value, 0, 100);
    $value = trim((string) preg_replace('/\s+/u', ' ', $value));
    return $mb ? mb_substr($value, 0, 20, 'UTF-8') : substr($value, 0, 20);
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
            'teamMode' => false,
            'teamPairing' => 0,
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
        if ($this->data['status'] === 'lobby' && !empty($this->data['teamMode']) && count($this->data['players']) !== MAX_PLAYERS) {
            $this->data['teamMode'] = false;
            $this->touch();
        }
        $this->transferHost();
        $this->checkIdle();
        $paused = $this->updatePresence();

        for ($step = 0; !$paused && $step < 6 && $this->data['game'] !== null; $step++) {
            $game = $this->data['game'];
            if ($game['phase'] === 'choosing' && $game['turnEndsAt'] !== null) {
                $botIndex = trumpf_player_index($this->data['players'], $game['activePlayerId']);
                $bot = $botIndex === null ? null : $this->data['players'][$botIndex];
                $botCard = $bot === null ? null : ($bot['hand'][0] ?? null);
                if (
                    $botCard !== null
                    && !empty($bot['bot'])
                    && $this->now >= $game['turnEndsAt'] - TURN_DURATION_MS + ai_think_ms((string) ($bot['difficulty'] ?? 'medium'), $bot['id'] . ':' . $game['round'])
                ) {
                    try {
                        $this->revealCards($game['activePlayerId'], ai_choose_category((string) $botCard, (string) ($bot['difficulty'] ?? 'medium'), $this->cardsInPlay()));
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
        if (!empty($this->data['game']['teams'])) {
            $teams = $this->data['game']['teams'];
            $roster = $this->data['players'];
            $onlineTeams = array_values(array_unique(array_map(static function ($index) use ($teams, $roster) {
                return $teams[$roster[$index]['id']] ?? 0;
            }, $online)));
            if (count($onlineTeams) === 1) {
                $winnerTeam = $onlineTeams[0];
            } else {
                $totals = [0, 0];
                foreach ($this->data['players'] as $player) {
                    $totals[$teams[$player['id']] ?? 0] += count($player['hand']);
                }
                $winnerTeam = $totals[0] >= $totals[1] ? 0 : 1;
            }
            trumpf_finish_team($this->data['game'], $this->data['players'], $winnerTeam);
            $this->data['game']['result']['reason'] = 'abandoned';
            $this->data['game']['pausedUntil'] = null;
            $this->data['status'] = 'finished';
            $this->touch();
            return;
        }
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

    /** Alle Karten, die in dieser Partie noch im Spiel sind (Hände, Pott, Tisch). */
    public function cardsInPlay(): array
    {
        $ids = [];
        foreach ($this->data['players'] as $player) {
            foreach ($player['hand'] as $cardId) {
                $ids[] = (string) $cardId;
            }
        }
        foreach ($this->data['game']['pot'] ?? [] as $cardId) {
            $ids[] = (string) $cardId;
        }
        return $ids;
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
        $this->recordStats();
        if ($this->data['game']['phase'] === 'finished') {
            $this->data['status'] = 'finished';
        } else {
            $this->data['game']['revealEndsAt'] = $this->now + REVEAL_DURATION_MS;
            $this->data['game']['readyIds'] = [];
        }
        $this->touch();
    }

    /** Statistik für den Endbildschirm: Stiche, Siegesserien, ausgeschieden in Runde, Stiche pro Karte. */
    private function recordStats(): void
    {
        $game = $this->data['game'];
        $stats = $this->data['stats'] ?? ['players' => [], 'cards' => []];
        $blank = ['tricks' => 0, 'streak' => 0, 'best' => 0, 'outRound' => null];
        $category = $game['category'] ?? null;
        $tableCards = $game['tableCards'] ?? [];
        if ($category !== null && !empty($game['teams']) && count($tableCards) > 1) {
            [$winnerTeam, $teamValue] = trumpf_team_outcome($game, $tableCards);
            $deck = trumpf_load_deck();
            foreach ($tableCards as $entry) {
                $team = $game['teams'][$entry['playerId']] ?? 0;
                $entryStats = $stats['players'][$entry['playerId']] ?? $blank;
                if ($winnerTeam !== null && $team === $winnerTeam) {
                    $entryStats['tricks']++;
                    $entryStats['streak']++;
                    $entryStats['best'] = max($entryStats['best'], $entryStats['streak']);
                    if ((float) ($deck[$entry['cardId']][$category] + 0) === (float) $teamValue[$team]) {
                        $stats['cards'][$entry['cardId']] = ($stats['cards'][$entry['cardId']] ?? 0) + 1;
                    }
                } elseif ($winnerTeam !== null) {
                    $entryStats['streak'] = 0;
                }
                $stats['players'][$entry['playerId']] = $entryStats;
            }
        } elseif ($category !== null && isset(TRUMPF_CATEGORIES[$category]) && count($tableCards) > 1) {
            $deck = trumpf_load_deck();
            $values = [];
            foreach ($tableCards as $entry) {
                $values[] = (float) ($deck[$entry['cardId']][$category] ?? 0);
            }
            $best = TRUMPF_CATEGORIES[$category]['direction'] === 'low' ? min($values) : max($values);
            $winners = array_keys(array_filter($values, static function ($value) use ($best) {
                return $value === $best;
            }));
            $winnerPos = count($winners) === 1 ? $winners[0] : null;
            foreach ($tableCards as $position => $entry) {
                $entryStats = $stats['players'][$entry['playerId']] ?? $blank;
                if ($position === $winnerPos) {
                    $entryStats['tricks']++;
                    $entryStats['streak']++;
                    $entryStats['best'] = max($entryStats['best'], $entryStats['streak']);
                    $stats['cards'][$entry['cardId']] = ($stats['cards'][$entry['cardId']] ?? 0) + 1;
                } elseif ($winnerPos !== null) {
                    $entryStats['streak'] = 0;
                }
                $stats['players'][$entry['playerId']] = $entryStats;
            }
        }
        foreach ($this->data['players'] as $player) {
            $entryStats = $stats['players'][$player['id']] ?? $blank;
            if (count($player['hand']) === 0 && $entryStats['outRound'] === null) {
                $entryStats['outRound'] = (int) $game['round'];
            }
            $stats['players'][$player['id']] = $entryStats;
        }
        $this->data['stats'] = $stats;
    }

    /** Revanche: Jeder stimmt ab, los geht es, wenn alle verbundenen Menschen zugestimmt haben. */
    public function voteRematch(string $playerId): ?string
    {
        if ($this->data['status'] !== 'finished') {
            return 'Die aktuelle Partie ist noch nicht beendet.';
        }
        $votes = $this->data['rematch'] ?? [];
        if (!in_array($playerId, $votes, true)) {
            $votes[] = $playerId;
        }
        $this->data['rematch'] = $votes;
        $connected = array_values(array_filter($this->data['players'], static function ($entry) {
            return $entry['connected'];
        }));
        $allVoted = true;
        foreach ($connected as $player) {
            $allVoted = $allVoted && (!empty($player['bot']) || in_array($player['id'], $votes, true));
        }
        $this->touch();
        if ($allVoted) {
            if (count($connected) < 2) {
                return 'Für eine Revanche müssen mindestens zwei Spieler verbunden sein.';
            }
            $this->data['players'] = $connected;
            $this->beginGame();
        }
        return null;
    }

    /** Spieler hat beim Ergebnis auf „Weiter“ getippt. Sind alle Menschen bereit, wird das Ergebnis verkürzt. */
    /** Chatnachricht eines Spielers speichern. Gibt eine Fehlermeldung zurück oder null. */
    public function addChat(int $playerIndex, string $text): ?string
    {
        $text = trim((string) preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $text));
        $text = trim((string) preg_replace('/\s+/u', ' ', $text));
        if ($text === '') {
            return 'Die Nachricht ist leer.';
        }
        $text = function_exists('mb_substr') ? mb_substr($text, 0, CHAT_MAX_LENGTH, 'UTF-8') : substr($text, 0, CHAT_MAX_LENGTH);
        $player = $this->data['players'][$playerIndex];
        if ($this->now - (int) ($player['lastChatAt'] ?? 0) < CHAT_MIN_GAP_MS) {
            return 'Nicht so schnell, warte kurz.';
        }
        $this->data['players'][$playerIndex]['lastChatAt'] = $this->now;
        $this->data['chatSeq'] = (int) ($this->data['chatSeq'] ?? 0) + 1;
        $chat = $this->data['chat'] ?? [];
        $chat[] = [
            'id' => $this->data['chatSeq'],
            'playerId' => $player['id'],
            'name' => $player['name'],
            'text' => $text,
            'at' => $this->now,
        ];
        $this->data['chat'] = array_slice($chat, -CHAT_HISTORY);
        $this->touch();
        return null;
    }

    public function markReady(string $playerId): void
    {
        $game = $this->data['game'];
        if ($game === null || $game['phase'] !== 'revealed' || $game['revealEndsAt'] === null) {
            return;
        }
        $ready = $game['readyIds'] ?? [];
        if (!in_array($playerId, $ready, true)) {
            $ready[] = $playerId;
        }
        $this->data['game']['readyIds'] = $ready;
        $onTable = array_column($game['tableCards'], 'playerId');
        $allReady = true;
        foreach ($this->data['players'] as $player) {
            $needed = $player['connected'] && empty($player['bot'])
                && (count($player['hand']) > 0 || in_array($player['id'], $onTable, true));
            $allReady = $allReady && (!$needed || in_array($player['id'], $ready, true));
        }
        if ($allReady) {
            $this->data['game']['revealEndsAt'] = min($game['revealEndsAt'], $this->now + READY_GRACE_MS);
        }
        $this->touch();
    }

    public function beginGame(): void
    {
        foreach ($this->data['players'] as $index => $player) {
            $this->data['players'][$index]['away'] = false;
        }
        $teams = null;
        if (!empty($this->data['teamMode']) && count($this->data['players']) === MAX_PLAYERS && empty($this->data['solo'])) {
            $teams = trumpf_team_map($this->data['players'], (int) ($this->data['teamPairing'] ?? 0));
        } else {
            $this->data['teamMode'] = false;
        }
        $this->data['game'] = trumpf_start_game($this->data['players'], (int) $this->data['cardsPerPlayer'], $teams);
        $this->data['stats'] = ['players' => [], 'cards' => []];
        $this->data['rematch'] = [];
        $this->data['status'] = 'playing';
        $this->armTurn();
        $this->touch();
    }

    /** Karte mit den meisten Stichen der Partie */
    private function topCard(): ?array
    {
        $cards = $this->data['stats']['cards'] ?? [];
        if (!$cards) {
            return null;
        }
        arsort($cards);
        $cardId = (string) array_key_first($cards);
        $card = trumpf_load_deck()[$cardId] ?? null;
        return $card === null ? null : ['name' => $card['name'], 'wins' => (int) $cards[$cardId]];
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

        $teamMap = null;
        if ($game !== null) {
            $teamMap = $game['teams'] ?? null;
        } elseif (!empty($data['teamMode']) && count($data['players']) === MAX_PLAYERS) {
            $teamMap = trumpf_team_map($data['players'], (int) ($data['teamPairing'] ?? 0));
        }
        $players = [];
        foreach ($data['players'] as $entry) {
            $count = count($entry['hand']);
            $players[] = [
                'id' => $entry['id'],
                'name' => $entry['name'],
                'isHost' => $entry['id'] === $data['hostId'],
                'connected' => $entry['connected'],
                'isBot' => !empty($entry['bot']),
                'difficulty' => $entry['difficulty'] ?? null,
                'level' => $entry['accountLevel'] ?? null,
                'team' => $teamMap === null ? null : ($teamMap[$entry['id']] ?? 0),
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
                'winnerIds' => $game['winnerIds'] ?? ($game['winnerId'] === null ? [] : [$game['winnerId']]),
                'teamMode' => !empty($game['teams']),
                'turnEndsAt' => $game['turnEndsAt'],
                'revealEndsAt' => $game['revealEndsAt'],
                'pausedUntil' => $game['pausedUntil'] ?? null,
                'readyIds' => $game['readyIds'] ?? [],
                'xpAwards' => $game['xpAwards'] ?? new stdClass(),
                'turnDurationMs' => TURN_DURATION_MS,
                'revealDurationMs' => REVEAL_DURATION_MS,
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
            'stats' => $data['stats']['players'] ?? new stdClass(),
            'topCard' => $this->topCard(),
            'rematchIds' => $data['rematch'] ?? [],
            'solo' => !empty($data['solo']),
            'teamMode' => $teamMap !== null,
            'chat' => array_values(array_slice($data['chat'] ?? [], -50)),
            'aiLevel' => $data['aiLevel'] ?? null,
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
    respond(['ok' => true, 'serverNow' => (int) floor(microtime(true) * 1000)]);
}
if ($action === 'cards') {
    // Alle Fahrzeugkarten für die Sammlung (öffentlich, ohne Spielstand).
    respond(['ok' => true, 'categories' => TRUMPF_CATEGORIES, 'cards' => array_values(trumpf_load_deck())]);
}
if (in_array($action, ['register', 'login', 'profile', 'playerProfile', 'leaderboard', 'heartbeat', 'inviteDecline', 'pushKey', 'pushSubscribe', 'pushUnsubscribe', 'friends', 'friendAdd', 'friendAccept', 'friendRemove', 'friendProfile'], true)) {
    trumpf_account_action($action, $input);
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
if ($roomCode === '123456') {
    $roomCode = ''; // alte Test-Session: gibt es nicht mehr, auch wenn die Datei noch auf dem Server liegt
}

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
$deleteRoom = false;
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
            $account = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
            if ($account !== null) {
                $name = $account['name'];
            } elseif ($name !== '' && $selfIndex === null && trumpf_account_by_name($name) !== null) {
                $reply = $fail('Dieser Spielername ist registriert. Melde dich an oder nimm einen anderen Namen.');
                break;
            }
            if ($selfIndex === null && !empty($room->data['solo'])) {
                $reply = $fail('Das ist ein Spiel gegen die KI, da kann niemand sonst beitreten.');
                break;
            }
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
                    $room->data = TrumpfRoom::fresh();
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
                    'accountId' => $account === null ? null : (int) $account['id'],
                    'accountLevel' => $account === null ? null : trumpf_level((int) $account['xp'])['level'],
                ];
                $selfIndex = count($room->data['players']) - 1;
                if ($account !== null) {
                    // Wer beigetreten ist, braucht die Einladungen zu diesem Raum nicht mehr.
                    try {
                        trumpf_db()->prepare('DELETE FROM invites WHERE to_id = ? AND room = ?')->execute([(int) $account['id'], $roomCode]);
                    } catch (PDOException $error) {
                        // Einladungen sind Zusatz
                    }
                }
                if ($room->data['hostId'] === null) {
                    $room->data['hostId'] = $room->data['players'][$selfIndex]['id'];
                }
                $ai = $creating && is_array($input['ai'] ?? null) ? $input['ai'] : null;
                if ($ai !== null) {
                    // Spiel gegen die KI: 1 bis 3 Gegner in der gewählten Stufe, niemand sonst kann beitreten.
                    $level = in_array($ai['difficulty'] ?? '', AI_LEVELS, true) ? $ai['difficulty'] : 'medium';
                    $opponents = max(1, min(MAX_PLAYERS - 1, (int) ($ai['opponents'] ?? 1)));
                    for ($i = 1; $i <= $opponents; $i++) {
                        $room->data['players'][] = [
                            'id' => bin2hex(random_bytes(16)),
                            'token' => bin2hex(random_bytes(24)),
                            'name' => AI_NAMES[$level] . ($opponents > 1 ? ' ' . $i : ''),
                            'connected' => true,
                            'lastSeen' => $room->now,
                            'hand' => [],
                            'bot' => true,
                            'difficulty' => $level,
                        ];
                    }
                    $room->data['solo'] = true;
                    $room->data['aiLevel'] = $level;
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
                if (!empty($room->data['solo'])) {
                    $deleteRoom = true; // gegen die KI spielt sonst niemand, der Raum wird nicht mehr gebraucht
                }
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

        case 'setTeams':
            if (!$isHost()) {
                $reply = $fail('Nur der Host kann den Spielmodus ändern.');
            } elseif ($room->data['status'] !== 'lobby' || !empty($room->data['solo'])) {
                $reply = $fail('Der Spielmodus kann nur in der Lobby geändert werden.');
            } elseif (!empty($input['on']) && count($room->data['players']) !== MAX_PLAYERS) {
                $reply = $fail('Für 2 gegen 2 braucht ihr genau 4 Spieler.');
            } else {
                $room->data['teamMode'] = !empty($input['on']);
                if (!empty($input['shuffle'])) {
                    $room->data['teamPairing'] = ((int) ($room->data['teamPairing'] ?? 0) + 1) % 3;
                }
                $room->touch();
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

        case 'invite':
            if ($selfIndex === null) {
                $reply = $fail('Du bist in keiner Session.');
            } elseif (trumpf_db() === null) {
                $reply = $fail('Einladungen sind gerade nicht verfügbar.');
            } else {
                try {
                    $reply = trumpf_send_invite(trumpf_db(), $room, $selfIndex, $roomCode, is_string($input['name'] ?? null) ? $input['name'] : '');
                } catch (PDOException $error) {
                    $reply = $fail('Datenbankfehler, bitte später nochmal versuchen.');
                }
            }
            break;

        case 'chat':
            if ($selfIndex === null) {
                $reply = $fail('Du bist in keiner Session.');
            } elseif (!empty($room->data['solo'])) {
                $reply = $fail('Im Spiel gegen die KI gibt es keinen Chat.');
            } else {
                $problem = $room->addChat($selfIndex, is_string($input['text'] ?? null) ? $input['text'] : '');
                if ($problem !== null) {
                    $reply = $fail($problem);
                }
            }
            break;

        case 'ready':
            if ($selfIndex !== null && $room->data['status'] === 'playing') {
                $room->markReady($room->data['players'][$selfIndex]['id']);
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
            if ($selfIndex === null) {
                $reply = $fail('Du bist in keiner Partie.');
            } else {
                $problem = $room->voteRematch($room->data['players'][$selfIndex]['id']);
                $selfIndex = $room->playerIndexByToken($token);
                if ($problem !== null) {
                    $reply = $fail($problem);
                }
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

trumpf_record_results($room);

if ($deleteRoom) {
    $room->dirty = false;
    @unlink($roomFile);
}

if ($room->dirty) {
    $tmp = $roomFile . '.tmp';
    file_put_contents($tmp, json_encode($room->data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    rename($tmp, $roomFile);
}

$reply['version'] = $room->data['version'];
$reply['serverNow'] = $room->now;
$reply['room'] = $roomCode;
if (empty($reply['unchanged']) && ($reply['code'] ?? '') !== 'not_joined') {
    $reply['state'] = $selfIndex === null ? null : $room->publicStateFor($selfIndex) + ['sessionId' => $roomCode];
}
respond($reply);
