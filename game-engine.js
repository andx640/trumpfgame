const CATEGORIES = Object.freeze({
  leistung: { label: "Leistung", unit: "PS", direction: "high", icon: "bolt" },
  hubraum: { label: "Hubraum", unit: "cm³", direction: "high", icon: "engine" },
  hoechstgeschwindigkeit: {
    label: "Höchstgeschwindigkeit",
    unit: "km/h",
    direction: "high",
    icon: "speed"
  },
  beschleunigung: {
    label: "0–100 km/h",
    unit: "s",
    direction: "low",
    icon: "timer"
  },
  drehmoment: { label: "Drehmoment", unit: "Nm", direction: "high", icon: "torque" },
  gewicht: { label: "Gewicht", unit: "kg", direction: "low", icon: "weight" },
  preis: { label: "Preis", unit: "€", direction: "high", icon: "price" }
});

const imageCatalog = require("./card-images.json");

const LOCAL_CARD_IMAGES = Object.freeze({
  "Audi R8 V10 Performance": "/cardimages/audi_r8_performance.png",
  "Audi RS6 Avant": "/cardimages/audi_rs6_performance.png",
  "Lamborghini Huracán EVO": "/cardimages/lamborghini_huracan_evo.png"
});

function shuffle(cards, random = Math.random) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function prepareDeck(cards) {
  const ids = new Set();
  const names = new Set();
  return cards.map((card) => {
    if (!card?.c_id || ids.has(card.c_id)) {
      throw new Error(`Ungültige oder doppelte Karten-ID: ${card?.c_id || "fehlt"}`);
    }
    ids.add(card.c_id);
    const normalizedName = String(card.name || "").trim().toLocaleLowerCase("de");
    if (!normalizedName || names.has(normalizedName)) {
      throw new Error(`Ungültiger oder doppelter Kartenname: ${card.name || "fehlt"}`);
    }
    names.add(normalizedName);
    for (const category of Object.keys(CATEGORIES)) {
      if (card[category] === null || card[category] === "" || !Number.isFinite(Number(card[category]))) {
        throw new Error(`Karte ${card.c_id} hat keinen gültigen Wert für ${category}.`);
      }
    }
    const imageInfo = imageCatalog[card.c_id];
    return {
      ...card,
      image: imageInfo?.localImage || imageInfo?.image || LOCAL_CARD_IMAGES[card.name] || null,
      imageMeta: imageInfo
        ? {
            pageUrl: imageInfo.pageUrl,
            source: imageInfo.source,
            author: imageInfo.author,
            license: imageInfo.license,
            licenseUrl: imageInfo.licenseUrl
          }
        : null
    };
  });
}

function startGame(players, sourceDeck, options = {}) {
  if (players.length < 2 || players.length > 4) {
    throw new Error("Ein Spiel benötigt 2 bis 4 Spieler.");
  }

  const normalizedOptions = typeof options === "function" ? { random: options } : options;
  const cardsPerPlayer = Number(normalizedOptions.cardsPerPlayer ?? 32);
  const random = normalizedOptions.random || Math.random;
  if (![8, 16, 32].includes(cardsPerPlayer)) {
    throw new Error("Pro Spieler sind nur 8, 16 oder 32 Karten erlaubt.");
  }

  const neededCards = players.length * cardsPerPlayer;
  const deck = prepareDeck(sourceDeck);
  if (deck.length < neededCards) {
    throw new Error(`Für diese Partie werden ${neededCards} unterschiedliche Karten benötigt.`);
  }

  const cards = shuffle(deck, random).slice(0, neededCards);
  players.forEach((player) => {
    player.hand = [];
  });
  cards.forEach((card, index) => {
    players[index % players.length].hand.push(card);
  });

  return {
    phase: "choosing",
    round: 1,
    cardsPerPlayer,
    activePlayerId: players[0].id,
    category: null,
    tableCards: [],
    pot: [],
    result: null,
    winnerId: null,
    turnEndsAt: null,
    revealEndsAt: null
  };
}

function chooseCategory(game, players, playerId, category) {
  if (game.phase !== "choosing") {
    throw new Error("In dieser Spielphase kann keine Kategorie gewählt werden.");
  }
  if (game.activePlayerId !== playerId) {
    throw new Error("Du bist noch nicht am Zug.");
  }
  if (!CATEGORIES[category]) {
    throw new Error("Diese Kategorie gibt es nicht.");
  }

  const contenders = players.filter((player) => player.hand.length > 0);
  if (contenders.length < 2) {
    finishWithLastPlayer(game, contenders[0]);
    return game.result;
  }

  const tableCards = contenders.map((player) => ({
    playerId: player.id,
    card: player.hand.shift()
  }));
  const values = tableCards.map(({ card }) => Number(card[category]));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Mindestens eine Karte hat für diese Kategorie keinen gültigen Wert.");
  }

  const rule = CATEGORIES[category];
  const bestValue = rule.direction === "low" ? Math.min(...values) : Math.max(...values);
  const winnerIds = tableCards
    .filter(({ card }) => Number(card[category]) === bestValue)
    .map(({ playerId: id }) => id);

  game.category = category;
  game.tableCards = tableCards;
  game.phase = "revealed";
  game.turnEndsAt = null;

  if (winnerIds.length === 1) {
    const winner = players.find((player) => player.id === winnerIds[0]);
    winner.hand.push(...game.pot, ...tableCards.map(({ card }) => card));
    game.pot = [];
    game.activePlayerId = winner.id;
    game.result = {
      type: "winner",
      winnerIds,
      value: bestValue,
      collectedCards: tableCards.length
    };
  } else {
    game.pot.push(...tableCards.map(({ card }) => card));
    const currentChooser = players.find((player) => player.id === game.activePlayerId);
    const nextChooser = currentChooser?.hand.length
      ? currentChooser
      : players.find((player) => winnerIds.includes(player.id) && player.hand.length > 0) ||
        players.find((player) => player.hand.length > 0);

    game.activePlayerId = nextChooser?.id || winnerIds[0];
    game.result = {
      type: "tie",
      winnerIds,
      value: bestValue,
      collectedCards: 0
    };
  }

  const remainingPlayers = players.filter((player) => player.hand.length > 0);
  if (remainingPlayers.length === 1) {
    const winner = remainingPlayers[0];
    winner.hand.push(...game.pot);
    game.pot = [];
    finishWithLastPlayer(game, winner);
  } else if (remainingPlayers.length === 0) {
    const winner = players.find((player) => player.id === winnerIds[0]);
    winner.hand.push(...game.pot);
    game.pot = [];
    finishWithLastPlayer(game, winner);
  }

  return game.result;
}

function finishWithLastPlayer(game, player) {
  game.phase = "finished";
  game.winnerId = player?.id || null;
  game.activePlayerId = player?.id || null;
  game.turnEndsAt = null;
  game.revealEndsAt = null;
  game.result = {
    type: "gameOver",
    winnerIds: player ? [player.id] : [],
    value: null,
    collectedCards: 0
  };
}

function nextRound(game, players) {
  if (game.phase !== "revealed") {
    return false;
  }

  const activePlayer = players.find(
    (player) => player.id === game.activePlayerId && player.hand.length > 0
  );
  const fallback = players.find((player) => player.hand.length > 0);
  if (!activePlayer && !fallback) {
    finishWithLastPlayer(game, null);
    return false;
  }

  game.phase = "choosing";
  game.round += 1;
  game.activePlayerId = activePlayer?.id || fallback.id;
  game.category = null;
  game.tableCards = [];
  game.result = null;
  game.revealEndsAt = null;
  return true;
}

function selectAutomaticCategory(card) {
  const entries = Object.entries(CATEGORIES).filter(([key]) => Number.isFinite(Number(card?.[key])));
  if (!entries.length) {
    return Object.keys(CATEGORIES)[0];
  }

  // Ohne Kenntnis fremder Karten ist eine zufällige gültige Wahl am fairsten.
  return entries[Math.floor(Math.random() * entries.length)][0];
}

module.exports = {
  CATEGORIES,
  chooseCategory,
  nextRound,
  prepareDeck,
  selectAutomaticCategory,
  shuffle,
  startGame
};
