// Tests der Spiellogik von Panzerkiste: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { TILE, W, createLevel, player, step, traceShot } from "../src/games/panzer/engine.js";

function seeded(seed) {
  let n = seed;
  return () => (n = (n * 16807) % 2147483647) / 2147483647;
}

const idle = { move: { x: 0, y: 0 } };

test("Level 1 lädt: Spieler, zwei Gegner, Kisten", () => {
  const state = createLevel(0, seeded(1));
  assert.equal(state.tanks.filter((t) => t.team === "enemy").length, 2);
  assert.ok(player(state));
  assert.ok(state.tiles.some((t) => t === TILE.CRATE));
});

test("Kugel prallt einmal ab und verschwindet beim zweiten Mal", () => {
  const state = createLevel(0, seeded(2));
  state.tanks = [player(state)];
  const me = player(state);
  me.x = 1.5;
  me.y = 1.5;
  step(state, { move: { x: 0, y: 0 }, aim: { x: 1.5, y: -5 }, fire: true }, 1 / 120);
  assert.equal(state.bullets.length, 1);
  let bounces = 0;
  for (let i = 0; i < 400 && state.bullets.length; i += 1) {
    step(state, idle, 1 / 120);
    bounces += state.events.filter((e) => e.type === "bounce").length;
    state.events = [];
  }
  assert.equal(bounces, 1);
});

test("Eigene Kugel trifft nach dem Abprall den Schützen", () => {
  const state = createLevel(0, seeded(3));
  state.tanks = [player(state)];
  const me = player(state);
  me.x = 1.5;
  me.y = 1.5;
  step(state, { move: { x: 0, y: 0 }, aim: { x: 1.5, y: -5 }, fire: true }, 1 / 120);
  for (let i = 0; i < 200 && me.alive; i += 1) step(state, idle, 1 / 120);
  assert.equal(me.alive, false);
});

test("Mine sprengt Pappkarton und Panzer in der Nähe", () => {
  const state = createLevel(0, seeded(4));
  const me = player(state);
  state.tanks = [me];
  state.tiles[7 * W + 5] = TILE.BOX;
  me.x = 4.5;
  me.y = 7.5;
  step(state, { move: { x: 0, y: 0 }, mine: true }, 1 / 120);
  assert.equal(state.mines.length, 1);
  for (let i = 0; i < 120 * 3; i += 1) step(state, { move: { x: -1, y: 0 } }, 1 / 120); // wegfahren
  for (let i = 0; i < 120 * 9; i += 1) step(state, idle, 1 / 120);
  assert.equal(state.tiles[7 * W + 5], TILE.EMPTY);
});

test("Gegner-KI: Partie läuft ohne Fehler, Wachposten trifft einen stillstehenden Spieler", () => {
  const rng = seeded(5);
  const state = createLevel(0, rng);
  const me = player(state);
  me.x = 16.5;
  me.y = 7.5; // direkt vor die Gegner gestellt
  for (let i = 0; i < 120 * 20 && state.status === "playing"; i += 1) step(state, idle, 1 / 120, rng);
  assert.equal(state.status, "lost");
});

test("Flugbahn-Vorschau erkennt Treffer", () => {
  const state = createLevel(0, seeded(6));
  const me = player(state);
  const enemy = state.tanks.find((t) => t.team === "enemy");
  enemy.x = me.x + 4;
  enemy.y = me.y;
  const shot = traceShot(state, me, 0, 6.5, 1);
  assert.equal(shot.hit?.id, enemy.id);
});
