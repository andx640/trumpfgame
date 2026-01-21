const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public")); // HTML, JS, CSS im public-Ordner

// Lobby & Spielstatus
let lobby = {
  players: [],       // { id, name, isHost, hand }
  hostId: null,
  gameStarted: false
};

// Auto-Deck (53 Karten) - sortiert nach Marke und Name
const deck = [
  // Audi
  {
    "c_id":"0001","name":"Audi R8 Performance",
    "leistung":620,
    "hubraum":5200,
    "hoechstgeschwindigkeit":331,
    "preis":149000,
    "beschleunigung":3.1,
    "gewicht":1670,
    "drehmoment":580,
    "drehzahl":8000,
    "picsrc":"cardimages/audi_r8_performance.png"
  },
  {
    "c_id":"0002",
    "name":"Audi RS6 Performance",
    "leistung":630,
    "hubraum":4000,
    "hoechstgeschwindigkeit":280,
    "preis":138500,
    "beschleunigung":3.4,
    "gewicht":2165,
    "drehmoment":850,
    "drehzahl":6000,
    "picsrc":"cardimages/audi_rs6_performance.png"
  },
  {
    "c_id":"0003",
    "name":"Lamborghini Huracán EVO",
    "leistung":640,
    "hubraum":5200,
    "hoechstgeschwindigkeit":325,
    "preis":260000,
    "beschleunigung":2.9,
    "gewicht":1422,
    "drehmoment":600,
    "drehzahl":8000,
    "picsrc":"cardimages/lamborghini_huracan_evo.png"
  },
  {
    "c_id":"0004",
    "name":"Lamborghini Huracán STO Underground Racing",
    "leistung":2000,
    "hubraum":5200,
    "hoechstgeschwindigkeit":350,
    "preis":1296000,
    "beschleunigung":2.0,
    "gewicht":1390,
    "drehmoment":2200,
    "drehzahl":8000,
    "picsrc":"cardimages/lamborghini_huracan_sto_ur.png"
  },
  {
    "c_id":"0005",
    "name":"Porsche 911 GT3 RS 992",
    "leistung":525,
    "hubraum":4000,
    "hoechstgeschwindigkeit":296,
    "preis":230000,
    "beschleunigung":3.3,
    "gewicht":1525,
    "drehmoment":465,
    "drehzahl":9000,
    "picsrc":"cardimages/porsche_911_gt3rs_992.png"
  },
];

// Shuffle-Funktion
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Karten austeilen
function dealCards(players) {
  const shuffledDeck = shuffle([...deck]); // Klon mischen
  players.forEach(player => {
    player.hand = shuffledDeck.splice(0, 16); // 16 Karten pro Spieler
  });
}

// Socket.io Events
io.on("connection", (socket) => {
  console.log("Client verbunden:", socket.id);

  socket.on("joinLobby", (name) => {
    const isHost = lobby.players.length === 0;
    if (isHost) lobby.hostId = socket.id;

    lobby.players.push({ id: socket.id, name, isHost, hand: [] });
    io.emit("lobbyUpdate", lobby.players);
  });

  socket.on("startGame", () => {
    if (socket.id !== lobby.hostId) return;

    lobby.gameStarted = true;
    dealCards(lobby.players);

    lobby.players.forEach(player => {
      io.to(player.id).emit("gameStarted", player.hand);
    });
  });

  socket.on("disconnect", () => {
    lobby.players = lobby.players.filter(p => p.id !== socket.id);

    if (socket.id === lobby.hostId && lobby.players.length > 0) {
      lobby.hostId = lobby.players[0].id;
      lobby.players[0].isHost = true;
    }

    io.emit("lobbyUpdate", lobby.players);
  });
});

server.listen(3000, () => {
  console.log("Server läuft auf Port 3000");
});
