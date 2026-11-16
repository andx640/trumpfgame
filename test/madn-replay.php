<?php
// Hilfsskript für test/madn-parity.test.mjs: spielt eine Zugfolge mit der PHP-Engine nach
// und gibt nach jeder Aktion den Zustand aus.
declare(strict_types=1);
require __DIR__ . '/../api/madn-engine.php';

$input = json_decode((string) stream_get_contents(STDIN), true);
$state = madn_create_game($input['seats']);
$states = [$state];
foreach ($input['actions'] as $action) {
    if ($action['t'] === 'roll') {
        $state = madn_roll($state, $action['v']);
    } elseif ($action['t'] === 'ai') {
        $state = madn_move($state, madn_choose_move($state)['index']);
    } else {
        $state = madn_move($state, $action['i']);
    }
    $states[] = $state;
}
echo json_encode($states, JSON_UNESCAPED_UNICODE);
