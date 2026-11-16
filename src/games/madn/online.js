import { useCallback, useEffect, useRef, useState } from "react";

// Verbindung zur Online-API (api/madn.php). Der Browser fragt regelmäßig nach dem Stand (Polling), wie bei Trumpf.

const API_URL = import.meta.env.VITE_MADN_API_URL || "api/madn.php";
const SESSION_KEY = "andi-madn-online";
const NAME_KEY = "andi-madn-name";
const POLL_LOBBY_MS = 1200;
const POLL_PLAYING_MS = 600;
const POLL_HIDDEN_MS = 4000;
const RETRY_MS = 2500;

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return value && value.room && value.token ? value : null;
  } catch {
    return null;
  }
}

function writeSession(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ohne Speicher hält die Sitzung nur bis zum Neuladen
  }
}

/** Gibt es im Tab eine laufende Online-Sitzung? Dann öffnet die App direkt dieses Spiel. */
export function hasOnlineSession() {
  return readSession() !== null;
}

export function readName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

function storeName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // egal
  }
}

async function post(body) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body)
  });
  return response.json();
}

/**
 * Raum-Verbindung: state ist null (nicht im Raum) oder der Stand vom Server.
 * Liefert außerdem create/join/act/leave und den Abstand zur Serveruhr.
 */
export function useOnlineRoom() {
  const [session, setSession] = useState(readSession);
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const offset = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const apply = useCallback((result, forSession) => {
    if (Number.isFinite(result.serverNow)) offset.current = result.serverNow - Date.now();
    setConnected(true);
    if (sessionRef.current !== forSession) return; // inzwischen verlassen oder gewechselt
    if (result.code === "not_joined") {
      writeSession(null);
      setSession(null);
      setState(null);
      version.current = 0;
      setError(result.message || "Du bist nicht mehr in diesem Raum.");
      return;
    }
    if (result.state && result.version >= version.current) {
      version.current = result.version;
      setState(result.state);
    }
  }, []);

  // regelmäßig nachfragen, solange man in einem Raum ist
  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    let timer;
    const poll = async () => {
      let delay = document.hidden ? POLL_HIDDEN_MS : state?.status === "playing" ? POLL_PLAYING_MS : POLL_LOBBY_MS;
      try {
        const result = await post({ action: "state", room: session.room, token: session.token, since: version.current || undefined });
        if (alive) apply(result, session);
      } catch {
        if (alive) setConnected(false);
        delay = RETRY_MS;
      }
      if (alive) timer = window.setTimeout(poll, delay);
    };
    poll();
    const onVisible = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, state?.status, apply]);

  const enter = useCallback(async (body) => {
    setBusy(true);
    setError(null);
    try {
      const result = await post(body);
      if (!result.ok || !result.token) {
        setError(result.message || "Das hat nicht geklappt.");
        return false;
      }
      storeName(body.name);
      const next = { room: result.room, token: result.token };
      writeSession(next);
      version.current = 0;
      sessionRef.current = next;
      setSession(next);
      apply(result, next);
      return true;
    } catch {
      setError("Keine Verbindung zum Server.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const create = useCallback((name) => enter({ action: "create", name }), [enter]);
  const join = useCallback((room, name) => enter({ action: "join", room: room.trim().toUpperCase(), name }), [enter]);

  const act = useCallback(async (action, body = {}) => {
    const current = sessionRef.current;
    if (!current) return null;
    setBusy(true);
    try {
      const result = await post({ action, room: current.room, token: current.token, ...body });
      apply(result, current);
      if (!result.ok && result.code !== "not_joined") setError(result.message || "Das hat nicht geklappt.");
      return result;
    } catch {
      setConnected(false);
      setError("Keine Verbindung zum Server.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const leave = useCallback(() => {
    const current = sessionRef.current;
    writeSession(null);
    setSession(null);
    setState(null);
    version.current = 0;
    if (current) post({ action: "leave", room: current.room, token: current.token }).catch(() => {});
  }, []);

  const serverNow = useCallback(() => Date.now() + offset.current, []);

  return { room: session?.room ?? null, state, connected, error, setError, busy, create, join, act, leave, serverNow };
}
