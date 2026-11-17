import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { H, MINE_BLAST, MINE_FUSE, TILE, TYPES, W } from "./engine";

// 3D-Darstellung von Panzerkiste: die Arena ist der Boden einer großen Holzkiste,
// darin Holzkisten, Pappkartons, Löcher und kleine Spielzeugpanzer.

const CX = W / 2;
const CY = H / 2;
const toWorld = (x, y, height = 0) => new THREE.Vector3(x - CX, height, y - CY);

function makeCanvas(w, h = w) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return [canvas, canvas.getContext("2d")];
}

function texture(canvas, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat !== 1) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}

const rand = (a, b) => a + Math.random() * (b - a);

function planks(ctx, w, h, base, count, vertical = false) {
  for (let i = 0; i < count; i += 1) {
    const c = new THREE.Color(base).offsetHSL(rand(-0.01, 0.01), rand(-0.05, 0.05), rand(-0.05, 0.05));
    ctx.fillStyle = `#${c.getHexString()}`;
    if (vertical) ctx.fillRect((i * w) / count, 0, w / count, h);
    else ctx.fillRect(0, (i * h) / count, w, h / count);
  }
  for (let i = 0; i < 260; i += 1) {
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? "70,40,15" : "255,230,190"},${rand(0.05, 0.15)})`;
    ctx.lineWidth = rand(0.5, 2);
    ctx.beginPath();
    if (vertical) {
      const x = Math.random() * w;
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + rand(-6, 6), h / 3, x + rand(-6, 6), (2 * h) / 3, x + rand(-4, 4), h);
    } else {
      const y = Math.random() * h;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w / 3, y + rand(-6, 6), (2 * w) / 3, y + rand(-6, 6), w, y + rand(-4, 4));
    }
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(50,28,10,0.55)";
  ctx.lineWidth = 3;
  for (let i = 1; i < count; i += 1) {
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo((i * w) / count, 0);
      ctx.lineTo((i * w) / count, h);
    } else {
      ctx.moveTo(0, (i * h) / count);
      ctx.lineTo(w, (i * h) / count);
    }
    ctx.stroke();
  }
}

function floorTexture() {
  const [canvas, ctx] = makeCanvas(1024);
  planks(ctx, 1024, 1024, "#d9b07a", 8, true);
  return texture(canvas);
}

function crateTexture() {
  const [canvas, ctx] = makeCanvas(256);
  planks(ctx, 256, 256, "#b9813f", 4);
  ctx.strokeStyle = "#5a3412";
  ctx.lineWidth = 22;
  ctx.strokeRect(11, 11, 234, 234);
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(20, 20);
  ctx.lineTo(236, 236);
  ctx.stroke();
  ctx.fillStyle = "#3a2410";
  [[22, 22], [234, 22], [22, 234], [234, 234]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  return texture(canvas);
}

function boxTexture() {
  const [canvas, ctx] = makeCanvas(256);
  ctx.fillStyle = "#c9a26a";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2000; i += 1) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "120,80,40" : "255,240,210"},${rand(0.03, 0.08)})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  ctx.fillStyle = "rgba(225,205,160,0.85)"; // Klebeband
  ctx.fillRect(108, 0, 40, 256);
  ctx.strokeStyle = "rgba(90,60,30,0.6)";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 252);
  ctx.fillStyle = "rgba(70,45,20,0.55)";
  ctx.font = "bold 34px Arial";
  ctx.fillText("↑↑", 30, 70);
  return texture(canvas);
}

function wallTexture() {
  const [canvas, ctx] = makeCanvas(1024, 128);
  planks(ctx, 1024, 128, "#a8723a", 2);
  return texture(canvas);
}

function glowTexture() {
  const [canvas, ctx] = makeCanvas(128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return texture(canvas);
}

function scorchTexture() {
  const [canvas, ctx] = makeCanvas(128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(20,12,5,0.75)");
  g.addColorStop(0.6, "rgba(30,18,8,0.35)");
  g.addColorStop(1, "rgba(30,18,8,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return texture(canvas);
}

export class PanzerScene {
  constructor(container) {
    this.container = container;
    this.meshes = new Map(); // id → Objekt
    this.effects = [];
    this.time = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = "pz-canvas";
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.45;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 200);
    this.textures = { crate: crateTexture(), box: boxTexture(), glow: glowTexture(), scorch: scorchTexture() };
    this.materials = {
      crate: new THREE.MeshStandardMaterial({ map: this.textures.crate, roughness: 0.75 }),
      box: new THREE.MeshStandardMaterial({ map: this.textures.box, roughness: 0.9 }),
      tread: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 }),
      barrel: new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.4, metalness: 0.5 }),
      bullet: new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffa040, emissiveIntensity: 1.2, roughness: 0.3 }),
      bulletFast: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x66ccff, emissiveIntensity: 1.6, roughness: 0.3 }),
      mine: new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5, metalness: 0.2 }),
      mineLight: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
      track: new THREE.MeshBasicMaterial({ color: 0x3b2410, transparent: true, opacity: 0.18, depthWrite: false }),
      scorch: new THREE.MeshBasicMaterial({ map: this.textures.scorch, transparent: true, depthWrite: false })
    };
    this.geometries = {
      crate: new RoundedBoxGeometry(1, 1, 1, 2, 0.04),
      box: new RoundedBoxGeometry(0.96, 0.8, 0.96, 2, 0.05),
      bullet: new THREE.CapsuleGeometry(0.07, 0.16, 4, 8),
      mine: new THREE.CylinderGeometry(0.24, 0.27, 0.1, 20),
      mineLight: new THREE.SphereGeometry(0.06, 10, 8),
      track: new THREE.PlaneGeometry(0.12, 0.36),
      scorch: new THREE.PlaneGeometry(1, 1),
      flash: new THREE.SphereGeometry(1, 20, 14)
    };
    this.geometries.bullet.rotateZ(Math.PI / 2);
    this.geometries.track.rotateX(-Math.PI / 2);
    this.geometries.scorch.rotateX(-Math.PI / 2);

    this.buildArena();
    this.buildAim();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  buildArena() {
    const scene = this.scene;
    scene.add(new THREE.HemisphereLight(0xfff3e0, 0x5a4030, 0.8));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.3);
    sun.position.set(-6, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 12, bottom: -12, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.8 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Wände der großen Kiste
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.7 });
    const wallH = 1.1;
    const t = 0.5;
    const walls = [
      [W + t * 2, wallH, t, 0, -CY - t / 2],
      [W + t * 2, wallH, t, 0, CY + t / 2],
      [t, wallH, H, -CX - t / 2, 0],
      [t, wallH, H, CX + t / 2, 0]
    ];
    walls.forEach(([w, h, d, x, z]) => {
      const wall = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.06), wallMat);
      wall.position.set(x, h / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      scene.add(wall);
    });

    this.tileGroup = new THREE.Group();
    scene.add(this.tileGroup);
    this.decals = new THREE.Group();
    scene.add(this.decals);
  }

  buildAim() {
    const points = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
    this.aimLine = new THREE.Line(points, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.55 }));
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);
    const ring = new THREE.RingGeometry(0.22, 0.3, 32);
    ring.rotateX(-Math.PI / 2);
    this.reticle = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
    this.scene.add(this.reticle);
  }

  /** Felder neu aufbauen (beim Levelstart und wenn ein Karton gesprengt wurde) */
  buildTiles(state) {
    this.tileGroup.clear();
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const tile = state.tiles[y * W + x];
        if (tile === TILE.CRATE) {
          const mesh = new THREE.Mesh(this.geometries.crate, this.materials.crate);
          mesh.position.copy(toWorld(x + 0.5, y + 0.5, 0.5));
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.tileGroup.add(mesh);
        } else if (tile === TILE.BOX) {
          const mesh = new THREE.Mesh(this.geometries.box, this.materials.box);
          mesh.position.copy(toWorld(x + 0.5, y + 0.5, 0.4));
          mesh.rotation.y = (((x * 7 + y * 3) % 5) - 2) * 0.03;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.tileGroup.add(mesh);
        } else if (tile === TILE.HOLE) {
          const hole = new THREE.Mesh(new THREE.CircleGeometry(0.46, 28), new THREE.MeshBasicMaterial({ color: 0x140c06 }));
          hole.rotation.x = -Math.PI / 2;
          hole.position.copy(toWorld(x + 0.5, y + 0.5, 0.004));
          const rim = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.5, 28), new THREE.MeshStandardMaterial({ color: 0x6b4520, roughness: 0.9 }));
          rim.rotation.x = -Math.PI / 2;
          rim.position.copy(toWorld(x + 0.5, y + 0.5, 0.005));
          this.tileGroup.add(hole, rim);
        }
      }
    }
  }

  /** Neues Level: alles Bewegliche entfernen und Felder bauen */
  reset(state) {
    for (const obj of this.meshes.values()) this.scene.remove(obj);
    this.meshes.clear();
    this.effects.forEach((e) => this.scene.remove(e.mesh));
    this.effects = [];
    this.decals.clear();
    this.buildTiles(state);
  }

  makeTank(tank) {
    const spec = TYPES[tank.type];
    const color = new THREE.Color(spec.color);
    const body = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15 });
    const dark = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.7), roughness: 0.5, metalness: 0.15 });
    const group = new THREE.Group();
    const hull = new THREE.Group();
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.78, 0.24, 0.56, 2, 0.06), body);
    base.position.y = 0.24;
    const left = new THREE.Mesh(new RoundedBoxGeometry(0.86, 0.2, 0.17, 2, 0.07), this.materials.tread);
    left.position.set(0, 0.11, 0.3);
    const right = left.clone();
    right.position.z = -0.3;
    const front = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.16, 0.5, 2, 0.04), dark);
    front.position.set(0.36, 0.3, 0);
    hull.add(base, left, right, front);
    const turret = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.17, 24), dark);
    dome.position.y = 0.44;
    const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 16), body);
    hatch.position.set(-0.05, 0.54, 0);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.5, 14), this.materials.barrel);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(0.37, 0.45, 0);
    turret.add(dome, hatch, barrel);
    group.add(hull, turret);
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    if (tank.team === "player") {
      // Leuchtring unter dem eigenen Panzer
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: this.textures.glow, color: 0xffa040, transparent: true, opacity: 0.35, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.01;
      group.add(glow);
    }
    hull.scale.setScalar(1.18);
    turret.scale.setScalar(1.18);
    group.userData = { hull, turret, barrel };
    this.scene.add(group);
    return group;
  }

  /** Spielzustand zeichnen. aim: Zielpunkt des Spielers (oder null) */
  render(state, dt, aim) {
    this.time += dt;
    const seen = new Set();

    for (const tank of state.tanks) {
      if (!tank.alive) continue;
      const key = `t${tank.id}`;
      seen.add(key);
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = this.makeTank(tank);
        this.meshes.set(key, mesh);
      }
      mesh.position.copy(toWorld(tank.x, tank.y));
      const { hull, turret, barrel } = mesh.userData;
      hull.rotation.y = -tank.angle;
      turret.rotation.y = -tank.turret;
      hull.position.y = tank.moving ? Math.abs(Math.sin(this.time * 30)) * 0.015 : 0;
      // Rückstoß des Rohrs
      barrel.position.x += (0.37 - barrel.position.x) * Math.min(1, dt * 10);
    }

    for (const bullet of state.bullets) {
      const key = `b${bullet.id}`;
      seen.add(key);
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = new THREE.Mesh(this.geometries.bullet, bullet.fast ? this.materials.bulletFast : this.materials.bullet);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.meshes.set(key, mesh);
      }
      mesh.position.copy(toWorld(bullet.x, bullet.y, 0.45));
      mesh.rotation.y = -Math.atan2(bullet.vy, bullet.vx);
    }

    for (const mine of state.mines) {
      const key = `m${mine.id}`;
      seen.add(key);
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = new THREE.Group();
        const disc = new THREE.Mesh(this.geometries.mine, this.materials.mine);
        disc.position.y = 0.05;
        disc.castShadow = true;
        const light = new THREE.Mesh(this.geometries.mineLight, this.materials.mineLight.clone());
        light.position.y = 0.12;
        mesh.add(disc, light);
        mesh.userData.light = light;
        this.scene.add(mesh);
        this.meshes.set(key, mesh);
      }
      mesh.position.copy(toWorld(mine.x, mine.y));
      // blinkt schneller, je näher die Explosion
      const rate = mine.fuse < 2.5 ? 12 : mine.age < 1 ? 2 : 3;
      mesh.userData.light.visible = Math.sin(this.time * rate * Math.PI) > -0.2 || mine.fuse > MINE_FUSE - 0.2;
    }

    for (const [key, mesh] of this.meshes) {
      if (!seen.has(key)) {
        this.scene.remove(mesh);
        this.meshes.delete(key);
      }
    }

    this.handleEvents(state);
    this.updateEffects(dt);
    this.updateAim(state, aim);
    this.renderer.render(this.scene, this.camera);
  }

  handleEvents(state) {
    for (const e of state.events) {
      if (e.type === "track") {
        const mark = new THREE.Mesh(this.geometries.track, this.materials.track);
        const pos = toWorld(e.x, e.y, 0.003);
        const side = new THREE.Vector3(-Math.sin(e.angle), 0, Math.cos(e.angle)).multiplyScalar(0.3);
        mark.rotation.y = -e.angle + Math.PI / 2;
        const a = mark.clone();
        a.position.copy(pos).add(side);
        mark.position.copy(pos).sub(side);
        this.decals.add(a, mark);
        while (this.decals.children.length > 700) this.decals.remove(this.decals.children[0]);
      } else if (e.type === "shot") {
        const tank = this.findShooter(e);
        if (tank) tank.userData.barrel.position.x = 0.25;
        this.flash(e.x, e.y, 0.45, 0.18, 0xffc060, 0.12);
      } else if (e.type === "bounce") {
        this.flash(e.x, e.y, 0.45, 0.12, 0xffe0a0, 0.1);
      } else if (e.type === "poof") {
        this.flash(e.x, e.y, 0.45, 0.22, 0xdddddd, 0.25);
      } else if (e.type === "destroyed") {
        this.flash(e.x, e.y, 0.4, 1.1, 0xff7a20, 0.6);
        this.flash(e.x, e.y, 0.5, 0.7, 0x333333, 1.2, true);
        this.scorch(e.x, e.y, 1.6);
      } else if (e.type === "explosion") {
        this.flash(e.x, e.y, 0.3, MINE_BLAST, 0xffa030, 0.55);
        this.flash(e.x, e.y, 0.5, MINE_BLAST * 0.7, 0x2a2a2a, 1.3, true);
        this.scorch(e.x, e.y, MINE_BLAST * 1.5);
      } else if (e.type === "box") {
        this.buildTiles(state);
        this.flash(e.x, e.y, 0.4, 0.8, 0xc9a26a, 0.5);
      }
    }
  }

  findShooter(e) {
    let best = null;
    let bestD = 1;
    for (const [key, mesh] of this.meshes) {
      if (!key.startsWith("t")) continue;
      const d = mesh.position.distanceTo(toWorld(e.x, e.y));
      if (d < bestD) {
        best = mesh;
        bestD = d;
      }
    }
    return best;
  }

  flash(x, y, height, radius, color, duration, smoke = false) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: smoke ? 0.5 : 0.9, depthWrite: false, blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(this.geometries.flash, material);
    mesh.position.copy(toWorld(x, y, height));
    mesh.scale.setScalar(radius * 0.3);
    this.scene.add(mesh);
    this.effects.push({ mesh, radius, duration, age: 0, smoke });
  }

  scorch(x, y, size) {
    const mark = new THREE.Mesh(this.geometries.scorch, this.materials.scorch);
    mark.position.copy(toWorld(x, y, 0.004));
    mark.scale.setScalar(size);
    mark.rotation.y = Math.random() * Math.PI;
    this.decals.add(mark);
  }

  updateEffects(dt) {
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      const k = fx.age / fx.duration;
      if (k >= 1) {
        this.scene.remove(fx.mesh);
        fx.mesh.material.dispose();
        return false;
      }
      const grow = fx.smoke ? 0.4 + k * 0.8 : 0.3 + Math.sqrt(k) * 0.7;
      fx.mesh.scale.setScalar(fx.radius * grow);
      if (fx.smoke) fx.mesh.position.y += dt * 0.8;
      fx.mesh.material.opacity = (fx.smoke ? 0.5 : 0.9) * (1 - k);
      return true;
    });
  }

  updateAim(state, aim) {
    const me = state.tanks.find((t) => t.team === "player" && t.alive);
    const show = Boolean(me && aim && state.status === "playing");
    this.aimLine.visible = show;
    this.reticle.visible = show;
    if (!show) return;
    const from = toWorld(me.x + Math.cos(me.turret) * 0.65, me.y + Math.sin(me.turret) * 0.65, 0.45);
    const to = toWorld(aim.x, aim.y, 0.45);
    this.aimLine.geometry.setFromPoints([from, to]);
    this.aimLine.computeLineDistances();
    this.reticle.position.copy(toWorld(aim.x, aim.y, 0.02));
    this.reticle.rotation.y = this.time * 1.5;
  }

  /** Bildschirmpunkt (clientX/Y) → Punkt in der Arena (Spielkoordinaten) */
  screenToArena(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.45);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x + CX, y: hit.z + CY };
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;
    // Kamera fast senkrecht von oben, leicht von vorne: ganze Kiste muss ins Bild
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const distance = Math.max((H / 2 + 1.3) / Math.tan(vfov / 2), (W / 2 + 0.9) / Math.tan(hfov / 2));
    const tilt = 0.32; // Neigung aus der Senkrechten
    this.camera.position.set(0, Math.cos(tilt) * distance, Math.sin(tilt) * distance);
    this.camera.lookAt(0, 0, 0.35);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    Object.values(this.textures).forEach((t) => t.dispose());
    this.envMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
