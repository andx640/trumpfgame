import { Suspense, useCallback, useEffect, useState } from "react";
import { GAMES, findGame } from "./games/registry";
import { Loading } from "./ui";

// Spielesammlung: Hauptmenü und Umschalter zwischen den Spielen.
// Das gewählte Spiel steht in der Adresse (#trumpf, #madn, #madn/CODE), so funktionieren Zurück-Taste, Neuladen und Einladungslinks.

const DEFAULT_TITLE = "Andi Spiele";

function readGameId() {
  const id = window.location.hash.replace(/^#\/?/, "").split("/")[0]; // #madn/RAUMCODE: Spiel madn mit Zusatz
  if (findGame(id)) return id;
  // keine Auswahl in der Adresse: eine laufende Partie geht vor, sonst das Menü
  return GAMES.find((game) => game.resume?.())?.id ?? null;
}

function App() {
  const [gameId, setGameId] = useState(readGameId);

  useEffect(() => {
    const onHash = () => setGameId(readGameId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const game = findGame(gameId);

  useEffect(() => {
    document.title = game ? game.title : DEFAULT_TITLE;
  }, [game]);

  const open = useCallback((id) => {
    window.location.hash = id;
  }, []);

  const exit = useCallback(() => {
    if (window.location.hash) {
      // Adresse ohne # zurücksetzen, ohne neu zu laden
      window.history.pushState(null, "", window.location.pathname + window.location.search);
    }
    setGameId(null);
  }, []);

  if (game) {
    const Game = game.component;
    return (
      <Suspense fallback={<div className="hub-loading"><Loading>Spiel wird geladen …</Loading></div>}>
        <Game key={game.id} onExit={exit} />
      </Suspense>
    );
  }
  return <Hub onOpen={open} />;
}

function Hub({ onOpen }) {
  return (
    <div className="app-shell is-home">
      <main>
        <section className="home hub">
          <div className="home-inner">
            <div className="home-logo" role="img" aria-label="Andi Spiele">
              <div className="home-logo-top"><span>ANDI</span></div>
              <div className="home-logo-bottom">SPIELE</div>
            </div>

            <nav className="home-menu" aria-label="Spiele">
              {GAMES.map((game, index) => {
                const Icon = game.icon;
                return (
                  <button key={game.id} type="button" className={`menu-tile ${index === 0 ? "is-primary" : ""}`} onClick={() => onOpen(game.id)}>
                    <Icon />
                    <span><strong>{game.title}</strong><small>{game.subtitle}</small></span>
                    <svg className="home-arrow" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                );
              })}
            </nav>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
