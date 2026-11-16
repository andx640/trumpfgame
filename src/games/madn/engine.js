// Mensch ärgere dich nicht – reine Spiellogik ohne Oberfläche.
// Jede Funktion bekommt einen Zustand und gibt einen neuen zurück; nichts wird verändert.
// Damit kann dieselbe Logik später auch auf einem Server laufen (Online-Partien).
//
// Figuren zählen ihre Schritte ab dem eigenen Startfeld:
//   -1      im Haus (noch nicht im Spiel)
//   0..39   auf der Laufbahn (0 = eigenes Startfeld)
//   40..43  im Ziel (43 = hinterstes Zielfeld)

export const TRACK = 40;
export const GOAL = 4;
export const PIECES = 4;
export const SEATS = 4;
export const HOME = -1;
export const LAST = TRACK + GOAL - 1;

export const COLORS = [
  { key: "red", name: "Rot" },
  { key: "blue", name: "Blau" },
  { key: "green", name: "Grün" },
  { key: "yellow", name: "Gelb" }
];

/** Feld auf der Laufbahn (0..39) für eine Figur, oder null im Haus/Ziel */
export function trackField(seat, progress) {
  if (progress < 0 || progress >= TRACK) return null;
  return (seat * (TRACK / SEATS) + progress) % TRACK;
}

/**
 * Neue Partie.
 * seats: Array mit 4 Einträgen, je null (frei) oder { name, type: "human" | "ai" }
 */
export function createGame(seats) {
  const players = seats
    .map((seat, index) => (seat ? { seat: index, name: seat.name || COLORS[index].name, type: seat.type === "ai" ? "ai" : "human" } : null))
    .filter(Boolean);
  if (players.length < 2) throw new Error("Mindestens zwei Spieler nötig.");
  const pieces = Array.from({ length: SEATS }, () => Array(PIECES).fill(HOME));
  const state = {
    players,
    pieces,
    current: 0, // Index in players
    phase: "roll", // roll | move | over
    dice: null,
    rollsLeft: 0,
    finished: [], // Sitzplätze in Zielreihenfolge
    lastMove: null,
    turn: 1
  };
  state.rollsLeft = rollsAllowed(state, players[0].seat);
  return state;
}

export function currentSeat(state) {
  return state.players[state.current].seat;
}

function isFinished(pieces) {
  return pieces.every((p) => p > TRACK - 1);
}

/** Alle Figuren im Haus oder im Ziel fest „aufgerückt“: dann darf man dreimal würfeln. */
function stuck(pieces) {
  const inGoal = pieces.filter((p) => p >= TRACK).sort((a, b) => b - a);
  if (pieces.some((p) => p >= 0 && p < TRACK)) return false;
  return inGoal.every((p, index) => p === LAST - index);
}

function rollsAllowed(state, seat) {
  return stuck(state.pieces[seat]) ? 3 : 1;
}

/** Welche Figur (Sitz, Nummer) steht auf einem Laufbahnfeld? */
function occupant(state, field) {
  for (let seat = 0; seat < SEATS; seat += 1) {
    const index = state.pieces[seat].findIndex((p) => trackField(seat, p) === field);
    if (index !== -1) return { seat, index };
  }
  return null;
}

/** Ziel einer Figur bei einem Wurf, oder null wenn der Zug nicht geht. */
function target(state, seat, index, dice) {
  const own = state.pieces[seat];
  const from = own[index];
  if (from === HOME) {
    if (dice !== 6) return null;
    return own.some((p) => p === 0) ? null : 0;
  }
  const to = from + dice;
  if (to > LAST) return null;
  if (own.some((p, i) => i !== index && p === to)) return null; // eigene Figur steht dort
  if (to >= TRACK) {
    // im Ziel wird nicht übersprungen
    for (let step = Math.max(from + 1, TRACK); step < to; step += 1) {
      if (own.includes(step)) return null;
    }
  }
  return to;
}

/**
 * Erlaubte Züge für den aktuellen Wurf, mit den üblichen Pflichten:
 * - Bei einer 6 muss eine Figur aus dem Haus, solange das Startfeld frei ist.
 * - Steht eine eigene Figur auf dem Startfeld und sind noch Figuren im Haus, muss sie weg.
 */
export function legalMoves(state) {
  if (state.phase !== "move" || !state.dice) return [];
  const seat = currentSeat(state);
  const own = state.pieces[seat];
  const moves = [];
  own.forEach((from, index) => {
    const to = target(state, seat, index, state.dice);
    if (to === null) return;
    const field = trackField(seat, to);
    const hit = field === null ? null : occupant(state, field);
    moves.push({ index, from, to, capture: hit && hit.seat !== seat ? hit : null });
  });

  const hasHome = own.includes(HOME);
  const leave = moves.filter((m) => m.from === HOME);
  if (leave.length) return leave.slice(0, 1); // alle Hausfiguren sind gleich, eine reicht
  if (hasHome) {
    const clear = moves.filter((m) => m.from === 0);
    if (clear.length) return clear;
  }
  return moves;
}

/** Würfeln. value: 1..6 (von außen, damit Zufall und Tests getrennt bleiben). */
export function roll(state, value) {
  if (state.phase !== "roll") return state;
  const next = { ...state, dice: value, phase: "move", rollsLeft: state.rollsLeft - 1, lastMove: null };
  if (legalMoves(next).length) return next;
  // kein Zug möglich
  if (value === 6 || next.rollsLeft > 0) return { ...next, phase: "roll", rollsLeft: Math.max(next.rollsLeft, 1) };
  return advance(next);
}

/** Figur ziehen (index 0..3 des aktuellen Spielers). */
export function move(state, index) {
  const option = legalMoves(state).find((m) => m.index === index);
  if (!option) return state;
  const seat = currentSeat(state);
  const pieces = state.pieces.map((list) => list.slice());
  pieces[seat][index] = option.to;
  if (option.capture) pieces[option.capture.seat][option.capture.index] = HOME;

  let finished = state.finished;
  if (isFinished(pieces[seat]) && !finished.includes(seat)) finished = [...finished, seat];

  const next = {
    ...state,
    pieces,
    finished,
    lastMove: { seat, index, from: option.from, to: option.to, capture: option.capture }
  };

  if (isOver(next)) return finish(next);
  if (state.dice === 6 && !finished.includes(seat)) {
    return { ...next, phase: "roll", rollsLeft: rollsAllowed(next, seat) };
  }
  return advance(next);
}

/** Partie vorbei, wenn nur noch einer übrig ist oder kein Mensch mehr mitspielt. */
function isOver(state) {
  const open = state.players.filter((p) => !state.finished.includes(p.seat));
  if (open.length <= 1) return true;
  const humans = state.players.filter((p) => p.type === "human");
  return humans.length > 0 && open.every((p) => p.type === "ai");
}

function progressSum(state, seat) {
  return state.pieces[seat].reduce((sum, p) => sum + (p === HOME ? 0 : p + 1), 0);
}

function finish(state) {
  // Restliche Spieler nach Fortschritt einordnen
  const rest = state.players
    .map((p) => p.seat)
    .filter((seat) => !state.finished.includes(seat))
    .sort((a, b) => progressSum(state, b) - progressSum(state, a));
  return { ...state, phase: "over", dice: state.dice, ranking: [...state.finished, ...rest] };
}

function advance(state) {
  let current = state.current;
  for (let i = 0; i < state.players.length; i += 1) {
    current = (current + 1) % state.players.length;
    if (!state.finished.includes(state.players[current].seat)) break;
  }
  const seat = state.players[current].seat;
  return { ...state, current, phase: "roll", rollsLeft: rollsAllowed(state, seat), turn: state.turn + 1 };
}

/** Einfache KI: schlagen, ins Ziel, raus aus dem Haus, Gefahr meiden, sonst die vorderste Figur. */
export function chooseMove(state) {
  const moves = legalMoves(state);
  if (moves.length <= 1) return moves[0] ?? null;
  const seat = currentSeat(state);
  const score = (m) => {
    let value = 0;
    if (m.capture) value += 100;
    if (m.to >= TRACK && m.from < TRACK) value += 60;
    if (m.from === HOME) value += 50;
    if (m.to >= TRACK) value += 10 + m.to;
    const before = m.from >= 0 && m.from < TRACK ? danger(state, seat, trackField(seat, m.from)) : 0;
    const after = m.to < TRACK ? danger(state, seat, trackField(seat, m.to)) : 0;
    value += (before - after) * 15;
    value += m.from / 10;
    return value;
  };
  return moves.reduce((best, m) => (score(m) > score(best) ? m : best));
}

/** Wie viele gegnerische Figuren stehen 1–6 Felder hinter einem Feld? */
function danger(state, seat, field) {
  let count = 0;
  for (let other = 0; other < SEATS; other += 1) {
    if (other === seat || !state.players.some((p) => p.seat === other)) continue;
    state.pieces[other].forEach((p) => {
      const at = trackField(other, p);
      if (at === null) return;
      const distance = (field - at + TRACK) % TRACK;
      if (distance >= 1 && distance <= 6 && p + distance < TRACK) count += 1;
    });
  }
  return count;
}
