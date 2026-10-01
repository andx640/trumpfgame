import { useEffect, useMemo, useState } from "react";
import { EffectCoverflow, Pagination } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";
import "swiper/css/effect-coverflow";
import "swiper/css/pagination";
import { socket } from "./socket";

const SESSION_TOKEN = "pitlane-trumpf-token";
const SESSION_NAME = "pitlane-trumpf-name";

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
      if (token) {
        socket.emit("joinGame", { token, name }, (response) => {
          if (!response?.ok) {
            sessionStorage.removeItem(SESSION_TOKEN);
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

  const join = (name) => {
    setJoining(true);
    socket.emit("joinGame", { name }, (response) => {
      setJoining(false);
      if (!response?.ok) {
        setNotice(response?.message || "Beitritt fehlgeschlagen.");
        return;
      }
      sessionStorage.setItem(SESSION_TOKEN, response.token);
      sessionStorage.setItem(SESSION_NAME, name.trim());
    });
  };

  const leave = () => {
    socket.emit("leaveLobby");
    sessionStorage.removeItem(SESSION_TOKEN);
    sessionStorage.removeItem(SESSION_NAME);
    setState(null);
  };

  const isPlaying = state && state.status !== "lobby";

  return (
    <div className={`app-shell ${isPlaying ? "is-playing" : ""}`}>
      {!isPlaying && <Header connected={connected} state={state} />}
      <main>
        {!state ? (
          <Welcome onJoin={join} joining={joining} connected={connected} />
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

function Header({ connected, state }) {
  return (
    <header className="site-header">
      <div className="brand" aria-label="Pitlane Trumpf">
        <LogoMark />
        <div>
          <strong>PITLANE</strong>
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

function Welcome({ onJoin, joining, connected }) {
  const [name, setName] = useState(sessionStorage.getItem(SESSION_NAME) || "");
  const submit = (event) => {
    event.preventDefault();
    if (name.trim()) onJoin(name.trim());
  };

  return (
    <section className="welcome page-width">
      <div className="hero-copy">
        <div className="eyebrow"><span /> AUTO-QUARTETT · LIVE</div>
        <h1>Werte wählen.<br /><em>Stiche holen.</em></h1>
        <p>
          Das klassische Trumpfspiel am digitalen Renntisch. Zwei bis vier Fahrer,
          128 Boliden und nur eine Pole Position.
        </p>
        <div className="hero-stats" aria-label="Spieldetails">
          <span><b>2–4</b> Spieler</span>
          <span><b>128</b> Fahrzeuge</span>
          <span><b>7</b> Kategorien</span>
        </div>
      </div>
      <div className="join-card panel">
        <div className="panel-number">01</div>
        <p className="eyebrow">STARTAUFSTELLUNG</p>
        <h2>Betritt die Lobby</h2>
        <p className="muted">Wähle deinen Fahrernamen. Der erste Spieler übernimmt die Rennleitung.</p>
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
          <button className="primary-button" disabled={!connected || joining || !name.trim()}>
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
        <div className="arena-brand"><LogoMark /><span>PITLANE <b>TRUMPF</b></span></div>
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
          <span className="swipe-symbol">←</span>
          Wischen
          <span className="swipe-symbol">→</span>
        </div>
      </div>
      <div className="stack-carousel">
        <Swiper
          className="hand-swiper"
          modules={[EffectCoverflow, Pagination]}
          slidesPerView="auto"
          centeredSlides
          spaceBetween={10}
          loop={false}
          grabCursor
          effect="coverflow"
          coverflowEffect={{
            rotate: 0,
            stretch: 0,
            depth: 280,
            modifier: 1,
            slideShadows: false
          }}
          pagination={{ clickable: true }}
          initialSlide={selectedIndex}
          onSlideChange={(swiper) => onSelectCard(hand[swiper.activeIndex]?.c_id)}
          aria-label={`Kartenkarussell, Karte ${selectedIndex + 1} von ${hand.length}`}
          key={`${hand[0].c_id}-${hand.length}`}
        >
          {hand.map((card, index) => {
            const selected = card.c_id === selectedCardId;
            const isTop = index === 0;
            return (
              <SwiperSlide
                className={`carousel-card ${selected ? "is-selected" : ""} ${isTop ? "is-top-card" : ""}`}
                onClick={() => onSelectCard(card.c_id)}
                key={card.c_id}
              >
                <div className="stack-card-label">
                  {isTop ? <b>SPIELKARTE</b> : <span>#{index + 1}</span>}
                </div>
                <VehicleCard
                  card={card}
                  categories={categories}
                  selectable={selected && isTop && canChoose && choosing}
                  highlight={null}
                />
                {selected && !isTop && <div className="not-playable"><LockIcon /> Nur Karte 1 ist spielbar</div>}
                {selected && isTop && choosing && !canChoose && (
                  <div className="not-playable"><SpinnerIcon /> {self?.eliminated ? "Du schaust zu" : "Warte auf den aktiven Spieler"}</div>
                )}
              </SwiperSlide>
            );
          })}
        </Swiper>
      </div>
    </aside>
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
        <div className="portrait-back-pattern"><LogoMark /><b>PITLANE</b><span>TRUMPF</span></div>
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
