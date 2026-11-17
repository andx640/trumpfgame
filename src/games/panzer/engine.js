// Panzerkiste – Spiellogik ohne Darstellung.
// Die Arena ist ein Raster aus W × H Feldern (1 Einheit = 1 Feld), x nach rechts, y nach unten.
// step() verändert den Zustand direkt (Echtzeitspiel, 120 Schritte pro Sekunde).
// Zufall kommt von außen (rng), damit Tests reproduzierbar bleiben.

import { LEVELS } from "./levels.js";

export const W = 22;
export const H = 16;
export const TILE = { EMPTY: 0, CRATE: 1, BOX: 2, HOLE: 3 };
export const TANK_R = 0.4;
export const BULLET_R = 0.09;
export const BARREL = 0.62;
export const MINE_FUSE = 10;
export const MINE_ARM = 1;
export const MINE_TRIGGER = 1.15;
export const MINE_BLAST = 1.75;
const SELF_SAFE = 0.25; // so lange kann die eigene Kugel den Schützen nicht treffen (außer nach Abprall)

/**
 * Panzertypen. Gegner sind eigene Entwürfe:
 *   wache   – Wachposten: steht still, dreht langsam den Turm, schießt nur auf direkte Sicht
 *   spaeher – Späher: fährt umher, weicht Kugeln aus, nutzt auch Abpraller
 *   jaeger  – Jäger: schnell, aggressiv, legt Minen
 *   blitz   – Blitz: schießt schnelle Kugeln ohne Abprall, hält Abstand
 */
export const TYPES = {
  player: { name: "Du", color: "#e8730a", speed: 3, turn: 10, bulletSpeed: 6.5, bounces: 1, maxBullets: 5, maxMines: 2, fireCooldown: [0.12, 0.12] },
  wache: { name: "Wachposten", color: "#7a8a3c", speed: 0, turn: 0, turretSpeed: 1.4, bulletSpeed: 4.5, bounces: 1, maxBullets: 1, maxMines: 0, fireCooldown: [1.4, 2.4], aimError: 0.08, bank: false, dodge: false, predict: 0, think: 0.25 },
  spaeher: { name: "Späher", color: "#4f7fa8", speed: 1.5, turn: 5, turretSpeed: 2.2, bulletSpeed: 5, bounces: 1, maxBullets: 2, maxMines: 0, fireCooldown: [1, 1.8], aimError: 0.05, bank: true, dodge: true, predict: 0.6, think: 0.18 },
  jaeger: { name: "Jäger", color: "#b23a48", speed: 2.4, turn: 7, turretSpeed: 3, bulletSpeed: 5.5, bounces: 1, maxBullets: 3, maxMines: 2, fireCooldown: [0.6, 1.2], aimError: 0.04, bank: true, dodge: true, predict: 0.9, think: 0.12, mineChance: 0.25, chase: true },
  blitz: { name: "Blitz", color: "#d9c34a", speed: 1.2, turn: 5, turretSpeed: 2.6, bulletSpeed: 9, bounces: 0, maxBullets: 1, maxMines: 0, fireCooldown: [1.6, 2.4], aimError: 0.025, bank: false, dodge: true, predict: 1, think: 0.15, keepAway: 7 }
};

const LEVEL_CHARS = { ".": TILE.EMPTY, "#": TILE.CRATE, b: TILE.BOX, o: TILE.HOLE };
const ENEMY_CHARS = { W: "wache", S: "spaeher", J: "jaeger", B: "blitz" };

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const randRange = (rng, [a, b]) => a + rng() * (b - a);

export function levelCount() {
  return LEVELS.length;
}

/** Neuen Zustand für ein Level bauen (index ab 0) */
export function createLevel(index, rng = Math.random) {
  const level = LEVELS[index];
  if (!level) throw new Error(`Level ${index + 1} gibt es nicht.`);
  const tiles = new Uint8Array(W * H);
  const tanks = [];
  let nextId = 1;
  level.map.forEach((row, y) => {
    for (let x = 0; x < W; x += 1) {
      const ch = row[x] ?? ".";
      if (ch in LEVEL_CHARS) tiles[y * W + x] = LEVEL_CHARS[ch];
      else if (ch === "P") tanks.push(makeTank(nextId++, "player", x + 0.5, y + 0.5, 0));
      else if (ch in ENEMY_CHARS) tanks.push(makeTank(nextId++, ENEMY_CHARS[ch], x + 0.5, y + 0.5, Math.PI));
    }
  });
  tanks.filter((t) => t.team === "enemy").forEach((t) => {
    t.cooldown = randRange(rng, [1, 2]); // kurze Schonfrist am Anfang
    t.ai.think = rng() * 0.2;
  });
  return {
    level: index,
    name: level.name,
    time: 0,
    tiles,
    tanks,
    bullets: [],
    mines: [],
    nextId,
    events: [],
    status: "playing" // playing | won | lost
  };
}

function makeTank(id, type, x, y, angle) {
  return {
    id,
    type,
    team: type === "player" ? "player" : "enemy",
    x,
    y,
    vx: 0,
    vy: 0,
    angle, // Fahrtrichtung der Wanne
    turret: angle,
    alive: true,
    cooldown: 0,
    moving: false,
    ai: { think: 0, aim: angle, solution: false, path: [], replan: 0, dodge: null, mineWait: 3 }
  };
}

export function tileAt(state, x, y) {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return TILE.CRATE; // Rand der Kiste
  return state.tiles[ty * W + tx];
}

const blocksBullet = (t) => t === TILE.CRATE || t === TILE.BOX;
const blocksTank = (t) => t !== TILE.EMPTY;

export function player(state) {
  return state.tanks.find((t) => t.team === "player");
}

export function enemiesLeft(state) {
  return state.tanks.filter((t) => t.team === "enemy" && t.alive).length;
}

/**
 * Einen Schritt rechnen.
 * input: { move: {x, y} (Länge ≤ 1), aim: {x, y} (Punkt in der Arena), fire: bool, mine: bool }
 * fire und mine gelten für genau diesen Schritt (Tastendruck), nicht gedrückt halten.
 */
export function step(state, input, dt, rng = Math.random) {
  state.time += dt;
  const me = player(state);
  if (me?.alive && state.status === "playing") {
    driveTank(state, me, input.move ?? { x: 0, y: 0 }, dt);
    if (input.aim) me.turret = Math.atan2(input.aim.y - me.y, input.aim.x - me.x);
    if (input.fire) fire(state, me);
    if (input.mine) layMine(state, me);
  }
  me && (me.cooldown = Math.max(0, me.cooldown - dt));

  if (state.status === "playing") {
    for (const tank of state.tanks) {
      if (tank.team === "enemy" && tank.alive) thinkEnemy(state, tank, dt, rng);
    }
  }
  separateTanks(state);
  moveBullets(state, dt);
  updateMines(state, dt);

  if (state.status === "playing") {
    if (!me?.alive) {
      state.status = "lost";
      state.events.push({ type: "lost" });
    } else if (enemiesLeft(state) === 0) {
      state.status = "won";
      state.events.push({ type: "won" });
    }
  }
  return state;
}

// ---------- Fahren ----------

/** Panzer dreht die Wanne zur Wunschrichtung (vorwärts oder rückwärts, was näher ist) und fährt los */
function driveTank(state, tank, move, dt) {
  const spec = TYPES[tank.type];
  const length = Math.min(1, Math.hypot(move.x, move.y));
  const oldX = tank.x;
  const oldY = tank.y;
  tank.moving = false;
  if (length > 0.15) {
    const want = Math.atan2(move.y, move.x);
    let diff = angleDiff(want, tank.angle);
    let dir = 1;
    if (Math.abs(diff) > Math.PI / 2) {
      // rückwärts fahren ist näher
      diff = angleDiff(want + Math.PI, tank.angle);
      dir = -1;
    }
    const turn = Math.sign(diff) * Math.min(Math.abs(diff), spec.turn * dt);
    tank.angle += turn;
    const align = Math.max(0, Math.cos(diff));
    if (Math.abs(diff) < 0.9) {
      const speed = spec.speed * length * align * align;
      tank.x += Math.cos(tank.angle) * speed * dir * dt;
      tank.y += Math.sin(tank.angle) * speed * dir * dt;
      tank.moving = speed > 0.05;
    }
    collideTiles(state, tank);
  }
  tank.vx = (tank.x - oldX) / dt;
  tank.vy = (tank.y - oldY) / dt;
  if (tank.moving) {
    tank.trackT = (tank.trackT ?? 0) + dt;
    if (tank.trackT > 0.12) {
      tank.trackT = 0;
      state.events.push({ type: "track", x: tank.x, y: tank.y, angle: tank.angle });
    }
  }
}

/** Kreis gegen Felder: aus Wänden herausschieben */
function collideTiles(state, tank) {
  for (let pass = 0; pass < 2; pass += 1) {
    const x0 = Math.floor(tank.x - TANK_R);
    const x1 = Math.floor(tank.x + TANK_R);
    const y0 = Math.floor(tank.y - TANK_R);
    const y1 = Math.floor(tank.y + TANK_R);
    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        if (!blocksTank(tileAt(state, tx + 0.5, ty + 0.5))) continue;
        const nx = Math.max(tx, Math.min(tank.x, tx + 1));
        const ny = Math.max(ty, Math.min(tank.y, ty + 1));
        const dx = tank.x - nx;
        const dy = tank.y - ny;
        const d = Math.hypot(dx, dy);
        if (d < TANK_R) {
          if (d > 1e-6) {
            tank.x = nx + (dx / d) * TANK_R;
            tank.y = ny + (dy / d) * TANK_R;
          } else {
            tank.y = ty - TANK_R; // Mittelpunkt steckt im Feld: nach oben raus
          }
        }
      }
    }
  }
}

function separateTanks(state) {
  const alive = state.tanks.filter((t) => t.alive);
  for (let i = 0; i < alive.length; i += 1) {
    for (let j = i + 1; j < alive.length; j += 1) {
      const a = alive[i];
      const b = alive[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < TANK_R * 2) {
        const push = (TANK_R * 2 - d) / 2;
        const aStill = TYPES[a.type].speed === 0;
        const bStill = TYPES[b.type].speed === 0;
        const fa = aStill ? 0 : bStill ? 2 : 1;
        const fb = bStill ? 0 : aStill ? 2 : 1;
        a.x -= (dx / d) * push * fa;
        a.y -= (dy / d) * push * fa;
        b.x += (dx / d) * push * fb;
        b.y += (dy / d) * push * fb;
        collideTiles(state, a);
        collideTiles(state, b);
      }
    }
  }
}

// ---------- Schießen und Kugeln ----------

export function bulletsOf(state, tank) {
  return state.bullets.filter((b) => b.owner === tank.id).length;
}

function fire(state, tank, rng = Math.random) {
  const spec = TYPES[tank.type];
  if (tank.cooldown > 0 || bulletsOf(state, tank) >= spec.maxBullets) return false;
  const dx = Math.cos(tank.turret);
  const dy = Math.sin(tank.turret);
  const x = tank.x + dx * BARREL;
  const y = tank.y + dy * BARREL;
  tank.cooldown = randRange(rng, spec.fireCooldown);
  if (blocksBullet(tileAt(state, x, y))) {
    // Rohr steckt in der Wand: Kugel verpufft sofort
    state.events.push({ type: "poof", x, y });
    return true;
  }
  state.bullets.push({ id: state.nextId++, owner: tank.id, x, y, vx: dx * spec.bulletSpeed, vy: dy * spec.bulletSpeed, bounces: spec.bounces, age: 0, bounced: false, fast: spec.bulletSpeed > 7 });
  state.events.push({ type: "shot", x, y, team: tank.team });
  return true;
}

function moveBullets(state, dt) {
  const remove = new Set();
  for (const bullet of state.bullets) {
    bullet.age += dt;
    const speed = Math.hypot(bullet.vx, bullet.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 0.05));
    const h = dt / steps;
    for (let s = 0; s < steps && !remove.has(bullet.id); s += 1) {
      const nx = bullet.x + bullet.vx * h;
      const ny = bullet.y + bullet.vy * h;
      if (blocksBullet(tileAt(state, nx, ny))) {
        if (bullet.bounces <= 0) {
          remove.add(bullet.id);
          state.events.push({ type: "poof", x: bullet.x, y: bullet.y });
          break;
        }
        const hitX = blocksBullet(tileAt(state, nx, bullet.y));
        const hitY = blocksBullet(tileAt(state, bullet.x, ny));
        if (hitX && !hitY) bullet.vx = -bullet.vx;
        else if (hitY && !hitX) bullet.vy = -bullet.vy;
        else {
          bullet.vx = -bullet.vx;
          bullet.vy = -bullet.vy;
        }
        bullet.bounces -= 1;
        bullet.bounced = true;
        state.events.push({ type: "bounce", x: bullet.x, y: bullet.y });
        continue;
      }
      bullet.x = nx;
      bullet.y = ny;
      // Treffer auf Panzer
      for (const tank of state.tanks) {
        if (!tank.alive) continue;
        if (tank.id === bullet.owner && !bullet.bounced && bullet.age < SELF_SAFE) continue;
        if (Math.hypot(tank.x - bullet.x, tank.y - bullet.y) < TANK_R + BULLET_R) {
          destroyTank(state, tank);
          remove.add(bullet.id);
          break;
        }
      }
      if (remove.has(bullet.id)) break;
      // Treffer auf Mine
      for (const mine of state.mines) {
        if (!mine.exploded && Math.hypot(mine.x - bullet.x, mine.y - bullet.y) < 0.3) {
          mine.fuse = 0;
          remove.add(bullet.id);
          break;
        }
      }
    }
  }
  // Kugeln heben sich gegenseitig auf
  const list = state.bullets.filter((b) => !remove.has(b.id));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (!remove.has(a.id) && !remove.has(b.id) && Math.hypot(a.x - b.x, a.y - b.y) < BULLET_R * 2.4) {
        remove.add(a.id);
        remove.add(b.id);
        state.events.push({ type: "poof", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
  }
  if (remove.size) state.bullets = state.bullets.filter((b) => !remove.has(b.id));
}

function destroyTank(state, tank) {
  if (!tank.alive) return;
  tank.alive = false;
  state.events.push({ type: "destroyed", x: tank.x, y: tank.y, tankType: tank.type, team: tank.team });
}

// ---------- Minen ----------

function layMine(state, tank) {
  const spec = TYPES[tank.type];
  const own = state.mines.filter((m) => m.owner === tank.id && !m.exploded).length;
  if (own >= spec.maxMines) return false;
  if (state.mines.some((m) => !m.exploded && Math.hypot(m.x - tank.x, m.y - tank.y) < 0.8)) return false;
  state.mines.push({ id: state.nextId++, owner: tank.id, team: tank.team, x: tank.x, y: tank.y, age: 0, fuse: MINE_FUSE, exploded: false });
  state.events.push({ type: "mine", x: tank.x, y: tank.y });
  return true;
}

function updateMines(state, dt) {
  for (const mine of state.mines) {
    if (mine.exploded) continue;
    mine.age += dt;
    mine.fuse -= dt;
    if (mine.age > MINE_ARM) {
      // Gegner in der Nähe lösen aus
      const near = state.tanks.some((t) => t.alive && t.team !== mine.team && Math.hypot(t.x - mine.x, t.y - mine.y) < MINE_TRIGGER);
      if (near) mine.fuse = Math.min(mine.fuse, 0);
    }
  }
  // Explosionen (auch Kettenreaktionen) in derselben Runde
  let again = true;
  while (again) {
    again = false;
    for (const mine of state.mines) {
      if (mine.exploded || mine.fuse > 0) continue;
      mine.exploded = true;
      again = true;
      explode(state, mine.x, mine.y);
    }
  }
  state.mines = state.mines.filter((m) => !m.exploded);
}

function explode(state, x, y) {
  state.events.push({ type: "explosion", x, y });
  for (const tank of state.tanks) {
    if (tank.alive && Math.hypot(tank.x - x, tank.y - y) < MINE_BLAST) destroyTank(state, tank);
  }
  state.bullets = state.bullets.filter((b) => Math.hypot(b.x - x, b.y - y) >= MINE_BLAST);
  for (const mine of state.mines) {
    if (!mine.exploded && Math.hypot(mine.x - x, mine.y - y) < MINE_BLAST) mine.fuse = 0;
  }
  for (let ty = Math.floor(y - MINE_BLAST); ty <= Math.floor(y + MINE_BLAST); ty += 1) {
    for (let tx = Math.floor(x - MINE_BLAST); tx <= Math.floor(x + MINE_BLAST); tx += 1) {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      if (state.tiles[ty * W + tx] === TILE.BOX && Math.hypot(tx + 0.5 - x, ty + 0.5 - y) < MINE_BLAST + 0.2) {
        state.tiles[ty * W + tx] = TILE.EMPTY;
        state.events.push({ type: "box", x: tx + 0.5, y: ty + 0.5, tx, ty });
      }
    }
  }
}

// ---------- KI ----------

/**
 * Flugbahn einer Kugel vorausrechnen. Gibt zurück, welchen Panzer sie zuerst treffen würde
 * (oder null) und die Eckpunkte der Bahn.
 */
export function traceShot(state, shooter, angle, bulletSpeed, bounces, maxLength = 32) {
  let x = shooter.x + Math.cos(angle) * BARREL;
  let y = shooter.y + Math.sin(angle) * BARREL;
  let vx = Math.cos(angle);
  let vy = Math.sin(angle);
  const points = [[shooter.x, shooter.y], [x, y]];
  if (blocksBullet(tileAt(state, x, y))) return { hit: null, points };
  let left = bounces;
  let bounced = false;
  const stepLen = 0.08;
  for (let travelled = 0; travelled < maxLength; travelled += stepLen) {
    const nx = x + vx * stepLen;
    const ny = y + vy * stepLen;
    if (blocksBullet(tileAt(state, nx, ny))) {
      if (left <= 0) break;
      const hitX = blocksBullet(tileAt(state, nx, y));
      const hitY = blocksBullet(tileAt(state, x, ny));
      if (hitX && !hitY) vx = -vx;
      else if (hitY && !hitX) vy = -vy;
      else {
        vx = -vx;
        vy = -vy;
      }
      left -= 1;
      bounced = true;
      points.push([x, y]);
      continue;
    }
    x = nx;
    y = ny;
    const age = travelled / bulletSpeed;
    for (const tank of state.tanks) {
      if (!tank.alive) continue;
      if (tank.id === shooter.id && !bounced && age < SELF_SAFE) continue;
      if (Math.hypot(tank.x - x, tank.y - y) < TANK_R + BULLET_R + 0.05) {
        points.push([x, y]);
        return { hit: tank, points };
      }
    }
  }
  points.push([x, y]);
  return { hit: null, points };
}

function thinkEnemy(state, tank, dt, rng) {
  const spec = TYPES[tank.type];
  const ai = tank.ai;
  const target = player(state);
  tank.cooldown = Math.max(0, tank.cooldown - dt);
  ai.think -= dt;

  if (ai.think <= 0 && target?.alive) {
    ai.think = spec.think * (0.8 + rng() * 0.4);
    planAim(state, tank, target, spec, rng);
    if (spec.speed > 0) planMove(state, tank, target, spec, rng);
  }

  // Turm drehen
  const diff = angleDiff(ai.aim, tank.turret);
  tank.turret += Math.sign(diff) * Math.min(Math.abs(diff), spec.turretSpeed * dt);

  // Schießen, wenn der Turm steht und der Schuss passt
  if (ai.solution && Math.abs(angleDiff(ai.aim, tank.turret)) < 0.05 && tank.cooldown <= 0 && bulletsOf(state, tank) < spec.maxBullets) {
    const check = traceShot(state, tank, tank.turret, spec.bulletSpeed, spec.bounces);
    if (check.hit && check.hit.team === "player") fire(state, tank, rng);
    else tank.cooldown = 0.15; // Bahn passt nicht mehr: kurz neu überlegen
  }

  // Minen legen
  if (spec.maxMines > 0) {
    ai.mineWait -= dt;
    if (ai.mineWait <= 0) {
      ai.mineWait = 2 + rng() * 3;
      const dist = target ? Math.hypot(target.x - tank.x, target.y - tank.y) : 99;
      if (dist < 8 && rng() < spec.mineChance) layMine(state, tank);
    }
  }

  if (spec.speed > 0) {
    driveTank(state, tank, steer(state, tank, spec), dt);
  }
}

/** Zielen: erst direkt (mit Vorhalt), sonst über einen Abpraller an der Wand */
function planAim(state, tank, target, spec, rng) {
  const dist = Math.hypot(target.x - tank.x, target.y - tank.y);
  const lead = (dist / spec.bulletSpeed) * spec.predict;
  const tx = target.x + target.vx * lead;
  const ty = target.y + target.vy * lead;
  const direct = Math.atan2(ty - tank.y, tx - tank.x);
  const hitsPlayer = (angle) => {
    const shot = traceShot(state, tank, angle, spec.bulletSpeed, spec.bounces);
    return shot.hit && shot.hit.team === "player";
  };
  const error = (rng() * 2 - 1) * spec.aimError;
  if (hitsPlayer(direct) || hitsPlayer(Math.atan2(target.y - tank.y, target.x - tank.x))) {
    ai(tank).aim = direct + error;
    ai(tank).solution = true;
    return;
  }
  if (spec.bank && spec.bounces > 0) {
    // Winkel absuchen; den nehmen, der dem Turm am nächsten liegt
    let best = null;
    const count = 90;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      if (hitsPlayer(angle)) {
        const turn = Math.abs(angleDiff(angle, tank.turret));
        if (!best || turn < best.turn) best = { angle, turn };
      }
    }
    if (best) {
      ai(tank).aim = best.angle + error * 0.5;
      ai(tank).solution = true;
      return;
    }
  }
  // kein Schuss möglich: Turm grob Richtung Spieler halten
  ai(tank).aim = direct + Math.sin(state.time * 0.7 + tank.id) * 0.5;
  ai(tank).solution = false;
}

const ai = (tank) => tank.ai;

/** Fahrplan: Kugeln ausweichen, Minen meiden, sonst zu einem Wegpunkt */
function planMove(state, tank, target, spec, rng) {
  const a = tank.ai;
  a.dodge = null;
  if (spec.dodge) {
    for (const bullet of state.bullets) {
      if (bullet.owner === tank.id && !bullet.bounced) continue;
      const speed = Math.hypot(bullet.vx, bullet.vy);
      const rx = tank.x - bullet.x;
      const ry = tank.y - bullet.y;
      const along = (rx * bullet.vx + ry * bullet.vy) / speed;
      if (along < 0 || along / speed > 1.4) continue;
      const cross = (rx * bullet.vy - ry * bullet.vx) / speed;
      if (Math.abs(cross) < 1) {
        // senkrecht zur Flugbahn weg, auf die freie Seite
        const side = cross >= 0 ? 1 : -1;
        let px = (-bullet.vy / speed) * side;
        let py = (bullet.vx / speed) * side;
        if (blocksTank(tileAt(state, tank.x + px * 0.9, tank.y + py * 0.9))) {
          px = -px;
          py = -py;
        }
        a.dodge = { x: px, y: py };
        break;
      }
    }
  }
  for (const mine of state.mines) {
    const d = Math.hypot(tank.x - mine.x, tank.y - mine.y);
    if (d < MINE_BLAST + 0.6 && (mine.team !== tank.team || mine.age > 0.5)) {
      a.dodge = { x: (tank.x - mine.x) / (d || 1), y: (tank.y - mine.y) / (d || 1) };
      if (d < 0.4) a.dodge = { x: Math.cos(tank.angle), y: Math.sin(tank.angle) };
      break;
    }
  }
  a.replan -= spec.think;
  const reached = a.path.length === 0;
  if (reached || a.replan <= 0) {
    a.replan = 1.5 + rng() * 2;
    const goal = pickWaypoint(state, tank, target, spec, rng);
    a.path = goal ? findPath(state, tank, goal) : [];
  }
}

function steer(state, tank, spec) {
  const a = tank.ai;
  if (a.dodge) return a.dodge;
  while (a.path.length) {
    const [px, py] = a.path[0];
    const dx = px - tank.x;
    const dy = py - tank.y;
    if (Math.hypot(dx, dy) < 0.25) {
      a.path.shift();
      continue;
    }
    // nicht in die Nähe eigener Minen fahren
    return { x: dx, y: dy };
  }
  return { x: 0, y: 0 };
}

function pickWaypoint(state, tank, target, spec, rng) {
  const tx0 = Math.floor(tank.x);
  const ty0 = Math.floor(tank.y);
  let best = null;
  for (let i = 0; i < 24; i += 1) {
    const x = Math.floor(tx0 + (rng() * 2 - 1) * 6);
    const y = Math.floor(ty0 + (rng() * 2 - 1) * 5);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (!tileFreeForTank(state, x, y)) continue;
    const dPlayer = target ? Math.hypot(x + 0.5 - target.x, y + 0.5 - target.y) : 10;
    let score = rng();
    if (spec.chase) score += 6 / (1 + dPlayer); // Jäger rückt näher
    if (spec.keepAway) score -= Math.abs(dPlayer - spec.keepAway) * 0.3;
    else if (dPlayer < 3) score -= 1; // nicht direkt vor den Spieler fahren
    if (!best || score > best.score) best = { x, y, score };
  }
  return best;
}

function tileFreeForTank(state, x, y) {
  return x >= 0 && y >= 0 && x < W && y < H && !blocksTank(state.tiles[y * W + x]);
}

/** Breitensuche über die Felder (8 Richtungen, keine Ecken schneiden) */
export function findPath(state, tank, goal) {
  const start = Math.floor(tank.y) * W + Math.floor(tank.x);
  const end = goal.y * W + goal.x;
  const prev = new Int32Array(W * H).fill(-1);
  prev[start] = start;
  const queue = [start];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === end) break;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!tileFreeForTank(state, nx, ny)) continue;
      if (dx && dy && (!tileFreeForTank(state, cx + dx, cy) || !tileFreeForTank(state, cx, cy + dy))) continue;
      const n = ny * W + nx;
      if (prev[n] !== -1) continue;
      prev[n] = cur;
      queue.push(n);
    }
  }
  if (prev[end] === -1) return [];
  const path = [];
  for (let cur = end; cur !== start; cur = prev[cur]) path.push([(cur % W) + 0.5, Math.floor(cur / W) + 0.5]);
  return path.reverse();
}
