import { useEffect, useRef, useState } from "react";
import { BackIcon, Button } from "../../ui";
import { playBoom, playBounce, playLose, playMineDrop, playShot, playWin, unlockAudio } from "../../sound";
import { createLevel, enemiesLeft, levelCount, step, TYPES } from "./engine";
import { LEVELS } from "./levels";
import { PanzerScene } from "./scene";
import "./panzer.css";

// Panzerkiste: Spielzeugpanzer in einer Holzkiste.
// PC: WASD/Pfeiltasten fahren, Maus zielt, Klick schießt, Leertaste/Rechtsklick legt eine Mine.
// Handy: Joystick links, Feuer- und Minenknopf rechts, Zielen durch Tippen irgendwo sonst.

const STEP = 1 / 120;
const START_LIVES = 3;
const INTRO_MS = 1800;
const END_MS = 1600;

export default function PanzerApp({ onExit }) {
  const [screen, setScreen] = useState("menu"); // menu | game
  return (
    <div className="pz-shell">
      {screen === "menu" ? <Menu onPlay={() => { unlockAudio(); setScreen("game"); }} onExit={onExit} /> : <Game onQuit={() => setScreen("menu")} />}
    </div>
  );
}

function Menu({ onPlay, onExit }) {
  return (
    <div className="pz-menu">
      <header className="pz-menu-top">
        <Button size="sm" onClick={onExit} iconStart={<BackIcon />}>Spiele</Button>
      </header>
      <div className="pz-menu-body">
        <TankLogo />
        <h1 className="pz-title">Panzerkiste</h1>
        <p className="pz-lead">Spielzeugpanzer in der Holzkiste. Kugeln prallen einmal von Wänden ab, Minen sprengen Pappkartons. Schalte alle Gegner aus, bevor sie dich erwischen.</p>
        <Button variant="primary" size="lg" onClick={onPlay}>Level 1 starten</Button>
        <div className="pz-help">
          <div>
            <h2>PC</h2>
            <ul>
              <li><b>WASD</b> oder <b>Pfeiltasten</b>: fahren</li>
              <li><b>Maus</b>: zielen · <b>Klick</b>: schießen</li>
              <li><b>Leertaste</b> oder <b>Rechtsklick</b>: Mine legen</li>
              <li><b>P</b> oder <b>Esc</b>: Pause</li>
            </ul>
          </div>
          <div>
            <h2>Handy (quer halten)</h2>
            <ul>
              <li><b>Joystick links</b>: fahren</li>
              <li><b>Irgendwo tippen</b>: dorthin zielen</li>
              <li><b>Feuer-Knopf</b>: schießen · <b>Mine</b>: Mine legen</li>
            </ul>
          </div>
        </div>
        <div className="pz-enemies">
          {Object.entries(TYPES).filter(([key]) => key !== "player").map(([key, spec]) => (
            <span key={key} className="pz-enemy-chip"><i style={{ background: spec.color }} />{spec.name}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TankLogo() {
  return (
    <svg className="pz-logo" viewBox="0 0 120 70" aria-hidden="true">
      <rect x="8" y="44" width="104" height="18" rx="9" fill="#2a2a2a" />
      {[20, 38, 56, 74, 92].map((x) => <circle key={x} cx={x + 4} cy="53" r="6" fill="#555" />)}
      <rect x="14" y="30" width="92" height="18" rx="5" fill="#e8730a" />
      <rect x="38" y="16" width="38" height="18" rx="7" fill="#c45f05" />
      <rect x="72" y="21" width="44" height="7" rx="3.5" fill="#3a3a3a" />
    </svg>
  );
}

const isCoarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

function Game({ onQuit }) {
  const hostRef = useRef(null);
  const input = useRef({ move: { x: 0, y: 0 }, aim: null, fire: false, mine: false, keys: new Set(), stick: { x: 0, y: 0 } });
  const [hud, setHud] = useState({ level: 0, lives: START_LIVES, enemies: 0, total: 0 });
  const [phase, setPhase] = useState("intro"); // intro | playing | paused | won | lost | gameover | done
  const [touch, setTouch] = useState(isCoarse);
  const [portrait, setPortrait] = useState(false);
  const [failed, setFailed] = useState(false);
  const game = useRef({ level: 0, lives: START_LIVES, state: null, scene: null, phase: "intro", phaseAt: 0 });

  const setGamePhase = (next) => {
    game.current.phase = next;
    game.current.phaseAt = performance.now();
    setPhase(next);
  };

  // Szene und Spielschleife
  useEffect(() => {
    let scene;
    try {
      scene = new PanzerScene(hostRef.current, { onLost: () => setFailed(true) });
    } catch {
      setFailed(true);
      return undefined;
    }
    const g = game.current;
    g.scene = scene;

    const startLevel = (index) => {
      g.level = index;
      g.state = createLevel(index);
      scene.reset(g.state);
      setGamePhase("intro");
      setHud({ level: index, lives: g.lives, enemies: enemiesLeft(g.state), total: enemiesLeft(g.state) });
    };
    g.startLevel = startLevel;
    startLevel(0);

    let last = performance.now();
    let acc = 0;
    let raf;
    let lastEnemies = -1;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const state = g.state;
      const inp = input.current;
      const elapsed = now - g.phaseAt;

      if (g.phase === "intro" && elapsed > INTRO_MS) setGamePhase("playing");

      if (g.phase === "playing" || g.phase === "won" || g.phase === "lost") {
        acc += dt;
        // Bewegung aus Tasten und Joystick
        const k = inp.keys;
        let mx = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0);
        let my = (k.has("s") || k.has("arrowdown") ? 1 : 0) - (k.has("w") || k.has("arrowup") ? 1 : 0);
        if (mx || my) {
          const len = Math.hypot(mx, my);
          mx /= len;
          my /= len;
        } else {
          mx = inp.stick.x;
          my = inp.stick.y;
        }
        const aim = inp.aimScreen ? scene.screenToArena(inp.aimScreen.x, inp.aimScreen.y) : null;
        if (aim) inp.aim = aim;
        while (acc >= STEP) {
          acc -= STEP;
          const playing = g.phase === "playing";
          step(state, { move: playing ? { x: mx, y: my } : { x: 0, y: 0 }, aim: playing ? inp.aim : null, fire: playing && inp.fire, mine: playing && inp.mine }, STEP);
          inp.fire = false;
          inp.mine = false;
        }
      } else {
        acc = 0;
      }

      playSounds(state.events);
      scene.render(state, g.phase === "paused" ? 0 : dt, g.phase === "playing" ? inp.aim : null);
      state.events = [];

      const left = enemiesLeft(state);
      if (left !== lastEnemies) {
        lastEnemies = left;
        setHud((h) => ({ ...h, enemies: left }));
      }

      if (g.phase === "playing" && state.status === "won") setGamePhase("won");
      if (g.phase === "playing" && state.status === "lost") setGamePhase("lost");
      if (g.phase === "won" && elapsed > END_MS) {
        playWin();
        setGamePhase(g.level + 1 < levelCount() ? "next" : "done");
      }
      if (g.phase === "lost" && elapsed > END_MS) {
        g.lives -= 1;
        if (g.lives <= 0) {
          playLose();
          setGamePhase("gameover");
        } else {
          startLevel(g.level);
        }
      }
    };
    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      if (document.hidden && g.phase === "playing") setGamePhase("paused");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      scene.dispose();
    };
  }, []);

  // Tastatur
  useEffect(() => {
    const down = (event) => {
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
      if (key === " " || key === "e") {
        if (!event.repeat) input.current.mine = true;
        return;
      }
      if (key === "p" || key === "escape") {
        togglePause();
        return;
      }
      input.current.keys.add(key);
      setTouch(false);
    };
    const up = (event) => input.current.keys.delete(event.key.toLowerCase());
    const blur = () => input.current.keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hochformat erkennen
  useEffect(() => {
    const check = () => setPortrait(window.innerHeight > window.innerWidth * 1.05);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const togglePause = () => {
    const g = game.current;
    if (g.phase === "playing") setGamePhase("paused");
    else if (g.phase === "paused") setGamePhase("playing");
  };

  // Zielen und Schießen auf der Spielfläche (Maus oder Finger, der keinen Knopf trifft)
  const aimPointers = useRef(new Set());
  const onPointerDown = (event) => {
    unlockAudio();
    if (event.pointerType === "touch") setTouch(true);
    else if (event.pointerType === "mouse") setTouch(false);
    input.current.aimScreen = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "mouse") {
      if (event.button === 0) input.current.fire = true;
      if (event.button === 2) input.current.mine = true;
    } else {
      aimPointers.current.add(event.pointerId);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };
  const onPointerMove = (event) => {
    if (event.pointerType === "mouse" || aimPointers.current.has(event.pointerId)) {
      input.current.aimScreen = { x: event.clientX, y: event.clientY };
    }
  };
  const onPointerUp = (event) => {
    aimPointers.current.delete(event.pointerId);
  };

  const g = game.current;
  const restartAll = () => {
    g.lives = START_LIVES;
    g.startLevel(0);
  };

  if (failed) {
    return (
      <div className="pz-menu">
        <p className="pz-lead">
          Die 3D-Grafik (WebGL) ist gerade nicht verfügbar. Panzerkiste braucht WebGL. Ist sie vorher abgestürzt,
          hilft meist: Tab schließen und die Seite neu öffnen.
        </p>
        <Button onClick={() => window.location.reload()}>Neu laden</Button>
        <Button onClick={onQuit}>Zurück</Button>
      </div>
    );
  }

  return (
    <div className={`pz-game ${touch ? "is-touch" : ""}`}>
      <div
        className="pz-stage"
        ref={hostRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div className="pz-hud">
        <button type="button" className="pz-hud-btn" onClick={onQuit} aria-label="Zurück ins Menü"><BackIcon /></button>
        <span className="pz-hud-level">Level {hud.level + 1}</span>
        <span className="pz-hud-lives" aria-label={`${game.current.lives} Leben`}>
          {Array.from({ length: START_LIVES }, (_, i) => <i key={i} className={i < game.current.lives ? "is-on" : ""} />)}
        </span>
        <span className="pz-hud-enemies">Gegner {hud.enemies}/{hud.total}</span>
        <button type="button" className="pz-hud-btn" onClick={togglePause} aria-label="Pause">{phase === "paused" ? "▶" : "❚❚"}</button>
      </div>

      {touch && <TouchControls input={input} />}

      {phase === "intro" && (
        <div className="pz-banner">
          <small>Level {hud.level + 1}</small>
          <strong>{LEVELS[hud.level]?.name}</strong>
          <span>Gegner: {hud.total}</span>
        </div>
      )}
      {phase === "won" && <div className="pz-banner is-good"><strong>Geschafft!</strong></div>}
      {phase === "lost" && <div className="pz-banner is-bad"><strong>Getroffen!</strong><span>{game.current.lives - 1 > 0 ? `Noch ${game.current.lives - 1} Leben` : "Letztes Leben verloren"}</span></div>}

      {phase === "paused" && (
        <Overlay title="Pause">
          <Button variant="primary" block onClick={togglePause}>Weiter</Button>
          <Button block onClick={onQuit}>Zum Menü</Button>
        </Overlay>
      )}
      {phase === "gameover" && (
        <Overlay title="Spiel vorbei" text={`Du hast Level ${hud.level + 1} nicht geschafft.`}>
          <Button variant="primary" block onClick={restartAll}>Nochmal</Button>
          <Button block onClick={onQuit}>Zum Menü</Button>
        </Overlay>
      )}
      {phase === "next" && (
        <Overlay title="Level geschafft!">
          <Button variant="primary" block onClick={() => g.startLevel(g.level + 1)}>Weiter zu Level {hud.level + 2}</Button>
        </Overlay>
      )}
      {phase === "done" && (
        <Overlay title="Level geschafft!" text="Das war das letzte Level – weitere folgen bald.">
          <Button variant="primary" block onClick={restartAll}>Nochmal spielen</Button>
          <Button block onClick={onQuit}>Zum Menü</Button>
        </Overlay>
      )}
      {touch && portrait && phase !== "paused" && (
        <div className="pz-rotate">Dreh dein Handy quer – dann ist die Kiste größer.</div>
      )}
    </div>
  );
}

function Overlay({ title, text, children }) {
  return (
    <div className="pz-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pz-card">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        <div className="pz-card-actions">{children}</div>
      </div>
    </div>
  );
}

function playSounds(events) {
  let shot = false;
  let bounce = false;
  for (const e of events) {
    if (e.type === "shot") shot = true;
    else if (e.type === "bounce") bounce = true;
    else if (e.type === "destroyed") playBoom(false);
    else if (e.type === "explosion") playBoom(true);
    else if (e.type === "mine") playMineDrop();
  }
  if (shot) playShot();
  if (bounce) playBounce();
}

/** Joystick links (erscheint dort, wo der Daumen aufsetzt), Feuer und Mine rechts */
function TouchControls({ input }) {
  const [stick, setStick] = useState(null); // { ox, oy, x, y }
  const stickPointer = useRef(null);
  const RADIUS = 56;

  const stickDown = (event) => {
    event.stopPropagation();
    unlockAudio();
    stickPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setStick({ ox: event.clientX, oy: event.clientY, x: 0, y: 0 });
    input.current.stick = { x: 0, y: 0 };
  };
  const stickMove = (event) => {
    if (event.pointerId !== stickPointer.current || !stick) return;
    let dx = event.clientX - stick.ox;
    let dy = event.clientY - stick.oy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setStick({ ...stick, x: dx, y: dy });
    // Bildschirm-oben ist in der Arena oben (Kamera schaut fast senkrecht)
    input.current.stick = { x: dx / RADIUS, y: dy / RADIUS };
  };
  const stickUp = (event) => {
    if (event.pointerId !== stickPointer.current) return;
    stickPointer.current = null;
    setStick(null);
    input.current.stick = { x: 0, y: 0 };
  };

  const press = (what) => (event) => {
    event.stopPropagation();
    event.preventDefault();
    unlockAudio();
    input.current[what] = true;
    event.currentTarget.classList.add("is-down");
  };
  const release = (event) => event.currentTarget.classList.remove("is-down");

  return (
    <>
      <div className="pz-stick-zone" onPointerDown={stickDown} onPointerMove={stickMove} onPointerUp={stickUp} onPointerCancel={stickUp}>
        {stick ? (
          <div className="pz-stick" style={{ left: stick.ox, top: stick.oy }}>
            <div className="pz-stick-knob" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }} />
          </div>
        ) : (
          <div className="pz-stick is-idle"><div className="pz-stick-knob" /></div>
        )}
      </div>
      <button type="button" className="pz-btn pz-btn-mine" onPointerDown={press("mine")} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>Mine</button>
      <button type="button" className="pz-btn pz-btn-fire" onPointerDown={press("fire")} onPointerUp={release} onPointerCancel={release} onPointerLeave={release} aria-label="Schießen">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
      </button>
    </>
  );
}

