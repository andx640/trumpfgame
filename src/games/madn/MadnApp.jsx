import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackIcon, Button, Segmented } from "../../ui";
import { playFlip, playImpact, playLose, playTurn, playWin, unlockAudio } from "../../sound";
import { COLORS, HOME, SEATS, TRACK, chooseMove, createGame, currentSeat, legalMoves, move, roll } from "./engine";
import "./madn.css";

// Mensch ärgere dich nicht: an einem Gerät reihum (Hot-Seat) oder gegen die KI.
// Die laufende Partie wird im Browser gespeichert und beim nächsten Öffnen fortgesetzt.

const SAVE_KEY = "andi-madn-game";
const SETUP_KEY = "andi-madn-setup";
const ROLL_MS = 520;
const AI_ROLL_MS = 650;
const AI_MOVE_MS = 550;
const AUTO_MOVE_MS = 450;

// Spielbrett: 11 × 11 Raster. Laufbahn im Uhrzeigersinn, Feld 0 ist das Startfeld von Rot.
const PATH = [
  [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [4, 3], [4, 2], [4, 1], [4, 0], [5, 0],
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [10, 5],
  [10, 6], [9, 6], [8, 6], [7, 6], [6, 6], [6, 7], [6, 8], [6, 9], [6, 10], [5, 10],
  [4, 10], [4, 9], [4, 8], [4, 7], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 5]
];
const GOALS = [
  [[1, 5], [2, 5], [3, 5], [4, 5]],
  [[5, 1], [5, 2], [5, 3], [5, 4]],
  [[9, 5], [8, 5], [7, 5], [6, 5]],
  [[5, 9], [5, 8], [5, 7], [5, 6]]
];
const HOUSES = [
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[9, 0], [10, 0], [9, 1], [10, 1]],
  [[9, 9], [10, 9], [9, 10], [10, 10]],
  [[0, 9], [1, 9], [0, 10], [1, 10]]
];
const CELL = 10;

function cellOf(seat, index, progress) {
  if (progress === HOME) return HOUSES[seat][index];
  if (progress >= TRACK) return GOALS[seat][progress - TRACK];
  return PATH[(seat * (TRACK / SEATS) + progress) % TRACK];
}

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

const DEFAULT_SETUP = [
  { type: "human", name: "" },
  { type: "ai", name: "" },
  { type: "ai", name: "" },
  { type: "ai", name: "" }
];

function rollDie() {
  if (window.crypto?.getRandomValues) {
    const buffer = new Uint8Array(1);
    do window.crypto.getRandomValues(buffer); while (buffer[0] >= 252);
    return (buffer[0] % 6) + 1;
  }
  return Math.floor(Math.random() * 6) + 1;
}

export default function MadnApp({ onExit }) {
  const [game, setGame] = useState(() => {
    const saved = load(SAVE_KEY);
    return saved && saved.players && saved.phase ? saved : null;
  });
  const [setup, setSetup] = useState(() => {
    const saved = load(SETUP_KEY);
    return Array.isArray(saved) && saved.length === SEATS ? saved : DEFAULT_SETUP;
  });

  useEffect(() => save(SAVE_KEY, game), [game]);
  useEffect(() => save(SETUP_KEY, setup), [setup]);

  const start = () => {
    unlockAudio();
    const seats = setup.map((seat, index) => (seat.type === "off" ? null : { type: seat.type, name: seat.name.trim() || (seat.type === "ai" ? `KI ${COLORS[index].name}` : COLORS[index].name) }));
    setGame(createGame(seats));
  };

  return (
    <div className="madn-shell">
      {game ? (
        <Board game={game} setGame={setGame} onExit={onExit} onNew={() => setGame(null)} onRematch={start} />
      ) : (
        <Setup setup={setup} setSetup={setSetup} onStart={start} onExit={onExit} />
      )}
    </div>
  );
}

function Header({ onExit, children }) {
  return (
    <header className="madn-header">
      <Button size="sm" onClick={onExit} iconStart={<BackIcon />}>Spiele</Button>
      <h1 className="madn-title">Mensch ärgere dich nicht</h1>
      <div className="madn-header-end">{children}</div>
    </header>
  );
}

const SEAT_OPTIONS = [
  { value: "human", label: "Mensch" },
  { value: "ai", label: "KI" },
  { value: "off", label: "Frei" }
];

function Setup({ setup, setSetup, onStart, onExit }) {
  const active = setup.filter((seat) => seat.type !== "off").length;
  const update = (index, patch) => setSetup((list) => list.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)));
  return (
    <>
      <Header onExit={onExit} />
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
        <details className="madn-rules">
          <summary>Spielregeln</summary>
          <ul>
            <li>Mit einer 6 kommt eine Figur aus dem Haus aufs Startfeld. Nach einer 6 wird nochmal gewürfelt.</li>
            <li>Wer keine Figur auf der Bahn hat, darf bis zu dreimal würfeln.</li>
            <li>Das eigene Startfeld muss geräumt werden, solange noch Figuren im Haus warten.</li>
            <li>Wer auf einer gegnerischen Figur landet, schlägt sie zurück ins Haus.</li>
            <li>Im Ziel darf nicht übersprungen werden. Wer zuerst alle vier Figuren im Ziel hat, gewinnt.</li>
          </ul>
        </details>
      </section>
    </>
  );
}

function Board({ game, setGame, onExit, onNew, onRematch }) {
  const [rolling, setRolling] = useState(false);
  const [face, setFace] = useState(game.dice || 6);
  const [lastRoll, setLastRoll] = useState(null); // { seat, value }
  const [confirmQuit, setConfirmQuit] = useState(false);
  const gameRef = useRef(game);
  gameRef.current = game;

  const seat = currentSeat(game);
  const player = game.players[game.current];
  const isAi = player.type === "ai";
  const moves = useMemo(() => legalMoves(game), [game]);
  const movable = new Set(moves.map((m) => m.index));
  const over = game.phase === "over";

  const doRoll = useCallback(() => {
    const state = gameRef.current;
    if (state.phase !== "roll") return;
    setRolling(true);
    const timer = window.setInterval(() => setFace(1 + Math.floor(Math.random() * 6)), 80);
    window.setTimeout(() => {
      window.clearInterval(timer);
      const value = rollDie();
      setFace(value);
      setRolling(false);
      setLastRoll({ seat: currentSeat(state), value });
      setGame((current) => (current === state ? roll(state, value) : current));
    }, ROLL_MS);
  }, [setGame]);

  const doMove = useCallback((index) => {
    const state = gameRef.current;
    const option = legalMoves(state).find((m) => m.index === index);
    if (!option) return;
    const next = move(state, index);
    if (option.capture) playImpact(2);
    else playFlip();
    if (next.phase === "over") {
      const humanWon = next.players.find((p) => p.seat === next.ranking[0])?.type === "human";
      if (humanWon) playWin();
      else playLose();
    }
    setGame(next);
  }, [setGame]);

  // KI-Züge und erzwungene Einzelzüge laufen von selbst
  useEffect(() => {
    if (over || rolling) return undefined;
    let timer;
    if (isAi && game.phase === "roll") timer = window.setTimeout(doRoll, AI_ROLL_MS);
    else if (isAi && game.phase === "move") timer = window.setTimeout(() => doMove(chooseMove(game).index), AI_MOVE_MS);
    else if (!isAi && game.phase === "move" && moves.length === 1) timer = window.setTimeout(() => doMove(moves[0].index), AUTO_MOVE_MS);
    return () => window.clearTimeout(timer);
  }, [game, isAi, over, rolling, moves, doRoll, doMove]);

  // Ton, wenn ein Mensch an der Reihe ist
  const turnKey = `${game.turn}-${game.current}`;
  useEffect(() => {
    if (!over && !isAi && game.phase === "roll") playTurn();
  }, [turnKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = (() => {
    if (over) return null;
    const name = <b className={`madn-name is-${COLORS[seat].key}`}>{player.name}</b>;
    if (rolling) return <>{name} würfelt …</>;
    if (game.phase === "move") return isAi ? <>{name} zieht …</> : <>{name}: Figur wählen</>;
    const missed = lastRoll && lastRoll.seat !== seat && !game.lastMove
      ? <span className="madn-missed">{game.players.find((p) => p.seat === lastRoll.seat)?.name} konnte nicht ziehen. </span>
      : null;
    const tries = game.rollsLeft > 1 ? ` (${game.rollsLeft} Versuche)` : "";
    return <>{missed}{name} ist dran{isAi ? "" : `: würfeln${tries}`}</>;
  })();

  const dieSeat = rolling ? seat : lastRoll?.seat ?? seat;
  const canRoll = !over && !isAi && !rolling && game.phase === "roll";

  return (
    <>
      <Header onExit={onExit}>
        <Button size="sm" variant="ghost" onClick={() => (over ? onNew() : setConfirmQuit(true))}>Neu</Button>
      </Header>
      <section className="madn-game">
        <p className="madn-status" role="status">{status}</p>
        <div className="madn-board-wrap">
          <BoardSvg game={game} movable={!isAi && game.phase === "move" ? movable : null} onPick={doMove} />
        </div>
        <div className="madn-controls">
          <button
            type="button"
            className={`madn-die is-${COLORS[dieSeat].key} ${rolling ? "is-rolling" : ""} ${canRoll ? "is-ready" : ""}`}
            onClick={canRoll ? doRoll : undefined}
            disabled={!canRoll}
            aria-label={canRoll ? "Würfeln" : `Würfel zeigt ${face}`}
          >
            <DieFace value={face} />
          </button>
          <div className="madn-players">
            {game.players.map((p, index) => (
              <span key={p.seat} className={`madn-chip is-${COLORS[p.seat].key} ${index === game.current && !over ? "is-current" : ""} ${game.finished.includes(p.seat) ? "is-done" : ""}`}>
                <i aria-hidden="true" />
                {p.name}
                {game.finished.includes(p.seat) && <small>{game.finished.indexOf(p.seat) + 1}.</small>}
              </span>
            ))}
          </div>
        </div>
      </section>

      {over && (
        <div className="madn-overlay" role="dialog" aria-modal="true" aria-label="Ergebnis">
          <div className="madn-result">
            <p className="madn-result-eyebrow">Partie beendet</p>
            <h2>{game.players.find((p) => p.seat === game.ranking[0])?.name} gewinnt!</h2>
            <ol>
              {game.ranking.map((s) => (
                <li key={s}><span className={`madn-dot is-${COLORS[s].key}`} aria-hidden="true" />{game.players.find((p) => p.seat === s)?.name}</li>
              ))}
            </ol>
            <div className="madn-result-actions">
              <Button variant="primary" block onClick={onRematch}>Nochmal spielen</Button>
              <Button block onClick={onNew}>Spieler ändern</Button>
              <Button variant="ghost" block onClick={onExit}>Zum Spiele-Menü</Button>
            </div>
          </div>
        </div>
      )}

      {confirmQuit && (
        <div className="madn-overlay" role="dialog" aria-modal="true" aria-label="Partie abbrechen">
          <div className="madn-result">
            <h2>Partie abbrechen?</h2>
            <p className="madn-lead">Der aktuelle Spielstand geht verloren.</p>
            <div className="madn-result-actions">
              <Button variant="primary" block onClick={() => { setConfirmQuit(false); onNew(); }}>Ja, neue Partie</Button>
              <Button block onClick={() => setConfirmQuit(false)}>Weiterspielen</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function BoardSvg({ game, movable, onPick }) {
  const seats = new Set(game.players.map((p) => p.seat));
  const at = ([x, y]) => ({ cx: x * CELL + CELL / 2, cy: y * CELL + CELL / 2 });
  const last = game.lastMove;

  return (
    <svg className="madn-board" viewBox={`0 0 ${11 * CELL} ${11 * CELL}`} role="img" aria-label="Spielbrett">
      <rect className="madn-board-bg" x="0.5" y="0.5" width={11 * CELL - 1} height={11 * CELL - 1} rx="6" />
      <polyline className="madn-path-line" points={[...PATH, PATH[0]].map(([x, y]) => `${x * CELL + CELL / 2},${y * CELL + CELL / 2}`).join(" ")} />
      {PATH.map((cell, index) => {
        const start = index % (TRACK / SEATS) === 0 ? index / (TRACK / SEATS) : null;
        return <circle key={`p${index}`} {...at(cell)} r="3.9" className={`madn-field ${start !== null ? `is-start is-${COLORS[start].key}` : ""}`} />;
      })}
      {GOALS.map((cells, s) => cells.map((cell, i) => (
        <circle key={`g${s}${i}`} {...at(cell)} r="3.9" className={`madn-field is-goal is-${COLORS[s].key} ${seats.has(s) ? "" : "is-unused"}`} />
      )))}
      {HOUSES.map((cells, s) => cells.map((cell, i) => (
        <circle key={`h${s}${i}`} {...at(cell)} r="3.9" className={`madn-field is-house is-${COLORS[s].key} ${seats.has(s) ? "" : "is-unused"}`} />
      )))}
      <circle {...at([5, 5])} r="2.2" className="madn-center" />

      {game.players.map(({ seat }) => game.pieces[seat].map((progress, index) => {
        const [x, y] = cellOf(seat, index, progress);
        const canMove = movable && seat === currentSeat(game) && movable.has(index);
        const isLast = last && last.seat === seat && last.index === index;
        return (
          <g
            key={`${seat}-${index}`}
            className={`madn-piece is-${COLORS[seat].key} ${canMove ? "is-movable" : ""} ${isLast ? "is-last" : ""}`}
            style={{ transform: `translate(${x * CELL + CELL / 2}px, ${y * CELL + CELL / 2}px)` }}
            onClick={canMove ? () => onPick(index) : undefined}
            role={canMove ? "button" : undefined}
            tabIndex={canMove ? 0 : undefined}
            aria-label={canMove ? `${COLORS[seat].name} Figur ${index + 1} ziehen` : undefined}
            onKeyDown={canMove ? (event) => (event.key === "Enter" || event.key === " ") && onPick(index) : undefined}
          >
            {canMove && <circle className="madn-piece-halo" r="4.8" />}
            <ellipse className="madn-piece-shadow" cx="0.5" cy="2.6" rx="3" ry="1.2" />
            <circle className="madn-piece-body" r="3" />
            <circle className="madn-piece-head" cy="-1.4" r="1.5" />
          </g>
        );
      }))}
    </svg>
  );
}

const PIPS = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]]
};

function DieFace({ value }) {
  return (
    <svg viewBox="0 0 4 4" aria-hidden="true">
      {(PIPS[value] || []).map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="0.38" />)}
    </svg>
  );
}
