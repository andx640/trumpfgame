import * as THREE from "three";

// Gemeinsame WebGL-Einstellungen für die 3D-Spiele.
// Auf Handys (vor allem iPhone/Safari) stürzt die GPU bei zu viel Last ab: Das Canvas wird zum
// „kaputt“-Symbol und Safari sperrt WebGL danach für die ganze Seite. Deshalb auf Touch-Geräten
// sparsamer rendern (geringere Auflösung, kein Multisampling, kleinere Schattenkarte).

export const LOW_POWER =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent));

export const SHADOW_MAP_SIZE = LOW_POWER ? 1024 : 2048;
export const ANISOTROPY = LOW_POWER ? 2 : 8;

/** WebGLRenderer mit geräteabhängigen Einstellungen. onLost wird gerufen, wenn der 3D-Kontext
 *  verloren geht und nicht innerhalb kurzer Zeit zurückkommt. */
export function createRenderer({ onLost } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const renderer = new THREE.WebGLRenderer({
    antialias: !LOW_POWER || dpr < 2,
    alpha: true,
    powerPreference: LOW_POWER ? "default" : "high-performance"
  });
  renderer.setPixelRatio(Math.min(dpr, LOW_POWER ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = LOW_POWER ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

  // three.js versucht nach einem Verlust selbst, den Kontext wiederherzustellen.
  // Kommt er nicht zurück, schaltet das Spiel auf seine Ersatzdarstellung.
  let timer = null;
  const canvas = renderer.domElement;
  const lost = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onLost?.(), 2500);
  };
  const restored = () => clearTimeout(timer);
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  renderer.releaseLossWatch = () => {
    clearTimeout(timer);
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
  };
  return renderer;
}

/** Renderer aufräumen und den WebGL-Kontext sofort freigeben (Safari erlaubt nur wenige gleichzeitig). */
export function disposeRenderer(renderer) {
  renderer.releaseLossWatch?.();
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}

/** Prüft, ob WebGL geht, ohne einen Kontext dauerhaft zu belegen. */
export function webglAvailable() {
  try {
    if (!window.WebGLRenderingContext) return false;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
