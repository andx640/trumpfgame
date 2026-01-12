const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.io Server mit CORS für lokale Tests
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET","POST"]
  }
});

io.on("connection", (socket) => {
  console.log("Client verbunden:", socket.id);

  // Nachricht empfangen (mit Farbe)
  socket.on("message", (data) => {
    // data = { text, color }
    io.emit("message", data); // An alle Clients senden
  });

  socket.on("disconnect", () => {
    console.log("Client getrennt:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server läuft auf http://localhost:3000");
});
