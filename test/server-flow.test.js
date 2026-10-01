const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { io: createClient } = require("socket.io-client");

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForState(socket, predicate, timeout = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("state", inspect);
      reject(new Error("Zeitüberschreitung beim Warten auf den Spielzustand."));
    }, timeout);
    const inspect = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off("state", inspect);
      resolve(state);
    };
    socket.on("state", inspect);
  });
}

test("zwei echte Socket-Clients erhalten private Karten und denselben Tisch", async () => {
  process.env.PORT = "0";
  const { httpServer, shutdown } = require("../server");
  if (!httpServer.listening) await once(httpServer, "listening");
  const port = httpServer.address().port;
  const clientA = createClient(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
  let clientB = createClient(`http://127.0.0.1:${port}`, { transports: ["websocket"] });

  try {
    await Promise.all([once(clientA, "connect"), once(clientB, "connect")]);
    const joinedA = await emitWithAck(clientA, "joinGame", { name: "Ada" });
    const lobbyForTwo = waitForState(clientA, (state) => state.players.length === 2);
    const joinedB = await emitWithAck(clientB, "joinGame", { name: "Ben" });
    assert.equal(joinedA.ok, true);
    assert.equal(joinedB.ok, true);
    await lobbyForTwo;

    const configuredA = waitForState(clientA, (state) => state.cardsPerPlayer === 8);
    const configuredB = waitForState(clientB, (state) => state.cardsPerPlayer === 8);
    clientA.emit("setCardsPerPlayer", 8);
    await Promise.all([configuredA, configuredB]);

    const startedA = waitForState(clientA, (state) => state.game?.phase === "choosing");
    const startedB = waitForState(clientB, (state) => state.game?.phase === "choosing");
    clientA.emit("startGame");
    const [stateA, stateB] = await Promise.all([startedA, startedB]);

    assert.equal(stateA.cardsPerPlayer, 8);
    assert.equal(stateA.players.reduce((sum, player) => sum + player.cardCount, 0), 16);
    assert.deepEqual(stateA.players.map((player) => player.cardCount), [8, 8]);
    assert.ok(stateA.game.ownCard);
    assert.ok(stateB.game.ownCard);
    assert.equal(stateA.game.ownHand.length, stateA.players.find((player) => player.id === stateA.selfId).cardCount);
    assert.equal(stateB.game.ownHand.length, stateB.players.find((player) => player.id === stateB.selfId).cardCount);
    assert.equal("hand" in stateA.players[0], false);
    assert.equal(stateA.game.tableCards.length, 0);
    assert.equal(stateB.game.tableCards.length, 0);

    const disconnectedState = waitForState(
      clientA,
      (state) => state.players.some((player) => player.name === "Ben" && !player.connected)
    );
    clientB.disconnect();
    await disconnectedState;
    clientB = createClient(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
    await once(clientB, "connect");
    const reconnectedState = waitForState(clientB, (state) => state.game?.phase === "choosing");
    const rejoinedB = await emitWithAck(clientB, "joinGame", { token: joinedB.token, name: "Ben" });
    const restoredB = await reconnectedState;
    assert.equal(rejoinedB.reconnected, true);
    assert.equal(restoredB.selfId, stateB.selfId);
    assert.equal(restoredB.game.ownCard.c_id, stateB.game.ownCard.c_id);

    const activeClient = stateA.game.activePlayerId === stateA.selfId ? clientA : clientB;
    const revealedA = waitForState(clientA, (state) => state.game?.phase === "revealed");
    const revealedB = waitForState(clientB, (state) => state.game?.phase === "revealed");
    activeClient.emit("chooseCategory", "leistung");
    const [tableA, tableB] = await Promise.all([revealedA, revealedB]);

    assert.equal(tableA.game.tableCards.length, 2);
    assert.deepEqual(tableA.game.tableCards, tableB.game.tableCards);
    assert.equal(tableA.game.category, "leistung");
    assert.equal(tableA.game.ownHand.length, tableA.players.find((player) => player.id === tableA.selfId).cardCount);
    assert.equal(tableB.game.ownHand.length, tableB.players.find((player) => player.id === tableB.selfId).cardCount);
  } finally {
    clientA.disconnect();
    clientB.disconnect();
    await shutdown();
  }
});
