<?php
// Testet die PHP-API mit dem eingebauten PHP-Server: php test/api-test.php
declare(strict_types=1);

require __DIR__ . '/../api/engine.php';

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
check(count($deck) === 128, '128 Karten geladen');

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
    array_merge($_ENV, ['TRUMPF_DATA_DIR' => $dataDir, 'PATH' => getenv('PATH')])
);
for ($i = 0; $i < 50; $i++) {
    if (@fsockopen('127.0.0.1', $port)) {
        break;
    }
    usleep(100000);
}

function call(int $port, array $body): array
{
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => json_encode($body),
        'ignore_errors' => true,
    ]]);
    $response = file_get_contents("http://127.0.0.1:$port/api/index.php", false, $context);
    return json_decode((string) $response, true) ?? ['ok' => false, 'raw' => $response];
}

try {
    check(call($port, ['action' => 'ping'])['ok'] === true, 'ping');

    $a = call($port, ['action' => 'join', 'name' => '  Ada  ']);
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
    $file = "$dataDir/room.json";
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

    check(call($port, ['action' => 'state', 'token' => 'falsch'])['code'] === 'not_joined', 'unbekannter Token');
    check(call($port, ['action' => 'unsinn', 'token' => $a['token']])['ok'] === false, 'unbekannte Aktion');
    $htaccess = file_exists("$dataDir/.htaccess");
    check($htaccess, 'Datenordner ist per .htaccess geschützt');
} finally {
    proc_terminate($server);
    foreach (glob("$dataDir/{,.}*", GLOB_BRACE) ?: [] as $file) {
        if (is_file($file)) {
            unlink($file);
        }
    }
    @rmdir($dataDir);
}

echo $failures === 0 ? "\nAlle Tests bestanden.\n" : "\n$failures Test(s) fehlgeschlagen.\n";
exit($failures === 0 ? 0 : 1);
