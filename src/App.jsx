import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { socket } from "./socket";

const SESSION_TOKEN = "pitlane-trumpf-token";
const SESSION_NAME = "pitlane-trumpf-name";
const SESSION_ROOM = "pitlane-trumpf-room";

// Sekunden bis zu einem Zeitpunkt. Nur die kleinen Anzeige-Komponenten ticken, nicht das ganze Spiel.
function useSeconds(target) {
  const compute = () => (target ? Math.max(0, Math.ceil((target - Date.now()) / 1000)) : 0);
  const [seconds, setSeconds] = useState(compute);
  useEffect(() => {
    const tick = () => setSeconds(compute());
    tick();
    if (!target) return undefined;
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [target]);
  return seconds;
}

function Seconds({ target }) {
  return useSeconds(target);
}

function TurnTimer({ target }) {
  const seconds = useSeconds(target);
  return <span className={`turn-timer ${seconds <= 5 ? "is-low" : ""}`}>{seconds}s</span>;
}

function App() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("home"); // home | new | join | collection

  useEffect(() => {
    let noticeTimer;
    const showError = ({ message }) => {
      setNotice(message);
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setNotice(""), 4_500);
    };
    const restoreSession = () => {
      setConnected(true);
      const token = sessionStorage.getItem(SESSION_TOKEN);
      const name = sessionStorage.getItem(SESSION_NAME);
      const room = sessionStorage.getItem(SESSION_ROOM);
      if (token && room) {
        socket.emit("joinGame", { token, name, room }, (response) => {
          if (!response?.ok) {
            sessionStorage.removeItem(SESSION_TOKEN);
            sessionStorage.removeItem(SESSION_ROOM);
            setState(null);
            showError(response || { message: "Die Sitzung konnte nicht wiederhergestellt werden." });
          } else if (response.token) {
            sessionStorage.setItem(SESSION_TOKEN, response.token);
          }
        });
      }
    };
    const loseConnection = () => setConnected(false);

    socket.on("connect", restoreSession);
    socket.on("disconnect", loseConnection);
    socket.on("state", setState);
    socket.on("gameError", showError);
    if (socket.connected) restoreSession();

    return () => {
      window.clearTimeout(noticeTimer);
      socket.off("connect", restoreSession);
      socket.off("disconnect", loseConnection);
      socket.off("state", setState);
      socket.off("gameError", showError);
    };
  }, []);

  const join = (name, room) => {
    setJoining(true);
    socket.emit("joinGame", { name, room, create: view === "new" }, (response) => {
      setJoining(false);
      if (!response?.ok) {
        setNotice(response?.message || "Beitritt fehlgeschlagen.");
        return;
      }
      sessionStorage.setItem(SESSION_TOKEN, response.token);
      sessionStorage.setItem(SESSION_ROOM, response.room);
      sessionStorage.setItem(SESSION_NAME, name.trim());
    });
  };

  const leave = () => {
    socket.emit("leaveLobby");
    sessionStorage.removeItem(SESSION_TOKEN);
    sessionStorage.removeItem(SESSION_ROOM);
    sessionStorage.removeItem(SESSION_NAME);
    setState(null);
    setView("home");
  };

  const isPlaying = state && state.status !== "lobby";

  return (
    <div className={`app-shell ${isPlaying ? "is-playing" : ""} ${!state && (view === "home" || view === "new" || view === "join") ? "is-home" : ""}`}>
      {!isPlaying && !(!state && (view === "home" || view === "new" || view === "join")) && <Header connected={connected} state={state} />}
      <main>
        {!state && view === "home" ? (
          <Home onNew={() => setView("new")} onJoin={() => setView("join")} onCollection={() => setView("collection")} />
        ) : !state && view === "collection" ? (
          <Collection onBack={() => setView("home")} />
        ) : !state ? (
          <Welcome mode={view} onBack={() => setView("home")} onJoin={join} joining={joining} connected={connected} />
        ) : state.status === "lobby" ? (
          <Lobby state={state} onLeave={leave} />
        ) : (
          <Game state={state} />
        )}
      </main>
      {notice && <div className="toast" role="alert">{notice}</div>}
    </div>
  );
}

function Home({ onNew, onJoin, onCollection }) {
  return (
    <section className="home">
      <div className="home-inner">
        <div className="home-logo" role="img" aria-label="Andi Trumpf">
          <div className="home-logo-top"><span>ANDI</span><FlagPattern /></div>
          <div className="home-logo-bottom">TRUMPF</div>
        </div>

        <nav className="home-menu" aria-label="Hauptmenü">
          <button type="button" className="home-primary" onClick={onNew}>
            <CardsIcon />
            <span><strong>Neues Spiel</strong><small>Lobby eröffnen</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="home-card" onClick={onJoin}>
            <PeopleIcon />
            <span><strong>Spiel beitreten</strong><small>Einer Lobby beitreten</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="home-card" onClick={onCollection}>
            <CollectionIcon />
            <span><strong>Sammlung</strong><small>Alle Autos im Überblick</small></span>
            <HomeArrow />
          </button>
        </nav>
      </div>
    </section>
  );
}

function Collection({ onBack }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    socket
      .request("cards")
      .then((result) => {
        if (!alive) return;
        if (result.ok) setData(result);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const cards = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("de");
    return (data?.cards || []).filter((card) => !needle || card.name.toLocaleLowerCase("de").includes(needle));
  }, [data, query]);

  return (
    <section className="collection page-width">
      <div className="collection-head">
        <button type="button" className="text-button" onClick={onBack}>← Zurück</button>
        <h1>Sammlung</h1>
        <p className="muted">{data ? `${cards.length} von ${data.cards.length} Autos` : "Lädt …"}</p>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Auto suchen, z. B. Porsche"
          aria-label="Auto suchen"
        />
      </div>
      {failed && <p className="collection-empty">Die Sammlung konnte nicht geladen werden. Versuche es gleich noch einmal.</p>}
      {data && cards.length === 0 && <p className="collection-empty">Kein Auto gefunden.</p>}
      <div className="collection-grid">
        {cards.map((card) => (
          <ScaledCard key={card.c_id}>
            <VehicleCard card={card} categories={data.categories} />
          </ScaledCard>
        ))}
      </div>
    </section>
  );
}

function Header({ connected, state }) {
  return (
    <header className="site-header">
      <div className="brand" aria-label="Andi Trumpf">
        <LogoMark />
        <div>
          <strong>ANDI</strong>
          <span>TRUMPF</span>
        </div>
      </div>
      <div className="header-meta">
        {state?.status !== "lobby" && state?.game && (
          <span className="round-chip">Runde {state.game.round}</span>
        )}
        <span className={`connection ${connected ? "is-online" : ""}`}>
          <i /> {connected ? "Live" : "Verbindung …"}
        </span>
      </div>
    </header>
  );
}

function Welcome({ mode = "new", onBack, onJoin, joining, connected }) {
  const [name, setName] = useState(sessionStorage.getItem(SESSION_NAME) || "");
  const [sessionId, setSessionId] = useState("");
  const submit = (event) => {
    event.preventDefault();
    if (name.trim() && (mode !== "join" || sessionId)) onJoin(name.trim(), sessionId);
  };

  return (
    <section className="welcome page-width">
      <div className="join-card panel">
        <div className="panel-number">01</div>
        {onBack && <button type="button" className="text-button join-back" onClick={onBack}>← Zurück</button>}
        <p className="eyebrow">STARTAUFSTELLUNG</p>
        <h2>{mode === "join" ? "Spiel beitreten" : "Neues Spiel"}</h2>
        <p className="muted">
          {mode === "join"
            ? "Gib einen Spielernamen und die Session-ID ein."
            : "Gib einen Spielernamen ein."}
        </p>
        <form onSubmit={submit}>
          <label htmlFor="player-name">Fahrername</label>
          <input
            id="player-name"
            value={name}
            onChange={(event) => setName(event.target.value.slice(0, 20))}
            placeholder="z. B. Niki"
            autoComplete="nickname"
            autoFocus={typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches}
          />
          {mode === "join" && (
            <>
              <label htmlFor="session-id">Session-ID</label>
              <input
                id="session-id"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="Session-ID eingeben"
                autoComplete="off"
              />
            </>
          )}
          <button className="primary-button" disabled={!connected || joining || !name.trim() || (mode === "join" && sessionId.length < 4)}>
            <span>{joining ? "Beitritt läuft …" : "Lobby beitreten"}</span>
            <ArrowIcon />
          </button>
        </form>
        <div className="secure-note"><ShieldIcon /> Dein Kartenstapel bleibt nur für dich sichtbar.</div>
      </div>
    </section>
  );
}

function Lobby({ state, onLeave }) {
  const selfIsHost = state.selfId === state.hostId;
  const canStart = state.players.length >= 2;
  const openSeats = Array.from({ length: state.maxPlayers - state.players.length });
  const cardCountOptions = state.cardCountOptions || [8, 16, 32];
  const totalCards = state.players.length * state.cardsPerPlayer;

  return (
    <section className="lobby page-width">
      <div className="lobby-heading">
        <div>
          <p className="eyebrow"><span /> BOXENGASSE OFFEN</p>
          <h1>Die Startaufstellung</h1>
          <p className="muted">Sobald mindestens zwei Fahrer bereit sind, kann der Host austeilen.</p>
        </div>
        <button className="text-button" onClick={onLeave}>Lobby verlassen</button>
      </div>
      <p className="muted session-code">Session-ID zum Beitreten: <b>{state.sessionId}</b></p>

      <div className="lobby-grid">
        <div className="players-panel panel">
          <div className="section-label">
            <span>FAHRER</span>
            <b>{state.players.length} / {state.maxPlayers}</b>
          </div>
          <div className="seat-list">
            {state.players.map((player, index) => (
              <div className="seat is-filled" key={player.id}>
                <div className="avatar">{initials(player.name)}</div>
                <div className="seat-copy">
                  <strong>{player.name} {player.id === state.selfId && <small>DU</small>}</strong>
                  <span>{player.isHost ? "Rennleitung · Host" : `Startplatz ${index + 1}`}</span>
                </div>
                <i className="ready-light" aria-label="Bereit" />
              </div>
            ))}
            {openSeats.map((_, index) => (
              <div className="seat" key={`open-${index}`}>
                <div className="avatar is-empty">+</div>
                <div className="seat-copy">
                  <strong>Freier Startplatz</strong>
                  <span>Wartet auf Fahrer …</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="rules-panel">
          <div className="deal-settings">
            <div>
              <span>KARTEN PRO SPIELER</span>
              <b>{totalCards} Karten gesamt</b>
            </div>
            <div className="card-count-options" role="group" aria-label="Karten pro Spieler">
              {cardCountOptions.map((count) => (
                <button
                  className={state.cardsPerPlayer === count ? "is-selected" : ""}
                  disabled={!selfIsHost}
                  onClick={() => socket.emit("setCardsPerPlayer", count)}
                  type="button"
                  key={count}
                >
                  <strong>{count}</strong>
                  <span>Karten</span>
                </button>
              ))}
            </div>
            <small>{selfIsHost ? "Du legst als Host die Stapelgröße fest." : "Der Host legt die Stapelgröße fest."}</small>
          </div>
          <div className="rule-line"><span>01</span><p><b>Stapel ansehen</b>Wische durch alle deine eigenen Karten.</p></div>
          <div className="rule-line"><span>02</span><p><b>Wert ansagen</b>Der aktive Fahrer wählt die Kategorie.</p></div>
          <div className="rule-line"><span>03</span><p><b>Stich gewinnen</b>Der beste Wert erhält alle Tischkarten.</p></div>
          <div className="direction-note"><b>↑</b> Karte 1 ist spielbar. Meist gewinnt der höchste Wert; bei Gewicht und 0–100 der niedrigste.</div>
          {selfIsHost ? (
            <button className="primary-button start-button" disabled={!canStart} onClick={() => socket.emit("startGame")}>
              <span>{canStart ? "Karten austeilen" : "Warte auf Mitspieler"}</span>
              <FlagIcon />
            </button>
          ) : (
            <div className="host-wait"><SpinnerIcon /><span>Der Host startet das Spiel.</span></div>
          )}
        </aside>
      </div>
    </section>
  );
}

function Game({ state }) {
  const { game, players, selfId, categories } = state;
  const hand = game.ownHand || [];
  const topCardId = hand[0]?.c_id || null;
  const [selectedCardId, setSelectedCardId] = useState(topCardId);
  const self = players.find((player) => player.id === selfId);
  const seatCount = Math.min(4, Math.max(2, players.filter((player) => !player.eliminated || game.tableCards.some((entry) => entry.playerId === player.id)).length));
  const isChoosing = game.phase === "choosing";
  const isMyTurn = isChoosing && game.activePlayerId === selfId;
  const isPaused = Boolean(game.pausedUntil) && game.phase !== "finished";
  const timerTarget = isPaused ? game.pausedUntil : isChoosing ? game.turnEndsAt : game.revealEndsAt;

  useEffect(() => setSelectedCardId(topCardId), [topCardId, isMyTurn]);

  return (
    <section className={`game-table-screen ${isMyTurn && !isPaused && hand.length ? "is-my-turn" : ""} ${game.phase === "revealed" ? "is-revealing" : ""}`} data-seats={seatCount}>
      <div className="arena-table">
        <div className="arena-inlay" />
        {isPaused && (
          <div className="arena-notice" role="status">
            <SpinnerIcon /> Mitspieler fehlen – das Spiel endet in <Seconds target={timerTarget} /> s, wenn niemand zurückkommt
          </div>
        )}
        {game.potCount > 0 && game.phase !== "finished" && <div className="arena-pot">Pot <b>{game.potCount}</b></div>}
        <TableCards state={state} timerTarget={isChoosing && !isPaused ? game.turnEndsAt : null} />
        <div className="arena-watermark"><LogoMark /><span>TRUMPF</span></div>
      </div>

      {game.phase !== "finished" && (
        <HandStack
          hand={hand}
          categories={categories}
          selectedCardId={selectedCardId}
          onSelectCard={setSelectedCardId}
          canChoose={isMyTurn}
          choosing={isChoosing}
          self={self}
          turnTarget={isMyTurn && !isPaused ? game.turnEndsAt : null}
          revealTarget={game.phase === "revealed" && !isPaused ? game.revealEndsAt : null}
        />
      )}

      {game.phase === "finished" && <FinishPanel state={state} />}
    </section>
  );
}

const TableCards = memo(function TableCards({ state, timerTarget = null }) {
  const { game, players, categories, selfId } = state;
  const tableByPlayer = new Map(game.tableCards.map((entry) => [entry.playerId, entry.card]));
  const participants = players.filter((player) => !player.eliminated || tableByPlayer.has(player.id));

  return (
    <div className={`arena-cards count-${participants.length}`}>
      {participants.map((player, index) => {
        const card = tableByPlayer.get(player.id) || null;
        const isSelf = player.id === selfId;
        const isBest = game.result?.winnerIds?.includes(player.id);
        const isActive = player.id === game.activePlayerId;
        return (
          <div
            className={`arena-seat ${isActive ? "is-active" : ""} ${isBest ? "is-best" : ""}`}
            style={{ "--seat-index": index }}
            key={player.id}
          >
            <div className={`arena-card-place ${isSelf && card ? "is-flying-in" : ""}`}>
              <ScaledCard>
                <FlipCard
                  card={card}
                  categories={categories}
                  highlight={game.category}
                  instant={isSelf}
                  layers={Math.min(player.cardCount, 3)}
                />
              </ScaledCard>
              {isBest && <span className="best-ribbon">{game.result.type === "tie" ? "GLEICHSTAND" : "STICH"}</span>}
            </div>
            <div className="player-under-card" aria-current={isActive ? "true" : undefined}>
              <span className="player-dot" />
              <strong>{player.name}</strong>
              {player.id === selfId && <small>DU</small>}
              {isActive && timerTarget && <TurnTimer target={timerTarget} />}
              <b>{player.cardCount}</b>
              {!player.connected && <i>offline</i>}
            </div>
          </div>
        );
      })}
    </div>
  );
});

// Tischkarte: Rückseite, die sich beim Aufdecken umdreht. Die eigene Karte (instant) wird nicht gedreht,
// sondern per CSS-Animation vom Kartenstapel auf den Tisch gelegt.
function FlipCard({ card, categories, highlight, instant, layers }) {
  const last = useRef(card);
  if (card) last.current = card;
  return (
    <div className={`flip ${card ? "is-face-up" : ""} ${instant ? "is-instant" : ""}`}>
      <div className="flip-inner">
        <div className="flip-face flip-back"><CardBack layers={layers} /></div>
        <div className="flip-face flip-front">
          {last.current && <VehicleCard card={last.current} categories={categories} highlight={highlight} />}
        </div>
      </div>
    </div>
  );
}

const HandStack = memo(function HandStack({ hand, categories, selectedCardId, onSelectCard, canChoose, choosing, self, turnTarget, revealTarget }) {
  const selectedIndex = Math.max(0, hand.findIndex((card) => card.c_id === selectedCardId));
  const step = (direction) => {
    if (hand.length > 1) onSelectCard(hand[(selectedIndex + direction + hand.length) % hand.length].c_id);
  };
  if (!hand.length) {
    return (
      <div className="empty-stack">
        <strong>Dein Stapel ist leer</strong>
        <span>Du kannst die restliche Partie am Tisch verfolgen.</span>
      </div>
    );
  }

  return (
    <aside className="stack-dock">
      <div className="stack-heading">
        <div>
          {turnTarget
            ? <span className="turn-banner">DU BIST DRAN · <Seconds target={turnTarget} />s</span>
            : revealTarget
              ? <span className="turn-banner">ERGEBNIS · weiter in <Seconds target={revealTarget} />s</span>
              : <span>DEIN KARTENSTAPEL</span>}
          <strong>Karte {selectedIndex + 1} von {hand.length}</strong>
        </div>
        <div className="stack-help">
          <button type="button" className="swipe-symbol" onClick={() => step(-1)} aria-label="Vorherige Karte">←</button>
          Wischen
          <button type="button" className="swipe-symbol" onClick={() => step(1)} aria-label="Nächste Karte">→</button>
        </div>
      </div>
      <div className="stack-carousel">
        <DeckCarousel
          count={hand.length}
          selectedIndex={selectedIndex}
          onSelectIndex={(index) => onSelectCard(hand[index].c_id)}
          label={`Kartenstapel, Karte ${selectedIndex + 1} von ${hand.length}`}
        >
          {(index, isActive) => {
            const card = hand[index];
            const isTop = index === 0;
            return (
              <>
                {isActive && (
                  <div className="stack-card-label">
                    {isTop ? <b>SPIELKARTE</b> : <span>#{index + 1}</span>}
                  </div>
                )}
                <ScaledCard>
                  <VehicleCard
                    card={card}
                    categories={categories}
                    selectable={isActive && isTop && canChoose && choosing}
                    highlight={null}
                  />
                  {isActive && !isTop && <div className="not-playable"><LockIcon /> Nur Karte 1 ist spielbar</div>}
                  {isActive && isTop && choosing && !canChoose && (
                    <div className="not-playable"><SpinnerIcon /> {self?.eliminated ? "Du schaust zu" : "Warte auf den aktiven Spieler"}</div>
                  )}
                </ScaledCard>
              </>
            );
          }}
        </DeckCarousel>
      </div>
    </aside>
  );
});

// Kartenstapel als 3D-Karussell (Animation nach der Vorlage index.html): Die Karten liegen gefächert hintereinander,
// beim Wischen folgen alle dem Finger und rücken nach vorn. Beim Ziehen werden die Stile direkt am DOM gesetzt,
// React rendert erst wieder, wenn eine andere Karte vorn liegt.
const DECK_NEAR = 5; // so viele Karten pro Seite gibt es im Fächer
const DECK_FULL = 2; // nur so viele davon mit vollem Inhalt, die übrigen sind schlichte Kartenrahmen
const DECK_DRAG_START = 6;

function deckSpacing() {
  return Math.min(window.innerWidth * 0.075, 28);
}

function circularOffset(index, current, count) {
  let offset = index - current;
  if (offset > count / 2) offset -= count;
  if (offset < -count / 2) offset += count;
  return offset;
}

function placeDeckCard(element, offset, dragging) {
  const distance = Math.abs(offset);
  element.style.transform = `translate3d(${offset * deckSpacing()}px, 0, ${-distance * 42}px) rotateY(${offset * -7}deg) scale(${Math.max(0.82, 1 - distance * 0.035)})`;
  element.style.opacity = dragging
    ? String(Math.max(0, 1 - Math.max(0, distance - 3) * 0.12))
    : String(distance > 4 ? 0 : 1 - distance * 0.08);
  element.style.zIndex = String(Math.round(100 - distance * 10));
}

function DeckCarousel({ count, selectedIndex, onSelectIndex, label, children }) {
  const stageRef = useRef(null);
  const cardRefs = useRef(new Map());
  const drag = useRef({ active: false, started: false, pointerId: null, startX: 0, dx: 0 });
  const justDragged = useRef(false);

  const layout = (progress = 0, dragging = false) => {
    cardRefs.current.forEach((element, index) => {
      if (element) placeDeckCard(element, circularOffset(index, selectedIndex, count) + progress, dragging);
    });
  };

  useLayoutEffect(() => {
    layout();
  }, [selectedIndex, count]);

  useEffect(() => {
    const onResize = () => layout();
    window.addEventListener("resize", onResize);
    const onKey = (event) => {
      if (event.key === "ArrowRight") onSelectIndex((selectedIndex + 1) % count);
      if (event.key === "ArrowLeft") onSelectIndex((selectedIndex - 1 + count) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [count, selectedIndex, onSelectIndex]);

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    drag.current = { active: true, started: false, pointerId: event.pointerId, startX: event.clientX, dx: 0 };
  };

  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d.active || event.pointerId !== d.pointerId) return;
    const dx = event.clientX - d.startX;
    if (!d.started) {
      // Erst ab ein paar Pixeln gilt es als Ziehen, damit ein Antippen der Werte weiter funktioniert.
      if (Math.abs(dx) < DECK_DRAG_START) return;
      d.started = true;
      stageRef.current?.classList.add("is-dragging");
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    d.dx = dx;
    layout(dx / deckSpacing(), true);
  };

  const onPointerEnd = (event) => {
    const d = drag.current;
    if (!d.active || event.pointerId !== d.pointerId) return;
    drag.current = { active: false, started: false, pointerId: null, startX: 0, dx: 0 };
    if (!d.started) return;
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 60);
    stageRef.current?.classList.remove("is-dragging");
    const threshold = Math.max(45, window.innerWidth * 0.15);
    if (event.type !== "pointercancel" && count > 1 && d.dx < -threshold) onSelectIndex((selectedIndex + 1) % count);
    else if (event.type !== "pointercancel" && count > 1 && d.dx > threshold) onSelectIndex((selectedIndex - 1 + count) % count);
    else layout();
  };

  const cards = [];
  for (let index = 0; index < count; index += 1) {
    if (Math.abs(circularOffset(index, selectedIndex, count)) > DECK_NEAR) continue;
    const isActive = index === selectedIndex;
    cards.push(
      <div
        className={`deck-card ${isActive ? "is-active" : ""}`}
        key={index}
        ref={(element) => {
          if (element) cardRefs.current.set(index, element);
          else cardRefs.current.delete(index);
        }}
        onClick={isActive ? undefined : () => { if (!justDragged.current) onSelectIndex(index); }}
      >
        {Math.abs(circularOffset(index, selectedIndex, count)) <= DECK_FULL ? children(index, isActive) : <div className="deck-blank" />}
      </div>
    );
  }

  return (
    <div
      className="deck-stage"
      role="group"
      aria-label={label}
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {cards}
    </div>
  );
}

// Spielkarten werden immer in der Entwurfsgröße 906 × 1405 gezeichnet und gleichmäßig auf die verfügbare
// Breite skaliert. So bleibt der Text auf jeder Kartengröße gleich gut lesbar.
const CARD_DESIGN_WIDTH = 906;

function ScaledCard({ children }) {
  const ref = useRef(null);
  const innerRef = useRef(null);
  // Die Skalierung wird direkt am Element gesetzt, damit Größenänderungen (z. B. beim Hochfahren des Stapels) kein React-Rendering auslösen.
  useLayoutEffect(() => {
    const element = ref.current;
    const inner = innerRef.current;
    if (!element || !inner) return undefined;
    const update = () => { inner.style.transform = `scale(${element.offsetWidth / CARD_DESIGN_WIDTH})`; };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="scaled-card" ref={ref}>
      <div className="scaled-card-inner" ref={innerRef}>{children}</div>
    </div>
  );
}

// Die acht Felder der Karte, in der Reihenfolge von oben links nach unten rechts.
// Nur Werte, die auch Spielkategorien sind, lassen sich anklicken; Drehzahl wird nur angezeigt.
const CARD_FIELDS = [
  { key: "leistung", label: "Leistung", unit: "PS", icon: "engine" },
  { key: "hubraum", label: "Hubraum", unit: "L", icon: "piston" },
  { key: "drehmoment", label: "Drehmoment", unit: "Nm", icon: "torque" },
  { key: "drehzahl", label: "Drehzahl", unit: "U/min", icon: "rpm" },
  { key: "beschleunigung", label: "Beschleunigung", unit: "s", icon: "timer" },
  { key: "hoechstgeschwindigkeit", label: "Geschwindigkeit", unit: "km/h", icon: "speed" },
  { key: "gewicht", label: "Gewicht", unit: "kg", icon: "weight" },
  { key: "preis", label: "Preis", unit: "€", icon: "price" }
];

function cardValue(card, key) {
  const value = Number(card[key]);
  if (card[key] == null || !Number.isFinite(value) || value <= 0) return null;
  if (key === "hubraum") return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 1000);
  if (key === "preis" && value >= 1_000_000) return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(value / 1_000_000)} Mio`;
  return formatValue(value, key);
}

const VehicleCard = memo(function VehicleCard({ card, categories, selectable = false, highlight = null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const nameSize = Math.min(58, 700 / (card.name.length * 0.43));
  return (
    <article className="portrait-card">
      <div className="gt-photo">
        {card.image && !imageFailed ? (
          <img src={card.image} alt={card.name} loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
        ) : (
          <VehicleFallback card={card} />
        )}
        {card.imageMeta?.pageUrl && (
          <a
            className="photo-source"
            href={card.imageMeta.pageUrl}
            target="_blank"
            rel="noreferrer"
            title={`Foto: ${card.imageMeta.author} · ${card.imageMeta.license}`}
            onClick={(event) => event.stopPropagation()}
          >
            FOTO ↗
          </a>
        )}
        {selectable && <div className="choose-hint">WERT ANKLICKEN</div>}
      </div>
      <div className="gt-plate"><h2 style={{ fontSize: `${nameSize}px` }}>{card.name}</h2></div>
      <div className="gt-stats">
        {CARD_FIELDS.map((field) => {
          const rule = categories[field.key];
          const canPick = selectable && Boolean(rule);
          const Tag = canPick ? "button" : "div";
          const value = cardValue(card, field.key);
          return (
            <Tag
              className={`portrait-stat ${canPick ? "is-selectable" : ""} ${highlight === field.key ? "is-highlighted" : ""}`}
              type={canPick ? "button" : undefined}
              onClick={canPick ? (event) => {
                event.stopPropagation();
                socket.emit("chooseCategory", field.key);
              } : undefined}
              key={field.key}
              title={canPick ? `${rule.label} wählen` : undefined}
            >
              <span className="stat-label">{field.label}</span>
              <GtIcon type={field.icon} />
              <strong>{value ?? "–"}{value && <small>{field.unit}</small>}</strong>
              {rule && <i>{rule.direction === "low" ? "▼" : "▲"}</i>}
            </Tag>
          );
        })}
      </div>
    </article>
  );
});

// Bronze-Symbole der Kartenfelder, flach gezeichnet in vier Tönen.
function GtIcon({ type }) {
  const B = "#b9885c", L = "#e8c397", D = "#5b3a28", K = "#1d1511";
  const icons = {
    engine: (
      <>
        <rect x="14" y="26" width="38" height="24" rx="4" fill={B} stroke={D} strokeWidth="2" />
        {[17, 25, 33, 41].map((x) => <rect key={x} x={x} y="14" width="7" height="14" rx="1.5" fill={L} stroke={D} strokeWidth="1.5" />)}
        <rect x="8" y="32" width="8" height="12" rx="2" fill={D} />
        <circle cx="52" cy="38" r="7" fill={K} stroke={L} strokeWidth="2" />
        <path d="M20 40h24M20 45h24" stroke={D} strokeWidth="2" />
      </>
    ),
    piston: (
      <>
        <rect x="21" y="8" width="22" height="22" rx="3" fill={B} stroke={D} strokeWidth="2" />
        <path d="M21 14h22M21 19h22M21 24h22" stroke={D} strokeWidth="2" />
        <path d="M28 30h8l3 20h-14z" fill={L} stroke={D} strokeWidth="2" />
        <circle cx="32" cy="52" r="8" fill={B} stroke={D} strokeWidth="2.5" />
        <circle cx="32" cy="52" r="3" fill={K} />
      </>
    ),
    torque: (
      <>
        <path d="M32 18l11 6.3v12.7L32 43.3 21 37V24.300z" fill={B} stroke={D} strokeWidth="2.5" />
        <circle cx="32" cy="30.500" r="5" fill={K} stroke={L} strokeWidth="1.500" />
        <path d="M10 34a23 23 0 0 0 40 12" fill="none" stroke={L} strokeWidth="5" strokeLinecap="round" />
        <path d="M54 36l-4.500 12-9-7z" fill={L} stroke={D} strokeWidth="1.500" strokeLinejoin="round" />
      </>
    ),
    rpm: (
      <>
        <circle cx="32" cy="32" r="25" fill={K} stroke={B} strokeWidth="5" />
        <circle cx="32" cy="32" r="19" fill="none" stroke={D} strokeWidth="1.500" />
        {Array.from({ length: 9 }, (_, i) => {
          const a = (Math.PI * (0.75 + i * 0.1875));
          return <path key={i} d={`M${32 + Math.cos(a) * 15} ${32 + Math.sin(a) * 15}L${32 + Math.cos(a) * 19} ${32 + Math.sin(a) * 19}`} stroke={i > 6 ? "#d6533a" : L} strokeWidth="2" />;
        })}
        <path d="M32 34l11-12" stroke="#f08a2a" strokeWidth="3" strokeLinecap="round" />
        <circle cx="32" cy="34" r="3.500" fill={B} />
      </>
    ),
    timer: (
      <>
        <rect x="26" y="5" width="12" height="6" rx="2" fill={L} stroke={D} strokeWidth="1.500" />
        <rect x="29.500" y="10" width="5" height="7" fill={B} />
        <circle cx="32" cy="37" r="22" fill={K} stroke={B} strokeWidth="5" />
        <circle cx="32" cy="37" r="16" fill="none" stroke={D} strokeWidth="1.500" />
        <path d="M32 37V24" stroke={L} strokeWidth="3" strokeLinecap="round" />
        <path d="M32 37l8 5" stroke="#f08a2a" strokeWidth="2.500" strokeLinecap="round" />
        <circle cx="32" cy="37" r="3" fill={B} />
        <path d="M50 14l4 4" stroke={B} strokeWidth="4" strokeLinecap="round" />
      </>
    ),
    speed: (
      <>
        <path d="M6 46a26 26 0 0 1 52 0z" fill={K} stroke={B} strokeWidth="5" strokeLinejoin="round" />
        {Array.from({ length: 7 }, (_, i) => {
          const a = Math.PI * (1 + i / 6);
          return <path key={i} d={`M${32 + Math.cos(a) * 17} ${46 + Math.sin(a) * 17}L${32 + Math.cos(a) * 21} ${46 + Math.sin(a) * 21}`} stroke={i > 4 ? "#d6533a" : L} strokeWidth="2" />;
        })}
        <path d="M32 44l11-12" stroke="#f08a2a" strokeWidth="3" strokeLinecap="round" />
        <circle cx="32" cy="44" r="3" fill={B} />
        <text x="32" y="55" textAnchor="middle" fontSize="8" fontWeight="800" fill={L} fontFamily="Barlow, sans-serif">KM/H</text>
      </>
    ),
    weight: (
      <>
        <path d="M22 22a10 10 0 0 1 20 0" fill="none" stroke={B} strokeWidth="6" />
        <path d="M18 24h28l7 30H11z" fill="#7d7a78" stroke="#2c2a29" strokeWidth="2.500" strokeLinejoin="round" />
        <path d="M21 28h6l-4 22h-6z" fill="#a8a5a2" opacity=".55" />
        <text x="32" y="46" textAnchor="middle" fontSize="15" fontWeight="800" fill="#2c2a29" fontFamily="Barlow, sans-serif">kg</text>
      </>
    ),
    price: (
      <>
        <ellipse cx="32" cy="52" rx="24" ry="8" fill={D} />
        <path d="M8 46v6c0 4.400 10.700 8 24 8s24-3.600 24-8v-6z" fill={B} stroke={D} strokeWidth="1.500" />
        <ellipse cx="32" cy="46" rx="24" ry="8" fill={L} stroke={D} strokeWidth="1.500" />
        <path d="M10 36v6c0 4.400 9.700 7 22 7s22-2.600 22-7v-6z" fill={B} stroke={D} strokeWidth="1.500" />
        <ellipse cx="32" cy="36" rx="22" ry="7" fill={L} stroke={D} strokeWidth="1.500" />
        <path d="M12 26v6c0 3.900 9 6 20 6s20-2.100 20-6v-6z" fill={B} stroke={D} strokeWidth="1.500" />
        <ellipse cx="32" cy="26" rx="20" ry="6.500" fill={L} stroke={D} strokeWidth="1.500" />
        <circle cx="32" cy="16" r="11" fill={L} stroke={D} strokeWidth="2" />
        <text x="32" y="21.500" textAnchor="middle" fontSize="15" fontWeight="800" fill={D} fontFamily="Barlow, sans-serif">€</text>
      </>
    )
  };
  return <svg className="gt-icon" viewBox="0 0 64 64" aria-hidden="true">{icons[type]}</svg>;
}

function FinishPanel({ state }) {
  const winner = state.players.find((player) => player.id === state.game.winnerId);
  const isHost = state.selfId === state.hostId;
  return (
    <div className="finish-overlay">
      <div className="finish-panel panel">
        <div className="trophy">🏁</div>
        <p className="eyebrow">PARTIE BEENDET</p>
        <h2>{winner?.name || "Unbekannt"} gewinnt!</h2>
        <p className="muted">
          {state.game.result?.reason === "abandoned"
            ? "Die Partie wurde beendet, weil zu viele Mitspieler gegangen sind."
            : "Alle Fahrzeugkarten sind im Siegerstapel gelandet."}
        </p>
        {isHost ? (
          <button className="primary-button" onClick={() => socket.emit("playAgain")}><span>Noch eine Partie</span><FlagIcon /></button>
        ) : (
          <div className="host-wait"><SpinnerIcon /><span>Warten auf den Host …</span></div>
        )}
      </div>
    </div>
  );
}

function CardBack({ layers = 1 }) {
  return (
    <div className="portrait-back-wrap">
      {Array.from({ length: Math.max(0, layers - 1) }, (_, index) => (
        <i className="back-layer" style={{ "--layer": index + 1 }} key={index} />
      ))}
      <div className="portrait-back">
        <div className="portrait-back-pattern"><LogoMark /><b>ANDI</b><span>TRUMPF</span></div>
      </div>
    </div>
  );
}

function VehicleFallback({ card }) {
  return (
    <div className="vehicle-fallback" aria-label={card.name}>
      <span>{String(card.c_id).padStart(2, "0")}</span>
      <CarSilhouette />
    </div>
  );
}

function formatValue(value, key) {
  if (!Number.isFinite(Number(value))) return "–";
  if (key === "preis") return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
  if (key === "beschleunigung") return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value);
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
}

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function LogoMark() {
  return <svg className="logo-mark" viewBox="0 0 42 42" aria-hidden="true"><path d="M5 8h21l11 9-11 17H5l11-13L5 8Z" /><path d="M17 15h10l4 4-7 9H13l6-7-2-6Z" /></svg>;
}

function FlagPattern() {
  const cells = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      if ((row + col) % 2 === 0) cells.push(<rect key={`${row}-${col}`} x={col * 12} y={row * 12} width="12" height="12" />);
    }
  }
  return (
    <svg className="home-flag" viewBox="0 0 60 36" aria-hidden="true">{cells}</svg>
  );
}

function HomeArrow() {
  return (
    <svg className="home-arrow" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CardsIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="6" y="9" width="24" height="32" rx="4" transform="rotate(-12 18 25)" fill="currentColor" opacity="0.55" />
      <rect x="16" y="7" width="26" height="34" rx="4" fill="currentColor" />
      <path d="M22 28l2-6h12l2 6v6h-3v-2H25v2h-3zm4.5-4l-1 3h11l-1-3z" fill="#e8730a" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="16" r="7" fill="currentColor" />
      <circle cx="10" cy="20" r="5" fill="currentColor" opacity="0.7" />
      <circle cx="38" cy="20" r="5" fill="currentColor" opacity="0.7" />
      <path d="M11 40c0-8 5-13 13-13s13 5 13 13z" fill="currentColor" />
      <path d="M1 38c0-6 3-10 9-10 2 0 3 .3 4 1-3 2-5 5-5.500 9z" fill="currentColor" opacity="0.7" />
      <path d="M47 38c0-6-3-10-9-10-2 0-3 .3-4 1 3 2 5 5 5.500 9z" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function CollectionIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="5" y="12" width="22" height="30" rx="4" transform="rotate(-10 16 27)" fill="none" stroke="currentColor" strokeWidth="2.500" />
      <rect x="17" y="8" width="22" height="32" rx="4" fill="none" stroke="currentColor" strokeWidth="2.500" />
      <rect x="27" y="10" width="17" height="30" rx="4" transform="rotate(8 35 25)" fill="none" stroke="currentColor" strokeWidth="2.500" opacity="0.6" />
    </svg>
  );
}

function ArrowIcon() {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M14 6l6 6-6 6" /></svg>;
}

function FlagIcon() {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4m0 1c5-3 8 3 14 0v9c-6 3-9-3-14 0" /></svg>;
}

function ShieldIcon() {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></svg>;
}

function LockIcon() {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}

function SpinnerIcon() {
  return <span className="spinner" aria-hidden="true" />;
}

function CarSilhouette() {
  return <svg className="car-silhouette" viewBox="0 0 260 100" aria-hidden="true"><path d="M20 69c5-15 15-26 33-30l39-6 26-20h48l35 23 31 8c8 2 12 11 10 25h-16a23 23 0 0 0-44 0H79a23 23 0 0 0-44 0H20Z" /><circle cx="57" cy="70" r="16" /><circle cx="204" cy="70" r="16" /><path className="window" d="m101 34 23-16h38l25 18-86-2Z" /></svg>;
}

export default App;
