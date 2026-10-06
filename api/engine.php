<?php
// Spiellogik: PHP-Port von game-engine.js. Karten werden im Spielstand nur als IDs gehalten.
declare(strict_types=1);

class TrumpfError extends RuntimeException
{
}

const TRUMPF_CATEGORIES = [
    'leistung' => ['label' => 'Leistung', 'unit' => 'PS', 'direction' => 'high', 'icon' => 'bolt'],
    'hubraum' => ['label' => 'Hubraum', 'unit' => 'cm³', 'direction' => 'high', 'icon' => 'engine'],
    'hoechstgeschwindigkeit' => [
        'label' => 'Höchstgeschwindigkeit',
        'unit' => 'km/h',
        'direction' => 'high',
        'icon' => 'speed',
    ],
    'beschleunigung' => ['label' => '0–100 km/h', 'unit' => 's', 'direction' => 'low', 'icon' => 'timer'],
    'drehmoment' => ['label' => 'Drehmoment', 'unit' => 'Nm', 'direction' => 'high', 'icon' => 'torque'],
    'gewicht' => ['label' => 'Gewicht', 'unit' => 'kg', 'direction' => 'low', 'icon' => 'weight'],
    'drehzahl' => ['label' => 'Drehzahl', 'unit' => 'U/min', 'direction' => 'high', 'icon' => 'rpm'],
    'preis' => ['label' => 'Preis', 'unit' => '€', 'direction' => 'high', 'icon' => 'price'],
    'raritaet' => ['label' => 'Rarität', 'unit' => '', 'direction' => 'high', 'icon' => 'gem', 'rating' => true],
    'performance' => ['label' => 'Performance', 'unit' => '', 'direction' => 'high', 'icon' => 'flag', 'rating' => true],
];

const TRUMPF_LOCAL_CARD_IMAGES = [
    'Audi R8 V10 Performance' => '/cardimages/audi_r8_performance.png',
    'Lamborghini Huracán EVO' => '/cardimages/lamborghini_huracan_evo.png',
    'Lamborghini Huracán STO' => '/cardimages/lamborghini_huracan_sto_ur.png',
];

function trumpf_data_file(string $name): string
{
    // Im Repo liegen die Dateien im Hauptordner, auf dem Server neben der API.
    foreach ([__DIR__ . '/' . $name, dirname(__DIR__) . '/' . $name] as $path) {
        if (is_file($path)) {
            return $path;
        }
    }
    throw new RuntimeException('Datei fehlt: ' . $name);
}

function trumpf_read_json(string $name): array
{
    $data = json_decode((string) file_get_contents(trumpf_data_file($name)), true);
    if (!is_array($data)) {
        throw new RuntimeException('Ungültiges JSON: ' . $name);
    }
    return $data;
}

function trumpf_lower(string $value): string
{
    return function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
}

/** Gibt alle Karten zurück (Map c_id => Karte inkl. Bildinfos), mit denselben Prüfungen wie prepareDeck(). */
function trumpf_load_deck(): array
{
    static $deck = null;
    if ($deck !== null) {
        return $deck;
    }

    $cards = trumpf_read_json('cards.json');
    $images = trumpf_read_json('card-images.json');
    $ids = [];
    $names = [];
    $deck = [];

    foreach ($cards as $card) {
        $id = isset($card['c_id']) ? (string) $card['c_id'] : '';
        if ($id === '' || isset($ids[$id])) {
            throw new RuntimeException('Ungültige oder doppelte Karten-ID: ' . ($id === '' ? 'fehlt' : $id));
        }
        $ids[$id] = true;

        $name = trim((string) ($card['name'] ?? ''));
        $normalized = trumpf_lower($name);
        if ($normalized === '' || isset($names[$normalized])) {
            throw new RuntimeException('Ungültiger oder doppelter Kartenname: ' . ($name === '' ? 'fehlt' : $name));
        }
        $names[$normalized] = true;

        foreach (array_keys(TRUMPF_CATEGORIES) as $category) {
            $value = $card[$category] ?? null;
            if ($value === null || $value === '' || !is_numeric($value) || !is_finite((float) $value)) {
                throw new RuntimeException("Karte $id hat keinen gültigen Wert für $category.");
            }
        }

        $info = $images[$id] ?? null;
        $card['c_id'] = $id;
        $card['image'] = ($info['localImage'] ?? '') ?: (($info['image'] ?? '') ?: (TRUMPF_LOCAL_CARD_IMAGES[$name] ?? null));
        $card['imageMeta'] = is_array($info)
            ? array_intersect_key($info, array_flip(['pageUrl', 'source', 'author', 'license', 'licenseUrl']))
            : null;
        $deck[$id] = $card;
    }

    return $deck;
}

function trumpf_shuffle(array $items): array
{
    for ($index = count($items) - 1; $index > 0; $index--) {
        $swap = random_int(0, $index);
        $tmp = $items[$index];
        $items[$index] = $items[$swap];
        $items[$swap] = $tmp;
    }
    return $items;
}

function trumpf_player_index(array $players, ?string $playerId): ?int
{
    foreach ($players as $index => $player) {
        if ($player['id'] === $playerId) {
            return $index;
        }
    }
    return null;
}

function trumpf_with_cards(array $players): array
{
    $indexes = [];
    foreach ($players as $index => $player) {
        if (count($player['hand']) > 0) {
            $indexes[] = $index;
        }
    }
    return $indexes;
}

/** Spieler mit Karten, der gerade online ist (nur diese nehmen an einer Runde teil). */
function trumpf_can_play(array $player): bool
{
    return count($player['hand']) > 0 && empty($player['away']);
}

function trumpf_playable(array $players): array
{
    $indexes = [];
    foreach ($players as $index => $player) {
        if (trumpf_can_play($player)) {
            $indexes[] = $index;
        }
    }
    return $indexes;
}

/** Teilt die Karten aus und liefert den Anfangszustand der Partie. */
/**
 * @param array|null $hands Eigene Decks: [playerId => [cardId, …]] (Modus mit Sammlung). Ohne: zufällig aus allen Karten.
 */
function trumpf_start_game(array &$players, int $cardsPerPlayer, ?array $teams = null, ?array $hands = null): array
{
    if (count($players) < 2 || count($players) > 4) {
        throw new TrumpfError('Ein Spiel benötigt 2 bis 4 Spieler.');
    }
    if (!in_array($cardsPerPlayer, [8, 16, 32], true)) {
        throw new TrumpfError('Pro Spieler sind nur 8, 16 oder 32 Karten erlaubt.');
    }

    if ($hands !== null) {
        foreach ($players as $index => $player) {
            $hand = array_map('strval', array_values($hands[$player['id']] ?? []));
            if (count($hand) !== $cardsPerPlayer) {
                throw new TrumpfError('Für ' . ($player['name'] ?? 'einen Spieler') . " fehlen Karten (es werden $cardsPerPlayer gebraucht).");
            }
            $players[$index]['hand'] = trumpf_shuffle($hand);
        }
    } else {
        $needed = count($players) * $cardsPerPlayer;
        $deck = trumpf_load_deck();
        if (count($deck) < $needed) {
            throw new TrumpfError("Für diese Partie werden $needed unterschiedliche Karten benötigt.");
        }

        $cardIds = array_slice(trumpf_shuffle(array_map('strval', array_keys($deck))), 0, $needed);
        foreach ($players as $index => $player) {
            $players[$index]['hand'] = [];
        }
        foreach ($cardIds as $position => $cardId) {
            $players[$position % count($players)]['hand'][] = (string) $cardId;
        }
    }

    return [
        'phase' => 'choosing',
        'round' => 1,
        'cardsPerPlayer' => $cardsPerPlayer,
        'activePlayerId' => $players[0]['id'],
        'teams' => $teams,
        'decks' => $hands,
        'lastChooser' => [null, null],
        'category' => null,
        'tableCards' => [],
        'pot' => [],
        'result' => null,
        'winnerId' => null,
        'turnEndsAt' => null,
        'revealEndsAt' => null,
        'pausedUntil' => null,
    ];
}

function trumpf_finish(array &$game, ?string $playerId): void
{
    $game['phase'] = 'finished';
    $game['winnerId'] = $playerId;
    $game['activePlayerId'] = $playerId;
    $game['turnEndsAt'] = null;
    $game['revealEndsAt'] = null;
    $game['result'] = [
        'type' => 'gameOver',
        'winnerIds' => $playerId === null ? [] : [$playerId],
        'value' => null,
        'collectedCards' => 0,
    ];
}

function trumpf_choose_category(array &$game, array &$players, string $playerId, string $category): array
{
    if ($game['phase'] !== 'choosing') {
        throw new TrumpfError('In dieser Spielphase kann keine Kategorie gewählt werden.');
    }
    if ($game['activePlayerId'] !== $playerId) {
        throw new TrumpfError('Du bist noch nicht am Zug.');
    }
    if (!isset(TRUMPF_CATEGORIES[$category])) {
        throw new TrumpfError('Diese Kategorie gibt es nicht.');
    }

    if (!empty($game['teams'])) {
        return trumpf_choose_team($game, $players, $category);
    }

    $deck = trumpf_load_deck();
    $withCards = trumpf_with_cards($players);
    if (count($withCards) < 2) {
        trumpf_finish($game, $withCards ? $players[$withCards[0]]['id'] : null);
        return $game['result'];
    }
    // Wer offline ist, setzt diese Runde aus; seine Karten bleiben ihm erhalten.
    $contenders = trumpf_playable($players);
    if (count($contenders) < 2) {
        throw new TrumpfError('Es sind nicht genug Spieler online.');
    }

    $tableCards = [];
    foreach ($contenders as $index) {
        $tableCards[] = [
            'playerId' => $players[$index]['id'],
            'cardId' => (string) array_shift($players[$index]['hand']),
        ];
    }

    $values = array_map(static function ($entry) use ($deck, $category) {
        return $deck[$entry['cardId']][$category] + 0;
    }, $tableCards);
    $best = TRUMPF_CATEGORIES[$category]['direction'] === 'low' ? min($values) : max($values);

    $winnerIds = [];
    foreach ($tableCards as $position => $entry) {
        if ((float) $values[$position] === (float) $best) {
            $winnerIds[] = $entry['playerId'];
        }
    }
    $tableCardIds = array_map(static function ($entry) {
        return $entry['cardId'];
    }, $tableCards);

    $game['category'] = $category;
    $game['tableCards'] = $tableCards;
    $game['phase'] = 'revealed';
    $game['turnEndsAt'] = null;

    if (count($winnerIds) === 1) {
        $winnerIndex = trumpf_player_index($players, $winnerIds[0]);
        $players[$winnerIndex]['hand'] = array_merge($players[$winnerIndex]['hand'], $game['pot'], $tableCardIds);
        $game['pot'] = [];
        $game['activePlayerId'] = $players[$winnerIndex]['id'];
        $game['result'] = [
            'type' => 'winner',
            'winnerIds' => $winnerIds,
            'value' => $best,
            'collectedCards' => count($tableCards),
        ];
    } else {
        $game['pot'] = array_merge($game['pot'], $tableCardIds);
        $currentIndex = trumpf_player_index($players, $game['activePlayerId']);
        $nextIndex = null;
        if ($currentIndex !== null && trumpf_can_play($players[$currentIndex])) {
            $nextIndex = $currentIndex;
        } else {
            foreach ($players as $index => $player) {
                if (in_array($player['id'], $winnerIds, true) && trumpf_can_play($player)) {
                    $nextIndex = $index;
                    break;
                }
            }
            if ($nextIndex === null) {
                $playable = trumpf_playable($players);
                $nextIndex = $playable ? $playable[0] : null;
            }
        }
        $game['activePlayerId'] = $nextIndex === null ? $winnerIds[0] : $players[$nextIndex]['id'];
        $game['result'] = [
            'type' => 'tie',
            'winnerIds' => $winnerIds,
            'value' => $best,
            'collectedCards' => 0,
        ];
    }

    $remaining = trumpf_with_cards($players);
    if (count($remaining) === 1) {
        $winnerIndex = $remaining[0];
        $players[$winnerIndex]['hand'] = array_merge($players[$winnerIndex]['hand'], $game['pot']);
        $game['pot'] = [];
        trumpf_finish($game, $players[$winnerIndex]['id']);
    } elseif (count($remaining) === 0) {
        $winnerIndex = trumpf_player_index($players, $winnerIds[0]);
        $players[$winnerIndex]['hand'] = array_merge($players[$winnerIndex]['hand'], $game['pot']);
        $game['pot'] = [];
        trumpf_finish($game, $players[$winnerIndex]['id']);
    }

    return $game['result'];
}

/** Teamzuordnung für 2 gegen 2: Index-Paare je nach Aufstellung (0: 1+3 gegen 2+4, 1: 1+2 gegen 3+4, 2: 1+4 gegen 2+3). */
function trumpf_team_map(array $players, int $pairing): array
{
    $teamA = [[0, 2], [0, 1], [0, 3]][$pairing % 3];
    $map = [];
    foreach ($players as $index => $player) {
        $map[$player['id']] = in_array($index, $teamA, true) ? 0 : 1;
    }
    return $map;
}

/** Ausgang eines Stichs im Teammodus: Teamwert = beste Karte des Teams. Gibt [Gewinnerteam oder null, Teamwerte, Bestwert] zurück. */
function trumpf_team_outcome(array $game, array $tableCards): array
{
    $deck = trumpf_load_deck();
    $category = $game['category'];
    $low = TRUMPF_CATEGORIES[$category]['direction'] === 'low';
    $teamValue = [null, null];
    foreach ($tableCards as $entry) {
        $team = $game['teams'][$entry['playerId']] ?? 0;
        $value = (float) ($deck[$entry['cardId']][$category] + 0);
        if ($teamValue[$team] === null || ($low ? $value < $teamValue[$team] : $value > $teamValue[$team])) {
            $teamValue[$team] = $value;
        }
    }
    if ($teamValue[0] === null || $teamValue[1] === null || $teamValue[0] === $teamValue[1]) {
        return [null, $teamValue, $teamValue[0] ?? $teamValue[1]];
    }
    $winner = ($low ? $teamValue[0] < $teamValue[1] : $teamValue[0] > $teamValue[1]) ? 0 : 1;
    return [$winner, $teamValue, $teamValue[$winner]];
}

/** Verteilt Karten reihum an alle Mitglieder eines Teams, angefangen beim angegebenen Spieler. */
function trumpf_give_to_team(array &$players, array $teams, int $team, array $cardIds, ?string $firstId): void
{
    $members = [];
    foreach ($players as $index => $player) {
        if (($teams[$player['id']] ?? null) === $team) {
            $members[] = $index;
        }
    }
    if (!$members) {
        return;
    }
    $start = 0;
    foreach ($members as $position => $index) {
        if ($players[$index]['id'] === $firstId) {
            $start = $position;
        }
    }
    foreach (array_values($cardIds) as $offset => $cardId) {
        $players[$members[($start + $offset) % count($members)]]['hand'][] = (string) $cardId;
    }
}

function trumpf_team_has_cards(array $players, array $teams): array
{
    $has = [false, false];
    foreach ($players as $player) {
        if (count($player['hand']) > 0) {
            $has[$teams[$player['id']] ?? 0] = true;
        }
    }
    return $has;
}

function trumpf_finish_team(array &$game, array &$players, ?int $team): void
{
    $ids = [];
    foreach ($players as $player) {
        if ($team !== null && ($game['teams'][$player['id']] ?? null) === $team) {
            $ids[] = $player['id'];
        }
    }
    if ($team !== null && $game['pot']) {
        trumpf_give_to_team($players, $game['teams'], $team, $game['pot'], $ids[0] ?? null);
        $game['pot'] = [];
    }
    $game['phase'] = 'finished';
    $game['winnerId'] = $ids[0] ?? null;
    $game['winnerIds'] = $ids;
    $game['winnerTeam'] = $team;
    $game['activePlayerId'] = $ids[0] ?? $game['activePlayerId'];
    $game['turnEndsAt'] = null;
    $game['revealEndsAt'] = null;
    $game['result'] = [
        'type' => 'gameOver',
        'winnerIds' => $ids,
        'winnerTeam' => $team,
        'value' => null,
        'collectedCards' => 0,
    ];
}

/** Wer wählt als Nächstes: die Teams wechseln sich ab (A, B, A, B), im Team wechseln die Spieler. */
function trumpf_team_next_chooser(array &$game, array $players): void
{
    $currentTeam = $game['teams'][$game['activePlayerId']] ?? 0;
    $game['lastChooser'][$currentTeam] = $game['activePlayerId'];
    foreach ([1 - $currentTeam, $currentTeam] as $team) {
        $members = [];
        foreach ($players as $player) {
            if (($game['teams'][$player['id']] ?? null) === $team && trumpf_can_play($player)) {
                $members[] = $player['id'];
            }
        }
        if (!$members) {
            continue;
        }
        $fresh = array_values(array_filter($members, static function ($id) use ($game, $team) {
            return $id !== ($game['lastChooser'][$team] ?? null);
        }));
        $game['activePlayerId'] = $fresh ? $fresh[0] : $members[0];
        return;
    }
}

function trumpf_choose_team(array &$game, array &$players, string $category): array
{
    $teams = $game['teams'];
    $has = trumpf_team_has_cards($players, $teams);
    if (!$has[0] || !$has[1]) {
        trumpf_finish_team($game, $players, $has[0] ? 0 : ($has[1] ? 1 : null));
        return $game['result'];
    }
    $contenders = trumpf_playable($players);
    $present = [false, false];
    foreach ($contenders as $index) {
        $present[$teams[$players[$index]['id']] ?? 0] = true;
    }
    if (!$present[0] || !$present[1]) {
        throw new TrumpfError('Von einem Team ist gerade niemand online.');
    }

    $tableCards = [];
    foreach ($contenders as $index) {
        $tableCards[] = [
            'playerId' => $players[$index]['id'],
            'cardId' => (string) array_shift($players[$index]['hand']),
        ];
    }
    $game['category'] = $category;
    $game['tableCards'] = $tableCards;
    $game['phase'] = 'revealed';
    $game['turnEndsAt'] = null;

    [$winnerTeam, $teamValue, $best] = trumpf_team_outcome($game, $tableCards);
    $deck = trumpf_load_deck();
    $tableCardIds = array_column($tableCards, 'cardId');
    // Karten, die den Teamwert erreichen (bei Gleichstand beider Teams ebenfalls)
    $winnerIds = [];
    foreach ($tableCards as $entry) {
        $team = $teams[$entry['playerId']] ?? 0;
        if (($winnerTeam === null || $team === $winnerTeam) && (float) ($deck[$entry['cardId']][$category] + 0) === (float) $teamValue[$team]) {
            $winnerIds[] = $entry['playerId'];
        }
    }

    if ($winnerTeam !== null) {
        trumpf_give_to_team($players, $teams, $winnerTeam, array_merge($game['pot'], $tableCardIds), $winnerIds[0] ?? null);
        $game['pot'] = [];
        $game['result'] = ['type' => 'winner', 'winnerIds' => $winnerIds, 'winnerTeam' => $winnerTeam, 'value' => $best, 'collectedCards' => count($tableCards)];
    } else {
        $game['pot'] = array_merge($game['pot'], $tableCardIds);
        $game['result'] = ['type' => 'tie', 'winnerIds' => $winnerIds, 'winnerTeam' => null, 'value' => $best, 'collectedCards' => 0];
    }
    trumpf_team_next_chooser($game, $players);

    $has = trumpf_team_has_cards($players, $teams);
    if (!$has[0] || !$has[1]) {
        trumpf_finish_team($game, $players, $has[0] ? 0 : ($has[1] ? 1 : null));
    }
    return $game['result'];
}

function trumpf_next_round(array &$game, array &$players): bool
{
    if ($game['phase'] !== 'revealed') {
        return false;
    }

    if (!trumpf_with_cards($players)) {
        trumpf_finish($game, null);
        return false;
    }
    $activeIndex = trumpf_player_index($players, $game['activePlayerId']);
    $playable = trumpf_playable($players);
    if ($activeIndex !== null && trumpf_can_play($players[$activeIndex])) {
        $chooser = $activeIndex;
    } elseif ($playable) {
        $chooser = $playable[0];
    } else {
        return false; // alle offline: die Runde wartet
    }

    $game['phase'] = 'choosing';
    $game['round']++;
    $game['activePlayerId'] = $players[$chooser]['id'];
    $game['category'] = null;
    $game['tableCards'] = [];
    $game['result'] = null;
    $game['revealEndsAt'] = null;
    return true;
}

/** Zufällige gültige Kategorie, wenn die Zugzeit abgelaufen ist. */
function trumpf_automatic_category(string $cardId): string
{
    $card = trumpf_load_deck()[$cardId] ?? [];
    $valid = [];
    foreach (array_keys(TRUMPF_CATEGORIES) as $category) {
        if (isset($card[$category]) && is_numeric($card[$category]) && $card[$category] > 0) {
            $valid[] = $category;
        }
    }
    if (!$valid) {
        return (string) array_key_first(TRUMPF_CATEGORIES);
    }
    return $valid[random_int(0, count($valid) - 1)];
}

/** Wie lange die KI „überlegt“, bevor sie wählt (je nach Stufe, pro Runde und Spieler leicht unterschiedlich). */
function ai_think_ms(string $level, string $seed): int
{
    $jitter = crc32($seed) % 1000;
    $base = ['easy' => 1800, 'medium' => 1400, 'hard' => 1000][$level] ?? 1400;
    return $base + (int) ($jitter * 1.2);
}

/**
 * Die KI wählt die Kategorie für ihre oberste Karte.
 *  - leicht: meistens zufällig (nur Werte, die die Karte hat), nur manchmal die beste
 *  - mittel: beste Kategorie im Vergleich zu allen Karten, aber mit Schwankung
 *  - schwer: beste Kategorie im Vergleich zu den Karten, die in dieser Partie wirklich im Spiel sind
 *
 * @param string[] $inPlayIds Karten-IDs, die in dieser Partie im Spiel sind
 */
function ai_choose_category(string $cardId, string $level, array $inPlayIds): string
{
    $deck = trumpf_load_deck();
    $card = $deck[$cardId] ?? null;
    $first = (string) array_key_first(TRUMPF_CATEGORIES);
    if ($card === null) {
        return $first;
    }
    $reference = $level === 'hard' && count($inPlayIds) > 1
        ? array_values(array_intersect_key($deck, array_flip($inPlayIds)))
        : array_values($deck);
    $scores = [];
    foreach (TRUMPF_CATEGORIES as $key => $rule) {
        if (!isset($card[$key]) || !is_numeric($card[$key]) || $card[$key] <= 0) {
            continue; // Karte hat hier keinen Wert (z. B. Elektroauto bei Hubraum)
        }
        $worse = 0;
        foreach ($reference as $other) {
            $worse += ($rule['direction'] === 'low' ? $other[$key] > $card[$key] : $other[$key] < $card[$key]) ? 1 : 0;
        }
        $scores[$key] = $worse / max(1, count($reference));
    }
    if (!$scores) {
        return $first;
    }
    $randomKey = static function () use ($scores) {
        $keys = array_keys($scores);
        return $keys[random_int(0, count($keys) - 1)];
    };
    if ($level === 'easy') {
        return random_int(1, 100) <= 30 ? (string) array_search(max($scores), $scores, true) : $randomKey();
    }
    if ($level === 'medium') {
        foreach ($scores as $key => $score) {
            $scores[$key] = $score + random_int(0, 55) / 100;
        }
    }
    return (string) array_search(max($scores), $scores, true);
}
