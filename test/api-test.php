<?php
// Testet die PHP-API mit dem eingebauten PHP-Server: php test/api-test.php
declare(strict_types=1);

require __DIR__ . '/../api/engine.php';
require_once __DIR__ . '/../api/push.php';
require_once __DIR__ . '/../api/accounts.php';

$failures = 0;
function check(bool $condition, string $label): void
{
    global $failures;
    echo ($condition ? '  ok   ' : '  FAIL ') . $label . "\n";
    if (!$condition) {
        $failures++;
    }
}

// --- Spiellogik -----------------------------------------------------------------------------
echo "Spiellogik\n";
$deck = trumpf_load_deck();
check(count($deck) === 400, '400 Karten geladen');
$tiers = array_count_values(array_map(fn($c) => (int) $c['raritaet'], $deck));
ksort($tiers);
check($tiers === [1 => 120, 2 => 100, 3 => 80, 4 => 60, 5 => 40], 'Seltenheit als Pyramide: 120/100/80/60/40');
$mythicOk = true;
foreach ($deck as $c) {
    if ((int) $c['raritaet'] === 5) {
        $mythicOk = $mythicOk && ($c['leistung'] >= 1500 || $c['drehmoment'] >= 1500 || $c['drehzahl'] >= 10000 || $c['preis'] >= 4000000
            || $c['hoechstgeschwindigkeit'] >= 400 || ($c['beschleunigung'] > 0 && $c['beschleunigung'] <= 2.2) || ($c['gewicht'] > 0 && $c['gewicht'] <= 1000));
    }
}
check($mythicOk, 'jede Mythic-Karte hat einen Extremwert');

$players = [['id' => 'a', 'hand' => []], ['id' => 'b', 'hand' => []]];
$game = trumpf_start_game($players, 8);
check(count($players[0]['hand']) === 8 && count($players[1]['hand']) === 8, '8 Karten pro Spieler');
check(count(array_unique(array_merge($players[0]['hand'], $players[1]['hand']))) === 16, 'alle Karten verschieden');

$players = [['id' => 'a', 'hand' => ['0001']], ['id' => 'b', 'hand' => ['0002']]];
$game = ['phase' => 'choosing', 'round' => 1, 'activePlayerId' => 'a', 'category' => null, 'tableCards' => [],
    'pot' => [], 'result' => null, 'winnerId' => null, 'turnEndsAt' => null, 'revealEndsAt' => null, 'cardsPerPlayer' => 8];
$leistungA = $deck['0001']['leistung'];
$leistungB = $deck['0002']['leistung'];
$result = trumpf_choose_category($game, $players, 'a', 'leistung');
check($leistungA === $leistungB || $result['type'] === 'gameOver', 'letzte Karten: Partie endet oder Gleichstand');

$threw = false;
try {
    $g = ['phase' => 'choosing', 'activePlayerId' => 'b'];
    $p = [];
    trumpf_choose_category($g, $p, 'a', 'leistung');
} catch (TrumpfError $e) {
    $threw = $e->getMessage() === 'Du bist noch nicht am Zug.';
}
check($threw, 'falscher Spieler darf nicht wählen');

$players = [['id' => 'a', 'hand' => ['0001', '0003']], ['id' => 'b', 'hand' => ['0002', '0004']]];
$game = ['phase' => 'choosing', 'round' => 1, 'activePlayerId' => 'a', 'category' => null, 'tableCards' => [],
    'pot' => [], 'result' => null, 'winnerId' => null, 'turnEndsAt' => null, 'revealEndsAt' => null, 'cardsPerPlayer' => 8];
$best = max($deck['0001']['leistung'], $deck['0002']['leistung']);
$result = trumpf_choose_category($game, $players, 'a', 'leistung');
if ($result['type'] === 'winner') {
    $winner = $result['winnerIds'][0];
    $idx = $winner === 'a' ? 0 : 1;
    check(count($players[$idx]['hand']) === 3 && $result['value'] === $best, 'Sieger bekommt beide Karten');
    check(trumpf_next_round($game, $players) && $game['activePlayerId'] === $winner && $game['round'] === 2, 'nächste Runde, Sieger am Zug');
}
$low = ['0001', '0002'];
$players = [['id' => 'a', 'hand' => ['0001', '0005']], ['id' => 'b', 'hand' => ['0002', '0006']]];
$game['phase'] = 'choosing'; $game['activePlayerId'] = 'a'; $game['pot'] = [];
$result = trumpf_choose_category($game, $players, 'a', 'beschleunigung');
$expect = $deck['0001']['beschleunigung'] <= $deck['0002']['beschleunigung'] ? 'a' : 'b';
if ($deck['0001']['beschleunigung'] !== $deck['0002']['beschleunigung']) {
    check($result['winnerIds'] === [$expect], 'niedriger Wert gewinnt bei Beschleunigung');
}

// Offline-Spieler setzen aus und behalten ihre Karten.
$players = [
    ['id' => 'a', 'hand' => ['0001', '0003']],
    ['id' => 'b', 'hand' => ['0002', '0004']],
    ['id' => 'c', 'hand' => ['0005', '0006'], 'away' => true],
];
$game = ['phase' => 'choosing', 'round' => 1, 'activePlayerId' => 'a', 'category' => null, 'tableCards' => [],
    'pot' => [], 'result' => null, 'winnerId' => null, 'turnEndsAt' => null, 'revealEndsAt' => null, 'pausedUntil' => null, 'cardsPerPlayer' => 8];
trumpf_choose_category($game, $players, 'a', 'leistung');
check(count($game['tableCards']) === 2 && count($players[2]['hand']) === 2, 'Abwesender legt keine Karte');
$players[1]['away'] = true;
$game['phase'] = 'choosing'; $game['activePlayerId'] = 'a';
$threw = false;
try {
    trumpf_choose_category($game, $players, 'a', 'leistung');
} catch (TrumpfError $e) {
    $threw = true;
}
check($threw, 'mit nur einem Spieler online wird nicht gespielt');

// Ganze Partien simulieren: es muss immer einen Sieger geben und keine Karte darf verloren gehen.
$allFinished = true;
$cardsKept = true;
foreach ([2, 3, 4] as $playerCount) {
    foreach ([8, 16, 32] as $perPlayer) {
        for ($run = 0; $run < 5; $run++) {
            $players = [];
            for ($n = 0; $n < $playerCount; $n++) {
                $players[] = ['id' => "p$n", 'hand' => []];
            }
            $game = trumpf_start_game($players, $perPlayer);
            $categories = array_keys(TRUMPF_CATEGORIES);
            for ($round = 0; $round < 200000 && $game['phase'] !== 'finished'; $round++) {
                trumpf_choose_category($game, $players, $game['activePlayerId'], $categories[random_int(0, count($categories) - 1)]);
                if ($game['phase'] === 'revealed') {
                    trumpf_next_round($game, $players);
                }
            }
            $total = array_sum(array_map(fn($p) => count($p['hand']), $players)) + count($game['pot']);
            $allFinished = $allFinished && $game['phase'] === 'finished' && $game['winnerId'] !== null;
            $cardsKept = $cardsKept && $total === $playerCount * $perPlayer;
        }
    }
}
check($allFinished, 'Simulation: jede Partie (2-4 Spieler, 8-32 Karten) endet mit Sieger');
check($cardsKept, 'Simulation: es gehen keine Karten verloren');

// 2 gegen 2: Teamwert, Verteilung an das Team, Zugreihenfolge A-B-A-B
echo "Teammodus\n";
$mk = static function (array $hands): array {
    $ids = ['a', 'b', 'c', 'd'];
    $players = [];
    foreach ($hands as $i => $hand) {
        $players[] = ['id' => $ids[$i], 'hand' => $hand];
    }
    return $players;
};
$players = $mk([['0001', '0005'], ['0002', '0006'], ['0003', '0007'], ['0004', '0008']]);
$teams = trumpf_team_map($players, 0);
check($teams === ['a' => 0, 'b' => 1, 'c' => 0, 'd' => 1], 'Teams: 1+3 gegen 2+4');
check(trumpf_team_map($players, 1) === ['a' => 0, 'b' => 0, 'c' => 1, 'd' => 1], 'Teams: Aufstellung 1+2 gegen 3+4');
$game = trumpf_start_game($players, 8, $teams);
check($game['teams'] === $teams, 'Spiel kennt die Teams');
$players = $mk([['0001', '0005'], ['0002', '0006'], ['0003', '0007'], ['0004', '0008']]);
$game['activePlayerId'] = 'a';
$game['lastChooser'] = [null, null];
$game['pot'] = [];
trumpf_choose_category($game, $players, 'a', 'leistung');
$vals = [];
foreach (['0001', '0002', '0003', '0004'] as $n => $id) {
    $vals[['a', 'b', 'c', 'd'][$n]] = $deck[$id]['leistung'];
}
$teamA = max($vals['a'], $vals['c']);
$teamB = max($vals['b'], $vals['d']);
if ($teamA !== $teamB) {
    $winTeam = $teamA > $teamB ? 0 : 1;
    check($game['result']['type'] === 'winner' && $game['result']['winnerTeam'] === $winTeam && (float) $game['result']['value'] === (float) max($teamA, $teamB), 'Teamwert: beste Karte des Teams entscheidet');
    $members = $winTeam === 0 ? [0, 2] : [1, 3];
    check(count($players[$members[0]]['hand']) === 3 && count($players[$members[1]]['hand']) === 3, 'Stichkarten werden auf beide im Siegerteam verteilt');
    check(($game['teams'][$game['activePlayerId']] ?? null) === 1, 'Zug wechselt zum anderen Team (A, B)');
    $first = $game['activePlayerId'];
    $game['phase'] = 'choosing';
    trumpf_choose_category($game, $players, $first, 'leistung');
    check($game['result']['type'] !== 'winner' || $game['teams'][$game['activePlayerId']] === 0 || $game['phase'] === 'finished', 'danach wieder Team A');
}
// Teammitglied ohne Karten bekommt beim Sieg wieder Karten und das Team spielt weiter
$players = $mk([['0001'], ['0002', '0006'], [], ['0004', '0008']]);
$game = trumpf_start_game($players, 8, $teams);
$players = $mk([['0001'], ['0002', '0006'], [], ['0004', '0008']]);
$game['activePlayerId'] = 'a';
trumpf_choose_category($game, $players, 'a', 'leistung');
check($game['phase'] !== 'choosing' && count($game['tableCards']) === 3, 'Spieler ohne Karten legt nicht mit');
// Team ohne Karten verliert
$players = $mk([['0001'], [], ['0003'], []]);
$game['phase'] = 'choosing';
$game['activePlayerId'] = 'a';
$game['pot'] = [];
trumpf_choose_category($game, $players, 'a', 'leistung');
check($game['phase'] === 'finished' && $game['winnerTeam'] === 0 && $game['winnerIds'] === ['a', 'c'], 'Team ohne Karten verliert, beide im Siegerteam gewinnen');
// Simulation ganzer Team-Partien
$teamsOk = true;
$cardsOk = true;
for ($run = 0; $run < 20; $run++) {
    foreach ([8, 16, 32] as $perPlayer) {
        $players = $mk([[], [], [], []]);
        $teams = trumpf_team_map($players, $run % 3);
        $game = trumpf_start_game($players, $perPlayer, $teams);
        $cats = array_keys(TRUMPF_CATEGORIES);
        for ($round = 0; $round < 100000 && $game['phase'] !== 'finished'; $round++) {
            trumpf_choose_category($game, $players, $game['activePlayerId'], $cats[random_int(0, count($cats) - 1)]);
            if ($game['phase'] === 'revealed') {
                trumpf_next_round($game, $players);
            }
        }
        $teamsOk = $teamsOk && $game['phase'] === 'finished' && count($game['winnerIds']) === 2;
        $total = array_sum(array_map(fn($p) => count($p['hand']), $players)) + count($game['pot']);
        $cardsOk = $cardsOk && $total === 4 * $perPlayer;
    }
}
check($teamsOk, 'Simulation: Team-Partien enden mit Siegerteam');
check($cardsOk, 'Simulation: im Teammodus gehen keine Karten verloren');

// Sammlung: Ziehchancen und Startkarten
echo "Sammlung\n";
$drawn = [1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0];
for ($i = 0; $i < 20000; $i++) {
    $drawn[(int) $deck[trumpf_draw_card()]['raritaet']]++;
}
check(abs($drawn[1] / 200 - 60) < 2.5 && abs($drawn[2] / 200 - 25) < 2 && abs($drawn[3] / 200 - 10) < 1.5 && abs($drawn[4] / 200 - 4) < 1 && abs($drawn[5] / 200 - 1) < 0.6, 'Ziehchancen ≈ 60/25/10/4/1 % (' . implode('/', array_map(fn($n) => round($n / 200, 1), $drawn)) . ')');
$starter = trumpf_starter_ids();
check(count($starter) === 16 && count(array_unique($starter)) === 16 && max(array_map(fn($id) => (int) $deck[$id]['raritaet'], $starter)) === 1, 'Startkarten: 16 verschiedene Common-Autos');
$scores = trumpf_card_scores();
check(count($scores) === 400 && min($scores) >= 0 && max($scores) <= 100, 'Kartenstärke 0–100 für alle Autos');
$starterRating = trumpf_deck_rating(trumpf_starter_ids());
check($starterRating < 30, "Startdeck ist schwach (Wertung $starterRating)");
$balanced = trumpf_balanced_deck(50, 32);
check(count($balanced) === 32 && abs(trumpf_deck_rating($balanced) - 50) <= 1, 'ausgeglichenes Deck trifft die Zielwertung');
$pickedRandom = trumpf_random_from_owned(['0001' => 2, '0002' => 1], 5, ['0001']);
check(count($pickedRandom) === 2 && count(array_keys($pickedRandom, '0001', true)) <= 1, 'Zufallsauswahl nimmt Duplikate nur so oft wie vorhanden');

// --- API mit echtem Server --------------------------------------------------------------------
echo "API\n";
$dataDir = sys_get_temp_dir() . '/trumpf-test-' . getmypid();
mkdir($dataDir, 0775, true);
$port = random_int(20000, 40000);
$root = realpath(__DIR__ . '/..');
$server = proc_open(
    ['php', '-S', "127.0.0.1:$port", '-t', $root],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
    $root,
    array_merge($_ENV, ['TRUMPF_DATA_DIR' => $dataDir, 'TRUMPF_DB_DSN' => "sqlite:$dataDir/accounts.sqlite", 'TRUMPF_PUSH_ALLOW_HTTP' => '1', 'PATH' => getenv('PATH')])
);
for ($i = 0; $i < 50; $i++) {
    if (@fsockopen('127.0.0.1', $port)) {
        break;
    }
    usleep(100000);
}

$currentRoom = null;
function call(int $port, array $body): array
{
    global $currentRoom;
    if ($currentRoom !== null && !array_key_exists('room', $body)) {
        $body['room'] = $currentRoom;
    }
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => json_encode($body),
        'ignore_errors' => true,
    ]]);
    $response = file_get_contents("http://127.0.0.1:$port/api/index.php", false, $context);
    return json_decode((string) $response, true) ?? ['ok' => false, 'raw' => $response];
}

$mockPort = $port + 2;
$mock = proc_open(
    ['php', '-S', "127.0.0.1:$mockPort", __DIR__ . '/push-mock.php'],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $mockPipes,
    $root,
    array_merge($_ENV, ['TRUMPF_DATA_DIR' => $dataDir, 'PATH' => getenv('PATH')])
);
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $mockPort); $i++) {
    usleep(100000);
}

try {
    check(call($port, ['action' => 'ping'])['ok'] === true, 'ping');
    $all = call($port, ['action' => 'cards']);
    check($all['ok'] && $all['total'] === 400 && !isset($all['cards']) && isset($all['categories']['leistung']), 'öffentlich nur Kategorien und Gesamtzahl, keine Autoliste');

    $a = call($port, ['action' => 'join', 'name' => '  Ada  ', 'create' => true]);
    $currentRoom = $a['room'];
    check(preg_match('/^[A-Z0-9]{5}$/', (string) $currentRoom) === 1 && $a['state']['sessionId'] === $currentRoom, 'neue Session bekommt eine ID');
    check(call($port, ['action' => 'join', 'name' => 'Zed', 'room' => 'NOPE1'])['ok'] === false, 'unbekannte Session-ID wird abgelehnt');
    $other = call($port, ['action' => 'join', 'name' => 'Ada', 'create' => true, 'room' => null]);
    check($other['ok'] && $other['room'] !== $currentRoom && count($other['state']['players']) === 1, 'zweite Session ist unabhängig (gleicher Name erlaubt)');
    check($a['ok'] && !empty($a['token']), 'Ada tritt bei');
    check(call($port, ['action' => 'join', 'name' => 'ada'])['ok'] === false, 'doppelter Name wird abgelehnt');
    $b = call($port, ['action' => 'join', 'name' => 'Ben']);
    check($b['ok'], 'Ben tritt bei');
    check($a['state']['players'][0]['name'] === 'Ada', 'Name wird bereinigt');

    $poll = call($port, ['action' => 'state', 'token' => $a['token']]);
    check(count($poll['state']['players']) === 2 && $poll['state']['hostId'] === $a['state']['selfId'], 'Lobby mit zwei Spielern, Ada ist Host');
    $same = call($port, ['action' => 'state', 'token' => $a['token'], 'since' => $poll['version']]);
    check(!empty($same['unchanged']), 'unveränderter Zustand wird nicht erneut gesendet');

    check(call($port, ['action' => 'start', 'token' => $b['token']])['ok'] === false, 'nur der Host darf starten');
    check(call($port, ['action' => 'setCards', 'token' => $a['token'], 'count' => 7])['ok'] === false, 'ungültige Kartenzahl');
    $set = call($port, ['action' => 'setCards', 'token' => $a['token'], 'count' => 8]);
    check($set['ok'] && $set['state']['cardsPerPlayer'] === 8, 'Kartenzahl 8');

    $start = call($port, ['action' => 'start', 'token' => $a['token']]);
    check($start['ok'] && $start['state']['game']['phase'] === 'choosing', 'Spiel startet');
    $sa = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    $sb = call($port, ['action' => 'state', 'token' => $b['token']])['state'];
    check(count($sa['game']['ownHand']) === 8 && count($sb['game']['ownHand']) === 8, 'jeder hat 8 Karten');
    check($sa['game']['ownCard']['c_id'] !== $sb['game']['ownCard']['c_id'], 'Spieler sehen verschiedene Karten');
    check($sa['game']['tableCards'] === [], 'vor der Wahl liegt nichts auf dem Tisch');
    check($sa['game']['turnEndsAt'] > (int) (microtime(true) * 1000), 'Zugzeit läuft');
    check(call($port, ['action' => 'join', 'name' => 'Cleo'])['ok'] === false, 'laufendes Spiel: kein Beitritt');

    $activeIsA = $sa['game']['activePlayerId'] === $sa['selfId'];
    $inactive = $activeIsA ? $b : $a;
    $active = $activeIsA ? $a : $b;
    check(call($port, ['action' => 'choose', 'token' => $inactive['token'], 'category' => 'leistung'])['ok'] === false, 'nur der aktive Spieler wählt');
    $played = call($port, ['action' => 'choose', 'token' => $active['token'], 'category' => 'leistung']);
    check($played['ok'] && $played['state']['game']['phase'] === 'revealed', 'Kategorie gewählt, Karten aufgedeckt');
    check(count($played['state']['game']['tableCards']) === 2, 'zwei Karten auf dem Tisch');

    // Aufdeck-Zeit abgelaufen -> nächste Runde
    $file = "$dataDir/room_$currentRoom.json";
    $room = json_decode((string) file_get_contents($file), true);
    $room['game']['revealEndsAt'] = (int) (microtime(true) * 1000) - 1;
    file_put_contents($file, json_encode($room));
    $next = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    check($next['game']['phase'] === 'choosing' && $next['game']['round'] === 2, 'nach Ablauf geht es in Runde 2');

    // Zugzeit abgelaufen -> automatische Kategorie
    $room = json_decode((string) file_get_contents($file), true);
    $room['game']['turnEndsAt'] = (int) (microtime(true) * 1000) - 1;
    file_put_contents($file, json_encode($room));
    $auto = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    check($auto['game']['phase'] === 'revealed', 'Zugzeit abgelaufen: Karten werden automatisch aufgedeckt');

    // Offline-Erkennung und Wiederverbinden
    $room = json_decode((string) file_get_contents($file), true);
    foreach ($room['players'] as $i => $p) {
        if ($p['token'] === $b['token']) {
            $room['players'][$i]['lastSeen'] -= 60000;
        }
    }
    file_put_contents($file, json_encode($room));
    $seen = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    $benOffline = array_values(array_filter($seen['players'], fn($p) => $p['name'] === 'Ben'))[0]['connected'] === false;
    check($benOffline, 'Ben wird offline angezeigt');
    $back = call($port, ['action' => 'join', 'token' => $b['token'], 'name' => 'Ben']);
    check($back['ok'] && $back['reconnected'] === true && $back['state']['game'] !== null, 'Ben verbindet sich wieder und behält seine Karten');

    // --- Mitspieler verlassen das Spiel -----------------------------------------------------
    $setSeen = function (array $tokens, int $offsetMs) use (&$file) {
        $room = json_decode((string) file_get_contents($file), true);
        foreach ($room['players'] as $i => $p) {
            if (in_array($p['token'], $tokens, true)) {
                $room['players'][$i]['lastSeen'] = (int) (microtime(true) * 1000) + $offsetMs;
            }
        }
        file_put_contents($file, json_encode($room));
    };
    $setField = function (callable $change) use (&$file) {
        $room = json_decode((string) file_get_contents($file), true);
        $change($room);
        file_put_contents($file, json_encode($room));
    };

    // Zu zweit: geht einer, pausiert das Spiel; kommt er zurück, läuft es weiter.
    $setSeen([$b['token']], -60000);
    $paused = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    check($paused['game']['pausedUntil'] > (int) (microtime(true) * 1000), 'allein: Spiel pausiert mit Countdown');
    check($paused['game']['turnEndsAt'] === null, 'allein: Zugzeit läuft nicht weiter');
    $activeA = call($port, ['action' => 'choose', 'token' => $a['token'], 'category' => 'leistung']);
    check($activeA['ok'] === false, 'allein: es wird nicht automatisch weitergespielt');
    call($port, ['action' => 'join', 'token' => $b['token'], 'name' => 'Ben']);
    $resumed = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    check($resumed['game']['pausedUntil'] === null, 'Mitspieler zurück: Pause endet');
    check($resumed['game']['phase'] === 'choosing' ? $resumed['game']['turnEndsAt'] !== null : $resumed['game']['revealEndsAt'] !== null, 'Mitspieler zurück: Zeit läuft wieder');

    // Nach einer Minute ohne Rückkehr endet die Partie, der verbliebene Spieler gewinnt.
    $setSeen([$b['token']], -60000);
    call($port, ['action' => 'state', 'token' => $a['token']]);
    $setField(function (&$room) { $room['game']['pausedUntil'] = (int) (microtime(true) * 1000) - 1; });
    $over = call($port, ['action' => 'state', 'token' => $a['token']])['state'];
    check($over['status'] === 'finished' && $over['game']['phase'] === 'finished', 'nach 1 Minute ohne Rückkehr endet die Partie');
    check($over['game']['winnerId'] === $over['selfId'] && ($over['game']['result']['reason'] ?? '') === 'abandoned', 'der verbliebene Spieler gewinnt');

    // Zu dritt: einer geht, die anderen spielen zu zweit weiter.
    unlink($file);
    $ada = call($port, ['action' => 'join', 'name' => 'Ada', 'create' => true, 'room' => null]);
    $currentRoom = $ada['room'];
    $file = "$dataDir/room_$currentRoom.json";
    $ben = call($port, ['action' => 'join', 'name' => 'Ben']);
    $cleo = call($port, ['action' => 'join', 'name' => 'Cleo']);
    call($port, ['action' => 'setCards', 'token' => $ada['token'], 'count' => 8]);
    call($port, ['action' => 'start', 'token' => $ada['token']]);
    $setSeen([$cleo['token']], -60000);
    $three = call($port, ['action' => 'state', 'token' => $ada['token']])['state'];
    $cleoRow = array_values(array_filter($three['players'], fn($p) => $p['name'] === 'Cleo'))[0];
    check($three['game']['pausedUntil'] === null && $three['game']['phase'] === 'choosing', 'zu dritt: einer geht, zu zweit geht es weiter');
    check($cleoRow['connected'] === false && $three['game']['activePlayerId'] !== $cleoRow['id'], 'der Abwesende ist nicht am Zug');
    $mover = $three['game']['activePlayerId'] === $three['selfId'] ? $ada : $ben;
    $trick = call($port, ['action' => 'choose', 'token' => $mover['token'], 'category' => 'leistung']);
    check($trick['ok'] && count($trick['state']['game']['tableCards']) === 2, 'zu zweit: nur zwei Karten auf dem Tisch');
    $cleoAfter = array_values(array_filter($trick['state']['players'], fn($p) => $p['name'] === 'Cleo'))[0];
    check($cleoAfter['cardCount'] === 8, 'Karten des Abwesenden bleiben unangetastet');

    // Der Abwesende kommt zurück und ist in der nächsten Runde wieder dabei.
    call($port, ['action' => 'join', 'token' => $cleo['token'], 'name' => 'Cleo']);
    $setField(function (&$room) { $room['game']['revealEndsAt'] = (int) (microtime(true) * 1000) - 1; });
    $round2 = call($port, ['action' => 'state', 'token' => $ada['token']])['state'];
    $mover2 = $round2['game']['activePlayerId'];
    $tokenById = [$round2['selfId'] => $ada['token']];
    foreach ([$ben, $cleo] as $pl) {
        $st = call($port, ['action' => 'state', 'token' => $pl['token']])['state'];
        $tokenById[$st['selfId']] = $pl['token'];
    }
    $second = call($port, ['action' => 'choose', 'token' => $tokenById[$mover2], 'category' => 'leistung']);
    check($second['ok'] && count($second['state']['game']['tableCards']) === 3, 'nach der Rückkehr spielen wieder alle drei');

    // KI-Stärke: Karten kommen aus dem Spielpool (den kennt nur „Schwer“), dort muss Schwer ≥ Mittel > Leicht gewinnen
    $deckAll = trumpf_load_deck();
    $ids = array_keys($deckAll);
    $inPlay = array_slice($ids, 0, 64);
    mt_srand(7);
    $rates = [];
    foreach (['easy', 'medium', 'hard'] as $level) {
        $wins = 0;
        $games = 3000;
        for ($i = 0; $i < $games; $i++) {
            $mine = $inPlay[mt_rand(0, count($inPlay) - 1)];
            $theirs = $inPlay[mt_rand(0, count($inPlay) - 1)];
            if ($mine === $theirs) {
                continue;
            }
            $category = ai_choose_category($mine, $level, $inPlay);
            $low = TRUMPF_CATEGORIES[$category]['direction'] === 'low';
            $mineValue = $deckAll[$mine][$category];
            $theirValue = $deckAll[$theirs][$category];
            $wins += ($low ? $mineValue < $theirValue : $mineValue > $theirValue) ? 1 : 0;
        }
        $rates[$level] = $wins / $games;
    }
    check($rates['easy'] < $rates['medium'] && $rates['medium'] <= $rates['hard'] + 0.02 && $rates['hard'] > 0.75, sprintf('KI-Stärke wächst mit der Stufe (leicht %.0f %%, mittel %.0f %%, schwer %.0f %%)', 100 * $rates['easy'], 100 * $rates['medium'], 100 * $rates['hard']));
    $electric = array_values(array_filter($deckAll, fn($c) => $c['hubraum'] == 0 || $c['drehzahl'] == 0))[0];
    $chosen = [];
    for ($i = 0; $i < 60; $i++) {
        $chosen[ai_choose_category($electric['c_id'], 'easy', [])] = true;
    }
    check(!isset($chosen['hubraum']) && !isset($chosen['drehzahl']), 'KI wählt keine Kategorie, die die Karte nicht hat');

    // --- Spiel gegen die KI ---------------------------------------------------------------------
    $currentRoom = null;
    check(call($port, ['action' => 'join', 'name' => 'Dev', 'room' => '123456'])['ok'] === false, 'die alte Test-Session 123456 gibt es nicht mehr');
    check(!file_exists("$dataDir/room_123456.json"), 'es wird keine Datei für 123456 angelegt');
    file_put_contents("$dataDir/room_123456.json", json_encode(['version' => 1, 'status' => 'lobby', 'players' => [], 'hostId' => null, 'cardsPerPlayer' => 8, 'game' => null, 'idleSince' => null]));
    check(call($port, ['action' => 'join', 'name' => 'Dev', 'room' => '123456'])['ok'] === false, 'auch eine alte Datei room_123456.json wird ignoriert');
    @unlink("$dataDir/room_123456.json");
    $solo = call($port, ['action' => 'join', 'name' => 'Andi', 'create' => true, 'ai' => ['difficulty' => 'hard', 'opponents' => 2]]);
    $currentRoom = $solo['room'];
    $names = array_map(fn($p) => $p['name'], $solo['state']['players']);
    check($solo['ok'] && $names === ['Andi', 'KI Schwer 1', 'KI Schwer 2'] && $solo['state']['solo'] === true && $solo['state']['aiLevel'] === 'hard', 'KI-Spiel: Mensch plus zwei KI-Gegner (' . implode(', ', $names) . ')');
    check($solo['state']['hostId'] === $solo['state']['selfId'], 'der Mensch ist Host, nicht die KI');
    check(count(array_filter($solo['state']['players'], fn($p) => $p['isBot'] && $p['connected'] && $p['difficulty'] === 'hard')) === 2, 'KI-Spieler sind online und kennen ihre Stufe');
    check(call($port, ['action' => 'join', 'name' => 'Fremder', 'room' => $solo['room']])['ok'] === false, 'in ein KI-Spiel kann niemand sonst beitreten');
    $badLevel = call($port, ['action' => 'join', 'name' => 'Bob', 'create' => true, 'ai' => ['difficulty' => 'gott', 'opponents' => 9]]);
    $currentRoom = $badLevel['room'];
    check($badLevel['ok'] && count($badLevel['state']['players']) === 4 && $badLevel['state']['aiLevel'] === 'medium', 'ungültige Stufe wird Mittel, höchstens drei Gegner');
    $leave = call($port, ['action' => 'leave', 'token' => $badLevel['token']]);
    check(!file_exists("$dataDir/room_{$badLevel['room']}.json"), 'KI-Raum wird beim Verlassen der Lobby gelöscht');

    foreach (['easy' => 'KI Leicht', 'medium' => 'KI Mittel'] as $level => $label) {
        $one = call($port, ['action' => 'join', 'name' => 'Cleo', 'create' => true, 'ai' => ['difficulty' => $level, 'opponents' => 1]]);
        check($one['ok'] && $one['state']['players'][1]['name'] === $label, "Stufe $level: Gegner heißt $label");
    }

    $currentRoom = $solo['room'];
    call($port, ['action' => 'setCards', 'token' => $solo['token'], 'count' => 8]);
    $go = call($port, ['action' => 'start', 'token' => $solo['token']]);
    check($go['ok'] && $go['state']['game']['phase'] === 'choosing' && count($go['state']['game']['ownHand']) === 8, 'KI-Spiel starten');
    $first = $go['state']['game']['activePlayerId'];
    $activeIsBot = (bool) array_filter($go['state']['players'], fn($p) => $p['id'] === $first && $p['isBot']);
    if ($activeIsBot) {
        usleep(3400000);
        $after = call($port, ['action' => 'state', 'token' => $solo['token']])['state'];
        check($after['game']['phase'] === 'revealed' && count($after['game']['tableCards']) === 3, 'die KI wählt von selbst (' . ($after['game']['category'] ?? '?') . ')');
    } else {
        $played = call($port, ['action' => 'choose', 'token' => $solo['token'], 'category' => 'leistung']);
        check($played['ok'] && $played['state']['game']['phase'] === 'revealed', 'Mensch wählt, KI-Karten werden aufgedeckt');
    }

    // Chat
    $chatA = call($port, ['action' => 'join', 'name' => 'ChatA', 'create' => true]);
    $chatB = call($port, ['action' => 'join', 'name' => 'ChatB', 'room' => $chatA['room']]);
    $currentRoom = $chatA['room'];
    $sent = call($port, ['action' => 'chat', 'token' => $chatA['token'], 'text' => "  Hallo   zusammen \n "]);
    check($sent['ok'] && count($sent['state']['chat']) === 1 && $sent['state']['chat'][0]['text'] === 'Hallo zusammen' && $sent['state']['chat'][0]['name'] === 'ChatA', 'Chat: Nachricht wird gespeichert und bereinigt');
    $seen = call($port, ['action' => 'state', 'token' => $chatB['token']]);
    check(count($seen['state']['chat']) === 1 && $seen['state']['chat'][0]['playerId'] === $sent['state']['selfId'], 'Chat: der andere Spieler sieht die Nachricht');
    check(call($port, ['action' => 'chat', 'token' => $chatA['token'], 'text' => 'zu schnell'])['ok'] === false, 'Chat: Schnellfeuer wird gebremst');
    usleep(800000);
    check(call($port, ['action' => 'chat', 'token' => $chatB['token'], 'text' => '   '])['ok'] === false, 'Chat: leere Nachricht wird abgelehnt');
    $long = call($port, ['action' => 'chat', 'token' => $chatB['token'], 'text' => str_repeat('ä', 500)]);
    check($long['ok'] && mb_strlen(end($long['state']['chat'])['text']) === 200, 'Chat: Nachricht auf 200 Zeichen gekürzt');
    check(call($port, ['action' => 'chat', 'token' => 'falsch', 'text' => 'hi'])['ok'] === false, 'Chat: ohne Teilnahme nicht möglich');
    $roomFile = "$dataDir/room_{$chatA['room']}.json";
    $chatRoom = json_decode((string) file_get_contents($roomFile), true);
    for ($i = 0; $i < 80; $i++) {
        $chatRoom['chat'][] = ['id' => 1000 + $i, 'playerId' => 'x', 'name' => 'x', 'text' => 'y', 'at' => 0];
    }
    $chatRoom['chatSeq'] = 2000;
    file_put_contents($roomFile, json_encode($chatRoom));
    usleep(800000);
    $capped = call($port, ['action' => 'chat', 'token' => $chatA['token'], 'text' => 'letzte']);
    $storedChat = json_decode((string) file_get_contents($roomFile), true)['chat'];
    check(count($storedChat) === 60 && count($capped['state']['chat']) === 50 && end($capped['state']['chat'])['text'] === 'letzte', 'Chat: Verlauf ist begrenzt (60 gespeichert, 50 ausgeliefert)');
    $soloChat = call($port, ['action' => 'join', 'name' => 'Solo', 'create' => true, 'ai' => ['difficulty' => 'hard', 'opponents' => 1]]);
    $currentRoom = $soloChat['room'];
    check(call($port, ['action' => 'chat', 'token' => $soloChat['token'], 'text' => 'hallo?'])['ok'] === false, 'Chat: im Spiel gegen die KI gibt es keinen Chat');
    $currentRoom = $a['room'];

    check(call($port, ['action' => 'state', 'token' => 'falsch'])['code'] === 'not_joined', 'unbekannter Token');
    check(call($port, ['action' => 'unsinn', 'token' => $a['token']])['ok'] === false, 'unbekannte Aktion');
    // Konten: registrieren, anmelden, Statistik nach Spielende
    $reg = call($port, ['action' => 'register', 'name' => 'Ana', 'password' => 'geheim']);
    check($reg['ok'] && strlen($reg['authToken']) === 48 && $reg['account']['level'] === 1, 'Konto registrieren');
    check(call($port, ['action' => 'register', 'name' => 'ana', 'password' => 'x'])['ok'] === false, 'Name nur einmal registrierbar');
    check(call($port, ['action' => 'login', 'name' => 'Ana', 'password' => 'falsch'])['ok'] === false, 'falsches Passwort wird abgelehnt');
    $login = call($port, ['action' => 'login', 'name' => 'ANA', 'password' => 'geheim']);
    check($login['ok'] && $login['authToken'] === $reg['authToken'] && $login['account']['name'] === 'Ana', 'Anmelden (Groß-/Kleinschreibung egal)');
    check(call($port, ['action' => 'join', 'name' => 'Ana', 'create' => true])['ok'] === false, 'Gast darf keinen registrierten Namen nehmen');
    $ana = call($port, ['action' => 'join', 'name' => 'egal', 'authToken' => $reg['authToken'], 'create' => true]);
    check($ana['ok'] && $ana['state']['players'][0]['name'] === 'Ana' && $ana['state']['players'][0]['level'] === 1, 'angemeldet beitreten: Kontoname und Level');
    $bea = call($port, ['action' => 'join', 'name' => 'Bea', 'room' => $ana['room']]);
    call($port, ['action' => 'start', 'token' => $ana['token'], 'room' => $ana['room']]);
    $file = "$dataDir/room_{$ana['room']}.json";
    $room = json_decode((string) file_get_contents($file), true);
    $room['status'] = 'finished';
    $room['game']['phase'] = 'finished';
    $room['game']['winnerId'] = $room['players'][0]['id'];
    $room['stats']['players'][$room['players'][0]['id']] = ['tricks' => 3, 'streak' => 0, 'best' => 2, 'outRound' => null];
    file_put_contents($file, json_encode($room));
    $done = call($port, ['action' => 'state', 'token' => $ana['token'], 'room' => $ana['room']]);
    call($port, ['action' => 'state', 'token' => $bea['token'], 'room' => $ana['room']]);
    $award = $done['state']['game']['xpAwards'][$done['state']['selfId']] ?? null;
    check($award !== null && $award['xp'] === 130 && $award['level'] === 2, 'Sieg bringt XP (100 + 3 Stiche) und Levelaufstieg');
    $profile = call($port, ['action' => 'profile', 'authToken' => $reg['authToken']]);
    check($profile['ok'] && $profile['account']['gamesPlayed'] === 1 && $profile['account']['wins'] === 1 && $profile['account']['winRate'] === 100 && $profile['account']['xp'] === 130, 'Statistik wird genau einmal gespeichert');
    check(call($port, ['action' => 'profile', 'authToken' => str_repeat('a', 48)])['ok'] === false, 'unbekanntes Anmelde-Token');

    // Gegen die KI: Leicht 20 %, Mittel 50 %, Schwer volle XP
    foreach (['easy' => 20, 'medium' => 50, 'hard' => 100] as $level => $expected) {
        $acc = call($port, ['action' => 'register', 'name' => 'Xp' . $level, 'password' => 'pw']);
        $g = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $acc['authToken'], 'create' => true, 'ai' => ['difficulty' => $level, 'opponents' => 1]]);
        call($port, ['action' => 'start', 'token' => $g['token'], 'room' => $g['room']]);
        $gameFile = "$dataDir/room_{$g['room']}.json";
        $gameData = json_decode((string) file_get_contents($gameFile), true);
        $gameData['status'] = 'finished';
        $gameData['game']['phase'] = 'finished';
        $gameData['game']['winnerId'] = $gameData['players'][0]['id'];
        file_put_contents($gameFile, json_encode($gameData));
        call($port, ['action' => 'state', 'token' => $g['token'], 'room' => $g['room']]);
        $p = call($port, ['action' => 'profile', 'authToken' => $acc['authToken']])['account'];
        check($p['xp'] === $expected && $p['gamesPlayed'] === 1 && $p['wins'] === 1, "KI $level: Sieg bringt $expected XP, das Spiel zählt trotzdem");
    }

    // Siegesserie: aktuelle Serie und Rekord
    $anaProfile = call($port, ['action' => 'profile', 'authToken' => $reg['authToken']])['account'];
    check($anaProfile['currentStreak'] === 1 && $anaProfile['bestStreak'] === 1, 'Sieg startet eine Siegesserie');
    $hardAcc = call($port, ['action' => 'login', 'name' => 'Xphard', 'password' => 'pw']);
    $finish = function (string $winner) use ($port, $hardAcc, $dataDir) {
        $g = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $hardAcc['authToken'], 'create' => true, 'ai' => ['difficulty' => 'hard', 'opponents' => 1]]);
        call($port, ['action' => 'start', 'token' => $g['token'], 'room' => $g['room']]);
        $file = "$dataDir/room_{$g['room']}.json";
        $data = json_decode((string) file_get_contents($file), true);
        $data['status'] = 'finished';
        $data['game']['phase'] = 'finished';
        $data['game']['winnerId'] = $data['players'][$winner === 'me' ? 0 : 1]['id'];
        file_put_contents($file, json_encode($data));
        call($port, ['action' => 'state', 'token' => $g['token'], 'room' => $g['room']]);
        return call($port, ['action' => 'profile', 'authToken' => $hardAcc['authToken']])['account'];
    };
    $finish('me');
    $streak = $finish('me');
    check($streak['currentStreak'] === 3 && $streak['bestStreak'] === 3, 'drei Siege am Stück: Serie 3, Rekord 3');
    $streak = $finish('bot');
    check($streak['currentStreak'] === 0 && $streak['bestStreak'] === 3, 'Niederlage: Serie 0, Rekord bleibt 3');

    // Rangliste: Top 10 nach XP
    $board = call($port, ['action' => 'leaderboard']);
    $xps = array_map(fn($p) => $p['xp'], $board['players'] ?? []);
    $sorted = $xps;
    rsort($sorted);
    check($board['ok'] && count($board['players']) <= 10 && $xps === $sorted && $board['players'][0]['name'] === 'Xphard', 'Rangliste sortiert nach XP (' . implode(', ', array_map(fn($p) => $p['name'] . ' ' . $p['xp'], $board['players'])) . ')');
    check(!isset($board['players'][0]['password']) && !isset($board['players'][0]['auth_token']), 'Rangliste ohne Passwörter');
    for ($i = 0; $i < 12; $i++) {
        call($port, ['action' => 'register', 'name' => "Rang$i", 'password' => 'pw']);
    }
    check(count(call($port, ['action' => 'leaderboard'])['players']) === 10, 'Rangliste zeigt höchstens 10 Spieler');
    $pp = call($port, ['action' => 'playerProfile', 'name' => 'ana']);
    check($pp['ok'] && $pp['account']['name'] === 'Ana' && $pp['account']['rank'] === 2 && $pp['account']['players'] >= 16 && !isset($pp['account']['password']), 'Spielerprofil mit Rangplatz (Ana: Platz ' . ($pp['account']['rank'] ?? '?') . ')');
    $last = call($port, ['action' => 'playerProfile', 'name' => 'Rang11']);
    check($last['ok'] && $last['account']['rank'] === $last['account']['players'], 'Rangplatz: Spieler ohne XP, zuletzt angemeldet, ist Letzter');
    check(call($port, ['action' => 'playerProfile', 'name' => 'Niemand'])['ok'] === false, 'Spielerprofil: unbekannter Name');
    $own = call($port, ['action' => 'profile', 'authToken' => $reg['authToken']]);
    check($own['account']['rank'] === 2, 'eigenes Profil enthält den Rangplatz');

    // Online-Status, Einladungen und Push
    $inv1 = call($port, ['action' => 'register', 'name' => 'Gastgeber', 'password' => 'pw']);
    $inv2 = call($port, ['action' => 'register', 'name' => 'Eingeladene', 'password' => 'pw']);
    $inv3 = call($port, ['action' => 'register', 'name' => 'Fremde', 'password' => 'pw']);
    call($port, ['action' => 'friendAdd', 'authToken' => $inv1['authToken'], 'name' => 'Eingeladene']);
    call($port, ['action' => 'friendAccept', 'authToken' => $inv2['authToken'], 'name' => 'Gastgeber']);
    $friendRows = call($port, ['action' => 'friends', 'authToken' => $inv1['authToken']])['friends'];
    check($friendRows[0]['online'] === false, 'Freund ohne Lebenszeichen ist off');
    check(call($port, ['action' => 'heartbeat', 'authToken' => $inv2['authToken']])['ok'] === true, 'Heartbeat funktioniert');
    $friendRows = call($port, ['action' => 'friends', 'authToken' => $inv1['authToken']])['friends'];
    check($friendRows[0]['online'] === true, 'Freund mit Heartbeat ist on');
    check(call($port, ['action' => 'heartbeat', 'authToken' => 'zzz'])['code'] === 'logged_out', 'Heartbeat ohne Anmeldung');

    $currentRoom = null;
    $host = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $inv1['authToken'], 'create' => true]);
    $currentRoom = $host['room'];
    check(call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Fremde'])['ok'] === false, 'Einladen: nur Freunde');
    check(call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Niemand'])['ok'] === false, 'Einladen: unbekannter Spieler');
    $guest = call($port, ['action' => 'join', 'name' => 'Gast', 'room' => $host['room']]);
    check(call($port, ['action' => 'invite', 'token' => $guest['token'], 'name' => 'Eingeladene'])['ok'] === false, 'Einladen: Gäste ohne Konto dürfen nicht einladen');

    // Push-Abo der Eingeladenen (Gerät im Test: eigenes Schlüsselpaar)
    $device = push_new_key_pair();
    $authSecret = random_bytes(16);
    $keyReply = call($port, ['action' => 'pushKey', 'authToken' => $inv2['authToken']]);
    check($keyReply['ok'] && strlen(push_b64url_decode($keyReply['key'])) === 65, 'Push: Server liefert seinen öffentlichen Schlüssel');
    $subscribe = fn(string $endpoint) => call($port, ['action' => 'pushSubscribe', 'authToken' => $inv2['authToken'], 'subscription' => ['endpoint' => $endpoint, 'keys' => ['p256dh' => push_b64url($device['public']), 'auth' => push_b64url($authSecret)]]]);
    check($subscribe('ftp://evil')['ok'] === false, 'Push: ungültiger Endpunkt wird abgelehnt');
    check($subscribe("http://127.0.0.1:$mockPort/ok")['ok'] === true, 'Push: Abo speichern');

    $sent = call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Eingeladene']);
    check($sent['ok'] === true && $sent['pushed'] === 1, 'Einladen: Freund wird eingeladen und Push zugestellt');
    check(call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Eingeladene'])['ok'] === false, 'Einladen: nicht doppelt');

    // Push beim „Gerät“ entschlüsseln (Gegenseite nach RFC 8291) und VAPID prüfen
    $last = json_decode((string) file_get_contents("$dataDir/push-last.json"), true);
    $raw = base64_decode($last['body']);
    $salt = substr($raw, 0, 16);
    $idLen = ord($raw[20]);
    $serverPublic = substr($raw, 21, $idLen);
    $encrypted = substr($raw, 21 + $idLen);
    $deviceKey = openssl_pkey_get_private($device['pem']);
    $shared = openssl_pkey_derive(push_public_key_resource($serverPublic), $deviceKey, 32);
    $ikm = hash_hkdf('sha256', $shared, 32, "WebPush: info\0" . $device['public'] . $serverPublic, $authSecret);
    $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
    $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
    $plain = openssl_decrypt(substr($encrypted, 0, -16), 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, substr($encrypted, -16));
    $message = $plain === false ? [] : json_decode(rtrim($plain, "\x02"), true);
    check(($message['title'] ?? '') === 'Einladung von Gastgeber' && ($message['url'] ?? '') === '/', 'Push: Nachricht lässt sich beim Gerät entschlüsseln (' . ($message['title'] ?? 'Fehler') . ')');
    check($last['encoding'] === 'aes128gcm' && substr($raw, 16, 4) === pack('N', 4096), 'Push: aes128gcm-Kopf stimmt');
    preg_match('/^vapid t=([^,]+), k=(.+)$/', $last['authorization'], $vapid);
    [$jwtHead, $jwtClaims, $jwtSig] = explode('.', $vapid[1]);
    $rawSig = push_b64url_decode($jwtSig);
    $derInt = fn(string $n) => "\x02" . chr(strlen(ltrim($n, "\0") . '') + ((ord(ltrim($n, "\0")[0] ?? "\0") & 0x80) ? 1 : 0)) . ((ord(ltrim($n, "\0")[0] ?? "\0") & 0x80) ? "\0" : '') . ltrim($n, "\0");
    $derBody = $derInt(substr($rawSig, 0, 32)) . $derInt(substr($rawSig, 32));
    $derSig = "\x30" . chr(strlen($derBody)) . $derBody;
    $claims = json_decode(push_b64url_decode($jwtClaims), true);
    check(openssl_verify("$jwtHead.$jwtClaims", $derSig, push_public_key_resource(push_b64url_decode($vapid[2])), OPENSSL_ALGO_SHA256) === 1 && $claims['aud'] === "http://127.0.0.1:$mockPort" && $claims['exp'] > time(), 'Push: VAPID-Signatur ist gültig');
    check(push_b64url_decode($vapid[2]) === push_b64url_decode($keyReply['key']), 'Push: VAPID-Schlüssel passt zum ausgelieferten Schlüssel');

    // Posteingang, Ablehnen, Beitreten
    $box = call($port, ['action' => 'heartbeat', 'authToken' => $inv2['authToken']]);
    check(count($box['invites']) === 1 && $box['invites'][0]['from'] === 'Gastgeber' && $box['invites'][0]['room'] === $host['room'], 'Einladung erscheint im Postfach');
    check(call($port, ['action' => 'heartbeat', 'authToken' => $inv3['authToken']])['invites'] === [], 'andere sehen die Einladung nicht');
    $declined = call($port, ['action' => 'inviteDecline', 'authToken' => $inv2['authToken'], 'id' => $box['invites'][0]['id']]);
    check($declined['ok'] && $declined['invites'] === [], 'Einladung ablehnen');
    call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Eingeladene']);
    $box = call($port, ['action' => 'heartbeat', 'authToken' => $inv2['authToken']]);
    check(count($box['invites']) === 1, 'neu einladen nach dem Ablehnen');
    $joined = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $inv2['authToken'], 'room' => $host['room']]);
    check($joined['ok'] && count($joined['state']['players']) === 3, 'Per Einladung beitreten');
    check(call($port, ['action' => 'heartbeat', 'authToken' => $inv2['authToken']])['invites'] === [], 'Einladung verschwindet nach dem Beitritt');
    call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Fremde']);

    // Einladung zu gestarteter Lobby verfällt; totes Push-Abo wird gelöscht
    $inv4 = call($port, ['action' => 'register', 'name' => 'Vierte', 'password' => 'pw']);
    call($port, ['action' => 'friendAdd', 'authToken' => $inv1['authToken'], 'name' => 'Vierte']);
    call($port, ['action' => 'friendAccept', 'authToken' => $inv4['authToken'], 'name' => 'Gastgeber']);
    call($port, ['action' => 'pushSubscribe', 'authToken' => $inv4['authToken'], 'subscription' => ['endpoint' => "http://127.0.0.1:$mockPort/gone", 'keys' => ['p256dh' => push_b64url($device['public']), 'auth' => push_b64url($authSecret)]]]);
    $goneDb = new PDO("sqlite:$dataDir/accounts.sqlite");
    check((int) $goneDb->query("SELECT COUNT(*) FROM push_subscriptions WHERE endpoint LIKE '%/gone'")->fetchColumn() === 1, 'Push: Abo mit Endpunkt /gone liegt vor');
    $invite4 = call($port, ['action' => 'invite', 'token' => $host['token'], 'name' => 'Vierte']);
    check($invite4['ok'] === true && $invite4['pushed'] === 0, 'Einladen klappt auch, wenn der Push-Dienst das Abo als abgelaufen meldet (nur Postfach)');
    check((int) $goneDb->query("SELECT COUNT(*) FROM push_subscriptions WHERE endpoint LIKE '%/gone'")->fetchColumn() === 0, 'Push: abgelaufenes Abo (HTTP 410) wird gelöscht');
    call($port, ['action' => 'start', 'token' => $host['token']]);
    check(call($port, ['action' => 'heartbeat', 'authToken' => $inv4['authToken']])['invites'] === [], 'Einladung zu einem gestarteten Spiel verfällt');
    $currentRoom = $a['room'];

    // Alte Tabelle ohne Serien-Spalten wird nachgerüstet
    require_once __DIR__ . '/../api/accounts.php';
    $old = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $old->exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, xp INTEGER)');
    $old->exec("INSERT INTO accounts (name, xp) VALUES ('Alt', 5)");
    trumpf_add_streak_columns($old);
    $migrated = $old->query('SELECT current_streak, best_streak FROM accounts')->fetch(PDO::FETCH_ASSOC);
    check($migrated === ['current_streak' => 0, 'best_streak' => 0], 'bestehende Tabelle bekommt die Serien-Spalten');

    // Freunde
    $cem = call($port, ['action' => 'register', 'name' => 'Cem', 'password' => 'pw']);
    check(call($port, ['action' => 'friendAdd', 'authToken' => $reg['authToken'], 'name' => 'Ana'])['ok'] === false, 'Freunde: sich selbst nicht addbar');
    check(call($port, ['action' => 'friendAdd', 'authToken' => $reg['authToken'], 'name' => 'Niemand'])['ok'] === false, 'Freunde: unbekannter Name');
    check(call($port, ['action' => 'friendAdd', 'name' => 'Cem'])['code'] === 'logged_out', 'Freunde: ohne Anmeldung nicht möglich');
    check(call($port, ['action' => 'friendAdd', 'authToken' => $reg['authToken'], 'name' => 'cem'])['ok'] === true, 'Freundschaftsanfrage senden');
    check(call($port, ['action' => 'friendAdd', 'authToken' => $reg['authToken'], 'name' => 'Cem'])['ok'] === false, 'Anfrage nicht doppelt');
    check(call($port, ['action' => 'friendProfile', 'authToken' => $reg['authToken'], 'name' => 'Cem'])['ok'] === false, 'Profil erst nach Annahme sichtbar');
    $cemList = call($port, ['action' => 'friends', 'authToken' => $cem['authToken']]);
    check($cemList['ok'] && count($cemList['incoming']) === 1 && $cemList['incoming'][0]['name'] === 'Ana' && count($cemList['friends']) === 0, 'Anfrage erscheint beim anderen');
    $anaList = call($port, ['action' => 'friends', 'authToken' => $reg['authToken']]);
    check(count($anaList['outgoing']) === 1 && $anaList['outgoing'][0]['name'] === 'Cem', 'gesendete Anfrage ist sichtbar');
    check(call($port, ['action' => 'friendAccept', 'authToken' => $cem['authToken'], 'name' => 'Ana'])['ok'] === true, 'Anfrage annehmen');
    $anaList = call($port, ['action' => 'friends', 'authToken' => $reg['authToken']]);
    check(count($anaList['friends']) === 1 && $anaList['friends'][0]['name'] === 'Cem' && isset($anaList['friends'][0]['winRate']), 'Freundesliste mit Profil');
    $friendProfile = call($port, ['action' => 'friendProfile', 'authToken' => $cem['authToken'], 'name' => 'Ana']);
    check($friendProfile['ok'] && $friendProfile['account']['gamesPlayed'] === 1 && $friendProfile['account']['wins'] === 1, 'Freundesprofil zeigt Statistik');
    check(!isset($friendProfile['account']['password']), 'Passwort wird nie ausgeliefert');
    $friendCards = call($port, ['action' => 'friendCollection', 'authToken' => $cem['authToken'], 'name' => 'Ana']);
    check($friendCards['ok'] && $friendCards['name'] === 'Ana' && $friendCards['collected'] === count($friendCards['cards']) && $friendCards['collected'] >= 16 && isset($friendCards['cards'][0]['score']), 'Sammlung eines Freundes ansehen');
    check(call($port, ['action' => 'friendCollection', 'authToken' => $cem['authToken'], 'name' => 'Cem'])['ok'] === false, 'Sammlung: nicht die eigene über Freunde');
    $dora = call($port, ['action' => 'register', 'name' => 'Dora', 'password' => 'pw']);
    check(call($port, ['action' => 'friendCollection', 'authToken' => $dora['authToken'], 'name' => 'Cem'])['ok'] === false, 'Sammlung nur bei Freunden sichtbar');
    call($port, ['action' => 'friendAdd', 'authToken' => $dora['authToken'], 'name' => 'Ana']);
    check(call($port, ['action' => 'friendAdd', 'authToken' => $reg['authToken'], 'name' => 'Dora'])['ok'] === true && count(call($port, ['action' => 'friends', 'authToken' => $reg['authToken']])['friends']) === 2, 'gegenseitige Anfragen werden zur Freundschaft');
    call($port, ['action' => 'friendRemove', 'authToken' => $reg['authToken'], 'name' => 'Cem']);
    check(count(call($port, ['action' => 'friends', 'authToken' => $cem['authToken']])['friends']) === 0, 'Freund entfernen');

    // Sammlung, Kartenmodi, Risiko und Belohnungen
    $roomFile = static function (string $code) use ($dataDir): string {
        return "$dataDir/room_$code.json";
    };
    $forceWin = static function (string $code, int $winnerIndex) use ($roomFile): void {
        // Partie abkürzen: der Gewinner bekommt alle Karten und ist am Zug
        $data = json_decode((string) file_get_contents($roomFile($code)), true);
        $all = [];
        foreach ($data['players'] as $index => $player) {
            $all = array_merge($all, $player['hand']);
            $data['players'][$index]['hand'] = [];
        }
        $data['players'][$winnerIndex]['hand'] = $all;
        $data['game']['activePlayerId'] = $data['players'][$winnerIndex]['id'];
        $data['game']['phase'] = 'choosing';
        file_put_contents($roomFile($code), json_encode($data));
    };
    $risa = call($port, ['action' => 'register', 'name' => 'Risa', 'password' => 'pw']);
    $rolf = call($port, ['action' => 'register', 'name' => 'Rolf', 'password' => 'pw']);
    $risaCol = call($port, ['action' => 'collection', 'authToken' => $risa['authToken']]);
    check($risaCol['ok'] && $risaCol['collected'] === 16 && $risaCol['total'] === 400 && count($risaCol['cards']) === 16 && $risaCol['cards'][0]['qty'] === 1, 'Sammlung: neues Konto hat 16 Startkarten, 16/400');
    check(call($port, ['action' => 'collection'])['ok'] === false, 'Sammlung: ohne Anmeldung keine Karten');
    $risaProfile = call($port, ['action' => 'profile', 'authToken' => $risa['authToken']]);
    check($risaProfile['account']['collected'] === 16 && $risaProfile['account']['totalCards'] === 400, 'Profil zeigt gesammelte Autos');

    // Tagespack: alle 24 Stunden 1 bis 5 zufällige Karten
    $dana = call($port, ['action' => 'register', 'name' => 'Dana', 'password' => 'pw']);
    $danaProfile = call($port, ['action' => 'profile', 'authToken' => $dana['authToken']]);
    check($danaProfile['account']['dailyAvailable'] === true && $danaProfile['account']['dailyNextAt'] <= time() * 1000, 'Tagespack: für neues Konto sofort verfügbar');
    check(call($port, ['action' => 'dailyClaim'])['ok'] === false, 'Tagespack: ohne Anmeldung nicht möglich');
    $before = array_sum(array_column(call($port, ['action' => 'collection', 'authToken' => $dana['authToken']])['cards'], 'qty'));
    $daily = call($port, ['action' => 'dailyClaim', 'authToken' => $dana['authToken']]);
    $got = count($daily['cards'] ?? []);
    check($daily['ok'] && $got >= 1 && $got <= 5 && isset($daily['cards'][0]['card']['name'], $daily['cards'][0]['card']['score'], $daily['cards'][0]['isNew']) && isset($daily['categories']['leistung']), "Tagespack: $got Karten (1–5) mit Werten, Stärke und „neu“-Markierung");
    check($daily['nextAt'] > (time() + 86300) * 1000 && $daily['nextAt'] < (time() + 86500) * 1000, 'Tagespack: nächstes in 24 Stunden');
    $after = call($port, ['action' => 'collection', 'authToken' => $dana['authToken']]);
    check(array_sum(array_column($after['cards'], 'qty')) === $before + $got, 'Tagespack: alle Karten sind in der Sammlung');
    $newCount = count(array_filter($daily['cards'], fn($c) => $c['isNew']));
    check($after['collected'] === 16 + $newCount, "Tagespack: genau die als neu markierten Autos kommen zur Sammlung dazu ($newCount neu)");
    $again = call($port, ['action' => 'dailyClaim', 'authToken' => $dana['authToken']]);
    check($again['ok'] === false && strpos($again['message'], '24 Stunden') !== false && $again['nextAt'] > time() * 1000, 'Tagespack: nur alle 24 Stunden');
    $danaNow = call($port, ['action' => 'profile', 'authToken' => $dana['authToken']])['account'];
    check($danaNow['dailyAvailable'] === false && $danaNow['dailyNextAt'] > (time() + 86300) * 1000, 'Tagespack: Profil zeigt Sperre und Zeitpunkt');
    $tdb = new PDO("sqlite:$dataDir/accounts.sqlite");
    $tdb->exec("UPDATE accounts SET last_daily = '" . (time() - 86300) . "' WHERE name = 'Dana'");
    check(call($port, ['action' => 'dailyClaim', 'authToken' => $dana['authToken']])['ok'] === false, 'Tagespack: nach 23 Stunden noch gesperrt');
    $tdb->exec("UPDATE accounts SET last_daily = '" . (time() - 86500) . "' WHERE name = 'Dana'");
    check(call($port, ['action' => 'dailyClaim', 'authToken' => $dana['authToken']])['ok'] === true, 'Tagespack: nach 24 Stunden wieder abholbar');
    $tdb->exec("UPDATE accounts SET last_daily = '2000-01-01' WHERE name = 'Dana'");
    check(call($port, ['action' => 'profile', 'authToken' => $dana['authToken']])['account']['dailyAvailable'] === true, 'Tagespack: altes Datumsformat wird verstanden');
    $counts = [];
    for ($i = 0; $i < 60; $i++) {
        $tdb->exec("UPDATE accounts SET last_daily = NULL WHERE name = 'Dana'");
        $counts[] = count(call($port, ['action' => 'dailyClaim', 'authToken' => $dana['authToken']])['cards']);
    }
    check(min($counts) === 1 && max($counts) === 5, 'Tagespack: Anzahl ist zufällig zwischen 1 und 5 (' . implode('', array_slice($counts, 0, 20)) . ' …)');
    $dirk = call($port, ['action' => 'register', 'name' => 'Dirk', 'password' => 'pw']);
    $other = call($port, ['action' => 'dailyClaim', 'authToken' => $dirk['authToken']]);
    check($other['ok'] === true && count($other['cards']) >= 1, 'Tagespack: jedes Konto hat sein eigenes');

    $currentRoom = null;
    $rh = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $risa['authToken'], 'create' => true]);
    $currentRoom = $rh['room'];
    $guestT = call($port, ['action' => 'join', 'name' => 'Gasti'])['token'];
    check(call($port, ['action' => 'setDeckMode', 'token' => $guestT, 'mode' => 'auto'])['ok'] === false, 'Kartenmodus: nur der Host');
    call($port, ['action' => 'setDeckMode', 'token' => $rh['token'], 'mode' => 'auto']);
    $guestStart = call($port, ['action' => 'start', 'token' => $rh['token']]);
    check($guestStart['ok'] === false && strpos($guestStart['message'], 'Gasti') !== false, 'Eigene Karten: Gast kann nicht mitspielen');
    call($port, ['action' => 'leave', 'token' => $guestT]);
    $rolfJoin = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $rolf['authToken']]);
    call($port, ['action' => 'setCards', 'token' => $rh['token'], 'count' => 32]);
    $tooFew = call($port, ['action' => 'start', 'token' => $rh['token']]);
    check($tooFew['ok'] === false && strpos($tooFew['message'], '(16)') !== false, 'Eigene Karten: zu wenige Karten für 32');
    call($port, ['action' => 'setCards', 'token' => $rh['token'], 'count' => 16]);
    $auto = call($port, ['action' => 'start', 'token' => $rh['token']]);
    $ownIds = array_column($risaCol['cards'], 'c_id');
    $autoHand = array_column($auto['state']['game']['ownHand'] ?? [], 'c_id');
    check($auto['ok'] && $auto['state']['game']['deckMode'] === 'auto' && count($autoHand) === 16 && !array_diff($autoHand, $ownIds), 'Automatisches Deck: 16 Karten aus der eigenen Sammlung');

    // Risiko-Modus
    $currentRoom = null;
    $rh = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $risa['authToken'], 'create' => true]);
    $currentRoom = $rh['room'];
    $rj = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $rolf['authToken']]);
    call($port, ['action' => 'setCards', 'token' => $rh['token'], 'count' => 8]);
    call($port, ['action' => 'setDeckMode', 'token' => $rh['token'], 'mode' => 'risk']);
    check(call($port, ['action' => 'setTeams', 'token' => $rh['token'], 'on' => true])['ok'] === false, 'Risiko und 2 gegen 2 schließen sich aus');
    $build = call($port, ['action' => 'start', 'token' => $rh['token']]);
    check($build['ok'] && $build['state']['status'] === 'deckbuild' && $build['state']['deckbuild']['need'] === 8 && $build['state']['deckbuild']['deadline'] > $build['serverNow'] + 80000, 'Risiko: 90 s Deck-Phase startet');
    $chosen = array_slice($ownIds, 0, 3);
    check(call($port, ['action' => 'deck', 'token' => $rh['token'], 'cards' => ['0400']])['ok'] === false, 'Deck: fremde Karten werden abgelehnt');
    $picked = call($port, ['action' => 'deck', 'token' => $rh['token'], 'cards' => $chosen, 'ready' => true]);
    check($picked['ok'] && $picked['state']['deckbuild']['picks'] === $chosen && $picked['state']['status'] === 'deckbuild', 'Deck: Auswahl gespeichert, wartet auf die anderen');
    $go = call($port, ['action' => 'deck', 'token' => $rj['token'], 'cards' => [], 'ready' => true]);
    $risaHand = array_column(call($port, ['action' => 'state', 'token' => $rh['token']])['state']['game']['ownHand'] ?? [], 'c_id');
    check($go['ok'] && $go['state']['status'] === 'playing' && count($risaHand) === 8 && !array_diff($chosen, $risaHand), 'Deck: alle fertig, Rest zufällig aufgefüllt, Spiel läuft');
    $rolfId = $go['state']['selfId'];
    $rolfDeck = json_decode((string) file_get_contents($roomFile($currentRoom)), true)['game']['decks'][$rolfId];
    $forceWin($currentRoom, 0);
    $over = call($port, ['action' => 'choose', 'token' => $rh['token'], 'category' => 'leistung']);
    check($over['state']['status'] === 'finished' && $over['state']['risk']['winnerId'] === $over['state']['selfId'] && ($over['state']['risk']['counts'][$rolfId] ?? 0) >= 1 && !isset($over['state']['risk']['options']) && $over['state']['risk']['fan'] === null, 'Risiko: Gewinner sieht nur einen verdeckten Fächer');
    check(call($port, ['action' => 'again', 'token' => $rh['token']])['ok'] === false, 'Risiko: Revanche erst nach der Kartenwahl');
    check(call($port, ['action' => 'riskPick', 'token' => $rj['token'], 'loserId' => $rolfId, 'slot' => 0])['ok'] === false, 'Risiko: Verlierer darf nicht wählen');
    $loserView = call($port, ['action' => 'state', 'token' => $rj['token']])['state']['risk'];
    check(is_array($loserView['fan']) && count($loserView['fan']) === $over['state']['risk']['counts'][$rolfId] && isset($loserView['fan'][0]['name']), 'Risiko: Verlierer sieht sein Fächer offen');
    check(call($port, ['action' => 'riskPick', 'token' => $rh['token'], 'loserId' => $rolfId, 'slot' => 99])['ok'] === false, 'Risiko: ungültiger Platz');
    $riskOptions = json_decode((string) file_get_contents($roomFile($currentRoom)), true)['risk']['options'][$rolfId];
    $prey = $riskOptions[0];
    $rolfBefore = array_column(call($port, ['action' => 'collection', 'authToken' => $rolf['authToken']])['cards'], 'qty', 'c_id');
    $risaBefore = array_column(call($port, ['action' => 'collection', 'authToken' => $risa['authToken']])['cards'], 'qty', 'c_id');
    $pick = call($port, ['action' => 'riskPick', 'token' => $rh['token'], 'loserId' => $rolfId, 'slot' => 0]);
    $rolfAfter = array_column(call($port, ['action' => 'collection', 'authToken' => $rolf['authToken']])['cards'], 'qty', 'c_id');
    $risaAfter = array_column(call($port, ['action' => 'collection', 'authToken' => $risa['authToken']])['cards'], 'qty', 'c_id');
    check($pick['ok'] && $pick['state']['risk']['done'] && $pick['state']['risk']['picks'][$rolfId]['c_id'] === $prey && $pick['state']['risk']['slots'][$rolfId] === 0, 'Risiko: Karte gewählt');
    check(($rolfAfter[$prey] ?? 0) === $rolfBefore[$prey] - 1 && ($risaAfter[$prey] ?? 0) === ($risaBefore[$prey] ?? 0) + 1 && array_sum($rolfAfter) === 15 && array_sum($risaAfter) === 17, 'Risiko: Karte wechselt dauerhaft den Besitzer');

    // Belohnung gegen KI: Leicht 1–3, Mittel 1–3, Schwer 3–5, Schwer mit 32 Karten genau 3
    foreach ([['easy', 8, 1, 3], ['medium', 16, 1, 3], ['hard', 8, 3, 5], ['hard', 16, 3, 5], ['hard', 32, 3, 3]] as [$level, $per, $min, $max]) {
        $currentRoom = null;
        $kira = call($port, ['action' => 'register', 'name' => "Kira$level$per", 'password' => 'pw']);
        $kr = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $kira['authToken'], 'create' => true, 'ai' => ['difficulty' => $level, 'opponents' => 1]]);
        $currentRoom = $kr['room'];
        call($port, ['action' => 'setCards', 'token' => $kr['token'], 'count' => $per]);
        call($port, ['action' => 'start', 'token' => $kr['token']]);
        $forceWin($currentRoom, 0);
        $won = call($port, ['action' => 'choose', 'token' => $kr['token'], 'category' => 'leistung'])['state'];
        $awards = $won['game']['cardAwards'];
        $after = call($port, ['action' => 'collection', 'authToken' => $kira['authToken']]);
        check(count($awards) >= $min && count($awards) <= $max && array_sum(array_column($after['cards'], 'qty')) === 16 + count($awards) && (!$awards || isset($awards[0]['card']['name'], $awards[0]['isNew'])), "Belohnung KI $level mit $per Karten: " . count($awards) . ' Auto(s)');
    }
    $currentRoom = null;

    // Gegen KI mit Konto: eigene Karten, KI-Deck mit passender Wertung
    $currentRoom = null;
    $kai = call($port, ['action' => 'register', 'name' => 'Kai', 'password' => 'pw']);
    $kaiOwn = array_column(call($port, ['action' => 'collection', 'authToken' => $kai['authToken']])['cards'], 'c_id');
    $ks = call($port, ['action' => 'join', 'name' => 'x', 'authToken' => $kai['authToken'], 'create' => true, 'ai' => ['difficulty' => 'hard', 'opponents' => 1]]);
    $currentRoom = $ks['room'];
    call($port, ['action' => 'setCards', 'token' => $ks['token'], 'count' => 32]);
    $kStart = call($port, ['action' => 'start', 'token' => $ks['token']])['state'];
    $kHand = array_column($kStart['game']['ownHand'] ?? [], 'c_id');
    $ratings = (array) $kStart['game']['deckRatings'];
    $mineRating = $ratings[$kStart['selfId']];
    unset($ratings[$kStart['selfId']]);
    $aiRating = array_values($ratings)[0];
    check(count($kHand) === 32 && count(array_intersect(array_unique($kHand), $kaiOwn)) === 16, 'KI-Spiel: 16 eigene Karten + 16 Leihkarten');
    check($aiRating - $mineRating >= 0 && $aiRating - $mineRating <= 8, "KI-Spiel Schwer: KI-Deck nur etwas stärker ($mineRating vs. $aiRating)");
    $currentRoom = null;

    // Nach Spielende zur Startseite
    $currentRoom = null;
    $lh = call($port, ['action' => 'join', 'name' => 'Lena', 'create' => true, 'ai' => ['difficulty' => 'easy', 'opponents' => 1]]);
    $currentRoom = $lh['room'];
    call($port, ['action' => 'setCards', 'token' => $lh['token'], 'count' => 8]);
    call($port, ['action' => 'start', 'token' => $lh['token']]);
    $forceWin($currentRoom, 0);
    call($port, ['action' => 'choose', 'token' => $lh['token'], 'category' => 'leistung']);
    $gone = call($port, ['action' => 'leave', 'token' => $lh['token']]);
    check($gone['ok'] && !is_file($roomFile($currentRoom)), 'Nach Spielende gegen KI: Startseite räumt den Raum ab');
    $currentRoom = null;

    // 2 gegen 2 per API
    $currentRoom = null;
    $t1 = call($port, ['action' => 'join', 'name' => 'Tim1', 'create' => true]);
    $currentRoom = $t1['room'];
    $tt = [$t1['token']];
    for ($n = 2; $n <= 4; $n++) {
        if ($n === 4) {
            check(call($port, ['action' => 'setTeams', 'token' => $tt[0], 'on' => true])['ok'] === false, 'Teams: mit 3 Spielern nicht möglich');
        }
        $tt[] = call($port, ['action' => 'join', 'name' => "Tim$n"])['token'];
    }
    check(call($port, ['action' => 'setTeams', 'token' => $tt[1], 'on' => true])['ok'] === false, 'Teams: nur der Host darf umschalten');
    $on = call($port, ['action' => 'setTeams', 'token' => $tt[0], 'on' => true]);
    check($on['ok'] && $on['state']['teamMode'] === true && $on['state']['players'][0]['team'] === 0 && $on['state']['players'][1]['team'] === 1 && $on['state']['players'][2]['team'] === 0, 'Teams: Lobby zeigt Teams 1+3 gegen 2+4');
    $shuffled = call($port, ['action' => 'setTeams', 'token' => $tt[0], 'on' => true, 'shuffle' => true]);
    check($shuffled['state']['players'][1]['team'] === 0, 'Teams: Aufstellung wechselt');
    call($port, ['action' => 'start', 'token' => $tt[0]]);
    $st = call($port, ['action' => 'state', 'token' => $tt[2]])['state'];
    check($st['teamMode'] === true && $st['game']['teamMode'] === true && $st['players'][2]['team'] === 1, 'Teams: Spiel läuft im Teammodus');
    $chooser = $st['game']['activePlayerId'];
    $chooserToken = $tt[array_search($chooser, array_column($st['players'], 'id'), true)];
    $after = call($port, ['action' => 'choose', 'token' => $chooserToken, 'category' => 'leistung']);
    check($after['ok'] && count($after['state']['game']['tableCards']) === 4 && in_array($after['state']['game']['result']['type'], ['winner', 'tie'], true), 'Teams: alle vier Karten liegen auf dem Tisch');
    $currentRoom = null;

    $htaccess = file_exists("$dataDir/.htaccess");
    check($htaccess, 'Datenordner ist per .htaccess geschützt');
} finally {
    proc_terminate($server);
    proc_terminate($mock);
    foreach (glob("$dataDir/{,.}*", GLOB_BRACE) ?: [] as $file) {
        if (is_file($file)) {
            unlink($file);
        }
    }
    @rmdir($dataDir);
}

echo $failures === 0 ? "\nAlle Tests bestanden.\n" : "\n$failures Test(s) fehlgeschlagen.\n";
exit($failures === 0 ? 0 : 1);
