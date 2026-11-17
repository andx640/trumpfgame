// Online-Partien laufen mit api/madn-engine.php, am Gerät mit engine.js. Beide müssen exakt gleich spielen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chooseMove, createGame, legalMoves, move, roll } from "../src/games/madn/engine.js";

const replay = fileURLToPath(new URL("./madn-replay.php", import.meta.url));

function play(seats, seed) {
  let n = seed;
  const random = () => (n = (n * 16807) % 2147483647);
  let state = createGame(seats);
  const states = [state];
  const actions = [];
  for (let steps = 0; state.phase !== "over" && steps < 4000; steps += 1) {
    if (state.phase === "roll") {
      const v = (random() % 6) + 1;
      actions.push({ t: "roll", v });
      state = roll(state, v);
    } else if (state.players[state.current].type === "ai") {
      actions.push({ t: "ai" });
      state = move(state, chooseMove(state).index);
    } else {
      const moves = legalMoves(state);
      const i = moves[random() % moves.length].index;
      actions.push({ t: "move", i });
      state = move(state, i);
    }
    states.push(state);
  }
  return { states, actions };
}

const setups = {
  "vier KI": [{ type: "ai" }, { type: "ai" }, { type: "ai" }, { type: "ai" }],
  "zwei Menschen gegenüber": [{ name: "A", type: "human" }, null, { name: "B", type: "human" }, null],
  "Mensch gegen drei KI": [{ name: "A", type: "human" }, { type: "ai" }, { type: "ai" }, { type: "ai" }],
  "drei gemischt": [null, { name: "B", type: "human" }, { type: "ai" }, { name: "D", type: "human" }],
  "sechs KI": [{ type: "ai" }, { type: "ai" }, { type: "ai" }, { type: "ai" }, { type: "ai" }, { type: "ai" }],
  "fünf gemischt (Sechser-Brett)": [{ name: "A", type: "human" }, { type: "ai" }, null, { type: "ai" }, { name: "E", type: "human" }, { type: "ai" }],
  "vier von sechs, Plätze 5 und 6 frei": [{ type: "ai" }, { type: "ai" }, { type: "ai" }, { type: "ai" }, null, null]
};

for (const [label, seats] of Object.entries(setups)) {
  for (const seed of [3, 42, 1234]) {
    test(`PHP und JS spielen gleich: ${label}, Startwert ${seed}`, () => {
      const { states, actions } = play(seats, seed);
      const output = execFileSync("php", [replay], { input: JSON.stringify({ seats, actions }), maxBuffer: 64 * 1024 * 1024 });
      const php = JSON.parse(output.toString());
      assert.equal(php.length, states.length);
      states.forEach((state, index) => assert.deepEqual(php[index], JSON.parse(JSON.stringify(state)), `Abweichung nach Aktion ${index}`));
    });
  }
}
