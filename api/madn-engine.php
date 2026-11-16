<?php
// Mensch ärgere dich nicht – Spielregeln für Online-Partien.
// Gleiche Regeln und gleicher Zustand wie src/games/madn/engine.js (test/madn-parity.test.mjs vergleicht beide).
//
// Figuren zählen ihre Schritte ab dem eigenen Startfeld:
//   -1 im Haus, 0..39 auf der Laufbahn, 40..43 im Ziel.
declare(strict_types=1);

const MADN_TRACK = 40;
const MADN_GOAL = 4;
const MADN_PIECES = 4;
const MADN_SEATS = 4;
const MADN_HOME = -1;
const MADN_LAST = MADN_TRACK + MADN_GOAL - 1;
const MADN_COLOR_NAMES = ['Rot', 'Blau', 'Grün', 'Gelb'];

function madn_track_field(int $seat, int $progress): ?int
{
    if ($progress < 0 || $progress >= MADN_TRACK) {
        return null;
    }
    return ($seat * intdiv(MADN_TRACK, MADN_SEATS) + $progress) % MADN_TRACK;
}

/** seats: 4 Einträge, je null oder ['name' => ..., 'type' => 'human'|'ai'] */
function madn_create_game(array $seats): array
{
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
        'pieces' => array_fill(0, MADN_SEATS, array_fill(0, MADN_PIECES, MADN_HOME)),
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

function madn_is_finished(array $pieces): bool
{
    foreach ($pieces as $p) {
        if ($p <= MADN_TRACK - 1) {
            return false;
        }
    }
    return true;
}

function madn_stuck(array $pieces): bool
{
    $inGoal = [];
    foreach ($pieces as $p) {
        if ($p >= 0 && $p < MADN_TRACK) {
            return false;
        }
        if ($p >= MADN_TRACK) {
            $inGoal[] = $p;
        }
    }
    rsort($inGoal);
    foreach ($inGoal as $index => $p) {
        if ($p !== MADN_LAST - $index) {
            return false;
        }
    }
    return true;
}

function madn_rolls_allowed(array $state, int $seat): int
{
    return madn_stuck($state['pieces'][$seat]) ? 3 : 1;
}

function madn_occupant(array $state, int $field): ?array
{
    for ($seat = 0; $seat < MADN_SEATS; $seat++) {
        foreach ($state['pieces'][$seat] as $index => $p) {
            if (madn_track_field($seat, $p) === $field) {
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
    $to = $from + $dice;
    if ($to > MADN_LAST) {
        return null;
    }
    foreach ($own as $i => $p) {
        if ($i !== $index && $p === $to) {
            return null;
        }
    }
    if ($to >= MADN_TRACK) {
        for ($step = max($from + 1, MADN_TRACK); $step < $to; $step++) {
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
        $field = madn_track_field($seat, $to);
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
    if (madn_is_finished($next['pieces'][$seat]) && !in_array($seat, $next['finished'], true)) {
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
    $score = static function (array $m) use ($state, $seat): float {
        $value = 0.0;
        if ($m['capture']) {
            $value += 100;
        }
        if ($m['to'] >= MADN_TRACK && $m['from'] < MADN_TRACK) {
            $value += 60;
        }
        if ($m['from'] === MADN_HOME) {
            $value += 50;
        }
        if ($m['to'] >= MADN_TRACK) {
            $value += 10 + $m['to'];
        }
        $before = $m['from'] >= 0 && $m['from'] < MADN_TRACK ? madn_danger($state, $seat, madn_track_field($seat, $m['from'])) : 0;
        $after = $m['to'] < MADN_TRACK ? madn_danger($state, $seat, madn_track_field($seat, $m['to'])) : 0;
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
    for ($other = 0; $other < MADN_SEATS; $other++) {
        if ($other === $seat || !in_array($other, $seats, true)) {
            continue;
        }
        foreach ($state['pieces'][$other] as $p) {
            $at = madn_track_field($other, $p);
            if ($at === null) {
                continue;
            }
            $distance = ($field - $at + MADN_TRACK) % MADN_TRACK;
            if ($distance >= 1 && $distance <= 6 && $p + $distance < MADN_TRACK) {
                $count++;
            }
        }
    }
    return $count;
}
