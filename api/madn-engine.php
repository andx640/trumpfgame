<?php
// Mensch ärgere dich nicht – Spielregeln für Online-Partien.
// Gleiche Regeln und gleicher Zustand wie src/games/madn/engine.js (test/madn-parity.test.mjs vergleicht beide).
//
// Figuren zählen ihre Schritte ab dem eigenen Startfeld:
//   -1 im Haus, 0..T-1 auf der Laufbahn, T..T+3 im Ziel.
// T = 10 Felder je Platz: 40 auf dem Vierer-, 60 auf dem Sechser-Brett. Brettgröße = count($state['pieces']).
declare(strict_types=1);

const MADN_SEGMENT = 10;
const MADN_TRACK = 40;
const MADN_GOAL = 4;
const MADN_PIECES = 4;
const MADN_SEATS = 4;
const MADN_MAX_SEATS = 6;
const MADN_HOME = -1;
const MADN_LAST = MADN_TRACK + MADN_GOAL - 1;
const MADN_COLOR_NAMES = ['Rot', 'Blau', 'Grün', 'Gelb', 'Schwarz', 'Lila'];

function madn_board(array $state): int
{
    return count($state['pieces']);
}

function madn_track_len(int $board): int
{
    return $board * MADN_SEGMENT;
}

function madn_track_field(int $seat, int $progress, int $board = MADN_SEATS): ?int
{
    $track = madn_track_len($board);
    if ($progress < 0 || $progress >= $track) {
        return null;
    }
    return ($seat * MADN_SEGMENT + $progress) % $track;
}

/** Vierer- oder Sechser-Brett: Sechser, sobald Platz 5 oder 6 besetzt ist */
function madn_board_for(array $seats): int
{
    for ($i = MADN_SEATS; $i < count($seats); $i++) {
        if (!empty($seats[$i])) {
            return MADN_MAX_SEATS;
        }
    }
    return MADN_SEATS;
}

/** seats: 4 oder 6 Einträge, je null oder ['name' => ..., 'type' => 'human'|'ai'] */
function madn_create_game(array $seats): array
{
    $board = madn_board_for($seats);
    $seats = array_slice(array_values($seats), 0, $board);
    $players = [];
    foreach ($seats as $index => $seat) {
        if ($seat) {
            $players[] = [
                'seat' => $index,
                'name' => ($seat['name'] ?? '') !== '' ? $seat['name'] : MADN_COLOR_NAMES[$index],
                'type' => ($seat['type'] ?? '') === 'ai' ? 'ai' : 'human'
            ];
        }
    }
    if (count($players) < 2) {
        throw new InvalidArgumentException('Mindestens zwei Spieler nötig.');
    }
    $state = [
        'players' => $players,
        'pieces' => array_fill(0, $board, array_fill(0, MADN_PIECES, MADN_HOME)),
        'current' => 0,
        'phase' => 'roll',
        'dice' => null,
        'rollsLeft' => 0,
        'finished' => [],
        'lastMove' => null,
        'lastRoll' => null,
        'turn' => 1
    ];
    $state['rollsLeft'] = madn_rolls_allowed($state, $players[0]['seat']);
    return $state;
}

function madn_current_seat(array $state): int
{
    return $state['players'][$state['current']]['seat'];
}

function madn_is_finished(array $pieces, int $track): bool
{
    foreach ($pieces as $p) {
        if ($p <= $track - 1) {
            return false;
        }
    }
    return true;
}

function madn_stuck(array $pieces, int $track): bool
{
    $inGoal = [];
    foreach ($pieces as $p) {
        if ($p >= 0 && $p < $track) {
            return false;
        }
        if ($p >= $track) {
            $inGoal[] = $p;
        }
    }
    rsort($inGoal);
    foreach ($inGoal as $index => $p) {
        if ($p !== $track + MADN_GOAL - 1 - $index) {
            return false;
        }
    }
    return true;
}

function madn_rolls_allowed(array $state, int $seat): int
{
    return madn_stuck($state['pieces'][$seat], madn_track_len(madn_board($state))) ? 3 : 1;
}

function madn_occupant(array $state, int $field): ?array
{
    $board = madn_board($state);
    for ($seat = 0; $seat < $board; $seat++) {
        foreach ($state['pieces'][$seat] as $index => $p) {
            if (madn_track_field($seat, $p, $board) === $field) {
                return ['seat' => $seat, 'index' => $index];
            }
        }
    }
    return null;
}

function madn_target(array $state, int $seat, int $index, int $dice): ?int
{
    $own = $state['pieces'][$seat];
    $from = $own[$index];
    if ($from === MADN_HOME) {
        if ($dice !== 6) {
            return null;
        }
        return in_array(0, $own, true) ? null : 0;
    }
    $track = madn_track_len(madn_board($state));
    $to = $from + $dice;
    if ($to > $track + MADN_GOAL - 1) {
        return null;
    }
    foreach ($own as $i => $p) {
        if ($i !== $index && $p === $to) {
            return null;
        }
    }
    if ($to >= $track) {
        for ($step = max($from + 1, $track); $step < $to; $step++) {
            if (in_array($step, $own, true)) {
                return null;
            }
        }
    }
    return $to;
}

function madn_legal_moves(array $state): array
{
    if ($state['phase'] !== 'move' || !$state['dice']) {
        return [];
    }
    $seat = madn_current_seat($state);
    $own = $state['pieces'][$seat];
    $moves = [];
    foreach ($own as $index => $from) {
        $to = madn_target($state, $seat, $index, $state['dice']);
        if ($to === null) {
            continue;
        }
        $field = madn_track_field($seat, $to, madn_board($state));
        $hit = $field === null ? null : madn_occupant($state, $field);
        $moves[] = ['index' => $index, 'from' => $from, 'to' => $to, 'capture' => $hit && $hit['seat'] !== $seat ? $hit : null];
    }
    $leave = array_values(array_filter($moves, static fn($m) => $m['from'] === MADN_HOME));
    if ($leave) {
        return [$leave[0]];
    }
    if (in_array(MADN_HOME, $own, true)) {
        $clear = array_values(array_filter($moves, static fn($m) => $m['from'] === 0));
        if ($clear) {
            return $clear;
        }
    }
    return $moves;
}

function madn_roll(array $state, int $value): array
{
    if ($state['phase'] !== 'roll') {
        return $state;
    }
    $next = $state;
    $next['dice'] = $value;
    $next['phase'] = 'move';
    $next['rollsLeft'] = $state['rollsLeft'] - 1;
    $next['lastMove'] = null;
    $next['lastRoll'] = ['seat' => madn_current_seat($state), 'value' => $value, 'n' => ($state['lastRoll']['n'] ?? 0) + 1];
    if (madn_legal_moves($next)) {
        return $next;
    }
    if ($value === 6 || $next['rollsLeft'] > 0) {
        $next['phase'] = 'roll';
        $next['rollsLeft'] = max($next['rollsLeft'], 1);
        return $next;
    }
    return madn_advance($next);
}

function madn_move(array $state, int $index): array
{
    $option = null;
    foreach (madn_legal_moves($state) as $m) {
        if ($m['index'] === $index) {
            $option = $m;
        }
    }
    if ($option === null) {
        return $state;
    }
    $seat = madn_current_seat($state);
    $next = $state;
    $next['pieces'][$seat][$index] = $option['to'];
    if ($option['capture']) {
        $next['pieces'][$option['capture']['seat']][$option['capture']['index']] = MADN_HOME;
    }
    if (madn_is_finished($next['pieces'][$seat], madn_track_len(madn_board($state))) && !in_array($seat, $next['finished'], true)) {
        $next['finished'][] = $seat;
    }
    $next['lastMove'] = ['seat' => $seat, 'index' => $index, 'from' => $option['from'], 'to' => $option['to'], 'capture' => $option['capture']];

    if (madn_is_over($next)) {
        return madn_finish($next);
    }
    if ($state['dice'] === 6 && !in_array($seat, $next['finished'], true)) {
        $next['phase'] = 'roll';
        $next['rollsLeft'] = madn_rolls_allowed($next, $seat);
        return $next;
    }
    return madn_advance($next);
}

function madn_is_over(array $state): bool
{
    $open = array_filter($state['players'], static fn($p) => !in_array($p['seat'], $state['finished'], true));
    if (count($open) <= 1) {
        return true;
    }
    $humans = array_filter($state['players'], static fn($p) => $p['type'] === 'human');
    if (!$humans) {
        return false;
    }
    foreach ($open as $p) {
        if ($p['type'] !== 'ai') {
            return false;
        }
    }
    return true;
}

function madn_progress_sum(array $state, int $seat): int
{
    $sum = 0;
    foreach ($state['pieces'][$seat] as $p) {
        $sum += $p === MADN_HOME ? 0 : $p + 1;
    }
    return $sum;
}

function madn_finish(array $state): array
{
    $rest = [];
    foreach ($state['players'] as $p) {
        if (!in_array($p['seat'], $state['finished'], true)) {
            $rest[] = $p['seat'];
        }
    }
    // stabil sortieren wie Array.prototype.sort in JS
    $order = array_flip($rest);
    usort($rest, static function ($a, $b) use ($state, $order) {
        return (madn_progress_sum($state, $b) - madn_progress_sum($state, $a)) ?: ($order[$a] - $order[$b]);
    });
    $state['phase'] = 'over';
    $state['ranking'] = array_merge($state['finished'], $rest);
    return $state;
}

function madn_advance(array $state): array
{
    $current = $state['current'];
    $count = count($state['players']);
    for ($i = 0; $i < $count; $i++) {
        $current = ($current + 1) % $count;
        if (!in_array($state['players'][$current]['seat'], $state['finished'], true)) {
            break;
        }
    }
    $state['current'] = $current;
    $state['phase'] = 'roll';
    $state['rollsLeft'] = madn_rolls_allowed($state, $state['players'][$current]['seat']);
    $state['turn']++;
    return $state;
}

/** Einfache KI, wählt genau wie chooseMove in engine.js. */
function madn_choose_move(array $state): ?array
{
    $moves = madn_legal_moves($state);
    if (count($moves) <= 1) {
        return $moves[0] ?? null;
    }
    $seat = madn_current_seat($state);
    $board = madn_board($state);
    $track = madn_track_len($board);
    $score = static function (array $m) use ($state, $seat, $board, $track): float {
        $value = 0.0;
        if ($m['capture']) {
            $value += 100;
        }
        if ($m['to'] >= $track && $m['from'] < $track) {
            $value += 60;
        }
        if ($m['from'] === MADN_HOME) {
            $value += 50;
        }
        if ($m['to'] >= $track) {
            $value += 10 + ($m['to'] - $track + MADN_TRACK);
        }
        $before = $m['from'] >= 0 && $m['from'] < $track ? madn_danger($state, $seat, madn_track_field($seat, $m['from'], $board)) : 0;
        $after = $m['to'] < $track ? madn_danger($state, $seat, madn_track_field($seat, $m['to'], $board)) : 0;
        $value += ($before - $after) * 15;
        $value += $m['from'] / 10;
        return $value;
    };
    $best = $moves[0];
    foreach ($moves as $m) {
        if ($score($m) > $score($best)) {
            $best = $m;
        }
    }
    return $best;
}

function madn_danger(array $state, int $seat, int $field): int
{
    $count = 0;
    $seats = array_column($state['players'], 'seat');
    $board = madn_board($state);
    $track = madn_track_len($board);
    for ($other = 0; $other < $board; $other++) {
        if ($other === $seat || !in_array($other, $seats, true)) {
            continue;
        }
        foreach ($state['pieces'][$other] as $p) {
            $at = madn_track_field($other, $p, $board);
            if ($at === null) {
                continue;
            }
            $distance = ($field - $at + $track) % $track;
            if ($distance >= 1 && $distance <= 6 && $p + $distance < $track) {
                $count++;
            }
        }
    }
    return $count;
}
