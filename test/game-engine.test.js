const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const productionDeck = require("../cards.json");
const imageCatalog = require("../card-images.json");
const {
  chooseCategory,
  nextRound,
  prepareDeck,
  startGame
} = require("../game-engine");

const card = (id, overrides = {}) => ({
  c_id: id,
  name: `Auto ${id}`,
  leistung: 500,
  hubraum: 3_000,
  hoechstgeschwindigkeit: 300,
  beschleunigung: 3.5,
  drehmoment: 600,
  gewicht: 1_500,
  preis: 100_000,
  ...overrides
});

function player(id) {
  return { id, name: id, hand: [] };
}

test("enthält mindestens 128 eindeutige Karten mit lokalem Echtbild", () => {
  assert.ok(productionDeck.length >= 128);
  assert.equal(new Set(productionDeck.map(({ c_id }) => c_id)).size, productionDeck.length);
  assert.equal(new Set(productionDeck.map(({ name }) => name)).size, productionDeck.length);
  for (const card of productionDeck) {
    const localImage = imageCatalog[card.c_id]?.localImage;
    assert.ok(localImage, `Lokales Bild für ${card.c_id} fehlt.`);
    assert.equal(fs.existsSync(path.join(__dirname, "..", localImage.replace(/^\//, ""))), true);
  }
});

test("teilt exakt 32 eindeutige Karten pro Client aus", () => {
  const players = [player("a"), player("b"), player("c"), player("d")];
  const deck = Array.from({ length: 128 }, (_, index) => card(String(index + 1)));
  const game = startGame(players, deck, { cardsPerPlayer: 32, random: () => 0.42 });

  assert.equal(game.phase, "choosing");
  assert.deepEqual(players.map(({ hand }) => hand.length), [32, 32, 32, 32]);
  assert.equal(new Set(players.flatMap(({ hand }) => hand.map(({ c_id }) => c_id))).size, 128);
});

test("zieht bei jeder Spieler- und Stapelgröße nur die benötigte Kartenmenge", () => {
  const deck = Array.from({ length: 160 }, (_, index) => card(String(index + 1)));
  for (const playerCount of [2, 3, 4]) {
    for (const cardsPerPlayer of [8, 16, 32]) {
      const players = Array.from({ length: playerCount }, (_, index) => player(String(index)));
      const game = startGame(players, deck, { cardsPerPlayer, random: () => 0.42 });
      const dealtCards = players.flatMap(({ hand }) => hand);

      assert.equal(game.cardsPerPlayer, cardsPerPlayer);
      assert.deepEqual(players.map(({ hand }) => hand.length), Array(playerCount).fill(cardsPerPlayer));
      assert.equal(dealtCards.length, playerCount * cardsPerPlayer);
      assert.equal(new Set(dealtCards.map(({ c_id }) => c_id)).size, dealtCards.length);
    }
  }
});

test("legt für zwei, drei und vier Spieler genau eine Karte je Fahrer auf den Tisch", () => {
  for (const playerCount of [2, 3, 4]) {
    const players = Array.from({ length: playerCount }, (_, index) => player(String(index)));
    players.forEach((entry, index) => {
      entry.hand = [card(`top-${index}`, { leistung: 500 + index }), card(`next-${index}`)];
    });
    const game = {
      phase: "choosing", round: 1, activePlayerId: "0", category: null,
      tableCards: [], pot: [], result: null, winnerId: null
    };

    chooseCategory(game, players, "0", "leistung");
    assert.equal(game.tableCards.length, playerCount);
    assert.deepEqual(game.tableCards.map(({ playerId }) => playerId), players.map(({ id }) => id));
  }
});

test("hoher Wert gewinnt eine normale Kategorie und bestimmt den nächsten Zug", () => {
  const players = [player("a"), player("b")];
  players[0].hand = [card("1", { leistung: 610 }), card("3")];
  players[1].hand = [card("2", { leistung: 720 }), card("4")];
  const game = {
    phase: "choosing", round: 1, activePlayerId: "a", category: null,
    tableCards: [], pot: [], result: null, winnerId: null
  };

  const result = chooseCategory(game, players, "a", "leistung");

  assert.equal(result.type, "winner");
  assert.deepEqual(result.winnerIds, ["b"]);
  assert.equal(game.activePlayerId, "b");
  assert.deepEqual(players.map(({ hand }) => hand.length), [1, 3]);
  assert.equal(game.tableCards.length, 2);
});

test("niedriger Wert gewinnt bei Beschleunigung und Gewicht", () => {
  for (const category of ["beschleunigung", "gewicht"]) {
    const players = [player("a"), player("b")];
    players[0].hand = [card("1", { [category]: 2.8 }), card("3")];
    players[1].hand = [card("2", { [category]: 3.2 }), card("4")];
    const game = {
      phase: "choosing", round: 1, activePlayerId: "a", category: null,
      tableCards: [], pot: [], result: null, winnerId: null
    };

    const result = chooseCategory(game, players, "a", category);
    assert.deepEqual(result.winnerIds, ["a"]);
  }
});

test("Gleichstand legt Karten in den Pot und der Folgesieger erhält alles", () => {
  const players = [player("a"), player("b")];
  players[0].hand = [card("1", { leistung: 600 }), card("3", { leistung: 800 }), card("5")];
  players[1].hand = [card("2", { leistung: 600 }), card("4", { leistung: 700 }), card("6")];
  const game = {
    phase: "choosing", round: 1, activePlayerId: "a", category: null,
    tableCards: [], pot: [], result: null, winnerId: null
  };

  const tie = chooseCategory(game, players, "a", "leistung");
  assert.equal(tie.type, "tie");
  assert.equal(game.pot.length, 2);
  assert.equal(nextRound(game, players), true);

  const win = chooseCategory(game, players, "a", "leistung");
  assert.deepEqual(win.winnerIds, ["a"]);
  assert.equal(game.pot.length, 0);
  assert.equal(players[0].hand.length, 5);
  assert.equal(players[1].hand.length, 1);
});

test("ergänzt Fahrzeugkarten um reale Bilder und Quellenmetadaten", () => {
  const deck = prepareDeck([
    card("0014", { name: "Lamborghini Huracán EVO" }),
    card("0001", { name: "Bugatti Chiron" })
  ]);

  assert.match(deck[0].image, /^\/cardimages\/cars\/0014\./);
  assert.match(deck[1].image, /^\/cardimages\/cars\/0001\./);
  assert.equal(deck[0].imageMeta.source, "Wikimedia Commons");
  assert.ok(deck[1].imageMeta.pageUrl);
});

test("weist ungültige Züge und unbekannte Kategorien zurück", () => {
  const players = [player("a"), player("b")];
  players[0].hand = [card("1"), card("3")];
  players[1].hand = [card("2"), card("4")];
  const game = {
    phase: "choosing", round: 1, activePlayerId: "a", category: null,
    tableCards: [], pot: [], result: null, winnerId: null
  };

  assert.throws(() => chooseCategory(game, players, "b", "leistung"), /noch nicht am Zug/);
  assert.throws(() => chooseCategory(game, players, "a", "farbe"), /Kategorie/);
  assert.deepEqual(players.map(({ hand }) => hand.length), [2, 2]);
});

test("weist fehlerhafte oder doppelte Kartendaten frühzeitig zurück", () => {
  assert.throws(() => prepareDeck([card("1"), card("1")]), /doppelte Karten-ID/);
  assert.throws(() => prepareDeck([card("1"), card("2", { name: "Auto 1" })]), /doppelter Kartenname/);
  assert.throws(() => prepareDeck([card("1", { gewicht: null })]), /keinen gültigen Wert/);
});
