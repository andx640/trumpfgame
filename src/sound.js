// Kurze Spielgeräusche, direkt mit der Web Audio API erzeugt (keine Audiodateien). Abschaltbar, Einstellung bleibt gespeichert.
const STORAGE_KEY = "andi-trumpf-sound";
let context = null;
let enabled = true;
try {
  enabled = localStorage.getItem(STORAGE_KEY) !== "off";
} catch {
  enabled = true;
}

export function soundEnabled() {
  return enabled;
}

export function setSoundEnabled(value) {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
  } catch {
    // ohne Speicher gilt die Einstellung nur bis zum Neuladen
  }
  if (value) unlockAudio();
}

// Der Chat-Ton hat einen eigenen Schalter im Chatfenster, unabhängig vom Spielton.
const CHAT_KEY = "andi-trumpf-chat-sound";
let chatEnabled = true;
try {
  chatEnabled = localStorage.getItem(CHAT_KEY) !== "off";
} catch {
  chatEnabled = true;
}

export function chatSoundEnabled() {
  return chatEnabled;
}

export function setChatSoundEnabled(value) {
  chatEnabled = value;
  try {
    localStorage.setItem(CHAT_KEY, value ? "on" : "off");
  } catch {
    // ohne Speicher gilt die Einstellung nur bis zum Neuladen
  }
  if (value) playChat();
}

function audio(force = false) {
  if (!enabled && !force) return null;
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
  }
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

// Browser erlauben Ton erst nach einer Berührung: beim ersten Tippen freischalten.
export function unlockAudio() {
  audio();
}

function tone(ctx, frequency, start, duration, { type = "sine", gain = 0.12, slideTo = null } = {}) {
  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + start);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + start + duration);
  volume.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  volume.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + start + 0.015);
  volume.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
  oscillator.connect(volume).connect(ctx.destination);
  oscillator.start(ctx.currentTime + start);
  oscillator.stop(ctx.currentTime + start + duration + 0.05);
}

function whoosh(ctx, start, duration) {
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const volume = ctx.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(600, ctx.currentTime + start);
  filter.frequency.exponentialRampToValueAtTime(3200, ctx.currentTime + start + duration);
  volume.gain.value = 0.18;
  source.connect(filter).connect(volume).connect(ctx.destination);
  source.start(ctx.currentTime + start);
}

/** Karten werden umgedreht */
export function playFlip() {
  const ctx = audio();
  if (ctx) whoosh(ctx, 0, 0.35);
}

/** eigener Stich */
export function playWin() {
  const ctx = audio();
  if (!ctx) return;
  tone(ctx, 660, 0, 0.18, { type: "triangle" });
  tone(ctx, 880, 0.1, 0.2, { type: "triangle" });
  tone(ctx, 1320, 0.2, 0.35, { type: "triangle", gain: 0.1 });
}

/** Stich verloren */
export function playLose() {
  const ctx = audio();
  if (ctx) tone(ctx, 330, 0, 0.35, { type: "sawtooth", gain: 0.05, slideTo: 180 });
}

/** man ist dran */
export function playTurn() {
  const ctx = audio();
  if (!ctx) return;
  tone(ctx, 740, 0, 0.12);
  tone(ctx, 988, 0.13, 0.18);
}

/** neue Chatnachricht: kurzes, helles „Plip“ (nur mit Chat-Ton an) */
export function playChat() {
  if (!chatEnabled) return;
  const ctx = audio(true);
  if (!ctx) return;
  tone(ctx, 1046, 0, 0.09, { gain: 0.09 });
  tone(ctx, 1568, 0.08, 0.14, { gain: 0.08 });
}

// ---- Pack-Öffnung: Aufladen, Explosion und je nach Seltenheit ein größerer Auftritt ----

function boom(ctx, start, { from = 140, to = 32, gain = 0.3, duration = 0.8 } = {}) {
  tone(ctx, from, start, duration, { type: "sine", gain, slideTo: to });
}

/** Das Pack lädt sich auf: tiefes Grollen, das ansteigt, dazu ein schneller werdendes Ticken */
export function playPackCharge() {
  const ctx = audio();
  if (!ctx) return;
  tone(ctx, 55, 0, 2, { type: "sawtooth", gain: 0.08, slideTo: 240 });
  tone(ctx, 110, 0.1, 1.9, { type: "triangle", gain: 0.06, slideTo: 720 });
  whoosh(ctx, 0.2, 1.8);
  for (let i = 0; i < 12; i += 1) tone(ctx, 900 + i * 70, 0.2 + i * 0.15, 0.05, { type: "square", gain: 0.025 });
}

/** Das Pack explodiert */
export function playPackBurst() {
  const ctx = audio();
  if (!ctx) return;
  boom(ctx, 0, { gain: 0.34 });
  whoosh(ctx, 0, 0.55);
  [1047, 1319, 1568, 2093, 2637].forEach((frequency, index) => tone(ctx, frequency, 0.1 + index * 0.07, 0.35, { type: "triangle", gain: 0.07 }));
}

/** Die nächste Karte lädt sich auf: ansteigende Spannung */
export function playCardCharge() {
  const ctx = audio();
  if (!ctx) return;
  tone(ctx, 220, 0, 1.2, { type: "sawtooth", gain: 0.035, slideTo: 880 });
  for (let i = 0; i < 6; i += 1) tone(ctx, 1200 + i * 90, 0.3 + i * 0.15, 0.04, { type: "square", gain: 0.02 });
}

/** Karte wird aufgedeckt: je seltener, desto größer der Auftritt */
export function playReveal(tier = 1) {
  const ctx = audio();
  if (!ctx) return;
  whoosh(ctx, 0, 0.35);
  const notes = {
    1: [660],
    2: [784, 988],
    3: [659, 880, 1175],
    4: [523, 659, 784, 1047, 1319],
    5: [523, 659, 784, 1047, 1319, 1568, 2093]
  }[tier] || [660];
  notes.forEach((frequency, index) => tone(ctx, frequency, 0.25 + index * 0.09, 0.4 + tier * 0.08, { type: "triangle", gain: 0.07 + tier * 0.008 }));
  if (tier >= 3) boom(ctx, 0.2, { gain: 0.1 + tier * 0.05, duration: 0.6 });
  if (tier >= 4) tone(ctx, 261, 0.3, 1.2, { type: "sawtooth", gain: 0.04, slideTo: 523 });
  if (tier >= 5) {
    boom(ctx, 0.2, { from: 90, to: 25, gain: 0.4, duration: 1.1 });
    tone(ctx, 392, 0.35, 1.6, { type: "sawtooth", gain: 0.045, slideTo: 784 });
  }
}
