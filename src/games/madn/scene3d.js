import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import "@fontsource/pinyon-script/latin-400.css";
import { HOME, MAX_SEATS, PIECES, SEGMENT, boardSize, currentSeat, legalMoves } from "./engine";
import { cellOf, layoutFor } from "./layout";

// 3D-Spielbrett mit three.js: Holzbrett, glänzende Figuren, die Feld für Feld hüpfen,
// und ein Würfel, der übers Brett geworfen wird und auf der gewürfelten Zahl liegen bleibt.

// Farben wie auf dem klassischen Brett: Rot, Blau, Grün, Gelb, Schwarz, Lila
const SEAT_CSS = ["#e3241b", "#1d6fd8", "#1c9a3c", "#f6d21a", "#1d1d1d", "#8b3fb3"];
const SEAT_COLORS = SEAT_CSS.map((c) => new THREE.Color(c).getHex());
const BOARD_YELLOW = "#f9e86a";
const INK = "#111111";
const SCRIPT_FONT = '"Pinyon Script", "Brush Script MT", cursive';
const DIE = 0.8;
const DIE_ROUND = 0.13;
const HOP_S = 0.17;
const THROW_S = 1.55;
const UP = new THREE.Vector3(0, 1, 0);
// Augenzahl je Würfelseite in der Reihenfolge +x, -x, +y, -y, +z, -z (Gegenseiten ergeben 7)
const FACE_VALUES = [3, 4, 1, 6, 2, 5];
const FACE_NORMALS = {
  3: new THREE.Vector3(1, 0, 0),
  4: new THREE.Vector3(-1, 0, 0),
  1: new THREE.Vector3(0, 1, 0),
  6: new THREE.Vector3(0, -1, 0),
  2: new THREE.Vector3(0, 0, 1),
  5: new THREE.Vector3(0, 0, -1)
};

const world = ([x, y], height = 0) => new THREE.Vector3(x, height, y);
// Kamerawinkel (um die Hochachse), damit ein Platz von seiner Armseite aufs Brett schaut
const viewAngle = (layout, seat) => Math.PI / 2 - (layout.armAngle[seat] ?? 0);
const rand = (a, b) => a + Math.random() * (b - a);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function makeCanvas(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return [canvas, canvas.getContext("2d")];
}

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/** Bedruckte Oberseite im Stil des klassischen Bretts: gelb, weiße Felder, A/B/a–d, Pfeile, Schriftzug */
function drawSurface(layout, activeSeats) {
  const size = 2048;
  const [canvas, ctx] = makeCanvas(size);
  const extent = layout.extent;
  const unit = size / (extent * 2);
  const px = (v) => (v + extent) * unit;
  const P = ([x, y]) => [px(x), px(y)];
  const faded = (seat) => !activeSeats.has(seat);
  const textOn = (seat) => (seat === 3 ? INK : "#ffffff");
  const upright = (seat) => layout.armAngle[seat] - Math.PI / 2;

  ctx.fillStyle = BOARD_YELLOW;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 7000; i += 1) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "150,120,20" : "255,255,255"},${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, rand(1, 4), rand(1, 4));
  }

  // Rahmenlinie
  ctx.strokeStyle = INK;
  ctx.lineWidth = unit * 0.06;
  if (layout.shape === "hexagon") hexPath(ctx, size / 2, size / 2, (extent - 0.35) * unit);
  else {
    ctx.beginPath();
    ctx.rect(unit * 0.3, unit * 0.3, size - unit * 0.6, size - unit * 0.6);
  }
  ctx.stroke();

  // Laufweg als dicke schwarze Verbindungen
  ctx.strokeStyle = INK;
  ctx.lineWidth = unit * 0.1;
  ctx.lineJoin = "round";
  ctx.beginPath();
  layout.path.forEach((cell, i) => {
    const [x, y] = P(cell);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();

  const letter = (text, x, y, seat, radius, angle) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = textOn(seat);
    ctx.font = `700 ${radius * 1.3}px Barlow, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, radius * 0.08);
    ctx.restore();
  };

  const field = (cell, fill, radius, alpha = 1) => {
    const [x, y] = P(cell);
    const r = radius * unit;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // leichte Mulde
    const hole = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.2, x, y, r);
    hole.addColorStop(0, "rgba(255,255,255,0.18)");
    hole.addColorStop(0.7, "rgba(0,0,0,0)");
    hole.addColorStop(1, "rgba(0,0,0,0.16)");
    ctx.fillStyle = hole;
    ctx.fill();
    ctx.lineWidth = unit * 0.055;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
    return [x, y, r];
  };

  layout.path.forEach((cell, i) => {
    const seat = i % SEGMENT === 0 ? i / SEGMENT : null;
    if (seat === null) {
      field(cell, "#ffffff", 0.38);
      return;
    }
    const alpha = faded(seat) ? 0.35 : 1;
    const [x, y, r] = field(cell, SEAT_CSS[seat], 0.38, alpha);
    ctx.globalAlpha = alpha;
    letter("A", x, y, seat, r, upright(seat));
    ctx.globalAlpha = 1;
  });

  layout.goals.forEach((cells, seat) => cells.forEach((cell, i) => {
    const alpha = faded(seat) ? 0.3 : 1;
    const [x, y, r] = field(cell, SEAT_CSS[seat], 0.3, alpha);
    ctx.globalAlpha = alpha;
    letter("abcd"[i], x, y, seat, r, upright(seat));
    ctx.globalAlpha = 1;
  }));

  layout.houses.forEach((cells, seat) => {
    const alpha = faded(seat) ? 0.3 : 1;
    cells.forEach((cell) => field(cell, SEAT_CSS[seat], 0.34, alpha));
    const cx = cells.reduce((sum, c) => sum + c[0], 0) / cells.length;
    const cy = cells.reduce((sum, c) => sum + c[1], 0) / cells.length;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px(cx), px(cy));
    ctx.rotate(upright(seat));
    ctx.fillStyle = INK;
    ctx.font = `800 ${unit * 0.32}px Barlow, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("B", 0, 0);
    ctx.restore();
  });

  // Pfeile mit Federn neben jedem Startfeld zeigen die Laufrichtung
  layout.armAngle.forEach((angle, seat) => {
    const start = layout.path[seat * SEGMENT];
    const next = layout.path[seat * SEGMENT + 1];
    const dx = next[0] - start[0];
    const dy = next[1] - start[1];
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    // seitlich nach außen, weg vom eigenen Ziel
    const goal = layout.goals[seat][0];
    let nx = -uy;
    let ny = ux;
    if ((goal[0] - start[0]) * nx + (goal[1] - start[1]) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const ax = start[0] + nx * 0.75;
    const ay = start[1] + ny * 0.75;
    const tail = [px(ax - ux * 0.35), px(ay - uy * 0.35)];
    const hx = px(ax + ux * 1.25);
    const hy = px(ay + uy * 1.25);
    ctx.save();
    ctx.globalAlpha = faded(seat) ? 0.35 : 1;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = unit * 0.035;
    ctx.beginPath();
    ctx.moveTo(tail[0], tail[1]);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    const s = unit * 0.16;
    ctx.beginPath();
    ctx.moveTo(hx + ux * s * 0.6, hy + uy * s * 0.6);
    ctx.lineTo(hx - ux * s + nx * s * 0.5, hy - uy * s + ny * s * 0.5);
    ctx.lineTo(hx - ux * s - nx * s * 0.5, hy - uy * s - ny * s * 0.5);
    ctx.closePath();
    ctx.fill();
    for (let f = 0; f < 3; f += 1) {
      const fx = tail[0] + ux * unit * (0.05 + f * 0.1);
      const fy = tail[1] + uy * unit * (0.05 + f * 0.1);
      ctx.beginPath();
      ctx.moveTo(fx + (nx - ux) * unit * 0.11, fy + (ny - uy) * unit * 0.11);
      ctx.lineTo(fx, fy);
      ctx.lineTo(fx + (-nx - ux) * unit * 0.11, fy + (-ny - uy) * unit * 0.11);
      ctx.stroke();
    }
    ctx.restore();
  });

  // Schriftzug
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  layout.words.forEach(({ text, at, size: scale = 1 }) => {
    ctx.font = `${unit * 0.95 * scale}px ${SCRIPT_FONT}`;
    ctx.fillText(text, px(at[0]), px(at[1]));
  });
  return canvas;
}

function drawWood() {
  const [canvas, ctx] = makeCanvas(512);
  const g = ctx.createLinearGradient(0, 0, 512, 0);
  g.addColorStop(0, "#5a3416");
  g.addColorStop(0.5, "#6e4220");
  g.addColorStop(1, "#4f2d12");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 70; i += 1) {
    const y = Math.random() * 512;
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? "30,15,5" : "150,95,50"},${rand(0.08, 0.25)})`;
    ctx.lineWidth = rand(0.6, 2.4);
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) ctx.lineTo(x, y + Math.sin(x / rand(40, 90) + i) * rand(1, 5));
    ctx.stroke();
  }
  return canvas;
}

function drawDieFace(value) {
  const [canvas, ctx] = makeCanvas(256);
  const g = ctx.createRadialGradient(100, 90, 20, 128, 128, 200);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#ebe8df");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const spots = {
    1: [[2, 2]],
    2: [[1, 1], [3, 3]],
    3: [[1, 1], [2, 2], [3, 3]],
    4: [[1, 1], [3, 1], [1, 3], [3, 3]],
    5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
    6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]]
  }[value];
  spots.forEach(([x, y]) => {
    const cx = 32 + (x - 1) * 96;
    const cy = 32 + (y - 1) * 96;
    const r = value === 1 ? 30 : 24;
    const pip = ctx.createRadialGradient(cx + r * 0.3, cy + r * 0.35, r * 0.1, cx, cy, r);
    pip.addColorStop(0, value === 1 ? "#d9302a" : "#3a3a3a");
    pip.addColorStop(1, value === 1 ? "#7a120e" : "#0d0d0d");
    ctx.fillStyle = pip;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  });
  return canvas;
}

function drawGlow() {
  const [canvas, ctx] = makeCanvas(256);
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return canvas;
}

/** Klassische Spielfigur als Drehkörper */
function pieceGeometry() {
  const profile = [
    [0, 0], [0.33, 0], [0.345, 0.03], [0.335, 0.075], [0.28, 0.12], [0.22, 0.2],
    [0.175, 0.32], [0.14, 0.44], [0.12, 0.52], [0.175, 0.555], [0.185, 0.58], [0.15, 0.605],
    [0.1, 0.625], [0.085, 0.645]
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.LatheGeometry(profile, 48);
  const head = new THREE.SphereGeometry(0.165, 40, 24);
  head.translate(0, 0.77, 0);
  return [body, head];
}

export class BoardScene {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.pieces = [];
    this.seatsKey = "";
    this.lastRollN = undefined;
    this.state = { movable: null, canRoll: false, waiting: false, turnSeat: 0 };
    this.hovered = null;
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = "madn-canvas";
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = this.envMap;
    scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.camera.position.set(0, 14, 13);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = 1.2;
    this.controls.rotateSpeed = 0.7;
    this.viewTheta = 0;
    this.viewTween = null;

    this.layout = layoutFor(4);
    this.buildLights();
    this.buildStatic();
    this.buildBoard();
    this.buildPieces();
    this.buildDie();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setView(0, true);
    // Schreibschrift nachladen und Brett dann neu zeichnen
    document.fonts?.load(`100px ${SCRIPT_FONT}`).then(() => {
      if (!this.disposed && this.activeSeats) this.setSurface(this.activeSeats, true);
    }).catch(() => {});

    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff4e6, 0x3a2a1a, 0.7));
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
    sun.position.set(7, 16, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -12;
    s.right = 12;
    s.top = 12;
    s.bottom = -12;
    s.near = 1;
    s.far = 40;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 4;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x9fc3ff, 0.6);
    rim.position.set(-8, 6, -10);
    this.scene.add(rim);
  }

  /** Teile, die für beide Bretter gleich sind */
  buildStatic() {
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.ShadowMaterial({ opacity: 0.4 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const wood = canvasTexture(drawWood());
    wood.wrapS = THREE.RepeatWrapping;
    wood.wrapT = THREE.RepeatWrapping;
    this.woodMaterial = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.5, metalness: 0.05 });
    this.surfaceMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
    this.glowTexture = canvasTexture(drawGlow());

    // Zielmarke beim Zeigen auf eine Figur
    this.ringGeometry = new THREE.RingGeometry(0.4, 0.56, 48);
    this.ringGeometry.rotateX(-Math.PI / 2);
    this.targetRing = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.targetRing.visible = false;
    this.scene.add(this.targetRing);
  }

  /** Holzplatte, bedruckte Fläche und Hausleuchten für das aktuelle Layout */
  buildBoard() {
    if (this.boardGroup) {
      this.scene.remove(this.boardGroup);
      this.boardGroup.traverse((object) => {
        object.geometry?.dispose();
        if (object.material && object.material !== this.woodMaterial && object.material !== this.surfaceMaterial) object.material.dispose();
      });
    }
    const layout = this.layout;
    const group = new THREE.Group();
    const extent = layout.extent;
    let slab;
    let surface;
    if (layout.shape === "hexagon") {
      slab = new THREE.Mesh(new THREE.CylinderGeometry(extent + 0.35, extent + 0.35, 0.5, 6), this.woodMaterial);
      surface = new THREE.Mesh(new THREE.CircleGeometry(extent, 6, Math.PI / 6), this.surfaceMaterial);
    } else {
      slab = new THREE.Mesh(new RoundedBoxGeometry(extent * 2 + 0.6, 0.5, extent * 2 + 0.6, 4, 0.22), this.woodMaterial);
      surface = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2, extent * 2), this.surfaceMaterial);
    }
    slab.position.y = -0.25;
    slab.receiveShadow = true;
    slab.castShadow = true;
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0.002;
    surface.receiveShadow = true;
    group.add(slab, surface);

    // Leuchten unter dem Haus des Spielers am Zug
    this.houseGlows = layout.houses.map((cells, seat) => {
      const material = new THREE.MeshBasicMaterial({ map: this.glowTexture, color: seat === 4 ? 0xffffff : SEAT_COLORS[seat], transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), material);
      glow.rotation.x = -Math.PI / 2;
      const cx = cells.reduce((sum, c) => sum + c[0], 0) / cells.length;
      const cy = cells.reduce((sum, c) => sum + c[1], 0) / cells.length;
      glow.position.copy(world([cx, cy], 0.01));
      group.add(glow);
      return glow;
    });
    this.scene.add(group);
    this.boardGroup = group;
    this.seatsKey = "";
  }

  setSurface(activeSeats, force = false) {
    this.activeSeats = activeSeats;
    const key = `${this.layout.board}:${[...activeSeats].sort().join(",")}`;
    if (key === this.seatsKey && !force) return;
    this.seatsKey = key;
    this.surfaceMaterial.map?.dispose();
    this.surfaceMaterial.map = canvasTexture(drawSurface(this.layout, activeSeats));
    this.surfaceMaterial.needsUpdate = true;
  }

  buildPieces() {
    const [body, head] = pieceGeometry();
    const hitGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 12);
    hitGeometry.translate(0, 0.55, 0);
    const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.ghostMaterials = SEAT_COLORS.map((color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghost = new THREE.Group();
    this.ghostBody = new THREE.Mesh(body, this.ghostMaterials[0]);
    this.ghostHead = new THREE.Mesh(head, this.ghostMaterials[0]);
    this.ghost.add(this.ghostBody, this.ghostHead);
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      this.pieces[seat] = [];
      for (let index = 0; index < PIECES; index += 1) {
        const material = new THREE.MeshPhysicalMaterial({
          color: SEAT_COLORS[seat],
          roughness: 0.22,
          metalness: 0,
          clearcoat: 1,
          clearcoatRoughness: 0.08,
          emissive: seat === 4 ? 0x9a9a9a : SEAT_COLORS[seat],
          emissiveIntensity: 0
        });
        const group = new THREE.Group();
        const figure = new THREE.Group();
        const b = new THREE.Mesh(body, material);
        const h = new THREE.Mesh(head, material);
        b.castShadow = h.castShadow = true;
        b.receiveShadow = h.receiveShadow = true;
        figure.add(b, h);
        const ring = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
        ring.position.y = 0.015;
        ring.visible = false;
        const hit = new THREE.Mesh(hitGeometry, hitMaterial);
        hit.userData = { seat, index };
        group.add(figure, ring, hit);
        group.visible = false;
        this.scene.add(group);
        this.pieces[seat][index] = { group, figure, ring, hit, material, progress: undefined, base: new THREE.Vector3(), anim: [], spin: 0 };
      }
    }
  }

  buildDie() {
    const materials = FACE_VALUES.map((value) => new THREE.MeshPhysicalMaterial({
      map: canvasTexture(drawDieFace(value)),
      roughness: 0.25,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
      emissive: 0xffffff,
      emissiveIntensity: 0
    }));
    this.dieMaterials = materials;
    const die = new THREE.Mesh(new RoundedBoxGeometry(DIE, DIE, DIE, 6, DIE_ROUND), materials);
    die.castShadow = true;
    die.receiveShadow = true;
    this.die = die;
    this.dieRest = { pos: new THREE.Vector3(2.5, 0, 2.5), quat: this.faceUp(6, 0.4) };
    die.position.copy(this.dieRest.pos);
    die.quaternion.copy(this.dieRest.quat);
    die.position.y = this.contactHeight(die.quaternion);
    this.scene.add(die);
    this.dieGlowColor = new THREE.Color();
    this.throwPlan = null;
  }

  faceUp(value, yaw) {
    const q = new THREE.Quaternion().setFromUnitVectors(FACE_NORMALS[value], UP);
    return new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(q);
  }

  /** Höhe des Würfelmittelpunkts, damit die tiefste (abgerundete) Ecke auf dem Brett liegt */
  contactHeight(quat) {
    const inner = DIE / 2 - DIE_ROUND;
    let min = Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i += 1) {
      v.set(i & 1 ? inner : -inner, i & 2 ? inner : -inner, i & 4 ? inner : -inner).applyQuaternion(quat);
      min = Math.min(min, v.y);
    }
    return -min + DIE_ROUND;
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    this.onPointerDown = (event) => {
      down = { x: event.clientX, y: event.clientY, t: performance.now() };
    };
    this.onPointerUp = (event) => {
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved > 10 || !quick) return;
      const hit = this.pick(event);
      if (hit === "die") this.callbacks.onRoll?.();
      else if (hit) this.callbacks.onPick?.(hit.index);
    };
    this.onPointerMove = (event) => {
      if (event.pointerType !== "mouse" || event.buttons) return;
      const hit = this.pick(event);
      el.style.cursor = hit ? "pointer" : "grab";
      this.setHovered(hit && hit !== "die" ? hit : null);
    };
    this.onPointerLeave = () => this.setHovered(null);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerleave", this.onPointerLeave);
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [];
    const { movable, canRoll, turnSeat } = this.state;
    if (canRoll && !this.throwPlan) targets.push(this.die);
    if (movable) movable.forEach((index) => targets.push(this.pieces[turnSeat][index].hit));
    if (!targets.length) return null;
    const hits = this.raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    return hits[0].object === this.die ? "die" : hits[0].object.userData;
  }

  setHovered(hit) {
    const key = hit ? `${hit.seat}-${hit.index}` : null;
    if (key === this.hoveredKey) return;
    this.hoveredKey = key;
    this.hovered = hit;
    this.updateGhost();
  }

  updateGhost() {
    const hit = this.hovered;
    const move = hit && this.moves?.find((m) => m.index === hit.index);
    if (!move || !this.state.movable?.has(hit.index)) {
      this.ghost.visible = false;
      this.targetRing.visible = false;
      return;
    }
    const pos = world(cellOf(this.layout, hit.seat, hit.index, move.to));
    this.ghost.position.copy(pos);
    this.ghostBody.material = this.ghostHead.material = this.ghostMaterials[hit.seat];
    this.ghost.visible = true;
    this.targetRing.position.copy(pos).setY(0.02);
    this.targetRing.material.color.setHex(SEAT_COLORS[hit.seat]);
    this.targetRing.visible = true;
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Abstand so wählen, dass das ganze Brett ins Bild passt
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const scale = (this.layout.extent / 5.7) * (this.layout.shape === "hexagon" ? 0.86 : 1);
    const distance = Math.max((6.2 * scale) / Math.tan(vfov / 2), (7.1 * scale) / Math.tan(hfov / 2));
    this.fitDistance = distance;
    this.controls.minDistance = distance * 0.55;
    this.controls.maxDistance = distance * 1.5;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.updateProjectionMatrix();
  }

  /** Kamera zur Seite eines Spielers drehen */
  setView(seat, instant = false) {
    const theta = viewAngle(this.layout, seat);
    const spherical = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    if (instant) {
      spherical.set(this.fitDistance ?? 20, this.layout.shape === "hexagon" ? 0.58 : 0.66, theta);
      this.camera.position.setFromSpherical(spherical).add(this.controls.target);
      this.camera.lookAt(this.controls.target);
      return;
    }
    let delta = theta - spherical.theta;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) < 0.01) return;
    this.viewTween = { from: spherical.theta, delta, phi: spherical.phi, radius: spherical.radius, start: this.time, duration: 1.1 };
  }

  /** Spielstand übernehmen. Wird bei jedem Rendern aufgerufen und tut nur, was sich geändert hat. */
  sync({ game, movable, viewSeat, waiting, canRoll }) {
    const board = boardSize(game);
    if (board !== this.layout.board) {
      // anderes Brett: neu aufbauen, Figuren neu setzen, Kamera neu ausrichten
      this.layout = layoutFor(board);
      this.buildBoard();
      this.pieces.flat().forEach((piece) => {
        piece.progress = undefined;
        piece.anim = [];
      });
      this.resize();
      if (this.viewSeat !== undefined) this.setView(this.viewSeat, true);
    }
    const active = new Set(game.players.map((p) => p.seat));
    this.setSurface(active);
    const turnSeat = game.phase === "over" ? -1 : currentSeat(game);
    this.state = { movable, canRoll, waiting, turnSeat };
    this.moves = movable ? legalMoves(game) : [];
    if (!movable && this.hovered) this.setHovered(null);
    else this.updateGhost();

    if (viewSeat !== undefined && viewSeat !== null && viewSeat !== this.viewSeat) {
      const first = this.viewSeat === undefined;
      this.viewSeat = viewSeat;
      this.setView(viewSeat, first);
    }

    const roll = game.lastRoll;
    if (this.lastRollN === undefined) {
      this.lastRollN = roll?.n ?? 0;
      if (roll) {
        this.dieRest.quat = this.faceUp(roll.value, 0.4);
        this.die.quaternion.copy(this.dieRest.quat);
        this.die.position.y = this.contactHeight(this.die.quaternion);
      }
    } else if (roll && roll.n !== this.lastRollN) {
      this.lastRollN = roll.n;
      this.throwDie(roll.value, roll.seat, roll.n);
    }

    // Figuren erst bewegen, wenn der Würfel liegt
    this.pending = { game, active };
    if (!this.throwPlan) this.syncPieces(game, active);
  }

  syncPieces(game, active) {
    const changes = [];
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      for (let index = 0; index < PIECES; index += 1) {
        const piece = this.pieces[seat][index];
        piece.group.visible = active.has(seat);
        if (!active.has(seat)) continue;
        const progress = game.pieces[seat][index];
        if (piece.progress === undefined) {
          piece.progress = progress;
          piece.base.copy(world(cellOf(this.layout, seat, index, progress)));
          piece.group.position.copy(piece.base);
          continue;
        }
        if (piece.progress !== progress) changes.push({ seat, index, piece, from: piece.progress, to: progress });
      }
    }
    if (!changes.length) return;
    // erst die ziehende Figur, dann geschlagene Figuren nach deren Ankunft
    let moverTime = 0;
    changes.filter((c) => c.to !== HOME).forEach((c) => {
      moverTime = Math.max(moverTime, this.planMove(c, 0));
    });
    changes.filter((c) => c.to === HOME).forEach((c) => this.planMove(c, Math.max(0, moverTime - 0.06)));
  }

  /** Bewegung einer Figur einplanen; gibt die Dauer zurück */
  planMove({ seat, index, piece, from, to }, delay) {
    piece.progress = to;
    const start = this.time + delay;
    const current = piece.anim.length ? piece.anim[piece.anim.length - 1].to.clone() : piece.group.position.clone().setY(0);
    piece.anim = [];
    const target = world(cellOf(this.layout, seat, index, to));
    let t = start;
    const push = (fromPos, toPos, height, duration, kind) => {
      piece.anim.push({ from: fromPos, to: toPos, height, start: t, duration, kind });
      t += duration;
    };
    if (this.reducedMotion) {
      push(current, target, 0.3, 0.25, "hop");
    } else if (to === HOME) {
      push(current, target, 2.6, 0.75, "fly");
    } else if (from === HOME || to < from) {
      push(current, target, 1.3, 0.5, "jump");
    } else {
      let prev = current;
      for (let p = from + 1; p <= to; p += 1) {
        const next = world(cellOf(this.layout, seat, index, p));
        push(prev, next, 0.42, HOP_S, p === to ? "land" : "hop");
        prev = next;
      }
    }
    piece.base.copy(target);
    return t - this.time;
  }

  throwDie(value, seat, n) {
    const layout = this.layout;
    const armAngle = layout.armAngle[seat] ?? 0;
    const out = new THREE.Vector3(Math.cos(armAngle), 0, Math.sin(armAngle));
    const side = new THREE.Vector3(-out.z, 0, out.x);
    // Werfer sitzt außen vor seinem Arm, der Würfel rollt auf eine freie Stelle auf der anderen Seite
    const startPos = out.clone().multiplyScalar(layout.extent + 1.7).addScaledVector(side, rand(-1.5, 1.5)).setY(2.6);
    const far = layout.rest.filter(([x, y]) => x * out.x + y * out.z < -0.5);
    const spots = far.length ? far : layout.rest;
    const [rx, ry] = spots[Math.floor(Math.random() * spots.length)];
    const endPos = new THREE.Vector3(rx + rand(-0.3, 0.3), 0, ry + rand(-0.3, 0.3));
    const dir = endPos.clone().sub(startPos).setY(0);
    const distance = dir.length();
    dir.normalize();
    const rollAxis = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const tumbleAxis = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
    const target = this.faceUp(value, rand(0, Math.PI * 2));

    // Bodenkontakte: erster Aufprall, dann immer kleinere Sprünge
    const land = 0.17;
    const bounces = [];
    let at = land;
    let dur = 0.19;
    while (dur > 0.03) {
      bounces.push({ start: at, duration: dur, height: 0.6 * (dur / 0.19) ** 2 });
      at += dur;
      dur *= 0.55;
    }
    const pickup = this.reducedMotion ? 0.01 : 0.28;
    this.throwPlan = {
      n,
      seat,
      startTime: this.time,
      pickup,
      duration: this.reducedMotion ? 0.35 : THROW_S,
      fromPos: this.die.position.clone(),
      fromQuat: this.die.quaternion.clone(),
      startPos,
      endPos,
      dir,
      distance,
      rollAxis,
      tumbleAxis,
      tumble: rand(2.5, 4) * Math.PI,
      target,
      land,
      bounces,
      nextImpact: 0
    };
  }

  dieAt(plan, u) {
    const horizontal = 1 - Math.pow(1 - u, 2.4);
    const d = plan.distance * horizontal;
    const pos = plan.startPos.clone().setY(0).addScaledVector(plan.dir, d);
    const radius = DIE * 0.6;
    const phi = d / radius - plan.distance / radius;
    const tumbleU = Math.min(1, u / 0.55);
    const psi = plan.tumble * (1 - Math.pow(1 - tumbleU, 2)) - plan.tumble;
    const quat = new THREE.Quaternion().setFromAxisAngle(plan.rollAxis, phi)
      .multiply(new THREE.Quaternion().setFromAxisAngle(plan.tumbleAxis, psi))
      .multiply(plan.target);
    let air = 0;
    if (u < plan.land) {
      const k = u / plan.land;
      air = plan.startPos.y * (1 - k * k);
    } else {
      const b = plan.bounces.find((x) => u >= x.start && u < x.start + x.duration);
      if (b) {
        const s = (u - b.start) / b.duration;
        air = 4 * b.height * s * (1 - s);
      }
    }
    pos.y = air + this.contactHeight(quat);
    return { pos, quat };
  }

  updateDie(dt) {
    const die = this.die;
    const plan = this.throwPlan;
    const { canRoll, waiting, turnSeat } = this.state;
    const glowTarget = canRoll && !plan ? 0.18 + 0.12 * Math.sin(this.time * 4) : 0;
    this.dieMaterials.forEach((m) => {
      m.emissiveIntensity += (glowTarget - m.emissiveIntensity) * Math.min(1, dt * 8);
      if (turnSeat >= 0) m.emissive.setHex(SEAT_COLORS[turnSeat]);
    });

    if (plan) {
      const elapsed = this.time - plan.startTime;
      if (elapsed < plan.pickup) {
        // Würfel hochnehmen und zum Werfer bringen
        const k = easeInOut(elapsed / plan.pickup);
        die.position.lerpVectors(plan.fromPos, plan.startPos, k);
        die.position.y += Math.sin(k * Math.PI) * 1.2;
        const first = this.dieAt(plan, 0).quat;
        die.quaternion.slerpQuaternions(plan.fromQuat, first, k);
        return;
      }
      const u = Math.min(1, (elapsed - plan.pickup) / plan.duration);
      const { pos, quat } = this.dieAt(plan, u);
      die.position.copy(pos);
      die.quaternion.copy(quat);
      const impacts = [plan.land, ...plan.bounces.map((b) => b.start + b.duration)];
      while (plan.nextImpact < impacts.length && u >= impacts[plan.nextImpact]) {
        this.callbacks.onImpact?.(Math.pow(0.55, plan.nextImpact));
        plan.nextImpact += 1;
      }
      if (u >= 1) {
        this.dieRest = { pos: pos.clone(), quat: quat.clone() };
        this.throwPlan = null;
        if (this.pending) this.syncPieces(this.pending.game, this.pending.active);
        this.callbacks.onSettled?.(plan.n);
      }
      return;
    }

    if (waiting && turnSeat >= 0) {
      // Würfel wird in der Hand geschüttelt, bis der Server die Zahl schickt
      const a = this.layout.armAngle[turnSeat] ?? 0;
      const hand = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(this.layout.extent + 0.9).setY(1.8);
      die.position.lerp(hand.add(new THREE.Vector3(Math.sin(this.time * 23) * 0.12, Math.sin(this.time * 31) * 0.1, 0)), Math.min(1, dt * 10));
      die.rotateX(dt * 9);
      die.rotateZ(dt * 7);
      return;
    }

    // ruhend: wieder an den Ruheplatz (z. B. nach abgebrochenem Wurf)
    die.position.lerp(this.dieRest.pos.clone().setY(this.contactHeight(this.dieRest.quat)), Math.min(1, dt * 6));
    die.quaternion.slerp(this.dieRest.quat, Math.min(1, dt * 6));
  }

  updatePieces() {
    const { movable, turnSeat } = this.state;
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      for (let index = 0; index < PIECES; index += 1) {
        const piece = this.pieces[seat][index];
        if (!piece.group.visible) continue;
        let spin = 0;
        if (piece.anim.length) {
          const step = piece.anim[0];
          if (this.time >= step.start) {
            const k = Math.min(1, (this.time - step.start) / step.duration);
            const e = step.kind === "fly" || step.kind === "jump" ? easeInOut(k) : k;
            piece.group.position.lerpVectors(step.from, step.to, e);
            piece.group.position.y = Math.sin(Math.PI * k) * step.height;
            if (step.kind === "fly") spin = k * Math.PI * 4;
            // kleine Stauchung beim Aufsetzen
            const squash = 1 - Math.max(0, 0.12 - Math.abs(k - 1) * 0.6) * (step.kind === "hop" ? 0.5 : 1);
            piece.figure.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
            if (k >= 1) {
              piece.anim.shift();
              if (!piece.anim.length) piece.figure.scale.set(1, 1, 1);
            }
          }
        } else {
          piece.group.position.lerp(piece.base, 0.25);
        }
        piece.figure.rotation.y = spin;

        const canMove = movable && seat === turnSeat && movable.has(index);
        const hovered = canMove && this.hovered?.seat === seat && this.hovered?.index === index;
        const lift = canMove && !piece.anim.length ? (hovered ? 0.32 : 0.1 + 0.08 * Math.sin(this.time * 5 + index)) : 0;
        piece.figure.position.y += (lift - piece.figure.position.y) * 0.2;
        piece.ring.visible = Boolean(canMove);
        if (canMove) {
          piece.ring.material.opacity = hovered ? 1 : 0.45 + 0.45 * Math.sin(this.time * 5 + index);
          const s = 1 + 0.08 * Math.sin(this.time * 5 + index);
          piece.ring.scale.set(s, 1, s);
          piece.ring.position.y = 0.015 - piece.group.position.y;
        }
        const glow = canMove ? (hovered ? 0.6 : 0.25 + 0.2 * Math.sin(this.time * 5 + index)) : 0;
        piece.material.emissiveIntensity = glow;
      }
    }
  }

  frame() {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, this.clock.getDelta());
    this.time += dt;

    if (this.viewTween) {
      const tw = this.viewTween;
      const k = Math.min(1, (this.time - tw.start) / tw.duration);
      const spherical = new THREE.Spherical(tw.radius, tw.phi, tw.from + tw.delta * easeInOut(k));
      this.camera.position.setFromSpherical(spherical).add(this.controls.target);
      if (k >= 1) this.viewTween = null;
    }
    this.controls.enabled = !this.viewTween;
    this.controls.update();

    this.houseGlows.forEach((glow, seat) => {
      const on = seat === this.state.turnSeat;
      const target = on ? 0.55 + 0.25 * Math.sin(this.time * 3) : 0;
      glow.material.opacity += (target - glow.material.opacity) * Math.min(1, dt * 5);
    });
    this.targetRing.material.opacity = 0.6 + 0.4 * Math.sin(this.time * 6);

    this.updateDie(dt);
    this.updatePieces();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    this.controls.dispose();
    this.scene.traverse((object) => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      materials.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    });
    this.envMap.dispose();
    this.renderer.dispose();
    el.remove();
  }
}

export function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    return false;
  }
}
