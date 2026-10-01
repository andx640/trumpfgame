const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");
const cards = require("./cards.json");
const {
  CATEGORIES,
  chooseCategory,
  nextRound,
  selectAutomaticCategory,
  startGame
} = require("./game-engine");

const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const TURN_DURATION_MS = 30_000;
const REVEAL_DURATION_MS = 6_000;
const MAX_PLAYERS = 4;
const CARD_COUNT_OPTIONS = Object.freeze([8, 16, 32]);

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  maxHttpBufferSize: 100_000
});
const rootDirectory = __dirname;
const distDirectory = path.join(rootDirectory, "dist");

app.use("/cardimages", express.static(path.join(rootDirectory, "cardimages")));
app.use("/images", express.static(path.join(rootDirectory, "images")));
app.use("/works", express.static(path.join(rootDirectory, "works")));
if (fs.existsSync(distDirectory)) {
  app.use(express.static(distDirectory));
  app.get("*", (_request, response) => response.sendFile(path.join(distDirectory, "index.html")));
} else {
  app.get("/", (_request, response) => {
    response
      .status(503)
      .send("Frontend noch nicht gebaut. Nutze `npm run dev` oder führe zuerst `npm run build` aus.");
  });
}

const room = {
  status: "lobby",
  players: [],
  hostId: null,
  cardsPerPlayer: 32,
  game: null
};

let phaseTimer = null;

function cleanName(value) {
  return String(value || "").slice(0, 100).trim().replace(/\s+/g, " ").slice(0, 20);
}

function playerBySocket(socketId) {
  return room.players.find((player) => player.socketId === socketId);
}

function publicStateFor(player) {
  const game = room.game;
  return {
    selfId: player.id,
    status: room.status,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    cardsPerPlayer: room.cardsPerPlayer,
    cardCountOptions: CARD_COUNT_OPTIONS,
    categories: CATEGORIES,
    players: room.players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      isHost: entry.id === room.hostId,
      connected: entry.connected,
      cardCount: entry.hand?.length || 0,
      eliminated: room.status !== "lobby" && (entry.hand?.length || 0) === 0
    })),
    game: game
      ? {
          phase: game.phase,
          round: game.round,
          cardsPerPlayer: game.cardsPerPlayer,
          activePlayerId: game.activePlayerId,
          category: game.category,
          tableCards: game.phase === "choosing" ? [] : game.tableCards,
          result: game.result,
          potCount: game.pot.length,
          winnerId: game.winnerId,
          turnEndsAt: game.turnEndsAt,
          revealEndsAt: game.revealEndsAt,
          ownCard: player.hand?.[0] || null,
          ownHand: player.hand || []
        }
      : null
  };
}

function sendState() {
  room.players.forEach((player) => {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit("state", publicStateFor(player));
    }
  });
}

function sendError(socket, message) {
  socket.emit("gameError", { message });
}

function clearPhaseTimer() {
  if (phaseTimer) {
    clearTimeout(phaseTimer);
    phaseTimer = null;
  }
}

function armTurnTimer() {
  clearPhaseTimer();
  if (!room.game || room.game.phase !== "choosing") return;

  room.game.turnEndsAt = Date.now() + TURN_DURATION_MS;
  phaseTimer = setTimeout(() => {
    const chooser = room.players.find((player) => player.id === room.game?.activePlayerId);
    if (!chooser?.hand?.[0] || room.game?.phase !== "choosing") return;
    revealCards(chooser.id, selectAutomaticCategory(chooser.hand[0]));
  }, TURN_DURATION_MS);
}

function armRevealTimer() {
  clearPhaseTimer();
  if (!room.game || room.game.phase !== "revealed") return;

  room.game.revealEndsAt = Date.now() + REVEAL_DURATION_MS;
  phaseTimer = setTimeout(() => {
    if (!room.game || !nextRound(room.game, room.players)) return;
    armTurnTimer();
    sendState();
  }, REVEAL_DURATION_MS);
}

function revealCards(playerId, category) {
  if (!room.game) return;
  try {
    chooseCategory(room.game, room.players, playerId, category);
  } catch (error) {
    const player = room.players.find((entry) => entry.id === playerId);
    const socket = player?.socketId ? io.sockets.sockets.get(player.socketId) : null;
    if (socket) sendError(socket, error.message);
    return;
  }

  clearPhaseTimer();
  if (room.game.phase === "finished") {
    room.status = "finished";
  } else {
    armRevealTimer();
  }
  sendState();
}

function beginGame() {
  clearPhaseTimer();
  room.game = startGame(room.players, cards, { cardsPerPlayer: room.cardsPerPlayer });
  room.status = "playing";
  armTurnTimer();
  sendState();
}

function transferHost() {
  const currentHost = room.players.find((player) => player.id === room.hostId);
  if (currentHost?.connected) return;
  room.hostId = room.players.find((player) => player.connected)?.id || room.players[0]?.id || null;
}

io.on("connection", (socket) => {
  socket.on("joinGame", ({ name, token } = {}, callback = () => {}) => {
    const requestedName = cleanName(name);
    let player = token ? room.players.find((entry) => entry.token === token) : null;

    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      if (requestedName && room.status === "lobby") player.name = requestedName;
      callback({ ok: true, token: player.token, reconnected: true });
      transferHost();
      sendState();
      return;
    }

    if (room.status !== "lobby") {
      callback({ ok: false, message: "Das Spiel läuft bereits. Warte auf die nächste Partie." });
      return;
    }
    if (!requestedName) {
      callback({ ok: false, message: "Bitte gib einen Spielernamen ein." });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      callback({ ok: false, message: "Die Lobby ist bereits voll." });
      return;
    }
    if (room.players.some((entry) => entry.name.toLowerCase() === requestedName.toLowerCase())) {
      callback({ ok: false, message: "Dieser Name ist bereits vergeben." });
      return;
    }

    player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString("hex"),
      socketId: socket.id,
      name: requestedName,
      connected: true,
      hand: []
    };
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    callback({ ok: true, token: player.token, reconnected: false });
    sendState();
  });

  socket.on("startGame", () => {
    const player = playerBySocket(socket.id);
    if (!player || player.id !== room.hostId) {
      sendError(socket, "Nur der Host kann das Spiel starten.");
      return;
    }
    if (room.status !== "lobby") {
      sendError(socket, "Das Spiel wurde bereits gestartet.");
      return;
    }
    if (room.players.length < 2) {
      sendError(socket, "Zum Starten werden mindestens zwei Spieler benötigt.");
      return;
    }
    beginGame();
  });

  socket.on("chooseCategory", (category) => {
    const player = playerBySocket(socket.id);
    if (!player || room.status !== "playing") {
      sendError(socket, "Du bist aktuell in keinem laufenden Spiel.");
      return;
    }
    revealCards(player.id, category);
  });

  socket.on("setCardsPerPlayer", (value) => {
    const player = playerBySocket(socket.id);
    const cardsPerPlayer = Number(value);
    if (!player || player.id !== room.hostId) {
      sendError(socket, "Nur der Host kann die Kartenzahl festlegen.");
      return;
    }
    if (room.status !== "lobby") {
      sendError(socket, "Die Kartenzahl kann nur in der Lobby geändert werden.");
      return;
    }
    if (!CARD_COUNT_OPTIONS.includes(cardsPerPlayer)) {
      sendError(socket, "Wähle 8, 16 oder 32 Karten pro Spieler.");
      return;
    }
    room.cardsPerPlayer = cardsPerPlayer;
    sendState();
  });

  socket.on("playAgain", () => {
    const player = playerBySocket(socket.id);
    if (!player || player.id !== room.hostId) {
      sendError(socket, "Nur der Host kann die nächste Partie starten.");
      return;
    }
    if (room.status !== "finished") {
      sendError(socket, "Die aktuelle Partie ist noch nicht beendet.");
      return;
    }
    const connectedPlayers = room.players.filter((entry) => entry.connected);
    if (connectedPlayers.length < 2) {
      sendError(socket, "Für eine neue Partie müssen mindestens zwei Spieler verbunden sein.");
      return;
    }
    room.players = connectedPlayers;
    beginGame();
  });

  socket.on("leaveLobby", () => {
    if (room.status !== "lobby") return;
    const player = playerBySocket(socket.id);
    if (!player) return;
    room.players = room.players.filter((entry) => entry.id !== player.id);
    transferHost();
    sendState();
  });

  socket.on("requestState", () => {
    const player = playerBySocket(socket.id);
    if (player) socket.emit("state", publicStateFor(player));
  });

  socket.on("disconnect", () => {
    const player = playerBySocket(socket.id);
    if (!player) return;

    if (room.status === "lobby") {
      room.players = room.players.filter((entry) => entry.id !== player.id);
    } else {
      player.connected = false;
      player.socketId = null;
    }
    transferHost();
    sendState();
  });
});

httpServer.listen(PORT, () => {
  const address = httpServer.address();
  console.log(`Pitlane Trumpf läuft auf http://localhost:${address.port}`);
});

function shutdown() {
  clearPhaseTimer();
  return new Promise((resolve) => io.close(resolve));
}

module.exports = { app, httpServer, room, shutdown };
