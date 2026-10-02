import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { socket } from "./socket";

const SESSION_TOKEN = "pitlane-trumpf-token";
const SESSION_NAME = "pitlane-trumpf-name";
const SESSION_ROOM = "pitlane-trumpf-room";

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return now;
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
          <VehicleCard key={card.c_id} card={card} categories={data.categories} />
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
  const now = useClock();
  const self = players.find((player) => player.id === selfId);
  const activePlayer = players.find((player) => player.id === game.activePlayerId);
  const isChoosing = game.phase === "choosing";
  const isMyTurn = isChoosing && game.activePlayerId === selfId;
  const isPaused = Boolean(game.pausedUntil) && game.phase !== "finished";
  const timerTarget = isPaused ? game.pausedUntil : isChoosing ? game.turnEndsAt : game.revealEndsAt;
  const seconds = timerTarget ? Math.max(0, Math.ceil((timerTarget - now) / 1000)) : 0;

  useEffect(() => setSelectedCardId(topCardId), [topCardId]);

  const statusText = useMemo(() => {
    if (game.phase === "finished") return "Partie beendet";
    if (isPaused) return "Mitspieler fehlen – Spiel endet bald, wenn niemand zurückkommt";
    if (isChoosing) {
      return isMyTurn
        ? "Du bist dran – wähle eine Kategorie auf Karte 1"
        : `Warten auf ${activePlayer?.name || "Mitspieler"} …`;
    }
    if (game.result?.type === "tie") return "Gleichstand – die Karten kommen in den Pot";
    const winner = players.find((player) => player.id === game.result?.winnerIds?.[0]);
    return `${winner?.name || "Der Gewinner"} gewinnt diesen Stich`;
  }, [activePlayer?.name, game.phase, game.result, isChoosing, isMyTurn, isPaused, players]);

  return (
    <section className="game-table-screen">
      <div className="arena-topbar">
        <div className="arena-brand"><LogoMark /><span>ANDI <b>TRUMPF</b></span></div>
        <div className={`turn-message ${isMyTurn ? "is-own-turn" : ""}`}>
          {((isChoosing && !isMyTurn) || isPaused) && <SpinnerIcon />}
          <strong>{statusText}</strong>
        </div>
        <div className="arena-round">
          <span>Runde <b>{game.round}</b></span>
          {game.potCount > 0 && <span>Pot <b>{game.potCount}</b></span>}
          {game.phase !== "finished" && <span className="simple-timer"><b>{seconds}</b>s</span>}
        </div>
      </div>

      <div className="arena-table">
        <div className="arena-inlay" />
        <TableCards state={state} />
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
        />
      )}

      {game.phase === "finished" && <FinishPanel state={state} />}
    </section>
  );
}

function TableCards({ state }) {
  const { game, players, categories, selfId } = state;
  const tableByPlayer = new Map(game.tableCards.map((entry) => [entry.playerId, entry.card]));
  const participants = players.filter((player) => !player.eliminated || tableByPlayer.has(player.id));

  return (
    <div className={`arena-cards count-${participants.length}`}>
      {participants.map((player, index) => {
        const card = tableByPlayer.get(player.id) ||
          (game.phase === "choosing" && player.id === selfId ? game.ownCard : null);
        const isBest = game.result?.winnerIds?.includes(player.id);
        return (
          <div
            className={`arena-seat ${player.id === game.activePlayerId ? "is-active" : ""} ${isBest ? "is-best" : ""}`}
            style={{ "--seat-index": index }}
            key={player.id}
          >
            <div className="arena-card-place">
              {card ? (
                <VehicleCard
                  card={card}
                  categories={categories}
                  selectable={game.phase === "choosing" && player.id === selfId && game.activePlayerId === selfId}
                  highlight={game.category}
                  tableCard
                />
              ) : (
                <CardBack layers={Math.min(player.cardCount, 3)} />
              )}
              {isBest && <span className="best-ribbon">{game.result.type === "tie" ? "GLEICHSTAND" : "STICH"}</span>}
            </div>
            <div className="player-under-card">
              <span className="player-dot" />
              <strong>{player.name}</strong>
              {player.id === selfId && <small>DU</small>}
              <b>{player.cardCount}</b>
              {!player.connected && <i>offline</i>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HandStack({ hand, categories, selectedCardId, onSelectCard, canChoose, choosing, self }) {
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
          <span>DEIN KARTENSTAPEL</span>
          <strong>Karte {selectedIndex + 1} von {hand.length}</strong>
        </div>
        <div className="stack-help">
          <button type="button" className="swipe-symbol" onClick={() => step(-1)} aria-label="Vorherige Karte">←</button>
          Wischen
          <button type="button" className="swipe-symbol" onClick={() => step(1)} aria-label="Nächste Karte">→</button>
        </div>
      </div>
      <div className="stack-carousel">
        <FlyingStack
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
              </>
            );
          }}
        </FlyingStack>
      </div>
    </aside>
  );
}

// Kartenstapel zum Wischen: Die oberste Karte folgt dem Finger/der Maus, ab SWIPE_THRESHOLD px wird
// die nächste (oder vorherige) Karte nach vorn geholt. Die Karten laufen im Kreis.
const SWIPE_THRESHOLD = 90;
const DRAG_START = 6;
const VISIBLE_CARDS = 4;

function FlyingStack({ count, selectedIndex, onSelectIndex, label, children }) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ active: false, started: false, pointerId: null, startX: 0, dx: 0 });

  const go = useCallback(
    (direction) => {
      if (count > 1) onSelectIndex((selectedIndex + direction + count) % count);
    },
    [count, selectedIndex, onSelectIndex]
  );

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "ArrowRight") go(1);
      if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (!event.target.closest(".flying-card.is-active")) return;
    drag.current = { active: true, started: false, pointerId: event.pointerId, startX: event.clientX, dx: 0 };
  };

  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d.active || event.pointerId !== d.pointerId) return;
    const dx = event.clientX - d.startX;
    if (!d.started) {
      // Erst ab ein paar Pixeln gilt es als Ziehen, damit ein Antippen der Werte weiter funktioniert.
      if (Math.abs(dx) < DRAG_START) return;
      d.started = true;
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    d.dx = dx;
    setDragX(dx);
  };

  const onPointerEnd = (event) => {
    const d = drag.current;
    if (!d.active || event.pointerId !== d.pointerId) return;
    drag.current = { active: false, started: false, pointerId: null, startX: 0, dx: 0 };
    if (!d.started) return;
    setDragging(false);
    setDragX(0);
    if (event.type !== "pointercancel" && Math.abs(d.dx) > SWIPE_THRESHOLD) go(d.dx < 0 ? 1 : -1);
  };

  const cards = [];
  for (let index = 0; index < count; index += 1) {
    let offset = index - selectedIndex;
    if (offset > count / 2) offset -= count;
    if (offset < -count / 2) offset += count;
    const distance = Math.abs(offset);
    if (distance > VISIBLE_CARDS + 1) continue; // weiter hinten liegende Karten gar nicht erst zeichnen
    const isActive = offset === 0;
    const hidden = distance > VISIBLE_CARDS;

    const style = isActive
      ? {
          zIndex: 100,
          opacity: 1,
          filter: "none",
          transform: `translate3d(${dragX}px, 0, 0) rotate(${dragX * 0.035}deg) scale(1)`
        }
      : {
          zIndex: 100 - distance,
          opacity: hidden ? 0 : 1,
          pointerEvents: "none",
          filter: `brightness(${1 - distance * 0.055})`,
          transform: `translate3d(${offset * 24}px, ${distance * 10}px, ${-distance * 25}px) rotate(${offset * 4}deg) scale(${1 - distance * 0.045})`
        };

    cards.push(
      <div
        className={`flying-card ${isActive ? "is-active" : ""} ${isActive && dragging ? "is-dragging" : ""}`}
        style={style}
        key={index}
      >
        {children(index, isActive)}
      </div>
    );
  }

  return (
    <div
      className="flying-stack"
      role="group"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {cards}
    </div>
  );
}

function VehicleCard({ card, categories, selectable = false, highlight = null, tableCard = false }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className={`portrait-card ${tableCard ? "is-table-card" : ""}`}>
      <div className="portrait-card-head">
        <span>GT <b>TRUMPF</b></span>
        <small>#{card.c_id}</small>
      </div>
      <div className="portrait-photo">
        {card.image && !imageFailed ? (
          <img src={card.image} alt={card.name} loading="lazy" onError={() => setImageFailed(true)} />
        ) : (
          <VehicleFallback card={card} />
        )}
        <div className="photo-gradient" />
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
        <h2>{card.name}</h2>
      </div>
      <div className="portrait-stats">
        {Object.entries(categories).map(([key, rule]) => {
          const Tag = selectable ? "button" : "div";
          return (
            <Tag
              className={`portrait-stat ${selectable ? "is-selectable" : ""} ${highlight === key ? "is-highlighted" : ""}`}
              type={selectable ? "button" : undefined}
              onClick={selectable ? (event) => {
                event.stopPropagation();
                socket.emit("chooseCategory", key);
              } : undefined}
              key={key}
              title={selectable ? `${rule.label} wählen` : undefined}
            >
              <CategoryIcon type={rule.icon} />
              <span>{shortCategoryLabel(key, rule.label)}</span>
              <strong>{formatValue(card[key], key)} <small>{rule.unit}</small></strong>
              <i>{rule.direction === "low" ? "↓" : "↑"}</i>
            </Tag>
          );
        })}
      </div>
      {selectable && <div className="choose-hint">WERT ANKLICKEN</div>}
    </article>
  );
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

function CategoryIcon({ type }) {
  const paths = {
    bolt: <path d="m13 2-8 11h6l-1 9 9-12h-6V2Z" />,
    engine: <><path d="M7 7h9l3 3v7H7z" /><path d="M9 7V4h5v3M4 10H2v5h2m15-3h3v4h-3" /></>,
    speed: <><path d="M4 17a8 8 0 1 1 16 0" /><path d="m12 14 5-5" /></>,
    timer: <><circle cx="12" cy="13" r="8" /><path d="M9 2h6m-3 3v8l4 2" /></>,
    torque: <><path d="M6 7a7 7 0 1 1-1 9" /><path d="M3 10V5h5" /></>,
    weight: <><path d="M8 8a4 4 0 1 1 8 0" /><path d="M5 8h14l2 13H3L5 8Z" /></>,
    price: <><circle cx="12" cy="12" r="9" /><path d="M15 8.5c-.8-.8-4-.9-4.8.2-1.5 2 5.5 1.7 4 4.6-.7 1.4-4 1.2-5 .2M12 6v12" /></>
  };
  return <svg className="category-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[type] || paths.speed}</svg>;
}

function shortCategoryLabel(key, label) {
  if (key === "hoechstgeschwindigkeit") return "V-Max";
  if (key === "beschleunigung") return "0–100";
  return label;
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
