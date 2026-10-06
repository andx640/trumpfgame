import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { socket } from "./socket";
import { disablePush, enablePush, pushPermission, pushSupported, syncPush } from "./push";
import { chatSoundEnabled, playChat, playFlip, playLose, playTurn, playWin, setChatSoundEnabled, setSoundEnabled, soundEnabled, unlockAudio } from "./sound";

const SESSION_TOKEN = "pitlane-trumpf-token";
const SESSION_NAME = "pitlane-trumpf-name";
const SESSION_ROOM = "pitlane-trumpf-room";
const AUTH_KEY = "andi-trumpf-auth";

function readAuthToken() {
  try {
    return localStorage.getItem(AUTH_KEY);
  } catch {
    return null;
  }
}

function storeAuthToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_KEY, token);
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    // ohne Speicher bleibt man nur bis zum Neuladen angemeldet
  }
}

// Sekunden bis zu einem Zeitpunkt. Nur die kleinen Anzeige-Komponenten ticken, nicht das ganze Spiel.
function useSeconds(target) {
  const compute = () => (target ? Math.max(0, Math.ceil((target - socket.now()) / 1000)) : 0);
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

const LOW_SECONDS = 10;

function TurnTimer({ target }) {
  const seconds = useSeconds(target);
  return <span className={`turn-timer ${seconds <= LOW_SECONDS ? "is-low" : ""}`}>{seconds}s</span>;
}

// Ring, der in der verbleibenden Zeit leerläuft. Läuft per CSS-Animation, ohne dass React tickt.
function TimerRing({ target, duration }) {
  const remaining = Math.max(0, target - socket.now());
  const elapsed = Math.max(0, duration - remaining);
  return (
    <svg className="timer-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="timer-ring-track" cx="18" cy="18" r="15.9155" />
      <circle
        className="timer-ring-bar"
        cx="18"
        cy="18"
        r="15.9155"
        key={target}
        style={{ animationDuration: `${duration}ms`, animationDelay: `-${elapsed}ms` }}
      />
    </svg>
  );
}

function TurnBanner({ target, duration }) {
  const seconds = useSeconds(target);
  const low = seconds <= LOW_SECONDS;
  return (
    <span className={`turn-banner ${low ? "is-low" : ""}`}>
      <TimerRing target={target} duration={duration} /> DU BIST DRAN · {seconds}s
    </span>
  );
}

function App() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("home"); // home | new | join | collection | account | profile
  const [authToken, setAuthToken] = useState(readAuthToken);
  const [account, setAccount] = useState(null);
  const [invites, setInvites] = useState([]);
  const [banner, setBanner] = useState(null);
  const notifiedInvites = useRef(new Set());

  const loadProfile = useCallback((token) => {
    if (!token) return;
    socket.request("profile", { authToken: token }).then((result) => {
      if (result.ok) setAccount(result.account);
      else if (result.code === "logged_out") {
        storeAuthToken(null);
        setAuthToken(null);
        setAccount(null);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => loadProfile(authToken), [authToken, loadProfile]);
  // nach einer Partie die neue Statistik holen
  useEffect(() => {
    if (state?.status === "finished") loadProfile(authToken);
  }, [state?.status, authToken, loadProfile]);

  // Lebenszeichen: macht mich für Freunde „on“ und holt offene Einladungen
  useEffect(() => {
    if (!authToken) {
      setInvites([]);
      return undefined;
    }
    let alive = true;
    const beat = () => {
      socket.request("heartbeat", { authToken })
        .then((result) => {
          if (!alive || !result.ok) return;
          setInvites(result.invites);
          const fresh = result.invites.filter((invite) => !notifiedInvites.current.has(invite.id));
          result.invites.forEach((invite) => notifiedInvites.current.add(invite.id));
          if (fresh.length && !document.hidden) {
            setBanner(fresh[0]);
            playTurn();
          }
        })
        .catch(() => {});
    };
    beat();
    const timer = window.setInterval(beat, 6_000);
    const onVisible = () => !document.hidden && beat();
    document.addEventListener("visibilitychange", onVisible);
    syncPush(authToken).catch(() => {});
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authToken]);

  useEffect(() => {
    if (!banner) return undefined;
    const timer = window.setTimeout(() => setBanner(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const signedIn = (token, data) => {
    storeAuthToken(token);
    setAuthToken(token);
    setAccount(data);
    setView("profile");
  };

  const signOut = () => {
    storeAuthToken(null);
    setAuthToken(null);
    setAccount(null);
    setView("home");
  };

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, []);

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

  const doJoin = (name, room, ai, create) => {
    setJoining(true);
    socket.emit("joinGame", { name, room, create, authToken: account ? authToken : undefined, ai }, (response) => {
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
  const join = (name, room, ai) => doJoin(name, room, ai, view === "new");

  const declineInvite = (invite) => {
    setBanner((current) => (current?.id === invite.id ? null : current));
    setInvites((list) => list.filter((entry) => entry.id !== invite.id));
    socket.request("inviteDecline", { authToken, id: invite.id }).then((result) => result.ok && setInvites(result.invites)).catch(() => {});
  };

  const acceptInvite = (invite) => {
    setBanner(null);
    if (state && state.status !== "lobby") {
      setNotice("Beende erst die laufende Partie, dann kannst du der Einladung folgen.");
      return;
    }
    const go = () => doJoin(account.name, invite.room, undefined, false);
    if (state) {
      // aus der aktuellen Lobby wechseln
      socket.emit("leaveLobby", undefined, () => {
        sessionStorage.removeItem(SESSION_TOKEN);
        sessionStorage.removeItem(SESSION_ROOM);
        go();
      });
    } else {
      go();
    }
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
  const fullScreenView = !state && ["home", "new", "join", "account", "profile", "leaderboard"].includes(view);

  // Seitenwechsel: das neue Fenster schiebt sich von rechts herein, beim Zurück von links.
  const pageKey = state ? (state.status === "lobby" ? "lobby" : state.status === "deckbuild" ? "deckbuild" : "game") : view;
  const pageRank = state ? (state.status === "lobby" ? 2 : state.status === "deckbuild" ? 2.5 : 3) : view === "home" ? 0 : 1;
  const headerInside = !state && view === "collection";

  return (
    <div className={`app-shell ${isPlaying ? "is-playing" : ""} ${fullScreenView ? "is-home" : ""} ${state && !state.solo ? "has-chat" : ""}`}>
      {!isPlaying && !fullScreenView && !headerInside && <Header connected={connected} state={state} />}
      <main>
        <SlideStage pageKey={pageKey} rank={pageRank}>
        {!state && view === "home" ? (
          <Home
            onNew={() => setView("new")}
            onJoin={() => setView("join")}
            onCollection={() => setView("collection")}
            onLeaderboard={() => setView("leaderboard")}
            account={account}
            inviteCount={invites.length}
            onAccount={() => setView(account ? "profile" : "account")}
          />
        ) : !state && view === "collection" ? (
          <>
            <Header connected={connected} state={state} />
            <Collection onBack={() => setView("home")} authToken={account ? authToken : null} />
          </>
        ) : !state && view === "leaderboard" ? (
          <Leaderboard onBack={() => setView("home")} selfName={account?.name} />
        ) : !state && view === "account" ? (
          <AccountForm onBack={() => setView("home")} onSignedIn={signedIn} connected={connected} />
        ) : !state && view === "profile" ? (
          account ? (
            <Profile
              account={account}
              authToken={authToken}
              invites={invites}
              onAcceptInvite={acceptInvite}
              onDeclineInvite={declineInvite}
              onBack={() => setView("home")}
              onSignOut={signOut}
            />
          ) : <AccountForm onBack={() => setView("home")} onSignedIn={signedIn} connected={connected} />
        ) : !state ? (
          <Welcome mode={view} onBack={() => setView("home")} onJoin={join} joining={joining} connected={connected} account={account} />
        ) : state.status === "lobby" ? (
          <Lobby state={state} onLeave={leave} account={account} />
        ) : state.status === "deckbuild" && state.deckbuild ? (
          <DeckBuilder state={state} authToken={authToken} />
        ) : (
          <Game state={state} onLeave={leave} />
        )}
        </SlideStage>
      </main>
      {banner && <InviteBanner invite={banner} canJoin={!state || state.status === "lobby"} onAccept={() => acceptInvite(banner)} onDecline={() => declineInvite(banner)} onClose={() => setBanner(null)} />}
      {state && !state.solo && <ChatWidget chat={state.chat || []} selfId={state.selfId} sessionId={state.sessionId} />}
      {notice && <div className="toast" role="alert">{notice}</div>}
    </div>
  );
}

const SLIDE_MS = 380;

// Hält beim Seitenwechsel kurz die alte Seite fest, damit sie hinausgleiten kann, während die neue hereinkommt.
function SlideStage({ pageKey, rank, children }) {
  const previous = useRef({ key: pageKey, node: children, rank });
  const [leaving, setLeaving] = useState(null);
  const [direction, setDirection] = useState("forward");

  useLayoutEffect(() => {
    const before = previous.current;
    if (before.key !== pageKey) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (before.key !== "game" && pageKey !== "game" && !reduced) {
        setDirection(rank < before.rank ? "back" : "forward");
        setLeaving(before);
        window.scrollTo(0, 0);
      } else {
        setLeaving(null);
      }
    }
    previous.current = { key: pageKey, node: children, rank };
  });

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => setLeaving(null), SLIDE_MS + 40);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const panes = [];
  if (leaving && leaving.key !== pageKey) {
    panes.push(<div className={`slide-pane is-leaving is-${direction}`} key={leaving.key} inert="" aria-hidden="true">{leaving.node}</div>);
  }
  panes.push(<div className={`slide-pane ${leaving ? `is-entering is-${direction}` : ""}`} key={pageKey}>{children}</div>);
  return <div className="slide-stage">{panes}</div>;
}

function Home({ onNew, onJoin, onCollection, onLeaderboard, account, onAccount, inviteCount = 0 }) {
  return (
    <section className="home">
      <button type="button" className="home-account" onClick={onAccount}>
        {account ? (
          <><LevelBadge level={account.level} /><span>{account.name}</span>{inviteCount > 0 && <b className="home-account-badge" aria-label={`${inviteCount} Einladungen`}>{inviteCount}</b>}</>
        ) : (
          <><UserIcon /><span>Anmelden</span></>
        )}
      </button>
      <div className="home-inner">
        <div className="home-logo" role="img" aria-label="Andi Trumpf">
          <div className="home-logo-top"><span>ANDI</span><FlagPattern /></div>
          <div className="home-logo-bottom">TRUMPF</div>
        </div>

        <nav className="home-menu" aria-label="Hauptmenü">
          <button type="button" className="home-primary" onClick={onNew}>
            <CardsIcon />
            <span><strong>Neues Spiel</strong><small>Mit Freunden oder gegen KI</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="home-card" onClick={onJoin}>
            <PeopleIcon />
            <span><strong>Spiel beitreten</strong><small>Einer Lobby beitreten</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="home-card" onClick={onCollection}>
            <CollectionIcon />
            <span><strong>Sammlung</strong><small>Deine gesammelten Autos</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="home-card" onClick={onLeaderboard}>
            <TrophyIcon />
            <span><strong>Rangliste</strong><small>Die Top 10 Spieler</small></span>
            <HomeArrow />
          </button>
        </nav>
      </div>
    </section>
  );
}

const TIER_NAMES = { 1: "Common", 2: "Rare", 3: "Epic", 4: "Legendary", 5: "Mythic" };

function TierBadge({ tier }) {
  return <span className={`tier-badge tier-${tier}`}>{TIER_NAMES[tier] || "Common"}</span>;
}

// Karte mit Seltenheitsrahmen, optional Anzahl (×3) und „NEU“
function CollectionCard({ card, categories, qty = 0, isNew = false, onClick, dimmed = false, style }) {
  const tier = Number(card.raritaet) || 1;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} className={`tier-frame tier-${tier} ${dimmed ? "is-dimmed" : ""}`} onClick={onClick} style={style}>
      <ScaledCard>
        <VehicleCard card={card} categories={categories} />
      </ScaledCard>
      <TierBadge tier={tier} />
      {qty > 1 && <b className="card-qty">×{qty}</b>}
      {isNew && <b className="card-new">NEU</b>}
    </Tag>
  );
}

// Eigene Karten des Kontos (nur angemeldet). Was es sonst noch gibt, bleibt geheim.
function useOwnCollection(authToken) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!authToken) return undefined;
    let alive = true;
    socket
      .request("collection", { authToken })
      .then((result) => {
        if (!alive) return;
        if (result.ok) setData(result);
        else setFailed(result.message || "Die Sammlung konnte nicht geladen werden.");
      })
      .catch(() => alive && setFailed("Die Sammlung konnte nicht geladen werden."));
    return () => {
      alive = false;
    };
  }, [authToken]);
  return [data, failed];
}

function sortCards(cards, order) {
  return [...cards].sort((a, b) => (order === "name" ? a.name.localeCompare(b.name, "de") : (b.raritaet - a.raritaet) || a.name.localeCompare(b.name, "de")));
}

function Collection({ onBack, authToken }) {
  const [data, failed] = useOwnCollection(authToken);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("tier");

  const cards = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("de");
    return sortCards((data?.cards || []).filter((card) => !needle || card.name.toLocaleLowerCase("de").includes(needle)), order);
  }, [data, query, order]);

  return (
    <section className="collection page-width">
      <div className="collection-head">
        <div className="card-head-row">
          <h1>Meine Sammlung</h1>
          <button type="button" className="text-button" onClick={onBack}>← Zurück</button>
        </div>
        {!authToken ? (
          <p className="muted">Melde dich an, um Autos zu sammeln. Neue Konten starten mit 16 Autos.</p>
        ) : (
          <>
            <p className="collection-count">{data ? <><b>{data.collected}</b> / {data.total} Autos</> : "Lädt …"}</p>
            <div className="collection-tools">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="In deiner Sammlung suchen"
                aria-label="Auto suchen"
              />
              <select value={order} onChange={(event) => setOrder(event.target.value)} aria-label="Sortierung">
                <option value="tier">Nach Seltenheit</option>
                <option value="name">Nach Name</option>
              </select>
            </div>
          </>
        )}
      </div>
      {failed && <p className="collection-empty">{failed}</p>}
      {data && cards.length === 0 && <p className="collection-empty">Kein Auto gefunden.</p>}
      <div className="collection-grid">
        {cards.map((card) => (
          <CollectionCard card={card} categories={data.categories} qty={card.qty} key={card.c_id} />
        ))}
      </div>
      {data && data.cards.length > 0 && (
        <details className="photo-credits">
          <summary>Bildnachweise</summary>
          <ul>
            {data.cards.filter((card) => card.imageMeta?.pageUrl).map((card) => (
              <li key={card.c_id}>
                {card.name}: <a href={card.imageMeta.pageUrl} target="_blank" rel="noreferrer">{card.imageMeta.author || "Wikimedia Commons"}</a>
                {card.imageMeta.license ? `, ${card.imageMeta.license}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// Risiko-Modus: 90 Sekunden, um aus der eigenen Sammlung das Deck zu wählen. Danach füllt der Server den Rest zufällig.
function DeckBuilder({ state, authToken }) {
  const build = state.deckbuild;
  const [data, failed] = useOwnCollection(authToken);
  const [picks, setPicks] = useState(build.picks || []);
  const [order, setOrder] = useState("tier");
  const isReady = build.readyIds.includes(state.selfId);
  const need = build.need;
  const secondsLeft = useSeconds(build.deadline);

  const send = useCallback((next, ready = false) => {
    socket.request("deck", { cards: next, ready }).then((result) => {
      if (result.ok) socket.applyResult(result);
    }).catch(() => {});
  }, []);

  const used = useMemo(() => {
    const counts = new Map();
    picks.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
    return counts;
  }, [picks]);

  const cards = useMemo(() => sortCards(data?.cards || [], order), [data, order]);
  const byId = useMemo(() => new Map((data?.cards || []).map((card) => [card.c_id, card])), [data]);

  const change = (next) => {
    if (isReady) return;
    setPicks(next);
    send(next);
  };
  const add = (card) => {
    if (picks.length >= need || (used.get(card.c_id) || 0) >= card.qty) return;
    change([...picks, card.c_id]);
  };
  const remove = (index) => change(picks.filter((_, position) => position !== index));
  const fillRandom = () => {
    const pool = [];
    (data?.cards || []).forEach((card) => {
      for (let i = (used.get(card.c_id) || 0); i < card.qty; i += 1) pool.push(card.c_id);
    });
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    change([...picks, ...pool.slice(0, need - picks.length)]);
  };
  const done = () => {
    send(picks, true);
  };
  const readyPlayers = state.players.filter((player) => build.readyIds.includes(player.id)).length;

  return (
    <section className="deckbuilder">
      <div className="deckbuilder-head page-width">
        <div className="card-head-row">
          <p className="eyebrow">RISIKO-MODUS</p>
          <span className={`deck-timer ${secondsLeft <= LOW_SECONDS ? "is-low" : ""}`}>{secondsLeft} s</span>
        </div>
        <h1>Deck zusammenstellen</h1>
        <p className="muted">Wähle {need} Karten aus deiner Sammlung. Wenn die Zeit um ist, wird der Rest zufällig gewählt. Achtung: Der Gewinner darf sich eine Karte aus deinem Deck aussuchen.</p>
        <div className="deck-picks" aria-label="Dein Deck">
          <b className="deck-count">{picks.length} / {need}</b>
          {picks.map((id, index) => {
            const card = byId.get(id);
            return (
              <button type="button" className={`deck-chip tier-${card?.raritaet || 1}`} key={`${id}-${index}`} onClick={() => remove(index)} disabled={isReady} title="Aus dem Deck nehmen">
                {card?.name || id} <span aria-hidden="true">×</span>
              </button>
            );
          })}
        </div>
        <div className="deck-actions">
          {isReady ? (
            <p className="deck-wait"><SpinnerIcon /> Fertig. Warte auf die anderen ({readyPlayers}/{state.players.length}) …</p>
          ) : (
            <>
              <button type="button" className="team-shuffle" onClick={fillRandom} disabled={picks.length >= need || !data}>Rest zufällig</button>
              <button type="button" className="primary-button deck-done" onClick={done}><span>{picks.length < need ? "Fertig (Rest zufällig)" : "Fertig"}</span><FlagIcon /></button>
            </>
          )}
          <select value={order} onChange={(event) => setOrder(event.target.value)} aria-label="Sortierung">
            <option value="tier">Nach Seltenheit</option>
            <option value="name">Nach Name</option>
          </select>
        </div>
      </div>
      {failed && <p className="collection-empty page-width">{failed}</p>}
      <div className="collection-grid page-width deck-grid">
        {cards.map((card) => {
          const left = card.qty - (used.get(card.c_id) || 0);
          return (
            <CollectionCard
              card={card}
              categories={data.categories}
              qty={left}
              dimmed={left <= 0 || isReady}
              onClick={left > 0 && !isReady ? () => add(card) : undefined}
              key={card.c_id}
            />
          );
        })}
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

const AI_LEVEL_INFO = [
  { id: "easy", label: "Leicht" },
  { id: "medium", label: "Mittel" },
  { id: "hard", label: "Schwer" }
];

function Welcome({ mode = "new", onBack, onJoin, joining, connected, account }) {
  const [typedName, setName] = useState(sessionStorage.getItem(SESSION_NAME) || "");
  const [sessionId, setSessionId] = useState("");
  const [vsAi, setVsAi] = useState(false);
  const [difficulty, setDifficulty] = useState("medium");
  const [opponents, setOpponents] = useState(1);
  const name = account ? account.name : typedName;
  const ai = mode === "new" && vsAi;
  const submit = (event) => {
    event.preventDefault();
    if (!name.trim() || (mode === "join" && !sessionId)) return;
    onJoin(name.trim(), sessionId, ai ? { difficulty, opponents } : undefined);
  };

  return (
    <section className="welcome page-width">
      <div className="join-card panel">
        <div className="card-head-row">
          <p className="eyebrow">STARTAUFSTELLUNG</p>
          {onBack && <button type="button" className="text-button join-back" onClick={onBack}>← Zurück</button>}
        </div>
        <h2>{mode === "join" ? "Spiel beitreten" : "Neues Spiel"}</h2>
        {mode === "new" && (
          <div className="account-tabs" role="tablist" aria-label="Spielart">
            <button type="button" role="tab" aria-selected={!vsAi} onClick={() => setVsAi(false)}>Mit Freunden</button>
            <button type="button" role="tab" aria-selected={vsAi} onClick={() => setVsAi(true)}>Gegen KI</button>
          </div>
        )}
        <p className="muted">
          {mode === "join"
            ? (account ? "Gib die Session-ID ein." : "Gib einen Spielernamen und die Session-ID ein.")
            : ai
              ? "Wähle die Stärke und die Zahl der Gegner."
              : account
                ? "Danach schickst du Freunden die Session-ID."
                : "Gib einen Spielernamen ein, danach schickst du Freunden die Session-ID."}
        </p>
        <form onSubmit={submit}>
          {account ? (
            <>
              <span className="field-label">Angemeldet als</span>
              <div className="signed-in-profile">
                <UserIcon />
                <b>{account.name}</b>
                <span className="muted">Level {account.level}</span>
              </div>
            </>
          ) : (
            <>
              <label htmlFor="player-name">Fahrername</label>
              <input
                id="player-name"
                value={name}
                onChange={(event) => setName(event.target.value.slice(0, 20))}
                placeholder="z. B. Niki"
                autoComplete="nickname"
                autoFocus={typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches}
              />
            </>
          )}
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
          {ai && (
            <>
              <span className="field-label">Schwierigkeit</span>
              <div className="ai-levels" role="radiogroup" aria-label="Schwierigkeit">
                {AI_LEVEL_INFO.map((level) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={difficulty === level.id}
                    className={`ai-level is-${level.id}`}
                    key={level.id}
                    onClick={() => setDifficulty(level.id)}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
              {difficulty === "easy" && <p className="ai-note" role="status">Gegen „Leicht“ gibt es keine XP.</p>}
              {difficulty === "medium" && <p className="ai-note" role="status">Gegen „Mittel“ gibt es nur 35 % der XP.</p>}
              {difficulty === "hard" && <p className="ai-note" role="status">Sieg mit 16 Karten: 1 neues Auto. Mit 32 Karten: Pack mit 3–5 Autos.{account ? "" : " Nur mit Konto."}</p>}
              <span className="field-label">Gegner</span>
              <div className="ai-opponents" role="radiogroup" aria-label="Anzahl der Gegner">
                {[1, 2, 3].map((count) => (
                  <button type="button" role="radio" aria-checked={opponents === count} key={count} onClick={() => setOpponents(count)}>
                    {count} Gegner
                  </button>
                ))}
              </div>
            </>
          )}
          <button className="primary-button" disabled={!connected || joining || !name.trim() || (mode === "join" && sessionId.length < 4)}>
            <span>{joining ? "Beitritt läuft …" : mode === "join" ? "Lobby beitreten" : ai ? "Gegen KI spielen" : "Lobby eröffnen"}</span>
            <ArrowIcon />
          </button>
        </form>
        <div className="secure-note">
          <ShieldIcon />
          {account ? `Angemeldet als ${account.name}: Siege und XP werden gespeichert.` : "Als Gast spielen. Mit Anmeldung werden Siege und XP gespeichert."}
        </div>
      </div>
    </section>
  );
}

const DECK_MODE_INFO = [
  { id: "friendly", label: "Freundschaft", short: "Pool-Karten", text: "Alle spielen mit Karten aus dem gemeinsamen Pool. Niemand gewinnt oder verliert Karten." },
  { id: "auto", label: "Eigene Karten", short: "zufällig", text: "Jeder spielt mit zufälligen Karten aus seiner Sammlung. Kein Verlust. Alle brauchen ein Konto und genug Karten." },
  { id: "risk", label: "Risiko", short: "eigenes Deck", text: "Jeder stellt in 90 Sekunden sein Deck zusammen. Der Gewinner darf sich von jedem Verlierer eine Karte aus dessen Deck nehmen." }
];

const TEAM_INFO = [{ name: "Team Rot", short: "Rot" }, { name: "Team Blau", short: "Blau" }];

function TeamTag({ team }) {
  if (team === null || team === undefined) return null;
  return <span className={`team-tag team-${team}`}>{TEAM_INFO[team].short}</span>;
}

function Lobby({ state, onLeave, account }) {
  const [inviting, setInviting] = useState(false);
  const selfIsHost = state.selfId === state.hostId;
  const canStart = state.players.length >= 2;
  const canTeams = !state.solo && state.players.length === state.maxPlayers;
  const openSeats = state.solo ? [] : Array.from({ length: state.maxPlayers - state.players.length });
  const cardCountOptions = state.cardCountOptions || [8, 16, 32];
  const totalCards = state.players.length * state.cardsPerPlayer;

  return (
    <section className="lobby page-width">
      <div className="lobby-heading">
        <div>
          <p className="eyebrow"><span /> BOXENGASSE OFFEN</p>
          <h1>Die Startaufstellung</h1>
          <p className="muted">{state.solo ? "Du spielst gegen die KI. Wähle die Kartenzahl und starte." : "Sobald mindestens zwei Fahrer bereit sind, kann der Host austeilen."}</p>
        </div>
        <button className="text-button" onClick={onLeave}>Lobby verlassen</button>
      </div>
      {state.solo ? (
        <p className="muted session-code">Spiel gegen KI · Stufe <b>{AI_LEVEL_INFO.find((level) => level.id === state.aiLevel)?.label || "Mittel"}</b></p>
      ) : (
        <p className="muted session-code">Session-ID zum Beitreten: <b>{state.sessionId}</b></p>
      )}
      {account && !state.solo && state.players.length < state.maxPlayers && (
        <button type="button" className="invite-open" onClick={() => setInviting(true)}>Freunde einladen</button>
      )}
      {inviting && <InviteModal players={state.players} onClose={() => setInviting(false)} />}

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
                  <strong>{player.name} {player.level && <LevelBadge level={player.level} />} {player.id === state.selfId && <small>DU</small>}</strong>
                  <span>{player.isBot ? "Computergegner" : player.isHost ? "Rennleitung · Host" : `Startplatz ${index + 1}`}</span>
                </div>
                <TeamTag team={player.team} />
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
          {!state.solo && (
            <div className="mode-settings">
              <div>
                <span>KARTEN</span>
                <b>{DECK_MODE_INFO.find((mode) => mode.id === state.deckMode)?.label || "Freundschaft"}</b>
              </div>
              <div className="mode-options is-three" role="group" aria-label="Kartenmodus">
                {DECK_MODE_INFO.map((mode) => (
                  <button
                    type="button"
                    className={state.deckMode === mode.id ? "is-selected" : ""}
                    disabled={!selfIsHost}
                    key={mode.id}
                    onClick={() => socket.request("setDeckMode", { mode: mode.id }).then((result) => (result.ok ? socket.applyResult(result) : window.alert(result.message))).catch(() => {})}
                  >
                    <strong>{mode.label}</strong><span>{mode.short}</span>
                  </button>
                ))}
              </div>
              <small>{DECK_MODE_INFO.find((mode) => mode.id === state.deckMode)?.text}</small>
            </div>
          )}
          {canTeams && (
            <div className="mode-settings">
              <div>
                <span>SPIELMODUS</span>
                <b>{state.teamMode ? "2 gegen 2" : "Jeder gegen jeden"}</b>
              </div>
              <div className="mode-options" role="group" aria-label="Spielmodus">
                <button type="button" className={!state.teamMode ? "is-selected" : ""} disabled={!selfIsHost} onClick={() => socket.emit("setTeams", { on: false })}>
                  <strong>Alle</strong><span>gegeneinander</span>
                </button>
                <button type="button" className={state.teamMode ? "is-selected" : ""} disabled={!selfIsHost} onClick={() => socket.emit("setTeams", { on: true })}>
                  <strong>2 vs 2</strong><span>im Team</span>
                </button>
              </div>
              {state.teamMode && (
                <>
                  <div className="team-lineup">
                    {[0, 1].map((team) => (
                      <p className={`team-${team}`} key={team}>
                        <b>{TEAM_INFO[team].name}</b>
                        {state.players.filter((player) => player.team === team).map((player) => player.name).join(" + ")}
                      </p>
                    ))}
                  </div>
                  {selfIsHost && <button type="button" className="team-shuffle" onClick={() => socket.emit("setTeams", { on: true, shuffle: true })}>Teams neu mischen</button>}
                  <small>Die beste Karte im Team zählt. Gewonnene Karten gehen an beide im Team. Die Teams sind abwechselnd dran.</small>
                </>
              )}
              {!selfIsHost && !state.teamMode && <small>Der Host kann 2 gegen 2 einstellen.</small>}
            </div>
          )}
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

function Game({ state, onLeave }) {
  const { game, players, selfId, categories } = state;
  const hand = game.ownHand || [];
  const [soundOn, setSoundOn] = useState(soundEnabled);
  const self = players.find((player) => player.id === selfId);
  const seatCount = Math.min(4, Math.max(2, players.filter((player) => !player.eliminated || game.tableCards.some((entry) => entry.playerId === player.id)).length));
  const isChoosing = game.phase === "choosing";
  const isMyTurn = isChoosing && game.activePlayerId === selfId;
  const isPaused = Boolean(game.pausedUntil) && game.phase !== "finished";
  const timerTarget = isPaused ? game.pausedUntil : isChoosing ? game.turnEndsAt : game.revealEndsAt;

  useEffect(() => {
    if (!isMyTurn || isPaused) return;
    playTurn();
  }, [isMyTurn, isPaused, game.turnEndsAt]);

  // Geräusche beim Aufdecken: Umdrehen, danach Stich gewonnen oder verloren
  useEffect(() => {
    if (game.phase !== "revealed") return undefined;
    const played = game.tableCards.some((entry) => entry.playerId === selfId);
    const selfTeam = players.find((player) => player.id === selfId)?.team;
    const won = game.result?.type === "winner" && (game.teamMode ? game.result.winnerTeam === selfTeam : game.result.winnerIds?.[0] === selfId);
    const flip = window.setTimeout(playFlip, 650);
    const outcome = window.setTimeout(() => {
      if (won) {
        playWin();
      } else if (played && game.result?.type === "winner") {
        playLose();
      }
    }, 1800);
    return () => {
      window.clearTimeout(flip);
      window.clearTimeout(outcome);
    };
  }, [game.phase, game.round]);

  const toggleSound = useCallback(() => {
    setSoundOn((value) => {
      setSoundEnabled(!value);
      return !value;
    });
  }, []);

  const isRevealed = game.phase === "revealed";
  const activePlayer = players.find((player) => player.id === game.activePlayerId);
  const onTable = new Set(game.tableCards.map((entry) => entry.playerId));
  const readyIds = game.readyIds || [];
  const readyNeeded = players.filter((player) => player.connected && !player.isBot && (player.cardCount > 0 || onTable.has(player.id)));
  const readyCount = readyNeeded.filter((player) => readyIds.includes(player.id)).length;

  return (
    <section className={`game-table-screen ${isMyTurn && !isPaused && hand.length ? "is-my-turn" : ""} ${game.phase === "revealed" ? "is-revealing" : ""}`} data-seats={seatCount}>
      <div className="arena-table">
        <div className="arena-inlay" />
        {isPaused && (
          <div className="arena-notice" role="status">
            <SpinnerIcon /> Mitspieler fehlen – das Spiel endet in <Seconds target={timerTarget} /> s, wenn niemand zurückkommt
          </div>
        )}
        {game.potCount > 0 && game.phase !== "finished" && <div className="arena-pot">Pott <b>{game.potCount}</b></div>}
        {isChoosing && !isMyTurn && !isPaused && activePlayer && game.turnEndsAt && (
          <div className="arena-waiting" role="status">
            <TimerRing target={game.turnEndsAt} duration={game.turnDurationMs || 45000} />
            <span><b>{activePlayer.name}</b> wählt …</span>
          </div>
        )}
        {isRevealed && game.teamMode && game.result?.type === "winner" && (
          <div className={`arena-result team-result team-${game.result.winnerTeam}`} role="status">
            <strong>{TEAM_INFO[game.result.winnerTeam].name} gewinnt den Stich</strong>
            <span>{game.result.collectedCards} Karten gehen an das Team</span>
          </div>
        )}
        {isRevealed && game.result?.type === "tie" && (
          <div className="arena-result" role="status">
            <strong>Gleichstand!</strong>
            <span>Pott: {game.potCount} Karten · <b>{activePlayer?.name}</b> wählt nochmal</span>
          </div>
        )}
        <TableCards state={state} timerTarget={isChoosing && !isPaused ? game.turnEndsAt : null} />
        <div className="arena-watermark"><LogoMark /><span>TRUMPF</span></div>
      </div>

      {game.phase !== "finished" && (
        <HandStack
          hand={hand}
          categories={categories}
          canChoose={isMyTurn}
          choosing={isChoosing}
          self={self}
          turnTarget={isMyTurn && !isPaused ? game.turnEndsAt : null}
          turnDuration={game.turnDurationMs || 45000}
          revealTarget={isRevealed && !isPaused ? game.revealEndsAt : null}
          isReady={readyIds.includes(selfId)}
          readyCount={readyCount}
          readyTotal={readyNeeded.length}
          soundOn={soundOn}
          onToggleSound={toggleSound}
        />
      )}

      {game.phase === "finished" && <FinishPanel state={state} onLeave={onLeave} />}
    </section>
  );
}

const COLLECT_LEAD_MS = 1000; // so lange vor Rundenende fliegen die Karten zum Gewinner

const TableCards = memo(function TableCards({ state, timerTarget = null }) {
  const { game, players, categories, selfId } = state;
  const tableByPlayer = new Map(game.tableCards.map((entry) => [entry.playerId, entry.card]));
  const participants = players.filter((player) => !player.eliminated || tableByPlayer.has(player.id));
  const rootRef = useRef(null);
  const countsBefore = useRef(new Map());
  const [collecting, setCollecting] = useState(false);
  const isRevealed = game.phase === "revealed";

  // Kartenzahlen vor dem Aufdecken merken, damit der Zähler des Gewinners erst beim Einsammeln hochzählt.
  useEffect(() => {
    if (game.phase === "choosing") countsBefore.current = new Map(players.map((player) => [player.id, player.cardCount]));
  }, [game.phase, players]);

  useEffect(() => setCollecting(false), [game.phase, game.round]);

  useEffect(() => {
    if (!isRevealed || !game.revealEndsAt || game.pausedUntil) return undefined;
    const timer = window.setTimeout(() => setCollecting(true), Math.max(0, game.revealEndsAt - socket.now() - COLLECT_LEAD_MS));
    return () => window.clearTimeout(timer);
  }, [isRevealed, game.revealEndsAt, game.pausedUntil]);

  // Ziel der Karten: Kartenzähler des Gewinners, bei Gleichstand der Pott in der Tischmitte.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!collecting || !root) return;
    const winnerId = game.result?.type === "winner" ? game.result.winnerIds?.[0] : null;
    const target = winnerId
      ? root.querySelector(`[data-player="${winnerId}"] .player-under-card b`)
      : root.parentElement?.querySelector(".arena-pot");
    const box = (target || root).getBoundingClientRect();
    const tx = box.left + box.width / 2;
    const ty = box.top + box.height / 2;
    root.querySelectorAll(".arena-card-place").forEach((place) => {
      const rect = place.getBoundingClientRect();
      place.style.setProperty("--fly-x", `${Math.round(tx - (rect.left + rect.width / 2))}px`);
      place.style.setProperty("--fly-y", `${Math.round(ty - (rect.top + rect.height / 2))}px`);
    });
  }, [collecting]);

  return (
    <div className={`arena-cards count-${participants.length} ${collecting ? "is-collecting" : ""}`} ref={rootRef}>
      {participants.map((player, index) => {
        const card = tableByPlayer.get(player.id) || null;
        const isSelf = player.id === selfId;
        const isBest = game.result?.winnerIds?.includes(player.id);
        const isActive = player.id === game.activePlayerId;
        const before = countsBefore.current.get(player.id);
        const played = isRevealed && tableByPlayer.has(player.id) && before !== undefined;
        const gain = played ? player.cardCount - (before - 1) : 0;
        const shownCount = played && !collecting ? Math.min(player.cardCount, before - 1) : player.cardCount;
        return (
          <div
            className={`arena-seat ${isActive ? "is-active" : ""} ${isBest ? "is-best" : ""} ${player.team !== null && player.team !== undefined ? `team-${player.team}` : ""}`}
            style={{ "--seat-index": index }}
            data-player={player.id}
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
              <b className={collecting && gain > 0 ? "is-bump" : ""}>{shownCount}</b>
              {collecting && gain > 0 && <em className="count-gain">+{gain}</em>}
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

// Eigener Stapel: wie beim echten Quartett sieht man nur die oberste Karte, darunter liegen die übrigen verdeckt.
const PILE_LAYERS = 6;

const HandStack = memo(function HandStack({ hand, categories, canChoose, choosing, self, turnTarget, turnDuration, revealTarget, isReady, readyCount, readyTotal, soundOn, onToggleSound }) {
  if (!hand.length) {
    return (
      <div className="empty-stack">
        <strong>Dein Stapel ist leer</strong>
        <span>Du kannst die restliche Partie am Tisch verfolgen.</span>
      </div>
    );
  }
  const top = hand[0];
  const layers = Math.min(hand.length - 1, PILE_LAYERS);

  return (
    <aside className="stack-dock">
      <div className="stack-heading">
        <div>
          {turnTarget
            ? <TurnBanner target={turnTarget} duration={turnDuration} />
            : revealTarget
              ? <span className="turn-banner">ERGEBNIS · weiter in <Seconds target={revealTarget} />s</span>
              : <span>DEIN KARTENSTAPEL</span>}
          <strong>{hand.length} {hand.length === 1 ? "Karte" : "Karten"}</strong>
        </div>
        <div className="stack-actions">
          <button
            type="button"
            className="sound-toggle"
            onClick={onToggleSound}
            aria-label={soundOn ? "Ton ausschalten" : "Ton einschalten"}
            aria-pressed={soundOn}
          >
            <SoundIcon on={soundOn} />
          </button>
          {revealTarget && (
            <button
              type="button"
              className={`ready-button ${isReady ? "is-ready" : ""}`}
              disabled={isReady}
              onClick={() => socket.emit("readyForNext")}
            >
              {isReady ? `Bereit ${readyCount}/${readyTotal}` : "Weiter"}
            </button>
          )}
        </div>
      </div>
      <div className="stack-carousel">
        <div className="deck-stage" aria-label={`Dein Stapel, ${hand.length} Karten`}>
          {Array.from({ length: layers }, (_, index) => (
            <div className="deck-card deck-pile" style={{ "--pile": layers - index }} key={index}>
              <div className="deck-blank" />
            </div>
          ))}
          <div className="deck-card is-active" key={top.c_id}>
            <div className="stack-card-label"><b>SPIELKARTE</b></div>
            <ScaledCard>
              <VehicleCard card={top} categories={categories} selectable={canChoose && choosing} highlight={null} />
              {choosing && !canChoose && self?.eliminated && (
                <div className="not-playable"><SpinnerIcon /> Du schaust zu</div>
              )}
            </ScaledCard>
          </div>
        </div>
      </div>
    </aside>
  );
});

function SoundIcon({ on }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {on ? (
        <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="m16 9 5 6m0-6-5 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
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
  { key: "preis", label: "Preis", unit: "€", icon: "price" },
  { key: "raritaet", label: "Rarität", icon: "gem", rating: "gem" },
  { key: "performance", label: "Performance", icon: "flag", rating: "flag" }
];

function cardValue(card, key) {
  const value = Number(card[key]);
  if (card[key] == null || !Number.isFinite(value) || value <= 0) return null;
  if (key === "hubraum") return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 1000);
  if (key === "preis" && value >= 1_000_000) return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(value / 1_000_000)} Mio`;
  if (key !== "preis" && key !== "beschleunigung") return String(Math.round(value)); // wie auf der Vorlage ohne Tausenderpunkt
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
              {field.rating ? (
                <RatingSymbols kind={field.rating} value={Number(card[field.key]) || 0} />
              ) : (
                <strong>{value ?? "–"}{value && <small>{field.unit}</small>}</strong>
              )}
              {rule && <i>{rule.direction === "low" ? "▼" : "▲"}</i>}
            </Tag>
          );
        })}
      </div>
    </article>
  );
});

// Rarität (Diamanten) und Performance (Zielflaggen): 1 bis 5, gefüllte Symbole leuchten gold
function RatingSymbols({ kind, value }) {
  return (
    <span className="rating" role="img" aria-label={`${value} von 5`}>
      {[1, 2, 3, 4, 5].map((index) => (
        <svg className={`rating-symbol ${index <= value ? "is-filled" : ""}`} viewBox="0 0 24 24" key={index} aria-hidden="true">
          {kind === "gem" ? (
            <>
              <path d="M6 3h12l4 6-10 12L2 9z" />
              <path d="M2 9h20M9 3l-2 6 5 12 5-12-2-6" className="rating-facets" />
            </>
          ) : (
            <>
              <path d="M5 2v21" className="rating-pole" />
              <path d="M6 3h14v11H6z" />
              <path d="M6 3h3.500v3.670H6zM13 3h3.500v3.670H13zM9.500 6.670H13v3.660H9.500zM16.500 6.670H20v3.660h-3.500zM6 10.330h3.500V14H6zM13 10.330h3.500V14H13z" className="rating-checks" />
            </>
          )}
        </svg>
      ))}
    </span>
  );
}

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
    gem: (
      <>
        <path d="M16 10h32l12 16-28 30L4 26z" fill={B} stroke={D} strokeWidth="2.500" strokeLinejoin="round" />
        <path d="M4 26h56M24 10l-8 16 16 30 16-30-8-16" fill="none" stroke={L} strokeWidth="2" strokeLinejoin="round" />
      </>
    ),
    flag: (
      <>
        <path d="M14 6v52" stroke={D} strokeWidth="5" strokeLinecap="round" />
        <path d="M14 8h38v28H14z" fill="#f4f1ee" stroke={D} strokeWidth="2.500" />
        {[0, 1, 2, 3].flatMap((col) => [0, 1, 2].map((row) => (col + row) % 2 === 0 ? <rect key={`${col}${row}`} x={14 + col * 9.500} y={8 + row * 9.330} width="9.500" height="9.330" fill="#1d1511" /> : null))}
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

// Session-Chat: Symbol oben rechts, Klick öffnet das Chatfenster (Lobby und Spiel)
function ChatWidget({ chat, selfId, sessionId }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [seenId, setSeenId] = useState(() => (chat.length ? chat[chat.length - 1].id : 0));
  const [soundOn, setSoundOn] = useState(chatSoundEnabled);
  const notifiedId = useRef(chat.length ? chat[chat.length - 1].id : 0);
  const listRef = useRef(null);
  const lastId = chat.length ? chat[chat.length - 1].id : 0;
  const unread = open ? 0 : chat.filter((message) => message.id > seenId && message.playerId !== selfId).length;

  // neue Nachricht eines anderen Spielers: Ton (nicht für den Verlauf beim Öffnen der Seite)
  useEffect(() => {
    const fresh = chat.filter((message) => message.id > notifiedId.current);
    if (!fresh.length) return;
    notifiedId.current = fresh[fresh.length - 1].id;
    if (fresh.some((message) => message.playerId !== selfId)) playChat();
  }, [chat, selfId]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setChatSoundEnabled(next);
  };

  // geöffnet: alles gilt als gelesen, Liste bleibt unten
  useEffect(() => {
    if (open) setSeenId(lastId);
  }, [open, lastId]);
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, lastId]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = (event) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    setError("");
    socket.request("chat", { text: message })
      .then((result) => {
        if (!result.ok) {
          setError(result.message || "Nachricht nicht gesendet.");
          setText(message);
        } else if (result.state) {
          socket.applyResult(result);
        }
      })
      .catch(() => {
        setError("Keine Verbindung zum Server.");
        setText(message);
      });
  };

  const time = (at) => new Date(at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <button type="button" className={`chat-button ${unread ? "has-unread" : ""}`} onClick={() => setOpen((value) => !value)} aria-label={unread ? `Chat öffnen, ${unread} neue Nachrichten` : "Chat öffnen"} aria-expanded={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="currentColor" />
        </svg>
        {unread > 0 && <b>{unread > 9 ? "9+" : unread}</b>}
      </button>
      {open && (
        <div className="chat-window" role="dialog" aria-label="Session-Chat">
          <div className="chat-head">
            <strong>Chat</strong>
            {sessionId && <small>Session {sessionId}</small>}
            <button
              type="button"
              className={`chat-sound ${soundOn ? "is-on" : ""}`}
              onClick={toggleSound}
              aria-pressed={soundOn}
              aria-label={soundOn ? "Chat-Ton ausschalten" : "Chat-Ton einschalten"}
              title={soundOn ? "Ton an" : "Ton aus"}
            >
              <SoundIcon on={soundOn} />
            </button>
            <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Chat schließen">✕</button>
          </div>
          <div className="chat-list" ref={listRef} aria-live="polite">
            {chat.length === 0 && <p className="chat-empty">Noch keine Nachrichten. Schreib den anderen Spielern etwas!</p>}
            {chat.map((message) => (
              <div className={`chat-message ${message.playerId === selfId ? "is-own" : ""}`} key={message.id}>
                {message.playerId !== selfId && <span className="chat-author">{message.name}</span>}
                <p>{message.text}</p>
                <small>{time(message.at)}</small>
              </div>
            ))}
          </div>
          {error && <p className="chat-error" role="alert">{error}</p>}
          <form className="chat-form" onSubmit={send}>
            <input
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, 200))}
              placeholder="Nachricht schreiben …"
              aria-label="Nachricht"
              maxLength={200}
              autoComplete="off"
            />
            <button type="submit" disabled={!text.trim()} aria-label="Senden">➤</button>
          </form>
        </div>
      )}
    </>
  );
}

function PresenceDot({ online }) {
  return (
    <span className={`presence ${online ? "is-on" : "is-off"}`} aria-label={online ? "online" : "offline"}>
      <i />
      {online ? "on" : "off"}
    </span>
  );
}

// Meldung von oben, wenn ein Freund einlädt
function InviteBanner({ invite, canJoin, onAccept, onDecline, onClose }) {
  return (
    <div className="invite-banner" role="alert">
      <div className="invite-banner-copy">
        <strong>{invite.from} lädt dich ein</strong>
        <span>{canJoin ? "Komm in die Lobby und spiel mit." : "Du kannst nach der Partie beitreten (siehe Postfach)."}</span>
      </div>
      {canJoin && <button type="button" className="friend-accept" onClick={onAccept}>Beitreten</button>}
      <button type="button" className="friend-ghost" onClick={canJoin ? onDecline : onClose} aria-label={canJoin ? "Einladung ablehnen" : "Meldung schließen"}>✕</button>
    </div>
  );
}

// Posteingang für Einladungen und Schalter für Push-Nachrichten aufs Handy
function Inbox({ invites, authToken, onAccept, onDecline }) {
  const [permission, setPermission] = useState(pushPermission);
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    syncPush(authToken).then((on) => alive && setPushOn(on)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [authToken]);

  const togglePush = () => {
    setBusy(true);
    setMessage("");
    const work = pushOn ? disablePush(authToken).then(() => false) : enablePush(authToken).then(() => true);
    work
      .then((on) => setPushOn(on))
      .catch((error) => setMessage(error.message || "Das hat nicht geklappt."))
      .finally(() => {
        setBusy(false);
        setPermission(pushPermission());
      });
  };

  return (
    <div className="inbox">
      <h3>Einladungen{invites.length > 0 ? ` (${invites.length})` : ""}</h3>
      {invites.length === 0 && <p className="muted">Keine Einladungen. Wenn ein Freund dich einlädt, erscheint sie hier.</p>}
      {invites.map((invite) => (
        <div className="friend-row" key={invite.id}>
          <div className="friend-copy"><strong>{invite.from}</strong><small>lädt dich zu einem Spiel ein</small></div>
          <button type="button" className="friend-accept" onClick={() => onAccept(invite)}>Beitreten</button>
          <button type="button" className="friend-ghost" onClick={() => onDecline(invite)} aria-label={`Einladung von ${invite.from} ablehnen`}>✕</button>
        </div>
      ))}
      {pushSupported() ? (
        <div className="push-row">
          <div className="friend-copy">
            <strong>Benachrichtigungen aufs Handy</strong>
            <small>{pushOn ? "An: Einladungen kommen auch, wenn die App zu ist." : permission === "denied" ? "Im Browser blockiert." : "Aus"}</small>
          </div>
          <button type="button" className={`push-toggle ${pushOn ? "is-on" : ""}`} onClick={togglePush} disabled={busy || permission === "denied"} aria-pressed={pushOn}>
            {pushOn ? "Ausschalten" : "Einschalten"}
          </button>
        </div>
      ) : (
        <p className="muted push-note">Push-Benachrichtigungen gibt es auf diesem Gerät nicht. Auf dem iPhone: App zum Home-Bildschirm hinzufügen.</p>
      )}
      {message && <p className="form-error" role="alert">{message}</p>}
    </div>
  );
}

// Freunde in die Lobby einladen
function InviteModal({ players, onClose }) {
  const [data, setData] = useState(null);
  const [message, setMessage] = useState("");
  const [invited, setInvited] = useState(() => new Set());

  const load = useCallback(() => {
    socket.request("friends", { authToken: readAuthToken() }).then((result) => result.ok && setData(result)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 8_000);
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [load, onClose]);

  const invite = (name) => {
    setMessage("");
    socket.request("invite", { name })
      .then((result) => {
        setMessage(result.message || "");
        if (result.ok) setInvited((set) => new Set(set).add(name));
      })
      .catch(() => setMessage("Keine Verbindung zum Server."));
  };

  const inLobby = new Set(players.map((player) => player.name.toLocaleLowerCase("de")));

  return (
    <div className="player-modal-backdrop" onClick={onClose}>
      <div className="player-modal panel" role="dialog" aria-modal="true" aria-label="Freunde einladen" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="player-modal-close" onClick={onClose} aria-label="Schließen">✕</button>
        <p className="eyebrow">EINLADEN</p>
        <h2>Freunde einladen</h2>
        {!data && <p className="muted">Lädt …</p>}
        {data && data.friends.length === 0 && <p className="muted">Du hast noch keine Freunde. Füge sie im Profil hinzu.</p>}
        <div className="friend-group">
          {data?.friends.map((friend) => {
            const there = inLobby.has(friend.name.toLocaleLowerCase("de"));
            const done = invited.has(friend.name);
            return (
              <div className="friend-row" key={friend.name}>
                <div className="friend-copy">
                  <strong>{friend.name} <LevelBadge level={friend.level} /></strong>
                  <PresenceDot online={friend.online} />
                </div>
                <button type="button" className="friend-accept" disabled={there || done} onClick={() => invite(friend.name)}>
                  {there ? "In der Lobby" : done ? "Eingeladen" : "Einladen"}
                </button>
              </div>
            );
          })}
        </div>
        {message && <p className="friend-message" role="status">{message}</p>}
      </div>
    </div>
  );
}

function LevelBadge({ level }) {
  return <span className="level-badge" title={`Level ${level}`}>Lv {level}</span>;
}

function XpBar({ level, xpInLevel, xpForLevel }) {
  const percent = Math.min(100, Math.round((100 * xpInLevel) / Math.max(1, xpForLevel)));
  return (
    <div className="xp-bar" aria-label={`Level ${level}: ${xpInLevel} von ${xpForLevel} XP`}>
      <div className="xp-bar-track"><i style={{ width: `${percent}%` }} /></div>
      <small>{xpInLevel} / {xpForLevel} XP bis Level {level + 1}</small>
    </div>
  );
}

function AccountForm({ onBack, onSignedIn, connected }) {
  const [mode, setMode] = useState("login"); // login | register
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = (event) => {
    event.preventDefault();
    if (!name.trim() || !password) return;
    setBusy(true);
    setError("");
    socket.request(mode, { name: name.trim(), password })
      .then((result) => {
        if (result.ok) onSignedIn(result.authToken, result.account);
        else setError(result.message || "Das hat nicht geklappt.");
      })
      .catch(() => setError("Keine Verbindung zum Server."))
      .finally(() => setBusy(false));
  };

  return (
    <section className="welcome page-width">
      <div className="join-card panel account-card">
        <div className="card-head-row">
          <p className="eyebrow">SPIELERKONTO</p>
          <button type="button" className="text-button join-back" onClick={onBack}>← Zurück</button>
        </div>
        <h2>{mode === "login" ? "Anmelden" : "Registrieren"}</h2>
        <div className="account-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>Anmelden</button>
          <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>Registrieren</button>
        </div>
        <p className="muted">Freiwillig: Mit Konto werden deine Spiele, Siege und XP gespeichert.</p>
        <form onSubmit={submit}>
          <label htmlFor="account-name">Spielername</label>
          <input id="account-name" value={name} onChange={(event) => setName(event.target.value.slice(0, 20))} autoComplete="username" placeholder="z. B. Niki" />
          <label htmlFor="account-password">Passwort</label>
          <input id="account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value.slice(0, 100))} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={!connected || busy || !name.trim() || !password}>
            <span>{busy ? "Moment …" : mode === "login" ? "Anmelden" : "Konto erstellen"}</span>
            <ArrowIcon />
          </button>
        </form>
        {mode === "register" && (
          <div className="secure-note"><ShieldIcon /> Nimm ein Passwort, das du sonst nirgends verwendest.</div>
        )}
      </div>
    </section>
  );
}

// Ringdiagramm: Anteil Siege (orange) und Niederlagen (grau), Siegquote in der Mitte
function WinRateDonut({ wins, losses }) {
  const total = wins + losses;
  const gap = wins > 0 && losses > 0 ? 1.2 : 0;
  const winPart = total ? (100 * wins) / total : 0;
  const lossPart = total ? 100 - winPart : 0;
  const winLength = Math.max(0, winPart - gap);
  const lossLength = Math.max(0, lossPart - gap);
  return (
    <div className="donut" role="img" aria-label={total ? `Siegquote ${Math.round(winPart)} Prozent: ${wins} Siege, ${losses} Niederlagen` : "Noch keine Spiele"}>
      <svg viewBox="0 0 42 42">
        <circle className="donut-track" cx="21" cy="21" r="15.9155" />
        {wins > 0 && (
          <circle className="donut-win" cx="21" cy="21" r="15.9155" strokeDasharray={`${winLength} ${100 - winLength}`} strokeDashoffset="25">
            <title>{wins} Siege</title>
          </circle>
        )}
        {losses > 0 && (
          <circle className="donut-loss" cx="21" cy="21" r="15.9155" strokeDasharray={`${lossLength} ${100 - lossLength}`} strokeDashoffset={25 - winPart}>
            <title>{losses} Niederlagen</title>
          </circle>
        )}
      </svg>
      <div className="donut-center">
        <strong>{total ? `${Math.round(winPart)}%` : "–"}</strong>
        <span>Siegquote</span>
      </div>
    </div>
  );
}

function MiniRing({ wins, losses }) {
  const total = wins + losses;
  const winPart = total ? (100 * wins) / total : 0;
  return (
    <span className="mini-ring" aria-label={total ? `Siegquote ${Math.round(winPart)} Prozent` : "Noch keine Spiele"}>
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle className="donut-track" cx="21" cy="21" r="15.9155" />
        {total > 0 && <circle className="donut-loss" cx="21" cy="21" r="15.9155" strokeDasharray="100 0" strokeDashoffset="25" />}
        {wins > 0 && <circle className="donut-win" cx="21" cy="21" r="15.9155" strokeDasharray={`${winPart} ${100 - winPart}`} strokeDashoffset="25" />}
      </svg>
      <b>{total ? `${Math.round(winPart)}%` : "–"}</b>
    </span>
  );
}

function FriendsPanel({ authToken }) {
  const [openName, setOpenName] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    socket.request("friends", { authToken }).then((result) => {
      if (result.ok) setData(result);
    }).catch(() => {});
  }, [authToken]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000); // neue Anfragen erscheinen von selbst
    return () => window.clearInterval(timer);
  }, [load]);

  const act = (action, friendName) =>
    socket.request(action, { authToken, name: friendName })
      .then((result) => {
        setMessage(result.message || "");
        load();
        return result;
      })
      .catch(() => setMessage("Keine Verbindung zum Server."));

  const add = (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    act("friendAdd", name.trim()).then((result) => {
      if (result?.ok) setName("");
    }).finally(() => setBusy(false));
  };

  const openFriend = (friend) => {
    setConfirmRemove(false);
    setOpenName(friend.name);
  };
  const closeFriend = useCallback(() => setOpenName(null), []);

  return (
    <div className="friends">
      <h3>Freunde{data ? ` (${data.friends.length})` : ""}</h3>
      <form className="friend-add" onSubmit={add}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value.slice(0, 20))}
          placeholder="Spielername hinzufügen"
          aria-label="Spielername des Freundes"
          autoComplete="off"
        />
        <button className="friend-add-button" disabled={busy || !name.trim()}>Hinzufügen</button>
      </form>
      {message && <p className="friend-message" role="status">{message}</p>}

      {data?.incoming.length > 0 && (
        <div className="friend-group">
          <h4>Anfragen an dich</h4>
          {data.incoming.map((entry) => (
            <div className="friend-row" key={entry.name}>
              <div className="friend-copy"><strong>{entry.name}</strong> <LevelBadge level={entry.level} /></div>
              <button type="button" className="friend-accept" onClick={() => act("friendAccept", entry.name)}>Annehmen</button>
              <button type="button" className="friend-ghost" onClick={() => act("friendRemove", entry.name)} aria-label={`Anfrage von ${entry.name} ablehnen`}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="friend-group">
        {data && data.friends.length === 0 && <p className="muted">Noch keine Freunde. Gib oben den Spielernamen eines Freundes ein.</p>}
        {data?.friends.map((friend) => (
          <button type="button" className="friend-row is-friend" key={friend.name} onClick={() => openFriend(friend)}>
            <MiniRing wins={friend.wins} losses={friend.losses} />
            <div className="friend-copy">
              <strong>{friend.name}</strong>
              <PresenceDot online={friend.online} />
            </div>
            <LevelBadge level={friend.level} />
          </button>
        ))}
      </div>

      {data?.outgoing.length > 0 && (
        <div className="friend-group">
          <h4>Gesendete Anfragen</h4>
          {data.outgoing.map((entry) => (
            <div className="friend-row" key={entry.name}>
              <div className="friend-copy"><strong>{entry.name}</strong> <small>wartet auf Antwort</small></div>
              <button type="button" className="friend-ghost" onClick={() => act("friendRemove", entry.name)} aria-label={`Anfrage an ${entry.name} zurückziehen`}>✕</button>
            </div>
          ))}
        </div>
      )}
      {openName && (
        <PlayerModal
          name={openName}
          online={data?.friends.find((friend) => friend.name === openName)?.online}
          onClose={closeFriend}
          footer={confirmRemove ? (
            <div className="friend-confirm">
              <span>{openName} wirklich entfernen?</span>
              <button type="button" className="friend-accept" onClick={() => act("friendRemove", openName).then(closeFriend)}>Ja, entfernen</button>
              <button type="button" className="text-button" onClick={() => setConfirmRemove(false)}>Abbrechen</button>
            </div>
          ) : (
            <button type="button" className="text-button" onClick={() => setConfirmRemove(true)}>Freund entfernen</button>
          )}
        />
      )}
    </div>
  );
}

// Statistikblock eines Spielers: Level, XP, Siegquote-Ring, Spiele, Siegesserie (Profil und Spielerfenster)
function ProfileStats({ account }) {
  return (
    <>
      <div className="profile-level">
        <span className="profile-level-number">Level {account.level}</span>
        {account.rank ? (
          <span className="profile-rank">Platz <b>{account.rank}</b>{account.players ? ` von ${account.players}` : ""}</span>
        ) : (
          <span className="muted">{account.xp} XP gesamt</span>
        )}
      </div>
      <XpBar level={account.level} xpInLevel={account.xpInLevel} xpForLevel={account.xpForLevel} />
      <WinRateDonut wins={account.wins} losses={account.losses} />
      <dl className="profile-stats">
        <div><dt>Spiele</dt><dd>{account.gamesPlayed}</dd></div>
        <div><dt><i className="swatch is-win" />Siege</dt><dd>{account.wins}</dd></div>
        <div><dt><i className="swatch is-loss" />Niederlagen</dt><dd>{account.losses}</dd></div>
      </dl>
      <dl className="profile-stats profile-streaks">
        <div><dt>Siegesserie</dt><dd>{account.currentStreak ?? 0}</dd><small>aktuell</small></div>
        <div className="is-record"><dt>Rekord</dt><dd>{account.bestStreak ?? 0}</dd><small>Siege am Stück</small></div>
      </dl>
      <p className="profile-xp-total">{account.xp} XP gesamt</p>
      {account.totalCards ? <p className="profile-collection">Sammlung: <b>{account.collected}</b> / {account.totalCards} Autos</p> : null}
    </>
  );
}

// Spielerfenster: öffnet sich über der Rangliste oder der Freundesliste
function PlayerModal({ name, online, onClose, footer = null }) {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    socket.request("playerProfile", { name })
      .then((result) => {
        if (!alive) return;
        if (result.ok) setAccount(result.account);
        else setError(result.message || "Das Profil konnte nicht geladen werden.");
      })
      .catch(() => alive && setError("Keine Verbindung zum Server."));
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [name, onClose]);

  return (
    <div className="player-modal-backdrop" onClick={onClose}>
      <div className="player-modal panel" role="dialog" aria-modal="true" aria-label={`Profil von ${name}`} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="player-modal-close" onClick={onClose} aria-label="Schließen">✕</button>
        <p className="eyebrow">SPIELERPROFIL</p>
        <h2>{name} {account && <LevelBadge level={account.level} />}</h2>
        {online !== undefined && <PresenceDot online={online} />}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!account && !error && <p className="muted">Lädt …</p>}
        {account && <ProfileStats account={account} />}
        {account && footer}
      </div>
    </div>
  );
}

function Profile({ account, authToken, invites = [], onAcceptInvite, onDeclineInvite, onBack, onSignOut }) {
  return (
    <section className="welcome page-width">
      <div className="join-card panel profile-card">
        <div className="card-head-row">
          <p className="eyebrow">SPIELERKONTO</p>
          <button type="button" className="text-button join-back" onClick={onBack}>← Zurück</button>
        </div>
        <h2>{account.name}</h2>
        <ProfileStats account={account} />
        <Inbox invites={invites} authToken={authToken} onAccept={onAcceptInvite} onDecline={onDeclineInvite} />
        <FriendsPanel authToken={authToken} />
        <button type="button" className="text-button" onClick={onSignOut}>Abmelden</button>
      </div>
    </section>
  );
}

function Leaderboard({ onBack, selfName }) {
  const [players, setPlayers] = useState(null);
  const [openName, setOpenName] = useState(null);
  const closePlayer = useCallback(() => setOpenName(null), []);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    socket.request("leaderboard")
      .then((result) => {
        if (!alive) return;
        if (result.ok) setPlayers(result.players);
        else setError(result.message || "Die Rangliste ist gerade nicht verfügbar.");
      })
      .catch(() => alive && setError("Keine Verbindung zum Server."));
    return () => {
      alive = false;
    };
  }, []);

  const self = selfName?.toLocaleLowerCase("de");

  return (
    <section className="welcome page-width">
      <div className="join-card panel leaderboard-card">
        <div className="card-head-row">
          <p className="eyebrow">RANGLISTE</p>
          <button type="button" className="text-button join-back" onClick={onBack}>← Zurück</button>
        </div>
        <h2>Top 10</h2>
        <p className="muted">Die Spieler mit den meisten XP.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!players && !error && <p className="muted">Lädt …</p>}
        {players && players.length === 0 && <p className="muted">Noch niemand hat XP gesammelt. Melde dich an und spiel eine Partie!</p>}
        {players && players.length > 0 && (
          <ol className="leaderboard">
            {players.map((player, index) => (
              <li key={player.name} className={`${index < 3 ? `is-top is-top-${index + 1}` : ""} ${player.name.toLocaleLowerCase("de") === self ? "is-self" : ""}`}>
                <button type="button" className="leaderboard-row" onClick={() => setOpenName(player.name)} aria-label={`Profil von ${player.name} öffnen`}>
                <span className="leaderboard-rank">{index + 1}</span>
                <div className="leaderboard-copy">
                  <strong>{player.name} <LevelBadge level={player.level} /></strong>
                  <small>{player.wins} {player.wins === 1 ? "Sieg" : "Siege"} · {player.gamesPlayed} {player.gamesPlayed === 1 ? "Spiel" : "Spiele"}{player.gamesPlayed ? ` · ${player.winRate} %` : ""}</small>
                </div>
                <span className="leaderboard-xp">{player.xp}<small>XP</small></span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {openName && <PlayerModal name={openName} onClose={closePlayer} />}
    </section>
  );
}

function TrophyIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <path d="M14 8h20v8c0 6.6-4.5 12-10 12S14 22.6 14 16z" fill="currentColor" />
      <path d="M14 11H7c0 6 3 9.500 7.500 10M34 11h7c0 6-3 9.500-7.500 10" fill="none" stroke="currentColor" strokeWidth="2.500" strokeLinecap="round" />
      <path d="M21 28h6v6h-6z" fill="currentColor" opacity="0.8" />
      <rect x="15" y="34" width="18" height="6" rx="2" fill="currentColor" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="user-icon">
      <circle cx="12" cy="8" r="4" fill="currentColor" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
    </svg>
  );
}

function FinishPanel({ state, onLeave }) {
  const { players, game, selfId } = state;
  const stats = state.stats || {};
  const winner = players.find((player) => player.id === game.winnerId);
  const winnerIds = game.winnerIds?.length ? game.winnerIds : game.winnerId ? [game.winnerId] : [];
  const winnerTeam = game.teamMode ? players.find((player) => player.id === game.winnerId)?.team : null;
  const statOf = (player) => stats[player.id] || { tricks: 0, best: 0, outRound: null };
  // Rangliste: Sieger zuerst, dann wer am längsten durchgehalten hat (bzw. die meisten Karten hat)
  const ranked = [...players].sort((a, b) => {
    const aWon = winnerIds.includes(a.id);
    const bWon = winnerIds.includes(b.id);
    if (aWon !== bWon) return aWon ? -1 : 1;
    const outA = statOf(a).outRound ?? Infinity;
    const outB = statOf(b).outRound ?? Infinity;
    if (outA !== outB) return outB - outA;
    return b.cardCount - a.cardCount;
  });
  const streakLeader = [...players].sort((a, b) => statOf(b).best - statOf(a).best)[0];
  const votes = state.rematchIds || [];
  const voters = players.filter((player) => player.connected && !player.isBot);
  const voted = votes.includes(selfId);
  const award = game.xpAwards?.[selfId];

  return (
    <div className="finish-overlay">
      <div className="finish-panel panel">
        <div className="trophy">🏁</div>
        <p className="eyebrow">PARTIE BEENDET</p>
        <h2>{game.teamMode && winnerTeam !== null && winnerTeam !== undefined ? `${TEAM_INFO[winnerTeam].name} gewinnt!` : `${winner?.name || "Unbekannt"} gewinnt!`}</h2>
        {game.teamMode && winnerIds.length > 0 && <p className="muted">{players.filter((player) => winnerIds.includes(player.id)).map((player) => player.name).join(" + ")}</p>}
        {game.result?.reason === "abandoned" && (
          <p className="muted">Die Partie wurde beendet, weil zu viele Mitspieler gegangen sind.</p>
        )}
        {award && award.xp > 0 && (
          <div className="finish-xp">
            <strong>+{award.xp} XP</strong>
            {award.level > award.levelBefore && <span className="finish-levelup">Level {award.level} erreicht!</span>}
            <XpBar level={award.level} xpInLevel={award.xpInLevel} xpForLevel={award.xpForLevel} />
            {state.solo && state.aiLevel === "medium" && <small className="finish-xp-note">Gegen „Mittel“ gibt es nur 35 % der XP.</small>}
          </div>
        )}
        {award && award.xp === 0 && state.solo && (
          <p className="muted finish-no-xp">Gegen „Leicht“ gibt es keine XP.</p>
        )}
        {game.cardAwards?.length > 0 && <PackReveal awards={game.cardAwards} categories={state.categories} />}
        {state.risk && <RiskPanel state={state} />}
        <ol className="finish-ranking">
          {ranked.map((player, index) => {
            const entry = statOf(player);
            return (
              <li key={player.id} className={player.id === selfId ? "is-self" : ""}>
                <span className="finish-rank">{index + 1}.</span>
                <b>{player.name} <TeamTag team={player.team} /> {(game.xpAwards?.[player.id]?.level || player.level) && <LevelBadge level={game.xpAwards?.[player.id]?.level || player.level} />}</b>
                <small>
                  {entry.tricks} {entry.tricks === 1 ? "Stich" : "Stiche"}
                  {entry.outRound ? ` · raus in Runde ${entry.outRound}` : ` · ${player.cardCount} Karten`}
                </small>
              </li>
            );
          })}
        </ol>
        <div className="finish-facts">
          {streakLeader && statOf(streakLeader).best > 1 && (
            <div><span>Längste Siegesserie</span><b>{streakLeader.name} · {statOf(streakLeader).best} Stiche am Stück</b></div>
          )}
          {state.topCard && (
            <div><span>Stärkste Karte</span><b>{state.topCard.name} · {state.topCard.wins} {state.topCard.wins === 1 ? "Stich" : "Stiche"}</b></div>
          )}
        </div>
        <div className="finish-actions">
          <button type="button" className="team-shuffle finish-home" onClick={onLeave}>← Startseite</button>
          <button className="primary-button" disabled={voted || (state.risk && !state.risk.done)} onClick={() => socket.emit("playAgain")}>
            <span>{voted ? `Warte auf die anderen (${votes.length}/${voters.length})` : "Revanche"}</span><FlagIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// Belohnung gegen KI „Schwer“: die Karten werden nacheinander aufgedeckt
function PackReveal({ awards, categories }) {
  return (
    <div className="pack-reveal">
      <p className="eyebrow">{awards.length > 1 ? `PACK MIT ${awards.length} AUTOS` : "NEUES AUTO"}</p>
      <div className="pack-cards">
        {awards.map((award, index) => (
          <CollectionCard
            card={award.card}
            categories={categories}
            isNew={award.isNew}
            style={{ "--reveal-delay": `${400 + index * 700}ms` }}
            key={`${award.card.c_id}-${index}`}
          />
        ))}
      </div>
    </div>
  );
}

// Risiko-Modus nach Spielende: der Gewinner wählt, alle sehen das Ergebnis
function RiskPanel({ state }) {
  const { risk, players, selfId, categories } = state;
  const winner = players.find((player) => player.id === risk.winnerId);
  const isWinner = selfId === risk.winnerId;
  const [busy, setBusy] = useState(false);
  const nameOf = (id) => players.find((player) => player.id === id)?.name || "Spieler";
  const pick = (loserId, cardId) => {
    setBusy(true);
    socket.request("riskPick", { loserId, cardId }).then((result) => {
      setBusy(false);
      if (result.ok) socket.applyResult(result);
    }).catch(() => setBusy(false));
  };

  if (risk.done) {
    return (
      <div className="risk-panel is-done">
        <p className="eyebrow">RISIKO</p>
        {Object.entries(risk.picks).map(([loserId, card]) => card && (
          <p key={loserId}>
            {isWinner ? <>Du bekommst <b>{card.name}</b> von {nameOf(loserId)}.</> : loserId === selfId ? <>Du hast <b>{card.name}</b> an {winner?.name} verloren.</> : <>{winner?.name} bekommt <b>{card.name}</b> von {nameOf(loserId)}.</>}
          </p>
        ))}
      </div>
    );
  }
  if (!isWinner) {
    return (
      <div className="risk-panel">
        <p className="eyebrow">RISIKO</p>
        <p><SpinnerIcon /> {winner?.name} sucht sich {risk.picks[selfId] !== undefined ? "eine Karte aus deinem Deck" : "seine Karten"} aus … noch <Seconds target={risk.deadline} /> s</p>
      </div>
    );
  }
  return (
    <div className="risk-panel">
      <p className="eyebrow">RISIKO · NOCH <Seconds target={risk.deadline} /> S</p>
      {Object.entries(risk.options || {}).map(([loserId, cards]) => (
        <div className="risk-choice" key={loserId}>
          <h3>Such dir eine Karte von {nameOf(loserId)} aus</h3>
          {risk.picks[loserId] ? (
            <p>Gewählt: <b>{risk.picks[loserId].name}</b></p>
          ) : (
            <div className="risk-cards">
              {sortCards(cards, "tier").map((card) => (
                <CollectionCard card={card} categories={categories} onClick={busy ? undefined : () => pick(loserId, card.c_id)} key={card.c_id} />
              ))}
            </div>
          )}
        </div>
      ))}
      <small className="muted">Ohne Wahl wird nach Ablauf der Zeit zufällig gewählt.</small>
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
