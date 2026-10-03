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
    array_merge($_ENV, ['TRUMPF_DATA_DIR' => $dataDir, 'TRUMPF_DB_DSN' => "sqlite:$dataDir/accounts.sqlite", 'PATH' => getenv('PATH')])
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

try {
    check(call($port, ['action' => 'ping'])['ok'] === true, 'ping');
    $all = call($port, ['action' => 'cards']);
    check($all['ok'] && count($all['cards']) === 128 && isset($all['categories']['leistung']), 'Sammlung: alle 128 Karten abrufbar');
    check(isset($all['cards'][0]['name'], $all['cards'][0]['image'], $all['cards'][0]['leistung']), 'Sammlung: Karten haben Name, Bild und Werte');

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

    // --- Entwicklungs-Session 123456 mit Test-Bot -------------------------------------------------
    $callAs = function (string $host, array $body) use ($port): array {
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nHost: $host\r\n",
            'content' => json_encode($body),
            'ignore_errors' => true,
        ]]);
        return json_decode((string) file_get_contents("http://127.0.0.1:$port/api/index.php", false, $context), true) ?? [];
    };
    // Online ist die Test-Session ebenfalls da (andere Domain im Host-Header), nur TRUMPF_DEV_SESSION=0 schaltet sie ab.
    @unlink("$dataDir/room_123456.json");
    $online = $callAs('andi-trumpf.de', ['action' => 'join', 'name' => 'Check', 'room' => '123456']);
    check($online['ok'] === true && $online['room'] === '123456', 'auch auf der echten Domain gibt es die Session 123456');
    @unlink("$dataDir/room_123456.json");
    $off = proc_open(
        ['php', '-S', "127.0.0.1:" . ($port + 1), '-t', $root],
        [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
        $offPipes,
        $root,
        array_merge($_ENV, ['TRUMPF_DATA_DIR' => $dataDir, 'TRUMPF_DEV_SESSION' => '0', 'PATH' => getenv('PATH')])
    );
    for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port + 1); $i++) {
        usleep(100000);
    }
    $offReply = json_decode((string) file_get_contents("http://127.0.0.1:" . ($port + 1) . "/api/index.php", false, stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => json_encode(['action' => 'join', 'name' => 'Check', 'room' => '123456']),
        'ignore_errors' => true,
    ]])), true) ?? [];
    proc_terminate($off);
    check(($offReply['ok'] ?? true) === false && !file_exists("$dataDir/room_123456.json"), 'mit TRUMPF_DEV_SESSION=0 gibt es die Session nicht');
    @unlink("$dataDir/room_123456.json");

    $currentRoom = '123456';
    $dev = call($port, ['action' => 'join', 'name' => 'Andi', 'room' => '123456']);
    check($dev['ok'] && $dev['room'] === '123456', 'Beitritt zu 123456 ohne vorher zu erstellen');
    $names = array_map(fn($p) => $p['name'], $dev['state']['players']);
    check($names === ['Test-Bot', 'Andi'], 'in der Session wartet schon der Test-Bot (' . implode(', ', $names) . ')');
    check($dev['state']['hostId'] === $dev['state']['selfId'], 'der Mensch ist Host, nicht der Bot');
    $botRow = array_values(array_filter($dev['state']['players'], fn($p) => $p['name'] === 'Test-Bot'))[0];
    check($botRow['connected'] === true, 'der Bot ist online');

    $set = call($port, ['action' => 'setCards', 'token' => $dev['token'], 'count' => 8]);
    $go = call($port, ['action' => 'start', 'token' => $dev['token']]);
    check($go['ok'] && $go['state']['game']['phase'] === 'choosing', 'alleine mit dem Bot starten geht');
    check($go['state']['game']['activePlayerId'] === $botRow['id'], 'der Bot ist als Erster am Zug');
    usleep(1800000);
    $after = call($port, ['action' => 'state', 'token' => $dev['token']])['state'];
    check($after['game']['phase'] === 'revealed' && count($after['game']['tableCards']) === 2, 'der Bot wählt von selbst eine Kategorie (' . ($after['game']['category'] ?? '?') . ')');

    // Der Bot bleibt online, auch wenn der Mensch weg ist; ein neuer Beitritt setzt die Session zurück.
    $room = json_decode((string) file_get_contents("$dataDir/room_123456.json"), true);
    foreach ($room['players'] as $i => $pl) {
        if (empty($pl['bot'])) {
            $room['players'][$i]['lastSeen'] -= 600000;
        }
    }
    file_put_contents("$dataDir/room_123456.json", json_encode($room));
    $again = call($port, ['action' => 'join', 'name' => 'Andi2', 'room' => '123456']);
    $names = $again['ok'] ? array_map(fn($p) => $p['name'], $again['state']['players']) : [];
    check($again['ok'] && $again['state']['status'] === 'lobby' && $names === ['Test-Bot', 'Andi2'], 'nach dem Weggehen: neue Lobby mit Bot statt "Spiel läuft bereits"');
    check($again['state']['hostId'] === $again['state']['selfId'], 'auch dann ist der Mensch Host');
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
