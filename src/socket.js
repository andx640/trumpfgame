// Ersatz für Socket.IO: gleiche Schnittstelle (on/off/emit/connected), aber per HTTP-Polling gegen api/index.php.
const API_URL = import.meta.env.VITE_API_URL || "api/index.php";
const POLL_MS = 1_000;
const POLL_PLAYING_MS = 450; // während einer Partie öfter fragen, damit alle gleichzeitig aufdecken
const POLL_HIDDEN_MS = 4_000;
const RETRY_MS = 2_000;

// Ereignisname der Oberfläche -> Aktion der API
const ACTIONS = {
  joinGame: "join",
  leaveLobby: "leave",
  startGame: "start",
  chooseCategory: "choose",
  setCardsPerPlayer: "setCards",
  setTeams: "setTeams",
  playAgain: "again",
  readyForNext: "ready",
  requestState: "state"
};

class PollingSocket {
  constructor() {
    this.connected = false;
    this.listeners = new Map();
    this.token = null;
    this.room = null;
    this.version = 0;
    this.timer = null;
    this.clockOffset = 0;
    this.playing = false; // Serverzeit minus Gerätezeit, damit alle Timer gleich laufen
    this.poll();
  }

  /** aktuelle Serverzeit in ms */
  now() {
    return Date.now() + this.clockOffset;
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return this;
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  dispatch(event, payload) {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.dispatch(value ? "connect" : "disconnect");
  }

  async request(action, body = {}) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ action, token: this.token, room: this.room, ...body })
    });
    const result = await response.json();
    if (Number.isFinite(result.serverNow)) this.clockOffset = result.serverNow - Date.now();
    this.setConnected(true);
    return result;
  }

  applyResult(result) {
    if (result.code === "not_joined") {
      this.token = null;
      this.room = null;
      this.version = 0;
      this.playing = false;
      this.dispatch("state", null);
      return;
    }
    if (result.unchanged || result.version < this.version) return; // veraltete Antwort einer früheren Abfrage
    if (result.state !== undefined) {
      this.playing = result.state?.status === "playing";
      this.version = result.version;
      this.dispatch("state", result.state);
    }
  }

  emit(event, payload, callback) {
    const action = ACTIONS[event];
    if (!action) return this;

    let body = {};
    if (event === "joinGame") {
      if (payload?.room) this.room = payload.room;
      body = { name: payload?.name, token: payload?.token ?? this.token, room: payload?.room ?? this.room, create: payload?.create, authToken: payload?.authToken, ai: payload?.ai };
    }
    if (event === "chooseCategory") body = { category: payload };
    if (event === "setCardsPerPlayer") body = { count: payload };
    if (event === "setTeams") body = payload || {};

    this.request(action, body)
      .then((result) => {
        if (event === "joinGame") {
          this.token = result.ok ? result.token : null;
          this.room = result.ok ? result.room : null;
          this.version = 0;
        }
        if (event === "leaveLobby") {
          this.token = null;
          this.room = null;
          this.version = 0;
        }
        this.applyResult(result);
        if (!result.ok && event !== "joinGame" && event !== "requestState" && result.message) {
          this.dispatch("gameError", { message: result.message });
        }
        callback?.(result);
      })
      .catch(() => {
        this.setConnected(false);
        callback?.({ ok: false, message: "Keine Verbindung zum Server." });
      });
    return this;
  }

  async poll() {
    let delay = document.hidden ? POLL_HIDDEN_MS : this.playing ? POLL_PLAYING_MS : POLL_MS;
    try {
      const result = this.token
        ? await this.request("state", { since: this.version })
        : await this.request("ping");
      if (this.token || result.code === "not_joined") this.applyResult(result);
    } catch {
      this.setConnected(false);
      delay = RETRY_MS;
    }
    this.timer = window.setTimeout(() => this.poll(), delay);
  }
}

export const socket = new PollingSocket();
