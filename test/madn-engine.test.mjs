// Tests der Spiellogik von „Mensch ärgere dich nicht“: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOME, chooseMove, createGame, legalMoves, move, roll, trackField } from "../src/games/madn/engine.js";

const two = () => createGame([{ name: "A", type: "human" }, null, { name: "B", type: "human" }, null]);
const withPieces = (state, seat, pieces) => ({ ...state, pieces: state.pieces.map((list, i) => (i === seat ? pieces : list)) });

test("Startfelder liegen je zehn Felder auseinander", () => {
  assert.equal(trackField(0, 0), 0);
  assert.equal(trackField(1, 0), 10);
  assert.equal(trackField(2, 5), 25);
  assert.equal(trackField(3, 15), 5);
  assert.equal(trackField(0, HOME), null);
  assert.equal(trackField(0, 41), null);
});

test("ohne Figur auf der Bahn darf man dreimal würfeln", () => {
  let s = two();
  assert.equal(s.rollsLeft, 3);
  s = roll(s, 2);
  assert.equal(s.current, 0);
  assert.equal(s.phase, "roll");
  s = roll(s, 3);
  s = roll(s, 4);
  assert.equal(s.current, 1, "nach drei Fehlwürfen ist der Nächste dran");
});

test("eine 6 bringt eine Figur raus, danach wird nochmal gewürfelt", () => {
  let s = roll(two(), 6);
  assert.equal(s.phase, "move");
  assert.deepEqual(legalMoves(s).map((m) => m.to), [0]);
  s = move(s, 0);
  assert.equal(s.pieces[0][0], 0);
  assert.equal(s.current, 0);
  assert.equal(s.phase, "roll");
  assert.equal(s.rollsLeft, 1);
});

test("Startfeld muss geräumt werden, solange Figuren im Haus sind", () => {
  let s = withPieces(two(), 0, [0, 12, HOME, HOME]);
  s = { ...s, rollsLeft: 1 };
  s = roll(s, 3);
  assert.deepEqual(legalMoves(s).map((m) => m.index), [0]);
});

test("Schlagen schickt die gegnerische Figur ins Haus", () => {
  let s = withPieces(two(), 0, [5, HOME, HOME, HOME]);
  s = withPieces(s, 2, [28, HOME, HOME, HOME]); // Sitz 2: Feld (20 + 28) % 40 = 8
  s = { ...s, rollsLeft: 1 };
  s = roll(s, 3);
  const [m] = legalMoves(s);
  assert.deepEqual(m.capture, { seat: 2, index: 0 });
  s = move(s, 0);
  assert.equal(s.pieces[0][0], 8);
  assert.equal(s.pieces[2][0], HOME);
});

test("im Ziel wird nicht übersprungen und nicht über das Ende gezogen", () => {
  let s = withPieces(two(), 0, [38, 41, 43, 30]);
  s = { ...s, rollsLeft: 1 };
  s = roll(s, 4); // 38 -> 42 würde über 41 springen
  const moves = legalMoves(s).map((m) => m.index);
  assert.ok(!moves.includes(0));
  assert.ok(!moves.includes(1), "41 + 4 wäre hinter dem Ziel");
  assert.ok(moves.includes(3));
});

test("wer alle Figuren im Ziel hat, gewinnt; mit zwei Spielern ist die Partie vorbei", () => {
  let s = withPieces(two(), 0, [39, 41, 42, 43]);
  s = { ...s, rollsLeft: 1 };
  s = roll(s, 1);
  s = move(s, 0);
  assert.equal(s.phase, "over");
  assert.deepEqual(s.ranking, [0, 2]);
});

test("KI schlägt lieber, als einfach weiterzuziehen", () => {
  let s = withPieces(two(), 0, [5, 20, HOME, HOME]);
  s = withPieces(s, 2, [28, HOME, HOME, HOME]);
  s = { ...s, rollsLeft: 1 };
  s = roll(s, 3);
  assert.equal(chooseMove(s).index, 0);
});

test("KI-Partie läuft bis zum Ende durch", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) % 6 + 1;
  let s = createGame([{ type: "ai" }, { type: "ai" }, { type: "ai" }, { type: "ai" }]);
  for (let steps = 0; s.phase !== "over" && steps < 20000; steps += 1) {
    if (s.phase === "roll") s = roll(s, random());
    else s = move(s, chooseMove(s).index);
  }
  assert.equal(s.phase, "over");
  assert.equal(s.ranking.length, 4);
});

test("Sechser-Brett: 60 Felder, Startfelder 10 auseinander, Vierer-Brett ohne Platz 5 und 6", async () => {
  const { createGame, roll, move, trackField } = await import("../src/games/madn/engine.js");
  const six = createGame([{ type: "ai" }, null, null, null, { name: "E", type: "human" }, null]);
  assert.equal(six.pieces.length, 6);
  assert.equal(trackField(4, 0, 6), 40);
  assert.equal(trackField(5, 15, 6), 5);
  const four = createGame([{ type: "ai" }, null, { type: "ai" }, null, null, null]);
  assert.equal(four.pieces.length, 4);
  // im Ziel des Sechser-Bretts: Fortschritt 60..63
  let state = { ...six, pieces: six.pieces.map((p, i) => (i === 0 ? [58, -1, -1, -1] : p)) };
  state = roll(state, 5);
  state = move(state, 0);
  assert.equal(state.pieces[0][0], 63);
});
