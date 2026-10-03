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
function trumpf_start_game(array &$players, int $cardsPerPlayer): array
{
    if (count($players) < 2 || count($players) > 4) {
        throw new TrumpfError('Ein Spiel benötigt 2 bis 4 Spieler.');
    }
    if (!in_array($cardsPerPlayer, [8, 16, 32], true)) {
        throw new TrumpfError('Pro Spieler sind nur 8, 16 oder 32 Karten erlaubt.');
    }

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

    return [
        'phase' => 'choosing',
        'round' => 1,
        'cardsPerPlayer' => $cardsPerPlayer,
        'activePlayerId' => $players[0]['id'],
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
