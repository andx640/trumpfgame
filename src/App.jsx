import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { socket } from "./socket";
import packArt from "./pack.webp";
import { disablePush, enablePush, pushPermission, pushSupported, syncPush } from "./push";
import { chatSoundEnabled, playCardCharge, playChat, playFlip, playImpact, playLose, playPackBurst, playPackCharge, playReveal, playTurn, playWin, setChatSoundEnabled, setSoundEnabled, soundEnabled, unlockAudio } from "./sound";
import {
  ArrowIcon, Button, Card, ChatIcon, CheckIcon, CloseIcon, ConnectionContext, CopyIcon, EmptyState, Field, FlagIcon, IconButton, InfoIcon,
  Loading, LogoMark, Modal, Note, Page, PlusIcon, SendIcon, Segmented, ShieldIcon, SoundIcon, Spinner, ToastProvider, UserIcon, useToast
} from "./ui";

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

const PAGE_RANK = { home: 0, new: 1, join: 1, collection: 1, leaderboard: 1, account: 1, profile: 1 };

function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent() {
  const notify = useToast();
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  const [joining, setJoining] = useState(false);
  const [view, setView] = useState("home"); // home | new | join | collection | leaderboard | account | profile
  const [authToken, setAuthToken] = useState(readAuthToken);
  const [account, setAccount] = useState(null);
  const [invites, setInvites] = useState([]);
  const [daily, setDaily] = useState(null); // geöffnetes Tagespack: { cards, categories }
  const [dailyBusy, setDailyBusy] = useState(false);
  const notifiedInvites = useRef(new Set());
  const stateRef = useRef(state);
  stateRef.current = state;

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

  // Tagespack: einmal pro Tag. Ohne Konto geht es zur Anmeldung, der Server entscheidet, ob heute noch eins da ist.
  const openDaily = () => {
    if (!account) {
      setView("account");
      return;
    }
    if (dailyBusy) return;
    setDailyBusy(true);
    unlockAudio();
    socket.request("dailyClaim", { authToken }).then((result) => {
      if (result.ok) {
        setDaily(result);
      } else {
        notify(result.message || "Das Tagespack ist gerade nicht verfügbar.");
        loadProfile(authToken);
      }
    }).catch(() => notify("Keine Verbindung zum Server.", { type: "error" })).finally(() => setDailyBusy(false));
  };
  // nach einer Partie die neue Statistik holen
  useEffect(() => {
    if (state?.status === "finished") loadProfile(authToken);
  }, [state?.status, authToken, loadProfile]);

  const doJoin = useCallback((name, room, ai, create) => {
    setJoining(true);
    socket.emit("joinGame", { name, room, create, authToken: account ? authToken : undefined, ai }, (response) => {
      setJoining(false);
      if (!response?.ok) {
        notify(response?.message || "Beitritt fehlgeschlagen.", { type: "error" });
        return;
      }
      sessionStorage.setItem(SESSION_TOKEN, response.token);
      sessionStorage.setItem(SESSION_ROOM, response.room);
      sessionStorage.setItem(SESSION_NAME, name.trim());
    });
  }, [account, authToken, notify]);
  const join = (name, room, ai) => doJoin(name, room, ai, view === "new");

  const declineInvite = useCallback((invite) => {
    setInvites((list) => list.filter((entry) => entry.id !== invite.id));
    socket.request("inviteDecline", { authToken, id: invite.id }).then((result) => result.ok && setInvites(result.invites)).catch(() => {});
  }, [authToken]);

  const acceptInvite = useCallback((invite) => {
    const current = stateRef.current;
    if (current && current.status !== "lobby") {
      notify("Beende erst die laufende Partie, dann kannst du der Einladung folgen.");
      return;
    }
    const go = () => doJoin(account.name, invite.room, undefined, false);
    if (current) {
      // aus der aktuellen Lobby wechseln
      socket.emit("leaveLobby", undefined, () => {
        sessionStorage.removeItem(SESSION_TOKEN);
        sessionStorage.removeItem(SESSION_ROOM);
        go();
      });
    } else {
      go();
    }
  }, [account, doJoin, notify]);

  const inviteHandlers = useRef({ acceptInvite, declineInvite });
  inviteHandlers.current = { acceptInvite, declineInvite };

  // Lebenszeichen: macht mich für Freunde „on“ und holt offene Einladungen. Neue Einladungen erscheinen kurz als Meldung.
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
            const invite = fresh[0];
            const canJoin = !stateRef.current || stateRef.current.status === "lobby";
            notify(canJoin ? "Komm in die Lobby und spiel mit." : "Du kannst nach der Partie beitreten (siehe Profil).", {
              title: `${invite.from} lädt dich ein`,
              duration: 10_000,
              actions: canJoin ? [{ label: "Beitreten", onClick: () => inviteHandlers.current.acceptInvite(invite) }] : []
            });
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
  }, [authToken, notify]);

  const signedIn = (token, data) => {
    storeAuthToken(token);
    setAuthToken(token);
    setAccount(data);
    setView("profile");
    notify(`Willkommen, ${data.name}!`, { type: "success" });
  };

  const signOut = () => {
    storeAuthToken(null);
    setAuthToken(null);
    setAccount(null);
    setView("home");
    notify("Du bist abgemeldet.");
  };

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, []);

  useEffect(() => {
    const showError = ({ message }) => notify(message, { type: "error" });
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
      socket.off("connect", restoreSession);
      socket.off("disconnect", loseConnection);
      socket.off("state", setState);
      socket.off("gameError", showError);
    };
  }, [notify]);

  const leave = () => {
    socket.emit("leaveLobby");
    sessionStorage.removeItem(SESSION_TOKEN);
    sessionStorage.removeItem(SESSION_ROOM);
    sessionStorage.removeItem(SESSION_NAME);
    setState(null);
    setView("home");
  };

  const goHome = () => setView("home");
  const isPlaying = state && state.status !== "lobby" && state.status !== "deckbuild"; // Deck-Zusammenstellung hat eine Leiste und muss scrollbar bleiben
  const hasChat = Boolean(state && !state.solo);

  // Seitenwechsel: das neue Fenster schiebt sich von rechts herein, beim Zurück von links.
  const pageKey = state ? (state.status === "lobby" ? "lobby" : state.status === "deckbuild" ? "deckbuild" : "game") : view;
  const pageRank = state ? (state.status === "lobby" ? 2 : state.status === "deckbuild" ? 2.5 : 3) : PAGE_RANK[view] ?? 1;

  let page;
  if (state) {
    page = state.status === "lobby"
      ? <Lobby state={state} onLeave={leave} account={account} />
      : state.status === "deckbuild" && state.deckbuild
        ? <DeckBuilder state={state} authToken={authToken} />
        : <Game state={state} onLeave={leave} />;
  } else if (view === "home") {
    page = (
      <Home
        onNew={() => setView("new")}
        onJoin={() => setView("join")}
        onCollection={() => setView("collection")}
        onLeaderboard={() => setView("leaderboard")}
        onDaily={openDaily}
        dailyBusy={dailyBusy}
        account={account}
        inviteCount={invites.length}
        onAccount={() => setView(account ? "profile" : "account")}
      />
    );
  } else if (view === "collection") {
    page = <Collection onBack={goHome} authToken={account ? authToken : null} onSignIn={() => setView("account")} />;
  } else if (view === "leaderboard") {
    page = <Leaderboard onBack={goHome} selfName={account?.name} />;
  } else if (view === "profile" && account) {
    page = (
      <Profile
        account={account}
        authToken={authToken}
        invites={invites}
        onAcceptInvite={acceptInvite}
        onDeclineInvite={declineInvite}
        onBack={goHome}
        onSignOut={signOut}
      />
    );
  } else if (view === "account" || view === "profile") {
    page = <AccountForm onBack={goHome} onSignedIn={signedIn} />;
  } else {
    page = <Welcome mode={view} onBack={goHome} onJoin={join} joining={joining} account={account} />;
  }

  return (
    <ConnectionContext.Provider value={connected}>
      <div className={`app-shell ${isPlaying ? "is-playing" : ""} ${!state && view === "home" ? "is-home" : ""} ${hasChat ? "has-chat" : ""}`}>
        <main>
          <SlideStage pageKey={pageKey} rank={pageRank}>{page}</SlideStage>
        </main>
        {hasChat && <ChatWidget chat={state.chat || []} selfId={state.selfId} sessionId={state.sessionId} />}
        {daily && (
          <PackOpening
            awards={daily.cards}
            categories={daily.categories}
            intro="daily"
            onDone={() => {
              setDaily(null);
              loadProfile(authToken);
            }}
          />
        )}
      </div>
    </ConnectionContext.Provider>
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
    panes.push(<div className={`slide-pane is-leaving is-${direction}`} key={leaving.key} inert aria-hidden="true">{leaving.node}</div>);
  }
  panes.push(<div className={`slide-pane ${leaving ? `is-entering is-${direction}` : ""}`} key={pageKey}>{children}</div>);
  return <div className="slide-stage">{panes}</div>;
}

function formatWait(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std ${m} Min` : `${m} Min`;
}

function Home({ onNew, onJoin, onCollection, onLeaderboard, onDaily, dailyBusy = false, account, onAccount, inviteCount = 0 }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000); // Countdown bis zum nächsten Tagespack
    return () => window.clearInterval(timer);
  }, []);
  const dailyReady = Boolean(account) && (account.dailyAvailable || socket.now() >= account.dailyNextAt);
  const dailyWait = account && !dailyReady ? formatWait(account.dailyNextAt - socket.now()) : "";
  return (
    <section className="home">
      <div className="home-top">
        {account ? (
          <Button size="sm" className="home-account" onClick={onAccount} iconStart={<LevelBadge level={account.level} />} icon={inviteCount > 0 ? <b className="count-badge" aria-label={`${inviteCount} Einladungen`}>{inviteCount}</b> : null}>
            {account.name}
          </Button>
        ) : (
          <Button size="sm" className="home-account" onClick={onAccount} iconStart={<UserIcon />}>Anmelden</Button>
        )}
      </div>
      <div className="home-inner">
        <div className="home-logo" role="img" aria-label="Andi Trumpf">
          <div className="home-logo-top"><span>ANDI</span><FlagPattern /></div>
          <div className="home-logo-bottom">TRUMPF</div>
        </div>

        <nav className="home-menu" aria-label="Hauptmenü">
          <button type="button" className="menu-tile is-primary" onClick={onNew}>
            <CardsIcon />
            <span><strong>Neues Spiel</strong><small>Mit Freunden oder gegen KI</small></span>
            <HomeArrow />
          </button>
          <button type="button" className={`menu-tile home-daily ${dailyReady ? "is-ready" : ""} ${account && !dailyReady ? "is-done" : ""}`} onClick={onDaily} disabled={dailyBusy}>
            <img className="home-pack" src={packArt} alt="" draggable="false" />
            <span>
              <strong>Tagespack</strong>
              <small>
                {!account ? "Anmelden und alle 24 Std Karten holen" : dailyReady ? "Gratis: 1–5 Karten, alle 24 Std" : `Schon geöffnet · nächstes in ${dailyWait}`}
              </small>
            </span>
            {dailyReady ? <b className="count-badge home-daily-badge">1×</b> : <HomeArrow />}
          </button>
          <button type="button" className="menu-tile" onClick={onJoin}>
            <PeopleIcon />
            <span><strong>Spiel beitreten</strong><small>Einer Lobby beitreten</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="menu-tile" onClick={onCollection}>
            <CollectionIcon />
            <span><strong>Sammlung</strong><small>Deine gesammelten Autos</small></span>
            <HomeArrow />
          </button>
          <button type="button" className="menu-tile" onClick={onLeaderboard}>
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

// Karte mit Seltenheitsrahmen, optional Anzahl (×3) und „NEU“
// In langen Listen (Sammlung, Deckbau) wird die Karte nur gebaut, solange sie in der Nähe des Bildschirms ist.
// Jede Karte besteht aus über hundert Elementen mit Bildern; 400 davon gleichzeitig machen das Handy langsam.
function useNearScreen(enabled) {
  const ref = useRef(null);
  const [near, setNear] = useState(!enabled);
  useEffect(() => {
    if (!enabled) return undefined;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), { rootMargin: "700px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  return [ref, near];
}

function CollectionCard({ card, categories, qty = 0, isNew = false, onClick, dimmed = false, style, lazy = false }) {
  const tier = Number(card.raritaet) || 1;
  const Tag = onClick ? "button" : "div";
  const [nearRef, near] = useNearScreen(false && lazy);
  return (
    <Tag type={onClick ? "button" : undefined} className={`tier-frame tier-${tier} ${dimmed ? "is-dimmed" : ""}`} onClick={onClick} style={style} ref={nearRef}>
      {near ? (
        <ScaledCard>
          <VehicleCard card={card} categories={categories} />
        </ScaledCard>
      ) : (
        <div className="scaled-card" />
      )}
      {qty > 1 && <b className="card-qty">×{qty}</b>}
      {card.score !== undefined && <span className="card-score" title="Kartenstärke (0–100)">{Math.round(card.score)}</span>}
      {isNew && <b className="card-new">NEU!</b>}
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

// Deckwertung: Durchschnitt der Kartenstärke (0–100, vom Server je Karte als score geliefert)
function deckRating(cards) {
  const list = cards.filter(Boolean);
  if (!list.length) return 0;
  const total = list.reduce((sum, card) => sum + (Number(card.score) || 0), 0);
  return Math.round(total / list.length);
}

function sortCards(cards, order) {
  if (order === "score") return [...cards].sort((a, b) => (b.score || 0) - (a.score || 0));
  return [...cards].sort((a, b) => (order === "name" ? a.name.localeCompare(b.name, "de") : (b.raritaet - a.raritaet) || a.name.localeCompare(b.name, "de")));
}

const SORT_OPTIONS = [
  { value: "tier", label: "Nach Seltenheit" },
  { value: "score", label: "Nach Stärke" },
  { value: "name", label: "Nach Name" }
];

function SortSelect({ value, onChange }) {
  return (
    <select className="select" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Sortierung">
      {SORT_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>
  );
}

// Suche und Sortierung über einer Kartenliste
function useCardFilter(allCards) {
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("tier");
  const cards = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("de");
    return sortCards((allCards || []).filter((card) => !needle || card.name.toLocaleLowerCase("de").includes(needle)), order);
  }, [allCards, query, order]);
  const toolbar = (
    <div className="toolbar">
      <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Auto suchen" aria-label="Auto suchen" />
      <SortSelect value={order} onChange={setOrder} />
    </div>
  );
  return [cards, toolbar];
}

function CollectionSummary({ data }) {
  return (
    <p className="summary-line">
      <span><b>{data.collected}</b> / {data.total} Autos</span>
      {data.cards.length > 0 && <span>Ø Stärke <b>{deckRating(data.cards)}</b></span>}
    </p>
  );
}

function Collection({ onBack, authToken, onSignIn }) {
  const [data, failed] = useOwnCollection(authToken);
  const [cards, toolbar] = useCardFilter(data?.cards);

  return (
    <Page
      width="wide"
      eyebrow="Sammlung"
      title="Meine Sammlung"
      lead={!authToken ? "Melde dich an, um Autos zu sammeln. Neue Konten starten mit 16 Autos." : data ? <CollectionSummary data={data} /> : null}
      onBack={onBack}
    >
      {!authToken ? (
        <div className="page-actions">
          <Button variant="primary" size="lg" onClick={onSignIn} icon={<ArrowIcon />}>Anmelden</Button>
        </div>
      ) : (
        <>
          {toolbar}
          {failed && <Note tone="danger" role="alert">{failed}</Note>}
          {!data && !failed && <Loading />}
          {data && cards.length === 0 && <EmptyState>Kein Auto gefunden.</EmptyState>}
          <div className="card-grid">
            {cards.map((card) => (
              <CollectionCard card={card} categories={data.categories} qty={card.qty} key={card.c_id} lazy />
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
        </>
      )}
    </Page>
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
  const done = () => send(picks, true);
  const readyPlayers = state.players.filter((player) => build.readyIds.includes(player.id)).length;

  return (
    <Page
      width="wide"
      eyebrow="Risiko-Modus"
      title="Deck zusammenstellen"
      lead={`Wähle ${need} Karten aus deiner Sammlung. Wenn die Zeit um ist, wird der Rest zufällig gewählt.`}
      start={<span className={`timer-pill ${secondsLeft <= LOW_SECONDS ? "is-low" : ""}`} role="timer" aria-label={`Noch ${secondsLeft} Sekunden`}>{secondsLeft} s</span>}
    >
      <Note tone="accent" icon={<InfoIcon />}>Achtung: Der Gewinner darf sich eine Karte aus deinem Deck aussuchen.</Note>
      <Card className="deck-panel" title="Dein Deck" meta={<>{picks.length} / {need}{picks.length > 0 && <> · Deckwertung <b>{deckRating(picks.map((id) => byId.get(id)))}</b></>}</>}>
        {picks.length > 0 ? (
          <div className="chip-list" aria-label="Dein Deck">
            {picks.map((id, index) => {
              const card = byId.get(id);
              return (
                <button type="button" className={`chip tier-${card?.raritaet || 1}`} key={`${id}-${index}`} onClick={() => remove(index)} disabled={isReady} aria-label={`${card?.name || id} aus dem Deck nehmen`}>
                  {card?.name || id} <span aria-hidden="true">×</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted">Tippe unten auf Karten, um sie ins Deck zu legen. Tippe auf eine gewählte Karte, um sie wieder herauszunehmen.</p>
        )}
      </Card>
      <div className="toolbar">
        <SortSelect value={order} onChange={setOrder} />
      </div>
      {failed && <Note tone="danger" role="alert">{failed}</Note>}
      {!data && !failed && <Loading />}
      <div className="card-grid">
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
              lazy
            />
          );
        })}
      </div>
      <div className="sticky-action">
        {isReady ? (
          <p className="waiting-bar" role="status"><Spinner /> Fertig. Warte auf die anderen ({readyPlayers}/{state.players.length}) …</p>
        ) : (
          <div className="button-row is-split">
            <Button size="lg" onClick={fillRandom} disabled={picks.length >= need || !data}>Rest zufällig</Button>
            <Button variant="primary" size="lg" onClick={done} icon={<FlagIcon />}>{picks.length < need ? `Fertig (${picks.length}/${need})` : "Fertig"}</Button>
          </div>
        )}
      </div>
    </Page>
  );
}

const AI_LEVEL_INFO = [
  { id: "easy", label: "Leicht" },
  { id: "medium", label: "Mittel" },
  { id: "hard", label: "Schwer" }
];

const AI_XP_NOTES = {
  easy: "Gegen „Leicht“ gibt es nur 20 % der XP.",
  medium: "Gegen „Mittel“ gibt es nur 50 % der XP.",
  hard: "Sieg mit 16 Karten: 1 neues Auto. Mit 32 Karten: Pack mit 3–5 Autos."
};

// Zeile mit Kürzel, Name und Zusatz, z. B. „Angemeldet als“
function IdentityRow({ account }) {
  return (
    <div className="list-row">
      <span className="avatar">{initials(account.name)}</span>
      <span className="list-row-main">
        <span className="list-row-title">{account.name} <LevelBadge level={account.level} /></span>
        <span className="list-row-sub">Siege und XP werden gespeichert</span>
      </span>
    </div>
  );
}

function Welcome({ mode = "new", onBack, onJoin, joining, account }) {
  const connected = useContext(ConnectionContext);
  const [typedName, setName] = useState(sessionStorage.getItem(SESSION_NAME) || "");
  const [sessionId, setSessionId] = useState("");
  const [vsAi, setVsAi] = useState(false);
  const [difficulty, setDifficulty] = useState("medium");
  const [opponents, setOpponents] = useState(1);
  const name = account ? account.name : typedName;
  const ai = mode === "new" && vsAi;
  const canSubmit = connected && !joining && Boolean(name.trim()) && (mode !== "join" || sessionId.length >= 4);
  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    onJoin(name.trim(), sessionId, ai ? { difficulty, opponents } : undefined);
  };

  const lead = mode === "join"
    ? "Gib die Session-ID ein, die du von deinen Freunden bekommen hast."
    : ai
      ? "Wähle die Stärke und die Zahl der Gegner."
      : "Eröffne eine Lobby und schick deinen Freunden die Session-ID.";

  return (
    <Page eyebrow="Spielen" title={mode === "join" ? "Spiel beitreten" : "Neues Spiel"} lead={lead} onBack={onBack}>
      <Card>
        <form className="form-stack" onSubmit={submit}>
          {mode === "new" && (
            <Segmented
              label="Spielart"
              value={vsAi}
              onChange={setVsAi}
              options={[{ value: false, label: "Mit Freunden" }, { value: true, label: "Gegen KI" }]}
            />
          )}
          {account ? (
            <Field label="Angemeldet als">
              <IdentityRow account={account} />
            </Field>
          ) : (
            <Field label="Fahrername" htmlFor="player-name">
              <input
                className="input"
                id="player-name"
                value={name}
                onChange={(event) => setName(event.target.value.slice(0, 20))}
                placeholder="z. B. Niki"
                autoComplete="nickname"
                autoFocus={typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches}
              />
            </Field>
          )}
          {mode === "join" && (
            <Field label="Session-ID" htmlFor="session-id">
              <input
                className="input input-code"
                id="session-id"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="z. B. K4ZN7"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck="false"
              />
            </Field>
          )}
          {ai && (
            <>
              <Field label="Schwierigkeit">
                <Segmented label="Schwierigkeit" value={difficulty} onChange={setDifficulty} options={AI_LEVEL_INFO.map((level) => ({ value: level.id, label: level.label }))} />
              </Field>
              <Note tone={difficulty === "hard" ? "accent" : "neutral"} icon={<InfoIcon />}>
                {AI_XP_NOTES[difficulty]}{difficulty === "hard" && !account ? " Nur mit Konto." : ""}
              </Note>
              <Field label="Gegner">
                <Segmented label="Anzahl der Gegner" value={opponents} onChange={setOpponents} options={[1, 2, 3].map((count) => ({ value: count, label: `${count} Gegner` }))} />
              </Field>
            </>
          )}
          <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit} icon={<ArrowIcon />}>
            {joining ? "Beitritt läuft …" : mode === "join" ? "Lobby beitreten" : ai ? "Gegen KI spielen" : "Lobby eröffnen"}
          </Button>
        </form>
      </Card>
      {!account && <p className="footnote"><ShieldIcon /> Du spielst als Gast. Mit Anmeldung werden Siege und XP gespeichert.</p>}
    </Page>
  );
}

const DECK_MODE_INFO = [
  { id: "friendly", label: "Freund\u00ADschaft", short: "Pool-Karten", text: "Alle spielen mit Karten aus dem gemeinsamen Pool. Niemand gewinnt oder verliert Karten." },
  { id: "auto", label: "Eigene Karten", short: "zufällig", text: "Jeder spielt mit zufälligen Karten aus seiner Sammlung. Kein Verlust. Alle brauchen ein Konto und genug Karten." },
  { id: "risk", label: "Risiko", short: "eigenes Deck", text: "Jeder stellt in 90 Sekunden sein Deck zusammen. Der Gewinner darf sich von jedem Verlierer eine Karte aus dessen Deck nehmen." }
];

const TEAM_INFO = [{ name: "Team Rot", short: "Rot" }, { name: "Team Blau", short: "Blau" }];

function TeamTag({ team }) {
  if (team === null || team === undefined) return null;
  return <span className={`team-tag team-${team}`}>{TEAM_INFO[team].short}</span>;
}

const RULES = [
  { title: "Stapel ansehen", text: "Deine oberste Karte ist spielbar." },
  { title: "Wert ansagen", text: "Wer dran ist, wählt eine Kategorie." },
  { title: "Stich gewinnen", text: "Der beste Wert erhält alle Tischkarten. Meist zählt der höchste, bei Gewicht und Beschleunigung der niedrigste." }
];

function Lobby({ state, onLeave, account }) {
  const notify = useToast();
  const [inviting, setInviting] = useState(false);
  const closeInvite = useCallback(() => setInviting(false), []);
  const selfIsHost = state.selfId === state.hostId;
  const canStart = state.players.length >= 2;
  const canTeams = !state.solo && state.players.length === state.maxPlayers;
  const openSeats = state.solo ? [] : Array.from({ length: state.maxPlayers - state.players.length });
  const cardCountOptions = state.cardCountOptions || [8, 16, 32];
  const totalCards = state.players.length * state.cardsPerPlayer;
  const deckMode = DECK_MODE_INFO.find((mode) => mode.id === state.deckMode) || DECK_MODE_INFO[0];
  const aiLevel = AI_LEVEL_INFO.find((level) => level.id === state.aiLevel)?.label || "Mittel";
  const hostHint = selfIsHost ? null : "Nur der Host kann das ändern.";

  const copyCode = () => {
    navigator.clipboard?.writeText(state.sessionId)
      .then(() => notify("Session-ID kopiert.", { type: "success" }))
      .catch(() => notify(`Session-ID: ${state.sessionId}`));
  };

  const setDeckMode = (mode) => {
    socket.request("setDeckMode", { mode })
      .then((result) => (result.ok ? socket.applyResult(result) : notify(result.message, { type: "error" })))
      .catch(() => notify("Keine Verbindung zum Server.", { type: "error" }));
  };

  return (
    <Page
      width="wide"
      eyebrow="Lobby"
      title="Startaufstellung"
      lead={state.solo
        ? `Du spielst gegen die KI (Stufe ${aiLevel}). Wähle die Kartenzahl und starte.`
        : "Sobald mindestens zwei Fahrer da sind, kann der Host austeilen."}
      onBack={onLeave}
      backLabel="Verlassen"
    >
      {!state.solo && (
        <div className="session-bar">
          <div className="session-code">
            <span>Session-ID</span>
            <b>{state.sessionId}</b>
          </div>
          <Button size="sm" onClick={copyCode} iconStart={<CopyIcon />}>Kopieren</Button>
          {account && state.players.length < state.maxPlayers && (
            <Button size="sm" onClick={() => setInviting(true)} iconStart={<PlusIcon />}>Freunde einladen</Button>
          )}
        </div>
      )}
      {state.solo && account && (
        <Note icon={<InfoIcon />}>
          Du spielst mit Autos aus deiner Sammlung, die KI bekommt ein Deck mit ähnlicher Deckwertung{state.aiLevel === "hard" ? " (etwas stärker)" : state.aiLevel === "easy" ? " (schwächer)" : ""}. Fehlen dir Karten, wird mit ähnlich starken Leihkarten aufgefüllt.
        </Note>
      )}
      {inviting && <InviteModal players={state.players} onClose={closeInvite} />}

      <div className="lobby-grid">
        <Card title="Fahrer" meta={`${state.players.length} / ${state.maxPlayers}`}>
          <ul className="list">
            {state.players.map((player) => (
              <li className="list-row" key={player.id}>
                <span className="avatar">{initials(player.name)}</span>
                <span className="list-row-main">
                  <span className="list-row-title">
                    {player.name} {player.level && <LevelBadge level={player.level} />} {player.id === state.selfId && <span className="badge">Du</span>}
                  </span>
                  <span className="list-row-sub">{player.isBot ? "Computergegner" : player.isHost ? "Host" : "Bereit"}</span>
                </span>
                <TeamTag team={player.team} />
                <StatusDot online={player.connected !== false} />
              </li>
            ))}
            {openSeats.map((_, index) => (
              <li className="list-row is-empty" key={`open-${index}`}>
                <span className="avatar is-empty" aria-hidden="true">+</span>
                <span className="list-row-main">
                  <span className="list-row-title">Freier Startplatz</span>
                  <span className="list-row-sub">Wartet auf Fahrer …</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <div className="lobby-side">
          <Card title="Einstellungen">
            <div className="form-stack">
              <Field label="Karten pro Spieler" hint={`${totalCards} Karten im Spiel`}>
                <Segmented
                  label="Karten pro Spieler"
                  value={state.cardsPerPlayer}
                  disabled={!selfIsHost}
                  onChange={(count) => socket.emit("setCardsPerPlayer", count)}
                  options={cardCountOptions.map((count) => ({ value: count, label: count, hint: "Karten" }))}
                />
              </Field>
              {!state.solo && (
                <Field label="Kartenmodus" hint={deckMode.text}>
                  <Segmented
                    label="Kartenmodus"
                    value={deckMode.id}
                    disabled={!selfIsHost}
                    onChange={setDeckMode}
                    options={DECK_MODE_INFO.map((mode) => ({ value: mode.id, label: mode.label, hint: mode.short }))}
                  />
                </Field>
              )}
              {canTeams && (
                <Field label="Spielmodus" hint={state.teamMode ? "Die beste Karte im Team zählt. Gewonnene Karten gehen an beide im Team. Die Teams sind abwechselnd dran." : null}>
                  <Segmented
                    label="Spielmodus"
                    value={Boolean(state.teamMode)}
                    disabled={!selfIsHost}
                    onChange={(on) => socket.emit("setTeams", { on })}
                    options={[{ value: false, label: "Alle", hint: "gegeneinander" }, { value: true, label: "2 vs 2", hint: "im Team" }]}
                  />
                </Field>
              )}
              {canTeams && state.teamMode && (
                <div className="team-lineup">
                  {[0, 1].map((team) => (
                    <p className={`team-${team}`} key={team}>
                      <b>{TEAM_INFO[team].name}</b>
                      {state.players.filter((player) => player.team === team).map((player) => player.name).join(" + ")}
                    </p>
                  ))}
                  {selfIsHost && <Button size="sm" onClick={() => socket.emit("setTeams", { on: true, shuffle: true })}>Teams neu mischen</Button>}
                </div>
              )}
              {hostHint && <p className="field-hint">{hostHint}</p>}
            </div>
          </Card>

          <div className="sticky-action">
            {selfIsHost ? (
              <Button variant="primary" size="lg" block disabled={!canStart} onClick={() => socket.emit("startGame")} icon={<FlagIcon />}>
                {canStart ? "Karten austeilen" : "Warte auf Mitspieler"}
              </Button>
            ) : (
              <p className="waiting-bar" role="status"><Spinner /> Der Host startet das Spiel.</p>
            )}
          </div>
          <Card title="So geht’s">
            <ol className="steps">
              {RULES.map((rule) => (
                <li key={rule.title}><b>{rule.title}</b><span>{rule.text}</span></li>
              ))}
            </ol>
          </Card>

        </div>
      </div>
    </Page>
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
            <Spinner /> Mitspieler fehlen – das Spiel endet in <Seconds target={timerTarget} /> s, wenn niemand zurückkommt
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
              <span className={`player-dot ${player.connected === false ? "is-off" : "is-on"}`} title={player.connected === false ? "offline" : "online"} />
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
          <IconButton
            label={soundOn ? "Ton ausschalten" : "Ton einschalten"}
            variant="secondary"
            size="sm"
            className={soundOn ? "" : "is-muted"}
            onClick={onToggleSound}
            aria-pressed={soundOn}
          >
            <SoundIcon on={soundOn} />
          </IconButton>
          {revealTarget && (
            isReady
              ? <Button size="sm" disabled iconStart={<CheckIcon />}>Bereit {readyCount}/{readyTotal}</Button>
              : <Button variant="primary" size="sm" onClick={() => socket.emit("readyForNext")} icon={<ArrowIcon />}>Weiter</Button>
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
                <div className="not-playable"><Spinner /> Du schaust zu</div>
              )}
            </ScaledCard>
          </div>
        </div>
      </div>
    </aside>
  );
});

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
    // zoom statt transform: scale – so wird die Karte in ihrer echten Größe gezeichnet. Mit scale hält der Browser jede Karte als
    // 906 × 1405 px große Textur im Grafikspeicher (rund 45 MB je Karte auf dem Handy) und skaliert sie nur herunter.
    const update = () => { inner.style.zoom = String(element.offsetWidth / CARD_DESIGN_WIDTH); };
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

// Felder, deren Beschriftung und Symbol schon im Rahmenbild (src/card-frame.webp) stehen. Nur der Wert kommt aus dem HTML.
// Sobald Rarität und Performance ebenfalls im Bild stehen, hier „raritaet“ und „performance“ ergänzen.
const BAKED_FIELDS = new Set(["leistung", "hubraum", "drehmoment", "drehzahl", "beschleunigung", "hoechstgeschwindigkeit", "gewicht", "preis", "raritaet", "performance"]);

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
  const tier = Math.min(5, Math.max(1, Number(card.raritaet) || 1)); // Seltenheit bestimmt den Rand (Common … Mythic)
  return (
    <article className={`portrait-card tier-${tier}`}>
      <div className="gt-photo">
        {card.image && !imageFailed ? (
          <img src={card.image} alt={card.name} loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
        ) : (
          <VehicleFallback card={card} />
        )}
        {selectable && <div className="choose-hint">WERT ANKLICKEN</div>}
      </div>
      <div className="gt-type"><span data-text={TIER_NAMES[tier]}>{TIER_NAMES[tier]}</span></div>
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
              {BAKED_FIELDS.has(field.key) ? (
                <span className="sr-only">{field.label}</span>
              ) : (
                <>
                  <span className="stat-label">{field.label}</span>
                  <GtIcon type={field.icon} />
                </>
              )}
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
      <span className="card-rim" aria-hidden="true" />
      {tier >= 3 && <span className="card-glow" aria-hidden="true" />}
      {tier >= 5 && <span className="card-shine" aria-hidden="true" />}
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
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [seenId, setSeenId] = useState(() => (chat.length ? chat[chat.length - 1].id : 0));
  const [soundOn, setSoundOn] = useState(chatSoundEnabled);
  const notifiedId = useRef(chat.length ? chat[chat.length - 1].id : 0);
  const listRef = useRef(null);
  const inputRef = useRef(null);
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
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
    const onKey = (event) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = (event) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    socket.request("chat", { text: message })
      .then((result) => {
        if (!result.ok) {
          notify(result.message || "Nachricht nicht gesendet.", { type: "error" });
          setText(message);
        } else if (result.state) {
          socket.applyResult(result);
        }
      })
      .catch(() => {
        notify("Keine Verbindung zum Server.", { type: "error" });
        setText(message);
      });
  };

  const time = (at) => new Date(at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <IconButton
        label={unread ? `Chat öffnen, ${unread} neue Nachrichten` : open ? "Chat schließen" : "Chat öffnen"}
        variant="secondary"
        className={`chat-button ${unread ? "has-unread" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChatIcon />
        {unread > 0 && <b className="count-badge">{unread > 9 ? "9+" : unread}</b>}
      </IconButton>
      {open && (
        <div className="chat-window" role="dialog" aria-label="Session-Chat">
          <div className="chat-head">
            <div>
              <strong>Chat</strong>
              {sessionId && <small>Session {sessionId}</small>}
            </div>
            <IconButton
              label={soundOn ? "Chat-Ton ausschalten" : "Chat-Ton einschalten"}
              size="sm"
              className={soundOn ? "" : "is-muted"}
              onClick={toggleSound}
              aria-pressed={soundOn}
            >
              <SoundIcon on={soundOn} />
            </IconButton>
            <IconButton label="Chat schließen" size="sm" onClick={() => setOpen(false)}><CloseIcon /></IconButton>
          </div>
          <div className="chat-list" ref={listRef} aria-live="polite">
            {chat.length === 0 && <EmptyState>Noch keine Nachrichten. Schreib den anderen Spielern etwas!</EmptyState>}
            {chat.map((message) => (
              <div className={`chat-message ${message.playerId === selfId ? "is-own" : ""}`} key={message.id}>
                {message.playerId !== selfId && <span className="chat-author">{message.name}</span>}
                <p>{message.text}</p>
                <small>{time(message.at)}</small>
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={send}>
            <input
              className="input"
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, 200))}
              placeholder="Nachricht schreiben …"
              aria-label="Nachricht"
              maxLength={200}
              autoComplete="off"
            />
            <IconButton label="Senden" variant="primary" type="submit" disabled={!text.trim()}><SendIcon /></IconButton>
          </form>
        </div>
      )}
    </>
  );
}

// Grüner Punkt = online, roter Punkt = offline (für alle Spieler, nicht nur Freunde)
function StatusDot({ online }) {
  return <i className={`status-dot ${online ? "is-on" : "is-off"}`} role="img" aria-label={online ? "online" : "offline"} title={online ? "online" : "offline"} />;
}

function PresenceDot({ online }) {
  return (
    <span className={`presence ${online ? "is-on" : "is-off"}`}>
      <i aria-hidden="true" />
      {online ? "online" : "offline"}
    </span>
  );
}

// Einladungen und Schalter für Push-Nachrichten aufs Handy
function Inbox({ invites, authToken, onAccept, onDecline }) {
  const notify = useToast();
  const [permission, setPermission] = useState(pushPermission);
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    syncPush(authToken).then((on) => alive && setPushOn(on)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [authToken]);

  const togglePush = () => {
    setBusy(true);
    const work = pushOn ? disablePush(authToken).then(() => false) : enablePush(authToken).then(() => true);
    work
      .then((on) => {
        setPushOn(on);
        notify(on ? "Benachrichtigungen sind an." : "Benachrichtigungen sind aus.", { type: "success" });
      })
      .catch((error) => notify(error.message || "Das hat nicht geklappt.", { type: "error" }))
      .finally(() => {
        setBusy(false);
        setPermission(pushPermission());
      });
  };

  return (
    <Card title="Einladungen" meta={invites.length > 0 ? `${invites.length} offen` : null}>
      {invites.length === 0 ? (
        <EmptyState>Keine Einladungen. Wenn ein Freund dich einlädt, erscheint sie hier.</EmptyState>
      ) : (
        <ul className="list">
          {invites.map((invite) => (
            <li className="list-row" key={invite.id}>
              <span className="avatar">{initials(invite.from)}</span>
              <span className="list-row-main">
                <span className="list-row-title">{invite.from}</span>
                <span className="list-row-sub">lädt dich zu einem Spiel ein</span>
              </span>
              <span className="list-row-actions">
                <Button variant="primary" size="sm" onClick={() => onAccept(invite)}>Beitreten</Button>
                <IconButton label={`Einladung von ${invite.from} ablehnen`} size="sm" variant="secondary" onClick={() => onDecline(invite)}><CloseIcon /></IconButton>
              </span>
            </li>
          ))}
        </ul>
      )}
      {pushSupported() ? (
        <div className="list-row setting-row">
          <span className="list-row-main">
            <span className="list-row-title">Benachrichtigungen aufs Handy</span>
            <span className="list-row-sub">{pushOn ? "An: Einladungen kommen auch, wenn die App zu ist." : permission === "denied" ? "Im Browser blockiert." : "Aus"}</span>
          </span>
          <Button size="sm" variant={pushOn ? "secondary" : "primary"} onClick={togglePush} disabled={busy || permission === "denied"} aria-pressed={pushOn}>
            {pushOn ? "Ausschalten" : "Einschalten"}
          </Button>
        </div>
      ) : (
        <p className="field-hint">Push-Benachrichtigungen gibt es auf diesem Gerät nicht. Auf dem iPhone: App zum Home-Bildschirm hinzufügen.</p>
      )}
    </Card>
  );
}

// Freunde in die Lobby einladen
function InviteModal({ players, onClose }) {
  const notify = useToast();
  const [data, setData] = useState(null);
  const [invited, setInvited] = useState(() => new Set());

  const load = useCallback(() => {
    socket.request("friends", { authToken: readAuthToken() }).then((result) => result.ok && setData(result)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 8_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const invite = (name) => {
    socket.request("invite", { name })
      .then((result) => {
        if (result.message) notify(result.message, { type: result.ok ? "success" : "error" });
        if (result.ok) setInvited((set) => new Set(set).add(name));
      })
      .catch(() => notify("Keine Verbindung zum Server.", { type: "error" }));
  };

  const inLobby = new Set(players.map((player) => player.name.toLocaleLowerCase("de")));

  return (
    <Modal eyebrow="Lobby" title="Freunde einladen" onClose={onClose}>
      {!data && <Loading />}
      {data && data.friends.length === 0 && <EmptyState>Du hast noch keine Freunde. Füge sie im Profil hinzu.</EmptyState>}
      {data?.friends.length > 0 && (
        <ul className="list">
          {data.friends.map((friend) => {
            const there = inLobby.has(friend.name.toLocaleLowerCase("de"));
            const done = invited.has(friend.name);
            return (
              <li className="list-row" key={friend.name}>
                <span className="avatar">{initials(friend.name)}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{friend.name} <LevelBadge level={friend.level} /></span>
                  <PresenceDot online={friend.online} />
                </span>
                <Button size="sm" variant={there || done ? "secondary" : "primary"} disabled={there || done} onClick={() => invite(friend.name)}>
                  {there ? "In der Lobby" : done ? "Eingeladen" : "Einladen"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

function LevelBadge({ level }) {
  return <span className="badge badge-level" title={`Level ${level}`}>Lv {level}</span>;
}

function XpBar({ level, xpInLevel, xpForLevel, total }) {
  const percent = Math.min(100, Math.round((100 * xpInLevel) / Math.max(1, xpForLevel)));
  return (
    <div className="xp-bar">
      <div className="xp-bar-track" role="progressbar" aria-label={`Fortschritt bis Level ${level + 1}`} aria-valuemin={0} aria-valuemax={xpForLevel} aria-valuenow={xpInLevel}>
        <i style={{ width: `${percent}%` }} />
      </div>
      <small>{xpInLevel} / {xpForLevel} XP bis Level {level + 1}{total !== undefined ? ` · ${total} XP gesamt` : ""}</small>
    </div>
  );
}

function AccountForm({ onBack, onSignedIn }) {
  const connected = useContext(ConnectionContext);
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

  // Fehler gelten nur für die aktuelle Eingabe
  const edit = (setter) => (event) => {
    setter(event);
    setError("");
  };

  return (
    <Page eyebrow="Spielerkonto" title={mode === "login" ? "Anmelden" : "Registrieren"} lead="Freiwillig: Mit Konto werden deine Spiele, Siege und XP gespeichert." onBack={onBack}>
      <Card>
        <form className="form-stack" onSubmit={submit}>
          <Segmented
            label="Konto"
            value={mode}
            onChange={(next) => {
              setMode(next);
              setError("");
            }}
            options={[{ value: "login", label: "Anmelden" }, { value: "register", label: "Registrieren" }]}
          />
          <Field label="Spielername" htmlFor="account-name">
            <input className="input" id="account-name" value={name} onChange={edit((event) => setName(event.target.value.slice(0, 20)))} autoComplete="username" placeholder="z. B. Niki" />
          </Field>
          <Field label="Passwort" htmlFor="account-password" hint={mode === "register" ? "Nimm ein Passwort, das du sonst nirgends verwendest." : null}>
            <input className="input" id="account-password" type="password" value={password} onChange={edit((event) => setPassword(event.target.value.slice(0, 100)))} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </Field>
          {error && <Note tone="danger" role="alert">{error}</Note>}
          <Button type="submit" variant="primary" size="lg" block disabled={!connected || busy || !name.trim() || !password} icon={<ArrowIcon />}>
            {busy ? "Moment …" : mode === "login" ? "Anmelden" : "Konto erstellen"}
          </Button>
        </form>
      </Card>
    </Page>
  );
}

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

// Sammlung eines Freundes: nur ansehen, kein Tauschen
function FriendCollection({ name, authToken, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [cards, toolbar] = useCardFilter(data?.cards);

  useEffect(() => {
    let alive = true;
    socket.request("friendCollection", { authToken, name })
      .then((result) => {
        if (!alive) return;
        if (result.ok) setData(result);
        else setError(result.message || "Die Sammlung konnte nicht geladen werden.");
      })
      .catch(() => alive && setError("Keine Verbindung zum Server."));
    return () => {
      alive = false;
    };
  }, [authToken, name]);

  return (
    <Modal eyebrow="Sammlung" title={name} onClose={onClose} size="lg">
      {error && <Note tone="danger" role="alert">{error}</Note>}
      {!data && !error && <Loading />}
      {data && (
        <div className="stack">
          <CollectionSummary data={data} />
          {toolbar}
          {cards.length === 0 && <EmptyState>Kein Auto gefunden.</EmptyState>}
          <div className="card-grid is-compact">
            {cards.map((card) => (
              <CollectionCard card={card} categories={data.categories} qty={card.qty} key={card.c_id} lazy />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function FriendsPanel({ authToken }) {
  const notify = useToast();
  const [openName, setOpenName] = useState(null);
  const [viewName, setViewName] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
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
        if (result.message) notify(result.message, { type: result.ok ? "success" : "error" });
        load();
        return result;
      })
      .catch(() => notify("Keine Verbindung zum Server.", { type: "error" }));

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
  const closeCollection = useCallback(() => setViewName(null), []);

  return (
    <Card title="Freunde" meta={data ? String(data.friends.length) : null}>
      <form className="inline-form" onSubmit={add}>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value.slice(0, 20))}
          placeholder="Spielername"
          aria-label="Spielername des Freundes"
          autoComplete="off"
        />
        <Button type="submit" variant="primary" disabled={busy || !name.trim()} iconStart={<PlusIcon />}>Hinzufügen</Button>
      </form>

      {data?.incoming.length > 0 && (
        <div className="list-group">
          <h3 className="list-heading">Anfragen an dich</h3>
          <ul className="list">
            {data.incoming.map((entry) => (
              <li className="list-row" key={entry.name}>
                <span className="avatar">{initials(entry.name)}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{entry.name} <LevelBadge level={entry.level} /></span>
                </span>
                <span className="list-row-actions">
                  <Button variant="primary" size="sm" onClick={() => act("friendAccept", entry.name)}>Annehmen</Button>
                  <IconButton label={`Anfrage von ${entry.name} ablehnen`} variant="secondary" size="sm" onClick={() => act("friendRemove", entry.name)}><CloseIcon /></IconButton>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="list-group">
        {data && data.friends.length === 0 && <EmptyState>Noch keine Freunde. Gib oben den Spielernamen eines Freundes ein.</EmptyState>}
        {data?.friends.length > 0 && (
          <ul className="list">
            {data.friends.map((friend) => (
              <li key={friend.name}>
                <button type="button" className="list-row" onClick={() => openFriend(friend)}>
                  <MiniRing wins={friend.wins} losses={friend.losses} />
                  <span className="list-row-main">
                    <span className="list-row-title">{friend.name} <LevelBadge level={friend.level} /></span>
                    <PresenceDot online={friend.online} />
                  </span>
                  <ChevronIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data?.outgoing.length > 0 && (
        <div className="list-group">
          <h3 className="list-heading">Gesendete Anfragen</h3>
          <ul className="list">
            {data.outgoing.map((entry) => (
              <li className="list-row" key={entry.name}>
                <span className="avatar is-empty">{initials(entry.name)}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{entry.name}</span>
                  <span className="list-row-sub">wartet auf Antwort</span>
                </span>
                <IconButton label={`Anfrage an ${entry.name} zurückziehen`} variant="secondary" size="sm" onClick={() => act("friendRemove", entry.name)}><CloseIcon /></IconButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      {openName && (
        <PlayerModal
          name={openName}
          online={data?.friends.find((friend) => friend.name === openName)?.online}
          onClose={closeFriend}
          footer={confirmRemove ? (
            <>
              <p className="confirm-text">{openName} wirklich als Freund entfernen?</p>
              <div className="button-row is-split">
                <Button onClick={() => setConfirmRemove(false)}>Abbrechen</Button>
                <Button variant="danger" onClick={() => act("friendRemove", openName).then(closeFriend)}>Entfernen</Button>
              </div>
            </>
          ) : (
            <div className="button-row is-split">
              <Button variant="danger" onClick={() => setConfirmRemove(true)}>Entfernen</Button>
              <Button variant="primary" onClick={() => { setViewName(openName); setOpenName(null); }}>Sammlung ansehen</Button>
            </div>
          )}
        />
      )}
      {viewName && <FriendCollection name={viewName} authToken={authToken} onClose={closeCollection} />}
    </Card>
  );
}

// Statistikblock eines Spielers: Level, XP, Siegquote-Ring, Spiele, Siegesserie (Profil und Spielerfenster)
function ProfileStats({ account }) {
  return (
    <div className="profile-stats">
      <div className="profile-level">
        <span className="profile-level-number">Level {account.level}</span>
        {account.rank ? <span className="profile-rank">Platz <b>{account.rank}</b>{account.players ? ` von ${account.players}` : ""}</span> : null}
      </div>
      <XpBar level={account.level} xpInLevel={account.xpInLevel} xpForLevel={account.xpForLevel} total={account.xp} />
      <WinRateDonut wins={account.wins} losses={account.losses} />
      <dl className="stat-grid">
        <div><dt>Spiele</dt><dd>{account.gamesPlayed}</dd></div>
        <div><dt><i className="swatch is-win" />Siege</dt><dd>{account.wins}</dd></div>
        <div><dt><i className="swatch is-loss" />Niederlagen</dt><dd>{account.losses}</dd></div>
      </dl>
      <dl className="stat-grid is-two">
        <div><dt>Siegesserie</dt><dd>{account.currentStreak ?? 0}</dd><small>aktuell</small></div>
        <div className="is-record"><dt>Rekord</dt><dd>{account.bestStreak ?? 0}</dd><small>Siege am Stück</small></div>
      </dl>
      {account.totalCards ? <p className="summary-line"><span>Sammlung: <b>{account.collected}</b> / {account.totalCards} Autos</span></p> : null}
    </div>
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
    return () => {
      alive = false;
    };
  }, [name]);

  return (
    <Modal eyebrow="Spielerprofil" title={name} onClose={onClose} footer={account ? footer : null}>
      {(online !== undefined || account) && <PresenceDot online={online ?? account.online} />}
      {error && <Note tone="danger" role="alert">{error}</Note>}
      {!account && !error && <Loading />}
      {account && <ProfileStats account={account} />}
    </Modal>
  );
}

function Profile({ account, authToken, invites = [], onAcceptInvite, onDeclineInvite, onBack, onSignOut }) {
  return (
    <Page eyebrow="Spielerkonto" title={account.name} onBack={onBack}>
      <Card title="Statistik">
        <ProfileStats account={account} />
      </Card>
      <Inbox invites={invites} authToken={authToken} onAccept={onAcceptInvite} onDecline={onDeclineInvite} />
      <FriendsPanel authToken={authToken} />
      <div className="page-actions">
        <Button variant="danger" onClick={onSignOut}>Abmelden</Button>
      </div>
    </Page>
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
    <Page eyebrow="Rangliste" title="Top 10" lead="Die Spieler mit den meisten XP." onBack={onBack}>
      <Card>
        {error && <Note tone="danger" role="alert">{error}</Note>}
        {!players && !error && <Loading />}
        {players && players.length === 0 && <EmptyState>Noch niemand hat XP gesammelt. Melde dich an und spiel eine Partie!</EmptyState>}
        {players && players.length > 0 && (
          <ol className="list">
            {players.map((player, index) => (
              <li key={player.name}>
                <button
                  type="button"
                  className={`list-row ${player.name.toLocaleLowerCase("de") === self ? "is-highlight" : ""}`}
                  onClick={() => setOpenName(player.name)}
                  aria-label={`Platz ${index + 1}: Profil von ${player.name} öffnen`}
                >
                  <span className={`rank ${index < 3 ? `is-top-${index + 1}` : ""}`}>{index + 1}</span>
                  <span className="list-row-main">
                    <span className="list-row-title"><StatusDot online={player.online} /> {player.name} <LevelBadge level={player.level} /></span>
                    <span className="list-row-sub">{player.wins} {player.wins === 1 ? "Sieg" : "Siege"} · {player.gamesPlayed} {player.gamesPlayed === 1 ? "Spiel" : "Spiele"}{player.gamesPlayed ? ` · ${player.winRate} %` : ""}</span>
                  </span>
                  <span className="list-row-value">{player.xp}<small>XP</small></span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Card>
      {openName && <PlayerModal name={openName} onClose={closePlayer} />}
    </Page>
  );
}

function ChevronIcon() {
  return <svg className="icon list-row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
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

function FinishPanel({ state, onLeave }) {
  const { players, game, selfId } = state;
  const [packSeen, setPackSeen] = useState(false);
  // Gewinnt man ein Pack, ist erst nur das Pack zu sehen; das Ergebnis kommt danach
  if (game.cardAwards?.length > 0 && !packSeen) {
    return <PackOpening awards={game.cardAwards} categories={state.categories} onDone={() => setPackSeen(true)} />;
  }
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

  const xpNote = state.solo ? AI_XP_NOTES[state.aiLevel] : null;
  const title = game.teamMode && winnerTeam !== null && winnerTeam !== undefined ? `${TEAM_INFO[winnerTeam].name} gewinnt!` : `${winner?.name || "Unbekannt"} gewinnt!`;

  return (
    <div className="finish-overlay">
      <section className="card finish-panel" aria-labelledby="finish-title">
        <div className="finish-head">
          <div className="trophy" aria-hidden="true">🏁</div>
          <p className="eyebrow">Partie beendet</p>
          <h2 className="modal-title" id="finish-title">{title}</h2>
          {game.teamMode && winnerIds.length > 0 && <p className="muted">{players.filter((player) => winnerIds.includes(player.id)).map((player) => player.name).join(" + ")}</p>}
          {game.result?.reason === "abandoned" && <p className="muted">Die Partie wurde beendet, weil zu viele Mitspieler gegangen sind.</p>}
        </div>
        {award && award.xp > 0 && (
          <div className="finish-xp">
            <strong>+{award.xp} XP</strong>
            {award.level > award.levelBefore && <span className="finish-levelup">Level {award.level} erreicht!</span>}
            <XpBar level={award.level} xpInLevel={award.xpInLevel} xpForLevel={award.xpForLevel} />
            {xpNote && state.aiLevel !== "hard" && <small className="field-hint">{xpNote}</small>}
          </div>
        )}
        {game.cardAwards?.length > 0 && <PackReveal awards={game.cardAwards} categories={state.categories} />}
        {state.risk && <RiskPanel state={state} />}
        <ol className="list">
          {ranked.map((player, index) => {
            const entry = statOf(player);
            const level = game.xpAwards?.[player.id]?.level || player.level;
            return (
              <li key={player.id} className={`list-row ${index === 0 ? "is-winner" : ""} ${player.id === selfId ? "is-highlight" : ""}`}>
                <span className={`rank ${index < 3 ? `is-top-${index + 1}` : ""}`}>{index + 1}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{player.name} <TeamTag team={player.team} /> {level && <LevelBadge level={level} />}</span>
                  <span className="list-row-sub">
                    {entry.tricks} {entry.tricks === 1 ? "Stich" : "Stiche"}
                    {entry.outRound ? ` · raus in Runde ${entry.outRound}` : ` · ${player.cardCount} Karten`}
                    {game.deckRatings?.[player.id] !== undefined && ` · Deckwertung ${game.deckRatings[player.id]}`}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
        {((streakLeader && statOf(streakLeader).best > 1) || state.topCard) && (
          <dl className="fact-list">
            {streakLeader && statOf(streakLeader).best > 1 && (
              <div><dt>Längste Siegesserie</dt><dd>{streakLeader.name} · {statOf(streakLeader).best} Stiche am Stück</dd></div>
            )}
            {state.topCard && (
              <div><dt>Stärkste Karte</dt><dd>{state.topCard.name} · {state.topCard.wins} {state.topCard.wins === 1 ? "Stich" : "Stiche"}</dd></div>
            )}
          </dl>
        )}
        <div className="button-row is-split">
          <Button size="lg" onClick={onLeave}>Startseite</Button>
          <Button variant="primary" size="lg" disabled={voted || (state.risk && !state.risk.done)} onClick={() => socket.emit("playAgain")} icon={voted ? null : <FlagIcon />}>
            {voted ? `Warte (${votes.length}/${voters.length})` : "Revanche"}
          </Button>
        </div>
      </section>
    </div>
  );
}

// Zusammenfassung der gewonnenen Karten im Ergebnisfenster (die Show läuft vorher in PackOpening)
function PackReveal({ awards, categories }) {
  return (
    <div className="pack-reveal">
      <p className="eyebrow">{awards.length > 1 ? `Pack mit ${awards.length} Autos` : "Neues Auto"}</p>
      <div className="pack-cards">
        {awards.map((award, index) => (
          <CollectionCard card={award.card} categories={categories} isNew={award.isNew} key={`${award.card.c_id}-${index}`} />
        ))}
      </div>
    </div>
  );
}

// Funken für Explosion und Aufdecken. Werte kommen aus dem Index, damit die Verteilung bei jedem Rendern gleich bleibt.
function Sparks({ count, color, power = 1 }) {
  return (
    <span className="sparks" style={{ "--spark-color": color }} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <i
          key={index}
          style={{
            "--a": `${(index * 137.5) % 360}deg`,
            "--d": `${(90 + ((index * 53) % 150)) * power}px`,
            "--size": `${4 + ((index * 7) % 8)}px`,
            "--delay": `${(index % 6) * 25}ms`
          }}
        />
      ))}
    </span>
  );
}

function RevealFx({ tier }) {
  const sparks = [0, 10, 16, 26, 44, 76][tier] || 10;
  return (
    <span className={`reveal-fx tier-${tier}`} aria-hidden="true">
      {tier >= 5 && <i className="reveal-rays" />}
      <i className="reveal-glow" />
      <i className="reveal-ring" />
      {tier >= 4 && <i className="reveal-ring is-late" />}
      {tier >= 4 && <i className={`quake-ring ${tier >= 5 ? "is-big" : ""}`} />}
      <Sparks count={sparks} color={`var(--tier-${tier})`} power={0.8 + tier * 0.25} />
    </span>
  );
}

const PACK_CHARGE_MS = 2000;
const PACK_BURST_MS = 1300;
const CARD_CHARGE_MS = 500;
const CARD_FLIP_MS = 800;
const DROP_MS = { 4: 240, 5: 320 }; // Legendary/Mythic: Karte fällt nach dem Umdrehen auf den Hintergrund, erst dann bebt er

// Risse im Hintergrund, die vom Einschlag ausgehen (Legendary klein, Mythic groß)
const CRACKS = [
  "M0 0 L14 -6 L26 -4 L38 -16 L52 -14 L66 -30 L82 -34 L100 -52",
  "M0 0 L8 12 L10 26 L24 34 L28 50 L42 60 L46 78 L58 100",
  "M0 0 L-12 8 L-24 6 L-36 20 L-52 18 L-66 32 L-82 30 L-100 44",
  "M0 0 L-6 -14 L-18 -22 L-16 -38 L-30 -48 L-34 -66 L-50 -80 L-54 -100",
  "M0 0 L16 4 L30 14 L44 12 L58 26 L74 24 L90 38 L100 40",
  "M0 0 L-14 -4 L-28 -14 L-44 -12 L-60 -26 L-76 -24 L-92 -38 L-100 -40",
  "M0 0 L4 -16 L16 -28 L14 -44 L28 -58 L26 -74 L40 -90 L44 -100",
  "M0 0 L-4 16 L-14 30 L-30 36 L-34 52 L-48 64 L-52 82 L-60 100",
  "M26 -4 L34 8 L48 14",
  "M-24 6 L-30 -8 L-44 -14",
  "M10 26 L-2 36 L-8 52",
  "M-18 -22 L-30 -26 L-40 -40"
];

function Cracks({ tier, x, y }) {
  const paths = tier >= 5 ? CRACKS : CRACKS.slice(0, 5);
  return (
    <svg className={`pack-cracks tier-${tier}`} style={{ left: x + 70, top: y + 70 }} viewBox="-100 -100 200 200" aria-hidden="true">
      {paths.map((d, index) => <path d={d} pathLength="1" style={{ "--d": `${index * 18}ms` }} key={index} />)}
    </svg>
  );
}

// Konfetti auf dem Sieg-Bildschirm
function Confetti() {
  const colors = ["#f9902a", "#ffe24a", "#3aa0ff", "#a66bff", "#3fbf6a", "#ff3b4e"];
  return (
    <span className="confetti" aria-hidden="true">
      {Array.from({ length: 46 }, (_, index) => (
        <i
          key={index}
          style={{
            "--x": `${(index * 23) % 100}%`,
            "--delay": `${(index % 12) * 260}ms`,
            "--dur": `${2600 + ((index * 131) % 1600)}ms`,
            "--color": colors[index % colors.length],
            "--spin": `${(index % 2 ? 1 : -1) * (240 + ((index * 47) % 360))}deg`
          }}
        />
      ))}
    </span>
  );
}

// Staubkörner, die beim Erdbeben von oben fallen
function Dust({ count }) {
  return (
    <span className="quake-dust" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <i key={index} style={{ "--x": `${(index * 37) % 100}%`, "--delay": `${(index % 7) * 45}ms`, "--size": `${3 + ((index * 5) % 6)}px` }} />
      ))}
    </span>
  );
}

// Belohnung nach dem Spiel: erst nur das Pack, dann Aufladen und Explosion.
// Danach kommt immer nur eine verdeckte Karte, die angetippt wird: Karte leuchtet kurz, dreht sich um und schlägt auf.
// Danach erscheint die nächste. Legendary und Mythic lassen dabei den Bildschirm beben. Am Ende liegt der ganze Fang offen da.
function PackOpening({ awards, categories, onDone, intro = "win" }) {
  const cards = awards;
  const total = cards.length;
  const tierOf = (index) => Number(cards[index]?.card.raritaet) || 1;
  const [phase, setPhase] = useState(intro === "win" ? "win" : "idle"); // win (nur nach einem Sieg) → idle → charge → burst → pick
  const [status, setStatus] = useState({}); // Karte → charging | flipping | landed | up
  const [focus, setFocus] = useState(-1); // Karte, die gerade aufgedeckt wird oder zu sehen ist
  const [current, setCurrent] = useState(0); // die eine Karte, die gerade verdeckt vor dir liegt
  const [quake, setQuake] = useState(null); // { tier, n, x, y } beim Einschlag von Legendary/Mythic
  const [flash, setFlash] = useState(null); // { tier, n } Farbblitz beim Aufschlag
  const timers = useRef([]);
  const handRef = useRef(null);
  const counter = useRef(0);

  const later = (fn, ms) => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    new Image().src = packArt; // Pack-Bild vorladen, damit es nach dem Sieg-Bildschirm sofort da ist
  }, []);

  useEffect(() => {
    let timer;
    if (phase === "win") {
      playWin();
    } else if (phase === "charge") {
      playPackCharge();
      timer = setTimeout(() => setPhase("burst"), PACK_CHARGE_MS);
    } else if (phase === "burst") {
      playPackBurst();
      timer = setTimeout(() => setPhase("pick"), PACK_BURST_MS);
    }
    return () => clearTimeout(timer);
  }, [phase]);

  const startOpening = () => {
    unlockAudio(); // Browser erlauben Ton erst nach einer Berührung
    setPhase("charge");
  };

  const mark = (index, value) => setStatus((current) => ({ ...current, [index]: value }));

  // Aufgedeckte Karte weg, die nächste verdeckte kommt (automatisch nach kurzer Zeit oder per Tippen)
  const advance = (index) => {
    mark(index, "up");
    setFocus((value) => (value === index ? -1 : value));
    setCurrent((value) => (value === index ? value + 1 : value));
  };

  // Die Karte antippen: kurzes Leuchten, ruhiges Umdrehen. Legendary/Mythic fallen dann auf den Hintergrund, der beim Einschlag bebt.
  // Tippt man die schon aufgedeckte Karte an, kommt sofort die nächste.
  const openCard = (index) => {
    if (phase !== "pick") return;
    if (status[index] === "landed") {
      advance(index);
      return;
    }
    if (status[index] || index !== current) return;
    const tier = tierOf(index);
    const drop = DROP_MS[tier] || 0;
    const landAt = CARD_CHARGE_MS + CARD_FLIP_MS;
    const impactAt = landAt + drop;
    mark(index, "charging");
    setFocus(index);
    playCardCharge();
    later(() => {
      mark(index, "flipping");
      playFlip();
    }, CARD_CHARGE_MS);
    if (drop) later(() => mark(index, "dropping"), landAt);
    later(() => {
      counter.current += 1;
      const n = counter.current;
      mark(index, "landed");
      playReveal(tier);
      if (tier >= 3) setFlash({ tier, n });
      if (tier >= 4) {
        playImpact(tier);
        const rect = handRef.current?.querySelector(".pack-slot.is-active")?.getBoundingClientRect();
        setQuake({ tier, n, x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2, y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2 });
        later(() => setQuake((current) => (current?.n === n ? null : current)), tier >= 5 ? 1600 : 900);
      }
    }, impactAt);
    const hold = tier >= 4 ? 3200 : 2400;
    later(() => advance(index), impactAt + hold);
  };

  const revealAll = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setQuake(null);
    setFocus(-1);
    setCurrent(total);
    setStatus(Object.fromEntries(cards.map((_, index) => [index, "up"])));
    setPhase("pick");
  };

  const allSettled = phase === "pick" && cards.every((_, index) => status[index] === "up");
  const newCount = cards.filter((award) => award.isNew).length;
  const showPack = phase === "idle" || phase === "charge" || phase === "burst";
  const focusStatus = focus >= 0 ? status[focus] : null;

  // Die vergrößerte Karte darf nicht über den Bildschirmrand ragen: bei Bedarf nach innen schieben
  useLayoutEffect(() => {
    const slot = handRef.current?.querySelector(".pack-slot.is-active");
    if (!slot) return;
    const zoom = parseFloat(getComputedStyle(handRef.current).getPropertyValue("--zoom")) || 1.5;
    const rect = slot.getBoundingClientRect();
    const half = (slot.offsetWidth * zoom) / 2;
    const center = rect.left + rect.width / 2;
    const margin = 10;
    let dx = 0;
    if (center - half < margin) dx = margin - (center - half);
    else if (center + half > window.innerWidth - margin) dx = window.innerWidth - margin - (center + half);
    slot.style.setProperty("--dx", `${Math.round(dx)}px`);
  }, [focus]);

  let eyebrow = intro === "daily" ? "TAGESPACK" : "BELOHNUNG";
  let headline = intro === "daily" ? <>Dein Tagespack wartet</> : <>Dein Pack wartet</>;
  if (phase === "charge") headline = <>Es lädt sich auf …</>;
  if (phase === "burst") headline = <>Jetzt!</>;
  if (phase === "pick") {
    eyebrow = `KARTE ${Math.min(current + 1, total)} VON ${total}`;
    headline = <>Tippe die Karte an</>;
    if (focusStatus === "charging" || focusStatus === "flipping" || focusStatus === "dropping") headline = <>Gleich …</>;
    if (focusStatus === "landed") {
      headline = <><span className={`pack-tier tier-${tierOf(focus)}`}>{TIER_NAMES[tierOf(focus)]}</span>{cards[focus].isNew && <em className="pack-new">NEU!</em>}</>;
    }
  }
  if (allSettled) {
    eyebrow = "DEIN FANG";
    headline = <>{total} {total === 1 ? "Auto" : "Autos"}{newCount > 0 ? ` · ${newCount} neu` : ""}</>;
  }

  return (
    <div className={`pack-overlay is-${phase}`} role="dialog" aria-label="Pack öffnen">
      {phase === "burst" && <div className="pack-flash" />}
      {flash && <div className={`tier-flash tier-${flash.tier}`} key={`flash-${flash.n}`} />}
      {quake && <Dust count={quake.tier >= 5 ? 34 : 12} key={`dust-${quake.n}`} />}
      <div className={`pack-bg ${quake ? `quake-${quake.tier}` : ""}`} key={quake ? `bg-${quake.n}` : "bg"}>
        {quake && <Cracks tier={quake.tier} x={quake.x} y={quake.y} />}
      </div>
      {phase === "win" ? (
        <div className="pack-shaker win-screen">
          <Confetti />
          <div className="win-trophy" aria-hidden="true">🏆</div>
          <p className="eyebrow">SIEG</p>
          <h2 className="win-title">Gewonnen!</h2>
          <p className="win-sub">Als Belohnung wartet ein Pack mit {total} {total === 1 ? "Karte" : "Karten"} auf dich.</p>
          <Button variant="primary" size="lg" onClick={() => { unlockAudio(); setPhase("idle"); }} icon={<ArrowIcon />}>Pack abholen</Button>
          <Button variant="ghost" onClick={revealAll}>Überspringen</Button>
        </div>
      ) : (
      <div className="pack-shaker">
        <div className="pack-head">
          <p className="eyebrow">{eyebrow}</p>
          <h2 key={`${phase}-${focus}-${focusStatus}-${allSettled}`}>{headline}</h2>
        </div>

        <div className={`pack-main ${allSettled && total > 5 ? "is-many" : ""}`}>
          <div className="pack-stage">
            {(phase === "charge" || phase === "burst") && <div className="pack-rays" />}
            {showPack && (
              <button
                type="button"
                className={`pack ${phase === "charge" ? "is-charging" : ""} ${phase === "burst" ? "is-bursting" : ""}`}
                onClick={phase === "idle" ? startOpening : undefined}
                aria-label="Pack öffnen"
              >
                <img className="pack-art pack-art-body" src={packArt} alt="" draggable="false" />
                <img className="pack-art pack-art-top" src={packArt} alt="" draggable="false" />
                <span className="pack-count">{total} {total === 1 ? "KARTE" : "KARTEN"}</span>
              </button>
            )}
            {phase === "burst" && (
              <>
                <i className="shockwave" />
                <i className="shockwave is-late" />
                <Sparks count={48} color="#ffd166" power={1.7} />
              </>
            )}
          </div>

          {phase === "burst" || phase === "pick" ? (
            <div className="pack-hand" data-n={allSettled ? (total > 5 ? "many" : total) : 1} ref={handRef}>
              {cards.map((award, index) => {
                if (!allSettled && index !== Math.min(current, total - 1)) return null;
                const tier = tierOf(index);
                const state = status[index];
                const isUp = state === "flipping" || state === "dropping" || state === "landed" || state === "up";
                const waiting = phase === "pick" && !state;
                const spread = allSettled; // einzeln in der Mitte, erst der fertige Fang liegt nebeneinander
                return (
                  <div
                    className={`pack-slot tier-${tier} ${isUp ? "is-up" : ""} ${state === "dropping" ? "is-dropping" : ""} ${focus === index ? "is-active" : ""} ${state === "charging" ? "is-charging" : ""} ${waiting ? "is-waiting" : ""} ${phase === "burst" ? "is-entering" : ""}`}
                    style={{ "--i": spread ? index : 0, "--mid": spread ? (total - 1) / 2 : 0 }}
                    key={`${award.card.c_id}-${index}`}
                    role="button"
                    tabIndex={waiting || state === "landed" ? 0 : -1}
                    aria-label={isUp ? `${award.card.name}, weiter zur nächsten Karte` : "Karte aufdecken"}
                    onClick={() => openCard(index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openCard(index);
                      }
                    }}
                  >
                    <div className="pack-shake">
                      <div className="pack-flip">
                        <div className="pf-face pf-back"><ScaledCard><CardBack /></ScaledCard></div>
                        <div className="pf-face pf-front"><CollectionCard card={award.card} categories={categories} isNew={award.isNew} /></div>
                      </div>
                    </div>
                    {state === "landed" && <RevealFx tier={tier} />}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="pack-actions">
          {allSettled ? (
            <Button variant="primary" size="lg" onClick={onDone} icon={<ArrowIcon />}>Weiter</Button>
          ) : (
            <>
              {phase === "pick" && (
                <>
                  <p className="pack-hint">{focusStatus === "landed" ? (current < total - 1 ? "Tippen für die nächste Karte" : "Tippen zum Abschluss") : " "}</p>
                  <div className="pack-dots" aria-hidden="true">
                    {cards.map((_, index) => (
                      <i key={index} className={`${index === current ? "is-current" : ""} ${status[index] === "landed" || status[index] === "up" ? `is-done tier-${tierOf(index)}` : ""}`} />
                    ))}
                  </div>
                </>
              )}
              {phase === "idle" && <Button variant="primary" size="lg" onClick={startOpening} icon={<ArrowIcon />}>Pack öffnen</Button>}
              <Button variant="ghost" onClick={revealAll}>{phase === "pick" ? "Alle aufdecken" : "Überspringen"}</Button>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// Risiko-Modus nach Spielende: der Gewinner wählt, alle sehen das Ergebnis
// Zeichnet das Fächer auf 500 px Breite und passt es per zoom an die verfügbare Breite an
function useFitZoom(designWidth) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const width = element.parentElement?.clientWidth || designWidth;
      element.style.zoom = String(Math.min(1, width / designWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [designWidth]);
  return ref;
}

const FAN_SWEEP = 36; // so weit schwenkt die Hand nach links und rechts (Grad)

// Die Hand mit dem Zeigefinger: schwenkt über dem Fächer hin und her und bleibt bei der gezogenen Karte stehen.
// Der Winkel wird direkt am Element gesetzt (kein React-Rendering pro Bild), die Bewegung läuft nur über transform.
function FanHand({ stopAngle }) {
  const ref = useRef(null);
  const stopRef = useRef(stopAngle);
  const angleRef = useRef(0);
  stopRef.current = stopAngle;
  useEffect(() => {
    let frame;
    let last = performance.now();
    let phase = 0;
    let settleFrom = null;
    let settleStart = 0;
    const tick = (now) => {
      const dt = Math.min(64, now - last);
      last = now;
      const target = stopRef.current;
      if (target == null) {
        phase += dt / 1000;
        // ruhig hin und her mit leichtem Zittern, wie jemand, der sich noch entscheidet
        angleRef.current = Math.sin(phase * 1.9) * FAN_SWEEP * (0.92 + 0.08 * Math.sin(phase * 7.3));
        settleFrom = null;
      } else {
        if (settleFrom === null) {
          settleFrom = angleRef.current;
          settleStart = now;
        }
        const t = Math.min(1, (now - settleStart) / 650);
        const eased = 1 - (1 - t) ** 3;
        angleRef.current = settleFrom + (target - settleFrom) * eased;
      }
      if (ref.current) ref.current.style.transform = `rotate(${angleRef.current.toFixed(2)}deg)`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="fan-hand" ref={ref} aria-hidden="true">
      <svg viewBox="0 0 64 96" width="64" height="96">
        <defs>
          <linearGradient id="hand-skin" x1="0" x2="1">
            <stop offset="0" stopColor="#f4c9a4" />
            <stop offset="1" stopColor="#d9a07a" />
          </linearGradient>
        </defs>
        <rect x="14" y="0" width="36" height="14" rx="3" fill="#e9edf3" stroke="#9aa6b6" strokeWidth="1.5" />
        <path d="M14 12h36v26q0 10-8 12H22q-8-2-8-12z" fill="url(#hand-skin)" stroke="#8a5a3c" strokeWidth="1.6" />
        <rect x="26" y="34" width="12" height="58" rx="6" fill="url(#hand-skin)" stroke="#8a5a3c" strokeWidth="1.6" />
        <path d="M14 30q-8 2-8 10t8 8" fill="url(#hand-skin)" stroke="#8a5a3c" strokeWidth="1.6" />
        <path d="M42 36h6q6 0 6 7t-6 7h-6M42 44h5" fill="#e9b790" stroke="#8a5a3c" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M28 70v-24M36 70v-24" stroke="#8a5a3c" strokeOpacity="0.25" strokeWidth="1.2" />
      </svg>
    </div>
  );
}

// Kartenfächer. mode "back": Rückseiten zum Anklicken (Gewinner). mode "front": die eigenen Karten offen mit Hand (Verlierer).
function RiskFan({ count, cards, mode, pickedSlot = null, onPick, busy = false, label }) {
  const zoomRef = useFitZoom(500);
  const step = count > 1 ? Math.min(7, 70 / (count - 1)) : 0;
  const angleOf = (slot) => (slot - (count - 1) / 2) * step;
  const pulled = pickedSlot !== null && pickedSlot !== undefined;
  return (
    <div className="risk-fan-wrap">
      <div className={`risk-fan is-${mode} ${pulled ? "has-pulled" : ""}`} ref={zoomRef}>
        <svg className="fan-arc" viewBox="0 0 500 300" aria-hidden="true"><path d="M70 208A395 395 0 0 1 430 208" fill="none" /></svg>
        {mode === "front" && <FanHand stopAngle={pulled ? angleOf(pickedSlot) : null} />}
        {Array.from({ length: count }, (_, slot) => {
          const isPulled = pickedSlot === slot;
          const card = cards?.[slot];
          const tier = Number(card?.raritaet) || 1;
          const common = {
            className: `fan-card ${isPulled ? "is-pulled" : ""} ${mode === "front" ? `tier-${tier}` : ""}`,
            style: { "--a": `${angleOf(slot)}deg`, "--z": slot }
          };
          if (mode === "back") {
            return (
              <button type="button" {...common} key={slot} disabled={busy || pulled} onClick={() => onPick(slot)} aria-label={`${label}: Karte ${slot + 1} ziehen`}>
                <ScaledCard><CardBack /></ScaledCard>
              </button>
            );
          }
          return (
            <div {...common} key={slot}>
              <div className="fan-face">
                {card?.image ? <img src={card.image} alt="" loading="lazy" decoding="async" /> : <span className="fan-face-fallback" />}
                <b>{card?.name}</b>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Gezogene Karte erscheint nach dem Herausziehen groß; beim Verlierer mit „VERLOREN“-Stempel
function LostCard({ card, categories, lost }) {
  return (
    <div className={`risk-reveal ${lost ? "is-lost" : "is-won"}`}>
      <p className="eyebrow">{lost ? "DIESE KARTE HAST DU VERLOREN" : "DU BEKOMMST"}</p>
      <div className="risk-reveal-card">
        <CollectionCard card={card} categories={categories} />
        {lost && <div className="lost-stamp" aria-hidden="true">VERLOREN</div>}
      </div>
    </div>
  );
}

function useDelayedFlag(on, ms) {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!on) {
      setFlag(false);
      return undefined;
    }
    const timer = setTimeout(() => setFlag(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return flag;
}

// Risiko-Modus nach Spielende: der Gewinner zieht aus verdeckten Fächern, die Verlierer sehen ihr Fächer offen
function RiskPanel({ state }) {
  const { risk, players, selfId, categories } = state;
  const winner = players.find((player) => player.id === risk.winnerId);
  const isWinner = selfId === risk.winnerId;
  const [busy, setBusy] = useState(false);
  const nameOf = (id) => players.find((player) => player.id === id)?.name || "Spieler";
  const pick = (loserId, slot) => {
    setBusy(true);
    socket.request("riskPick", { loserId, slot }).then((result) => {
      setBusy(false);
      if (result.ok) socket.applyResult(result);
    }).catch(() => setBusy(false));
  };
  const mySlot = risk.slots?.[selfId];
  const myPick = risk.picks?.[selfId];
  const showMine = useDelayedFlag(!isWinner && mySlot !== null && mySlot !== undefined && Boolean(myPick), 1100);

  if (!isWinner) {
    return (
      <div className="risk-panel">
        <p className="eyebrow">RISIKO{risk.done ? "" : <> · NOCH <Seconds target={risk.deadline} /> S</>}</p>
        {mySlot === null || mySlot === undefined ? (
          <p className="risk-line"><Spinner /> {winner?.name} zieht eine Karte aus deinem Deck …</p>
        ) : (
          <p className="risk-line">{winner?.name} hat gezogen.</p>
        )}
        {risk.fan && <RiskFan count={risk.fan.length} cards={risk.fan} mode="front" pickedSlot={mySlot ?? null} />}
        {showMine && myPick && <LostCard card={myPick} categories={categories} lost />}
      </div>
    );
  }
  return (
    <div className="risk-panel">
      <p className="eyebrow">{risk.done ? "RISIKO" : <>RISIKO · NOCH <Seconds target={risk.deadline} /> S</>}</p>
      {Object.entries(risk.counts || {}).map(([loserId, count]) => {
        const slot = risk.slots?.[loserId];
        const taken = risk.picks?.[loserId];
        return (
          <div className="risk-choice" key={loserId}>
            <h3>{taken ? `Du hast eine Karte von ${nameOf(loserId)} gezogen` : `Zieh eine Karte von ${nameOf(loserId)}`}</h3>
            <RiskFan count={count} mode="back" pickedSlot={slot ?? null} onPick={(index) => pick(loserId, index)} busy={busy} label={nameOf(loserId)} />
            {taken && <LostCard card={taken} categories={categories} lost={false} />}
          </div>
        );
      })}
      {!risk.done && <small className="muted">Ohne Wahl wird nach Ablauf der Zeit zufällig gezogen.</small>}
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

function CarSilhouette() {
  return <svg className="car-silhouette" viewBox="0 0 260 100" aria-hidden="true"><path d="M20 69c5-15 15-26 33-30l39-6 26-20h48l35 23 31 8c8 2 12 11 10 25h-16a23 23 0 0 0-44 0H79a23 23 0 0 0-44 0H20Z" /><circle cx="57" cy="70" r="16" /><circle cx="204" cy="70" r="16" /><path className="window" d="m101 34 23-16h38l25 18-86-2Z" /></svg>;
}

export default App;
