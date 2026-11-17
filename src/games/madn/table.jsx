import { useEffect, useRef, useState } from "react";
import { BackIcon, Button } from "../../ui";
import { playFlip, playImpact, playLose, playTurn, playWin } from "../../sound";
import { COLORS, SEATS, TRACK, currentSeat, legalMoves } from "./engine";
import { GOALS, HOUSES, PATH, cellOf } from "./layout";
import Board3D from "./Board3D";

// Gemeinsame Ansicht für Partien am Gerät und online: Kopfzeile, Brett, Würfel, Spielerleiste, Ergebnis.

export function Header({ onBack, backLabel = "Zurück", title = "Mensch ärgere dich nicht", children }) {
  return (
    <header className="madn-header">
      <Button size="sm" onClick={onBack} iconStart={<BackIcon />}>{backLabel}</Button>
      <h1 className="madn-title">{title}</h1>
      <div className="madn-header-end">{children}</div>
    </header>
  );
}

const CELL = 10;

function nameOf(game, seat) {
  return game.players.find((p) => p.seat === seat)?.name ?? COLORS[seat].name;
}

/** Spielgeräusche aus den Zustandsänderungen. mine(seat): gehört dieser Platz zu diesem Gerät? */
export function useGameSounds(game, mine) {
  const previous = useRef(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = game;
    if (!game) return;
    const turnKey = `${game.turn}-${game.current}-${game.phase === "roll" ? "r" : ""}`;
    const moveKey = `${game.lastRoll?.n ?? 0}-${game.lastMove ? "m" : ""}`;
    if (!before) return;
    const beforeMoveKey = `${before.lastRoll?.n ?? 0}-${before.lastMove ? "m" : ""}`;
    if (game.lastMove && moveKey !== beforeMoveKey) {
      if (game.lastMove.capture) playImpact(2);
      else playFlip();
    }
    if (game.phase === "over" && before.phase !== "over") {
      if (mine(game.ranking[0])) playWin();
      else playLose();
      return;
    }
    const beforeTurnKey = `${before.turn}-${before.current}-${before.phase === "roll" ? "r" : ""}`;
    if (game.phase === "roll" && turnKey !== beforeTurnKey && before.current !== game.current && mine(currentSeat(game))) playTurn();
  }, [game]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Spieltisch.
 * controls(seat)  – darf dieses Gerät für den Platz würfeln und ziehen?
 * rolling         – Würfel wird gerade geworfen
 * seatInfo(seat)  – optional { online, you } für die Spielerleiste
 * timeLeft        – optional Sekunden für den eigenen Zug (online)
 * viewSeat        – von welcher Seite die Kamera aufs Brett schaut
 * onDiceBusy(b)   – meldet, ob der Würfel gerade noch rollt
 */
export function Table({ game, controls, rolling, onRoll, onMove, seatInfo, timeLeft = null, busy = false, viewSeat, onDiceBusy }) {
  const seat = currentSeat(game);
  const player = game.players[game.current];
  const mineNow = controls(seat);
  const over = game.phase === "over";

  // Solange der Würfel noch übers Brett rollt, ist die Zahl „geheim“ und es wird nicht gezogen.
  const rollN = game.lastRoll?.n ?? 0;
  const [settledN, setSettledN] = useState(rollN);
  const diceBusy = rollN !== settledN;
  useEffect(() => {
    onDiceBusy?.(diceBusy);
  }, [diceBusy]); // eslint-disable-line react-hooks/exhaustive-deps

  const moves = legalMoves(game);
  const movable = mineNow && !busy && !diceBusy && game.phase === "move" ? new Set(moves.map((m) => m.index)) : null;
  const canRoll = !over && mineNow && !rolling && !busy && !diceBusy && game.phase === "roll";

  const status = (() => {
    if (over) return null;
    if (diceBusy && game.lastRoll) {
      const rollerYou = seatInfo?.(game.lastRoll.seat)?.you;
      return <><b className={`madn-name is-${COLORS[game.lastRoll.seat].key}`}>{rollerYou ? "Du" : nameOf(game, game.lastRoll.seat)}</b> {rollerYou ? "würfelst" : "würfelt"} …</>;
    }
    const you = seatInfo?.(seat)?.you;
    const name = <b className={`madn-name is-${COLORS[seat].key}`}>{you ? "Du" : player.name}</b>;
    const clock = mineNow && timeLeft !== null && timeLeft <= 20 ? <span className="madn-clock"> · {timeLeft}s</span> : null;
    const rolled = game.lastRoll ? <span className="madn-rolled">{game.lastRoll.value}</span> : null;
    if (rolling) return <>{name} {you ? "würfelst" : "würfelt"} …</>;
    if (game.phase === "move") {
      return mineNow
        ? <>{rolled} {name}: {moves.length === 1 ? "Figur antippen" : "welche Figur?"}{clock}</>
        : <>{rolled} {name} {you ? "ziehst" : "zieht"} …</>;
    }
    const last = game.lastRoll;
    const missed = last && last.seat !== seat && !game.lastMove
      ? <span className="madn-missed">{seatInfo?.(last.seat)?.you ? "Du konntest" : `${nameOf(game, last.seat)} konnte`} nicht ziehen. </span>
      : null;
    const tries = game.rollsLeft > 1 ? ` (${game.rollsLeft} Versuche)` : "";
    if (!mineNow) return <>{missed}{name} ist dran</>;
    return <>{missed}{name} {you ? "bist" : "ist"} dran: würfeln{tries}{clock}</>;
  })();

  return (
    <section className="madn-game">
      <p className="madn-status" role="status">{status}</p>
      <div className="madn-board-wrap">
        <Board3D
          game={game}
          movable={movable}
          viewSeat={viewSeat ?? seat}
          waiting={rolling}
          canRoll={canRoll}
          onPick={onMove}
          onRoll={onRoll}
          onSettled={setSettledN}
          fallback={<BoardSvg game={game} movable={movable} onPick={onMove} />}
        />
        {movable && (
          <div className="madn-sr-only">
            {[...movable].map((index) => (
              <button type="button" key={index} onClick={() => onMove(index)}>{COLORS[seat].name} Figur {index + 1} ziehen</button>
            ))}
          </div>
        )}
      </div>
      <div className="madn-controls">
        <button
          type="button"
          className={`madn-roll is-${COLORS[seat].key} ${canRoll ? "is-ready" : ""}`}
          onClick={canRoll ? onRoll : undefined}
          disabled={!canRoll}
        >
          <DieFace value={diceBusy || !game.lastRoll ? 6 : game.lastRoll.value} />
          <span>{canRoll ? "Würfeln" : diceBusy || rolling ? "rollt …" : game.lastRoll ? `Gewürfelt: ${game.lastRoll.value}` : "Würfel"}</span>
        </button>
        <div className="madn-players">
          {game.players.map((p, index) => {
            const info = seatInfo?.(p.seat) ?? {};
            const done = game.finished.includes(p.seat);
            return (
              <span key={p.seat} className={`madn-chip is-${COLORS[p.seat].key} ${index === game.current && !over ? "is-current" : ""} ${done ? "is-done" : ""} ${info.online === false ? "is-offline" : ""}`}>
                <i aria-hidden="true" />
                {p.name}{info.you ? " (du)" : ""}
                {info.online === false && <small>offline</small>}
                {done && <small>{game.finished.indexOf(p.seat) + 1}.</small>}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Ergebnis-Fenster; actions sind die Knöpfe darunter. */
export function Result({ game, seatInfo, children }) {
  const winner = game.ranking[0];
  return (
    <Overlay label="Ergebnis">
      <p className="madn-result-eyebrow">Partie beendet</p>
      <h2>{seatInfo?.(winner)?.you ? "Du gewinnst!" : `${nameOf(game, winner)} gewinnt!`}</h2>
      <ol>
        {game.ranking.map((s) => (
          <li key={s}><span className={`madn-dot is-${COLORS[s].key}`} aria-hidden="true" />{nameOf(game, s)}{seatInfo?.(s)?.you ? " (du)" : ""}</li>
        ))}
      </ol>
      <div className="madn-result-actions">{children}</div>
    </Overlay>
  );
}

export function Overlay({ label, children }) {
  return (
    <div className="madn-overlay" role="dialog" aria-modal="true" aria-label={label}>
      <div className="madn-result">{children}</div>
    </div>
  );
}

export function Confirm({ title, text, confirmLabel, onConfirm, onCancel }) {
  return (
    <Overlay label={title}>
      <h2>{title}</h2>
      {text && <p className="madn-lead">{text}</p>}
      <div className="madn-result-actions">
        <Button variant="primary" block onClick={onConfirm}>{confirmLabel}</Button>
        <Button block onClick={onCancel}>Weiterspielen</Button>
      </div>
    </Overlay>
  );
}

export function Rules() {
  return (
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
  );
}

function BoardSvg({ game, movable, onPick }) {
  const seats = new Set(game.players.map((p) => p.seat));
  const at = ([x, y]) => ({ cx: x * CELL + CELL / 2, cy: y * CELL + CELL / 2 });
  const last = game.lastMove;
  const turnSeat = currentSeat(game);

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
        const canMove = movable && seat === turnSeat && movable.has(index);
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
