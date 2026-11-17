import { GOAL, HOME, SEGMENT } from "./engine";

// Lage der Felder auf dem Brett, als Punkte um die Brettmitte (x nach rechts, y nach unten, 1 = Feldabstand).
// Vierer-Brett: das klassische Kreuz. Sechser-Brett: sechs kurze Arme mit Verbindungsstücken.
// Die Laufbahn geht im Uhrzeigersinn; Feld 10·k ist das Startfeld (A) von Platz k.

// Vierer-Brett auf dem 11 × 11 Raster, Feld 0 ist das Startfeld von Rot.
const GRID_PATH = [
  [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [4, 3], [4, 2], [4, 1], [4, 0], [5, 0],
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [10, 5],
  [10, 6], [9, 6], [8, 6], [7, 6], [6, 6], [6, 7], [6, 8], [6, 9], [6, 10], [5, 10],
  [4, 10], [4, 9], [4, 8], [4, 7], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 5]
];
const GRID_GOALS = [
  [[1, 5], [2, 5], [3, 5], [4, 5]],
  [[5, 1], [5, 2], [5, 3], [5, 4]],
  [[9, 5], [8, 5], [7, 5], [6, 5]],
  [[5, 9], [5, 8], [5, 7], [5, 6]]
];
const GRID_HOUSES = [
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[9, 0], [10, 0], [9, 1], [10, 1]],
  [[9, 9], [10, 9], [9, 10], [10, 10]],
  [[0, 9], [1, 9], [0, 10], [1, 10]]
];

const centered = ([x, y]) => [x - 5, y - 5];

function fourLayout() {
  return {
    board: 4,
    path: GRID_PATH.map(centered),
    goals: GRID_GOALS.map((cells) => cells.map(centered)),
    houses: GRID_HOUSES.map((cells) => cells.map(centered)),
    // Richtung, in die der Arm eines Platzes zeigt (Bogenmaß, y nach unten)
    armAngle: [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5],
    extent: 5.7, // halbe Kantenlänge der bedruckten Fläche
    shape: "square",
    // freie Stellen, auf denen der Würfel liegen bleiben darf
    rest: [[-2.5, -2.5], [2.5, -2.5], [2.5, 2.5], [-2.5, 2.5]],
    // Schriftzug in den freien Ecken
    words: [
      { text: "Mensch", at: [-2.75, -2.4], size: 0.85 },
      { text: "ärgere", at: [2.75, -2.4], size: 0.85 },
      { text: "Dich", at: [-2.75, 2.6], size: 0.85 },
      { text: "nicht", at: [2.75, 2.6], size: 0.85 }
    ]
  };
}

function sixLayout() {
  const board = 6;
  const outer = 7.7; // Abstand der Armspitze von der Mitte
  const inner = outer - 2; // innerstes Feld eines Arms
  const width = 1; // halbe Armbreite
  const angle = (k) => Math.PI + (k * Math.PI * 2) / board;
  const unit = (a) => [Math.cos(a), Math.sin(a)];
  const point = (k, r, side) => {
    const [ux, uy] = unit(angle(k));
    const [vx, vy] = unit(angle(k) + Math.PI / 2); // zeigt zum nächsten Arm (Uhrzeigersinn)
    return [ux * r + vx * width * side, uy * r + vy * width * side];
  };
  const path = [];
  for (let k = 0; k < board; k += 1) {
    const next = (k + 1) % board;
    // Startfeld A und zwei Felder den eigenen Arm hinein
    path.push(point(k, outer, 1), point(k, outer - 1, 1), point(k, inner, 1));
    // drei Felder hinüber zum nächsten Arm
    const from = point(k, inner, 1);
    const to = point(next, inner, -1);
    for (let i = 1; i <= 3; i += 1) path.push([from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4]);
    // am nächsten Arm hinaus und über die Spitze
    path.push(point(next, inner, -1), point(next, inner + 1, -1), point(next, outer, -1), point(next, outer, 0));
  }
  const goals = Array.from({ length: board }, (_, k) => Array.from({ length: GOAL }, (__, i) => point(k, outer - 1 - i, 0)));
  const houses = Array.from({ length: board }, (_, k) => {
    // Haus in der Lücke neben dem eigenen Startfeld
    const a = angle(k) + Math.PI / 5.2;
    const [ux, uy] = unit(a);
    const [vx, vy] = unit(a + Math.PI / 2);
    const cx = ux * 8.1;
    const cy = uy * 8.1;
    return [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].map(([r, s]) => [cx + ux * r + vx * s, cy + uy * r + vy * s]);
  });
  const rest = Array.from({ length: board }, (_, k) => {
    const [ux, uy] = unit(angle(k) + Math.PI / board);
    return [ux * 2.6, uy * 2.6];
  });
  return {
    board,
    path,
    goals,
    houses,
    armAngle: Array.from({ length: board }, (_, k) => angle(k)),
    extent: 10,
    shape: "hexagon",
    rest,
    words: [{ text: "Mensch", at: [0, -0.4], size: 1.9 }, { text: "ärgere Dich nicht", at: [0, 1.1], size: 0.9 }]
  };
}

const LAYOUTS = { 4: fourLayout(), 6: sixLayout() };

export function layoutFor(board) {
  return LAYOUTS[board] ?? LAYOUTS[4];
}

/** Punkt einer Figur: Haus, Laufbahn oder Ziel */
export function cellOf(layout, seat, index, progress) {
  const track = layout.board * SEGMENT;
  if (progress === HOME) return layout.houses[seat][index];
  if (progress >= track) return layout.goals[seat][progress - track];
  return layout.path[(seat * SEGMENT + progress) % track];
}
