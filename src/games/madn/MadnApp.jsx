import { useState } from "react";
import LocalGame, { savedLocalGame } from "./LocalGame";
import OnlineGame from "./OnlineGame";
import { hasOnlineSession } from "./online";
import { Header } from "./table";
import "./madn.css";

// Mensch ärgere dich nicht: Auswahl der Spielart, dann Partie am Gerät (gegen KI / mehrere Leute) oder online.

function inviteFromHash() {
  // Einladungslink: #madn/RAUMCODE
  const match = window.location.hash.match(/^#\/?madn\/([A-Za-z0-9]{4,8})$/);
  return match ? match[1].toUpperCase() : "";
}

export default function MadnApp({ onExit }) {
  const [invite] = useState(inviteFromHash);
  const [mode, setMode] = useState(() => (invite || hasOnlineSession() ? "online" : null)); // null | ai | device | resume | online

  const backToMenu = () => {
    if (invite) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#madn`);
    setMode(null);
  };

  let page;
  if (mode === "online") page = <OnlineGame onBack={backToMenu} inviteCode={invite} />;
  else if (mode) page = <LocalGame key={mode} preset={mode} onBack={backToMenu} />;
  else page = <ModeMenu onPick={setMode} onExit={onExit} />;

  return <div className="madn-shell">{page}</div>;
}

function ModeMenu({ onPick, onExit }) {
  const saved = savedLocalGame();
  const tiles = [
    saved && { id: "resume", title: "Partie fortsetzen", text: `${saved.players.map((p) => p.name).join(", ")}`, icon: <PlayIcon /> },
    { id: "ai", title: "Gegen die KI", text: "Du gegen bis zu drei Computergegner", icon: <ChipIcon /> },
    { id: "online", title: "Online spielen", text: "Mit Freunden auf ihren Geräten, per Raum-Code", icon: <GlobeIcon /> },
    { id: "device", title: "An einem Gerät", text: "2–4 Leute reihum am selben Handy oder Tablet", icon: <GroupIcon /> }
  ].filter(Boolean);

  return (
    <>
      <Header onBack={onExit} backLabel="Spiele" />
      <section className="madn-menu">
        <nav className="home-menu" aria-label="Spielart">
          {tiles.map((tile, index) => (
            <button key={tile.id} type="button" className={`menu-tile ${index === 0 ? "is-primary" : ""}`} onClick={() => onPick(tile.id)}>
              {tile.icon}
              <span><strong>{tile.title}</strong><small>{tile.text}</small></span>
              <svg className="home-arrow" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))}
        </nav>
      </section>
    </>
  );
}

function PlayIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M20 15l13 9-13 9z" fill="currentColor" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="11" y="11" width="26" height="26" rx="5" fill="none" stroke="currentColor" strokeWidth="3" />
      <rect x="18" y="18" width="12" height="12" rx="2" fill="currentColor" />
      <path d="M17 5v6M24 5v6M31 5v6M17 37v6M24 37v6M31 37v6M5 17h6M5 24h6M5 31h6M37 17h6M37 24h6M37 31h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6">
      <circle cx="24" cy="24" r="18" />
      <ellipse cx="24" cy="24" rx="8" ry="18" />
      <path d="M7 18h34M7 30h34" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="16" cy="15" r="6" fill="currentColor" />
      <circle cx="33" cy="17" r="5" fill="currentColor" opacity="0.7" />
      <path d="M5 40c0-8 4-14 11-14s11 6 11 14z" fill="currentColor" />
      <path d="M29 40c0-6-1-10-4-12 2-1 5-2 8-2 6 0 10 5 10 14z" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
