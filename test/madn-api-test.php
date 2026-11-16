<?php
// Testet die Online-API von „Mensch ärgere dich nicht“ mit dem eingebauten PHP-Server: php test/madn-api-test.php
declare(strict_types=1);

$failures = 0;
function check(bool $condition, string $label): void
{
    global $failures;
    echo ($condition ? '  ok   ' : '  FAIL ') . $label . "\n";
    if (!$condition) {
        $failures++;
    }
}

$dataDir = sys_get_temp_dir() . '/madn-test-' . getmypid();
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
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
    usleep(100000);
}

function api(array $body): array
{
    global $port;
    $context = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => json_encode($body), 'ignore_errors' => true]]);
    $response = file_get_contents("http://127.0.0.1:$port/api/madn.php", false, $context);
    return json_decode((string) $response, true) ?? ['ok' => false, 'raw' => $response];
}

echo "Mensch ärgere dich nicht online\n";
try {
    check(api(['action' => 'create', 'name' => ''])['ok'] === false, 'ohne Namen kein Raum');
    $a = api(['action' => 'create', 'name' => '  Ada ']);
    $room = $a['room'] ?? '';
    check($a['ok'] && preg_match('/^[A-Z0-9]{5}$/', $room) === 1 && $a['state']['selfSeat'] === 0 && $a['state']['isHost'], 'Raum erstellen: Gastgeber sitzt auf Rot');
    check($a['state']['seats'][0]['name'] === 'Ada', 'Name wird bereinigt');
    check(api(['action' => 'join', 'room' => 'NOPE1', 'name' => 'Bo'])['ok'] === false, 'unbekannter Raum wird abgelehnt');

    $b = api(['action' => 'join', 'room' => $room, 'name' => 'Bo']);
    check($b['ok'] && $b['state']['selfSeat'] === 2 && !$b['state']['isHost'], 'zweiter Spieler sitzt gegenüber (Grün)');
    $again = api(['action' => 'join', 'room' => $room, 'token' => $b['token'], 'name' => 'Bo']);
    check($again['ok'] && $again['state']['selfSeat'] === 2 && !isset($again['token']), 'erneuter Beitritt mit Token behält den Platz');

    check(api(['action' => 'start', 'room' => $room, 'token' => $b['token']])['ok'] === false, 'nur der Gastgeber startet');
    check(api(['action' => 'addAi', 'room' => $room, 'token' => $b['token'], 'seat' => 1])['ok'] === false, 'nur der Gastgeber fügt KI hinzu');
    $ai = api(['action' => 'addAi', 'room' => $room, 'token' => $a['token'], 'seat' => 1]);
    check($ai['ok'] && $ai['state']['seats'][1]['type'] === 'ai', 'KI auf Blau');

    $s = api(['action' => 'start', 'room' => $room, 'token' => $a['token']]);
    $game = $s['state']['game'];
    check($s['ok'] && $s['state']['status'] === 'playing' && count($game['players']) === 3, 'Partie mit drei Spielern gestartet');
    check(api(['action' => 'join', 'room' => $room, 'name' => 'Cy'])['ok'] === false, 'laufender Partie kann niemand beitreten');
    check(api(['action' => 'roll', 'room' => $room, 'token' => $b['token']])['ok'] === false, 'Grün darf nicht würfeln, wenn Rot dran ist');

    $r = api(['action' => 'roll', 'room' => $room, 'token' => $a['token']]);
    $roll = $r['state']['game']['lastRoll'];
    check($r['ok'] && $roll['seat'] === 0 && $roll['value'] >= 1 && $roll['value'] <= 6, 'Server würfelt für Rot');
    check(api(['action' => 'move', 'room' => $room, 'token' => $a['token'], 'piece' => 9])['ok'] === false, 'ungültiger Zug wird abgelehnt');

    // Rot würfelt, bis ein Zug möglich ist oder der Zug weitergeht
    $state = $r['state'];
    for ($i = 0; $i < 6 && $state['game']['current'] === 0 && $state['game']['phase'] === 'roll'; $i++) {
        $state = api(['action' => 'roll', 'room' => $room, 'token' => $a['token']])['state'];
    }
    if ($state['game']['current'] === 0 && $state['game']['phase'] === 'move') {
        $m = api(['action' => 'move', 'room' => $room, 'token' => $a['token'], 'piece' => 0]);
        check($m['ok'] && $m['state']['game']['pieces'][0][0] === 0, 'Rot zieht mit der 6 aufs Startfeld');
        $state = $m['state'];
    } else {
        check($state['game']['current'] !== 0, 'nach drei Fehlwürfen ist der Nächste dran');
    }

    // KI und Zeitablauf: Grün verlässt die Partie, KI übernimmt; Ada bleibt, der Server spielt die KI von selbst
    $left = api(['action' => 'leave', 'room' => $room, 'token' => $b['token']]);
    check($left['ok'] && !isset($left['state']), 'Grün verlässt die Partie');
    $st = api(['action' => 'state', 'room' => $room, 'token' => $a['token']])['state'];
    check($st['seats'][2]['type'] === 'ai' && str_contains($st['seats'][2]['name'], '(KI)'), 'KI übernimmt den verlassenen Platz');
    check(api(['action' => 'state', 'room' => $room, 'token' => $b['token']])['code'] === 'not_joined', 'altes Token ist ungültig');

    // Raum mit nur KI-Gegnern läuft von allein weiter, wenn Ada nicht reagiert
    $file = "$dataDir/madn_$room.json";
    $data = json_decode((string) file_get_contents($file), true);
    $before = $data['game']['turn'];
    $data['deadline'] = 0; // Zeit abgelaufen
    file_put_contents($file, json_encode($data));
    $st = api(['action' => 'state', 'room' => $room, 'token' => $a['token']])['state'];
    check($st['game']['turn'] > $before || $st['game']['lastRoll']['n'] > $data['game']['lastRoll']['n'], 'nach Zeitablauf spielt der Server weiter');

    $unchanged = api(['action' => 'state', 'room' => $room, 'token' => $a['token'], 'since' => api(['action' => 'state', 'room' => $room, 'token' => $a['token']])['version']]);
    check(!empty($unchanged['unchanged']) && !isset($unchanged['state']), 'unveränderter Stand wird nicht neu geschickt');

    $bye = api(['action' => 'leave', 'room' => $room, 'token' => $a['token']]);
    check($bye['ok'] && !is_file($file), 'letzter Mensch geht: Raum wird gelöscht');
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
