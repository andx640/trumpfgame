const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // erlaubt alle Clients
    methods: ["GET", "POST"]
  }
});

// Karten laden
const karten = JSON.parse(fs.readFileSync("karten.json"));

// Farben für Clients
const colors = ["red","blue","green","yellow"];
let clients = [];

io.on("connection", (socket) => {
  console.log("Client verbunden:", socket.id);

  // Client eine Farbe zuweisen
  clients.push(socket.id);
  const myColor = colors[clients.length - 1] || "gray";
  socket.emit("yourColor", myColor);

  // Zufällige zwei Karten an Client schicken
  const karte1 = karten[Math.floor(Math.random() * karten.length)];
  const karte2 = karten[Math.floor(Math.random() * karten.length)];
  socket.emit("karten", { karte1, karte2 });

  // Nachricht empfangen und an alle senden
  socket.on("message", (data) => {
    io.emit("message", data);
  });

  socket.on("disconnect", () => {
    const index = clients.indexOf(socket.id);
    if(index !== -1) clients.splice(index,1);
    console.log("Client getrennt:", socket.id);
  });
});

// HTTP Route für Testseite
app.get("/", (req,res) => {
  res.send("Server läuft, Socket.io bereit!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
