import { lazy } from "react";

// Alle Spiele der Sammlung. Ein neues Spiel braucht nur einen Eintrag hier:
//   id          – kurzer Schlüssel, steht in der Adresse (#id)
//   title       – Name im Menü und im Browser-Tab
//   subtitle    – eine Zeile unter dem Namen
//   icon        – kleines Symbol für die Menükachel
//   component   – das Spiel selbst; bekommt { onExit } und kehrt damit ins Menü zurück
//   resume      – optional: true, wenn eine laufende Partie beim Laden direkt fortgesetzt werden soll
// Die Spiele werden erst beim Öffnen geladen, damit das Menü schnell bleibt.

export const GAMES = [
  {
    id: "trumpf",
    title: "Andi Trumpf",
    subtitle: "Autoquartett online · 2–4 Spieler",
    icon: TrumpfIcon,
    component: lazy(() => import("./trumpf/TrumpfApp.jsx")),
    // laufende Online-Partie im selben Tab: direkt wieder hinein
    resume: () => {
      try {
        return Boolean(sessionStorage.getItem("pitlane-trumpf-token") && sessionStorage.getItem("pitlane-trumpf-room"));
      } catch {
        return false;
      }
    }
  },
  {
    id: "madn",
    title: "Mensch ärgere dich nicht",
    subtitle: "Online, gegen KI oder an einem Gerät · 2–6 Spieler",
    icon: MadnIcon,
    component: lazy(() => import("./madn/MadnApp.jsx")),
    // laufende Online-Partie im selben Tab (gleicher Schlüssel wie in madn/online.js)
    resume: () => {
      try {
        return Boolean(sessionStorage.getItem("andi-madn-online"));
      } catch {
        return false;
      }
    }
  },
  {
    id: "panzer",
    title: "Panzerkiste",
    subtitle: "Spielzeugpanzer-Action · Handy und PC",
    icon: PanzerIcon,
    component: lazy(() => import("./panzer/PanzerApp.jsx"))
  }
];

export function findGame(id) {
  return GAMES.find((game) => game.id === id) || null;
}

function TrumpfIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="6" y="9" width="24" height="32" rx="4" transform="rotate(-12 18 25)" fill="currentColor" opacity="0.55" />
      <rect x="16" y="7" width="26" height="34" rx="4" fill="currentColor" />
      <path d="M22 28l2-6h12l2 6v6h-3v-2H25v2h-3zm4.5-4l-1 3h11l-1-3z" fill="#e8730a" />
    </svg>
  );
}

function MadnIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="17" cy="11" r="6" fill="currentColor" />
      <path d="M11 38c1-8 3-14 6-18 3 4 5 10 6 18z" fill="currentColor" />
      <rect x="8" y="37" width="18" height="5" rx="2.5" fill="currentColor" />
      <rect x="26" y="22" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="30.5" cy="26.5" r="1.8" fill="#e8730a" />
      <circle cx="34.5" cy="30.5" r="1.8" fill="#e8730a" />
      <circle cx="38.5" cy="34.5" r="1.8" fill="#e8730a" />
    </svg>
  );
}

function PanzerIcon() {
  return (
    <svg className="home-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="5" y="30" width="38" height="10" rx="5" fill="currentColor" opacity="0.6" />
      <rect x="8" y="22" width="32" height="10" rx="3" fill="currentColor" />
      <rect x="16" y="14" width="14" height="10" rx="4" fill="currentColor" />
      <rect x="28" y="17" width="16" height="4" rx="2" fill="#e8730a" />
    </svg>
  );
}
