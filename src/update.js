// Hält die Seite aktuell: Ist eine neuere Version online, lädt die App von selbst neu.
// Spielstände liegen im localStorage bzw. auf dem Server und überstehen das Neuladen.

const CHECK_MS = 60 * 1000;
const RELOAD_KEY = "andi-reloaded-for";

function reloadOnce(reason) {
  try {
    // nicht in einer Schleife neu laden, falls der Server noch die alte Seite ausliefert
    if (sessionStorage.getItem(RELOAD_KEY) === reason) return;
    sessionStorage.setItem(RELOAD_KEY, reason);
  } catch {
    // ohne sessionStorage trotzdem neu laden
  }
  window.location.reload();
}

async function check() {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const { build } = await response.json();
    if (build && build !== __BUILD_ID__) reloadOnce(build);
  } catch {
    // offline oder Datei fehlt: beim nächsten Mal wieder versuchen
  }
}

export function startUpdateCheck() {
  if (import.meta.env.DEV) return;
  check();
  window.setInterval(check, CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("focus", check);
  // Teil der App nach einem Update nicht mehr ladbar: neu laden statt Fehler zeigen
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    reloadOnce("chunk");
  });
}
