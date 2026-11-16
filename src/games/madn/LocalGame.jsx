import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Segmented } from "../../ui";
import { unlockAudio } from "../../sound";
import { COLORS, SEATS, chooseMove, createGame, currentSeat, legalMoves, move, roll } from "./engine";
import { Confirm, Header, Result, Rules, Table, useGameSounds } from "./table";

// Partie an einem Gerät: Menschen reihum (Hot-Seat) und/oder gegen die KI. Alles läuft im Browser.
// Der Spielstand bleibt gespeichert, bis die Partie endet oder abgebrochen wird.

const SAVE_KEY = "andi-madn-game";
const SETUP_KEY = "andi-madn-setup";
const ROLL_MS = 520;
const AI_ROLL_MS = 650;
const AI_MOVE_MS = 550;
const AUTO_MOVE_MS = 450;

export const PRESETS = {
  ai: [{ type: "human", name: "" }, { type: "ai", name: "" }, { type: "ai", name: "" }, { type: "ai", name: "" }],
  device: [{ type: "human", name: "" }, { type: "off", name: "" }, { type: "human", name: "" }, { type: "off", name: "" }]
};

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ohne Speicher geht die Partie beim Neuladen verloren
  }
}

export function savedLocalGame() {
  const saved = load(SAVE_KEY);
  return saved && saved.players && saved.phase && saved.phase !== "over" ? saved : null;
}

function rollDie() {
  if (window.crypto?.getRandomValues) {
    const buffer = new Uint8Array(1);
    do window.crypto.getRandomValues(buffer); while (buffer[0] >= 252);
    return (buffer[0] % 6) + 1;
  }
  return Math.floor(Math.random() * 6) + 1;
}

/** preset: "ai" | "device" | "resume" */
export default function LocalGame({ preset, onBack }) {
  const [game, setGame] = useState(() => (preset === "resume" ? savedLocalGame() : null));
  const [setup, setSetup] = useState(() => {
    if (preset === "ai" || preset === "device") {
      // Namen von früher behalten, Aufstellung aus der Vorlage
      const names = load(SETUP_KEY);
      return PRESETS[preset].map((seat, index) => ({ ...seat, name: Array.isArray(names) ? names[index]?.name ?? "" : "" }));
    }
    const saved = load(SETUP_KEY);
    return Array.isArray(saved) && saved.length === SEATS ? saved : PRESETS.ai;
  });

  useEffect(() => {
    if (game) save(SAVE_KEY, game.phase === "over" ? null : game);
  }, [game]);
  useEffect(() => save(SETUP_KEY, setup), [setup]);

  const start = () => {
    unlockAudio();
    const seats = setup.map((seat, index) => (seat.type === "off" ? null : { type: seat.type, name: seat.name.trim() || (seat.type === "ai" ? `KI ${COLORS[index].name}` : COLORS[index].name) }));
    setGame(createGame(seats));
  };

  const quit = () => {
    save(SAVE_KEY, null);
    setGame(null);
  };

  return game
    ? <LocalTable game={game} setGame={setGame} onBack={onBack} onNew={quit} onRematch={start} />
    : <Setup setup={setup} setSetup={setSetup} onStart={start} onBack={onBack} />;
}

const SEAT_OPTIONS = [
  { value: "human", label: "Mensch" },
  { value: "ai", label: "KI" },
  { value: "off", label: "Frei" }
];

function Setup({ setup, setSetup, onStart, onBack }) {
  const active = setup.filter((seat) => seat.type !== "off").length;
  const update = (index, patch) => setSetup((list) => list.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)));
  return (
    <>
      <Header onBack={onBack} />
      <section className="madn-setup">
        <p className="madn-lead">Wähle für jede Farbe, wer spielt. Menschen spielen reihum an diesem Gerät.</p>
        <div className="madn-seats">
          {setup.map((seat, index) => (
            <div className={`madn-seat ${seat.type === "off" ? "is-off" : ""}`} key={COLORS[index].key}>
              <span className={`madn-dot is-${COLORS[index].key}`} aria-hidden="true" />
              <div className="madn-seat-body">
                <div className="madn-seat-head">
                  <strong>{COLORS[index].name}</strong>
                  <Segmented label={`Spieler ${COLORS[index].name}`} options={SEAT_OPTIONS} value={seat.type} onChange={(type) => update(index, { type })} className="madn-seat-type" />
                </div>
                {seat.type === "human" && (
                  <input
                    className="madn-input"
                    value={seat.name}
                    maxLength={16}
                    placeholder={`Name (${COLORS[index].name})`}
                    aria-label={`Name für ${COLORS[index].name}`}
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <Button variant="primary" size="lg" block disabled={active < 2} onClick={onStart}>
          {active < 2 ? "Mindestens zwei Spieler" : `Spiel starten · ${active} Spieler`}
        </Button>
        <Rules />
      </section>
    </>
  );
}

function LocalTable({ game, setGame, onBack, onNew, onRematch }) {
  const [rolling, setRolling] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const gameRef = useRef(game);
  gameRef.current = game;

  const isHuman = (seat) => game.players.find((p) => p.seat === seat)?.type === "human";
  useGameSounds(game, isHuman);

  const isAi = game.players[game.current].type === "ai";
  const over = game.phase === "over";

  const doRoll = useCallback(() => {
    const state = gameRef.current;
    if (state.phase !== "roll") return;
    setRolling(true);
    window.setTimeout(() => {
      setRolling(false);
      setGame((current) => (current === state ? roll(state, rollDie()) : current));
    }, ROLL_MS);
  }, [setGame]);

  const doMove = useCallback((index) => {
    setGame((state) => (legalMoves(state).some((m) => m.index === index) ? move(state, index) : state));
  }, [setGame]);

  // KI-Züge und erzwungene Einzelzüge laufen von selbst
  useEffect(() => {
    if (over || rolling) return undefined;
    const moves = legalMoves(game);
    let timer;
    if (isAi && game.phase === "roll") timer = window.setTimeout(doRoll, AI_ROLL_MS);
    else if (isAi && game.phase === "move") timer = window.setTimeout(() => doMove(chooseMove(game).index), AI_MOVE_MS);
    else if (!isAi && game.phase === "move" && moves.length === 1) timer = window.setTimeout(() => doMove(moves[0].index), AUTO_MOVE_MS);
    return () => window.clearTimeout(timer);
  }, [game, isAi, over, rolling, doRoll, doMove]);

  const onlyOneHuman = game.players.filter((p) => p.type === "human").length === 1;
  const seatInfo = onlyOneHuman ? (seat) => ({ you: isHuman(seat) }) : undefined;

  return (
    <>
      <Header onBack={onBack}>
        <Button size="sm" variant="ghost" onClick={() => (over ? onNew() : setConfirmQuit(true))}>Neu</Button>
      </Header>
      <Table game={game} controls={(seat) => isHuman(seat) && currentSeat(game) === seat} rolling={rolling} onRoll={doRoll} onMove={doMove} seatInfo={seatInfo} />

      {over && (
        <Result game={game} seatInfo={seatInfo}>
          <Button variant="primary" block onClick={onRematch}>Nochmal spielen</Button>
          <Button block onClick={onNew}>Spieler ändern</Button>
          <Button variant="ghost" block onClick={onBack}>Zurück</Button>
        </Result>
      )}
      {confirmQuit && (
        <Confirm
          title="Partie abbrechen?"
          text="Der aktuelle Spielstand geht verloren."
          confirmLabel="Ja, neue Partie"
          onConfirm={() => { setConfirmQuit(false); onNew(); }}
          onCancel={() => setConfirmQuit(false)}
        />
      )}
    </>
  );
}
