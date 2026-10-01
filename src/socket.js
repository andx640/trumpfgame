import { io } from "socket.io-client";

// Ohne VITE_SOCKET_URL verbindet sich der Client mit dem Server, der die Seite ausliefert.
const serverUrl = import.meta.env.VITE_SOCKET_URL || undefined;

export const socket = io(serverUrl, {
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4_000
});
