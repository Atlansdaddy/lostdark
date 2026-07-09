/**
 * TOWERLAB — viewer for the remnant-building generator (pure presentation).
 * A black mass with a few embers in it, not an interior: near-black clear,
 * warm dead-tech fixtures (ember/sodium) that flicker like failing power,
 * cold exterior night. View modes: TOWER orbit · SLICE (one floor + ghosted
 * floor below, step ▲▼) · EXPLODE (floors fanned apart). Vertical-edge
 * overlay (stairs white, climbs green, drops orange, ledges cyan), critical
 * ascent red, pulse probe, acceptance printed every regen.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Tower, TowerParams, TOWER_DEFAULTS, TCell, generateTower, runTowerAcceptance } from './TowerGen';

const app = document.getElementById('app')!;
const errBox = document.createElement('div');
errBox.style.cssText =
  'position:fixed;bottom:8px;left:8px;right:8px;z-index:99;color:#ff8080;font:10px/1.4 ui-monospace,monospace;' +
  'background:#200608ee;padding:6px 8px;border-radius:6px;white-space:pre-wrap;display:none;';
document.body.appendChild(errBox);
addEventListener('error', (e) => {
  errBox.style.display = 'block';
  errBox.textContent = `⚠ ${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}`;
});

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const COARSE = matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.2 : 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const VIBE_FOG = new THREE.FogExp2(0x030308, 0.05);
let vibe = false;
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 700);
camera.position.set(34, 40, 46);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 16, 0);

const ambient = new THREE.AmbientLight(0xffffff, 2.2);
scene.add(ambient);
scene.add(new THREE.HemisphereLight(0x141a2e, 0x05060a, 0.25));

function setVibe(on: boolean): void {
  vibe = on;
  scene.fog = on ? VIBE_FOG : null;
  scene.background = new THREE.Color(on ? 0x030308 : 0x0b0e14);
  ambient.intensity = on ? 0.22 : 2.2;
}

// Always-visible orientation ring (fog-immune).
const ring = new THREE.Mesh(
  new THREE.RingGeometry(3, 3.35, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8c3a, fog: false, side: THREE.DoubleSide }),
);
ring.position.y = 0.2;
scene.add(ring);

// --- State ------------------------------------------------------------------

const params: TowerParams = { ...TOWER_DEFAULTS, seed: 20250703 };
let tower: Tower;
let mode: 'tower' | 'slice' | 'explode' = 'tower';
let slice = 0;
let group = new THREE.Group();
scene.add(group);
const overlay = new THREE.Group();
scene.add(overlay);
const toggles = { edges: false, crit: false, lightHeat: false };
const dynLights: { light: THREE.PointLight; phase: number; base: number }[] = [];

const probe = new THREE.PointLight(0xfff2c9, 1.7, 16, 1.6);
probe.visible = false;
scene.add(probe);
const probeMarker = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff2c9 }));
probeMarker.visible = false;
scene.add(probeMarker);
let probeArmed = false;

// --- Materials / geometries ----------------------------------------------------

const lambert = (c: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color: c });
const ghostMat = new THREE.MeshLambertMaterial({ color: 0x666a78, transparent: true, opacity: 0.14 });
const MAT = {
  floor: new THREE.MeshLambertMaterial({ color: 0xffffff }),
  wall: new THREE.MeshLambertMaterial({ color: 0xffffff }),
  rubble: lambert(0x4a4640),
  stair: lambert(0x5f6672),
  ledge: lambert(0x3c414d),
  shaft: lambert(0x272b34),
  husk: lambert(0x3d4450),
  locker: new THREE.MeshBasicMaterial({ color: 0xffd28a }),
  glass: new THREE.MeshBasicMaterial({ color: 0x2c3a44, transparent: true, opacity: 0.7 }),
  cable: new THREE.MeshBasicMaterial({ color: 0x8de8a0 }),
  fixtureDead: lambert(0x23262e),
  fixtureLive: new THREE.MeshBasicMaterial({ color: 0xffb85c }),
  beacon: new THREE.MeshBasicMaterial({ color: 0x66201a }),
} as const;

const GEO = {
  slab: new THREE.BoxGeometry(1, 0.25, 1),
  wall: new THREE.BoxGeometry(1, 3, 1),
  rubble: new THREE.BoxGeometry(1, 1, 1), // scaled 0.4–0.9 per instance
  husk: new THREE.BoxGeometry(0.8, 1.1, 0.6),
  locker: new THREE.BoxGeometry(0.6, 1.8, 0.6),
  glass: new THREE.BoxGeometry(1.4, 0.06, 1.4),
  cable: new THREE.CylinderGeometry(0.05, 0.05, 3, 5),
  fixture: new THREE.BoxGeometry(0.5, 0.12, 0.5),
  beacon: new THREE.OctahedronGeometry(0.8, 0),
  spawn: new THREE.TetrahedronGeometry(0.28),
} as const;
const SPAWN_COLOR: Record<string, number> = { skitter: 0x5c6470, snuffer: 0xb05050, warden: 0xff5c2a };

// --- Build ------------------------------------------------------------------------

function yOf(f: number): number {
  return mode === 'explode' ? f * 9 : f * 3;
}

function floorVisible(f: number): boolean {
  if (mode !== 'slice') return true;
  return f === slice || f === slice - 1;
}

function rebuild(newSeed: boolean): void {
  if (newSeed) params.seed = (Math.random() * 1e9) | 0;
  tower = generateTower(params);
  slice = Math.min(slice, tower.floors - 1);
  rebuildScene();
  updateHud();
}

function rebuildScene(): void {
  scene.remove(group);
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !Object.values(GEO).includes(m.geometry as never)) m.geometry.dispose();
  });
  for (const d of dynLights) scene.remove(d.light);
  dynLights.length = 0;
  group = new THREE.Group();
  scene.add(group);

  const { W, H, floors: F, layers, light } = tower;
  const cx0 = W / 2;
  const cy0 = H / 2;
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const q0 = new THREE.Quaternion();

  interface Bucket {
    geo: THREE.BufferGeometry;
    mat: THREE.Material;
    items: { x: number; y: number; z: number; sx: number; sy: number; sz: number; c?: THREE.Color }[];
  }
  const buckets = new Map<string, Bucket>();
  const put = (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, item: Bucket['items'][0]): void => {
    if (!buckets.has(key)) buckets.set(key, { geo, mat, items: [] });
    buckets.get(key)!.items.push(item);
  };

  for (let f = 0; f < F; f++) {
    if (!floorVisible(f)) continue;
    const ghost = mode === 'slice' && f === slice - 1;
    const L = layers[f];
    const yBase = yOf(f);
    const tintCool = f / F; // drifts cooler with altitude
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = L[y * W + x];
        if (c === TCell.VOID || c === TCell.HOLE) continue;
        const wx = x - cx0;
        const wz = y - cy0;
        const l = light[f][y * W + x];
        const shade = 0.25 + 0.75 * l;
        if (ghost) {
          if (c === TCell.WALL) put('gwall', GEO.wall, ghostMat, { x: wx, y: yBase + 1.5, z: wz, sx: 1, sy: 1, sz: 1 });
          else put('gslab', GEO.slab, ghostMat, { x: wx, y: yBase, z: wz, sx: 1, sy: 1, sz: 1 });
          continue;
        }
        switch (c) {
          case TCell.FLOOR: {
            const jitter = 0.94 + ((x * 31 + y * 17) % 12) / 100;
            put('floor', GEO.slab, MAT.floor, {
              x: wx, y: yBase, z: wz, sx: 1, sy: 1, sz: 1,
              c: new THREE.Color(0.5 * shade * jitter, (0.5 + 0.04 * tintCool) * shade * jitter, (0.55 + 0.12 * tintCool) * shade * jitter),
            });
            break;
          }
          case TCell.WALL:
            put('wall', GEO.wall, MAT.wall, {
              x: wx, y: yBase + 1.5, z: wz, sx: 1, sy: 1, sz: 1,
              c: new THREE.Color(0.2 + 0.35 * l, 0.21 + 0.33 * l, 0.26 + 0.3 * l),
            });
            break;
          case TCell.RUBBLE: {
            const h = 0.4 + ((x * 13 + y * 29 + f * 7) % 6) / 10;
            put('rubble', GEO.rubble, MAT.rubble, { x: wx, y: yBase + h / 2, z: wz, sx: 1, sy: h, sz: 1 });
            break;
          }
          case TCell.STAIR:
            put('stair', GEO.wall, MAT.stair, { x: wx, y: yBase + 1.5, z: wz, sx: 1, sy: 1, sz: 1 });
            break;
          case TCell.LEDGE:
            put('ledge', GEO.slab, MAT.ledge, { x: wx, y: yBase + 0.4, z: wz, sx: 1, sy: 1, sz: 1 });
            break;
          case TCell.SHAFT:
            put('shaft', GEO.wall, MAT.shaft, { x: wx, y: yBase + 1.5, z: wz, sx: 1, sy: 1, sz: 1 });
            break;
        }
      }
    }
  }
  // props + spawns
  for (const p2 of tower.props) {
    if (!floorVisible(p2.floor) || (mode === 'slice' && p2.floor === slice - 1)) continue;
    const wx = p2.x - cx0;
    const wz = p2.y - cy0;
    const yb = yOf(p2.floor);
    switch (p2.kind) {
      case 'husk':
        put('husk', GEO.husk, MAT.husk, { x: wx, y: yb + 0.55, z: wz, sx: p2.scale, sy: p2.scale, sz: p2.scale });
        break;
      case 'locker':
        put('locker', GEO.locker, MAT.locker, { x: wx, y: yb + 0.9, z: wz, sx: 1, sy: 1, sz: 1 });
        break;
      case 'glass':
        put('glass', GEO.glass, MAT.glass, { x: wx, y: yb + 0.16, z: wz, sx: p2.scale, sy: 1, sz: p2.scale });
        break;
      case 'cable':
        put('cable', GEO.cable, MAT.cable, { x: wx, y: yb - 1.5, z: wz, sx: 1, sy: 1, sz: 1 });
        break;
      case 'fixture': {
        const em = tower.emitters.find((e) => e.kind === 'fixture' && e.floor === p2.floor && e.x === p2.x && e.y === p2.y);
        put(em?.alive ? 'fixL' : 'fixD', GEO.fixture, em?.alive ? MAT.fixtureLive : MAT.fixtureDead, {
          x: wx, y: yb + 2.8, z: wz, sx: 1, sy: 1, sz: 1,
        });
        break;
      }
      case 'beacon':
        put('beacon', GEO.beacon, MAT.beacon, { x: wx, y: yb + 1.4, z: wz, sx: p2.scale, sy: p2.scale, sz: p2.scale });
        break;
      default:
        break;
    }
  }
  for (const sp of tower.spawns) {
    if (!floorVisible(sp.floor) || (mode === 'slice' && sp.floor === slice - 1)) continue;
    put('spawn', GEO.spawn, new THREE.MeshBasicMaterial({ vertexColors: false, color: 0xffffff }), {
      x: sp.x - cx0, y: yOf(sp.floor) + 0.5, z: sp.y - cy0, sx: 1, sy: 1, sz: 1,
      c: new THREE.Color(SPAWN_COLOR[sp.tier]),
    });
  }

  for (const [, b] of buckets) {
    const inst = new THREE.InstancedMesh(b.geo, b.mat, b.items.length);
    for (let i = 0; i < b.items.length; i++) {
      const it = b.items[i];
      m4.compose(new THREE.Vector3(it.x, it.y, it.z), q0, new THREE.Vector3(it.sx, it.sy, it.sz));
      inst.setMatrixAt(i, m4);
      if (it.c) inst.setColorAt(i, col.copy(it.c));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.frustumCulled = false;
    group.add(inst);
  }

  // Dynamic lights ≤12: beacon first, then live fixtures farthest-point.
  const live = tower.emitters.filter((e) => e.intensity > 0 && floorVisible(e.floor));
  live.sort((a, b) => (b.kind === 'beacon' ? 1 : 0) - (a.kind === 'beacon' ? 1 : 0));
  const chosen: typeof live = [];
  while (chosen.length < (COARSE ? 5 : 12) && live.length) {
    let bi = 0;
    let bs = -1;
    for (let i = 0; i < live.length; i++) {
      let minD = Infinity;
      for (const c of chosen) {
        minD = Math.min(minD, Math.hypot(c.x - live[i].x, c.y - live[i].y) + Math.abs(c.floor - live[i].floor) * 6);
      }
      const sc = (live[i].kind === 'beacon' ? 4 : 1) * (chosen.length ? Math.min(minD, 30) : 1);
      if (sc > bs) {
        bs = sc;
        bi = i;
      }
    }
    chosen.push(live.splice(bi, 1)[0]);
  }
  for (const e of chosen) {
    const colHex = e.kind === 'beacon' ? 0x66201a : (e.x * 7 + e.y) % 2 ? 0xff8c3a : 0xffb85c;
    const L = new THREE.PointLight(colHex, e.intensity * 2, e.radius * 2.2, 1.7);
    L.position.set(e.x - cx0, yOf(e.floor) + 2.4, e.y - cy0);
    scene.add(L);
    dynLights.push({ light: L, phase: (e.x * 13 + e.y * 7 + e.floor * 31) % 97, base: e.intensity * 2 });
  }

  buildOverlay(cx0, cy0);
}

function buildOverlay(cx0: number, cy0: number): void {
  for (const ch of [...overlay.children]) {
    overlay.remove(ch);
    (ch as THREE.LineSegments).geometry?.dispose();
  }
  const KIND_COL: Record<string, number> = { stair: 0xffffff, climb: 0x4fc06a, drop: 0xff8c3a, ledge: 0x53e0ff, shaft: 0xcfa9ff };
  const groups: Record<string, number[]> = { stair: [], climb: [], drop: [], ledge: [], shaft: [] };
  const crit: number[] = [];
  for (const e of tower.vEdges) {
    if (e.collapsed) continue;
    const seg = [e.x - cx0, yOf(e.fromFloor) + 1, e.y - cy0, e.x - cx0, yOf(e.toFloor) + 1, e.y - cy0];
    groups[e.kind].push(...seg);
    if (e.isCritical) crit.push(...seg);
  }
  const edgesGroup = new THREE.Group();
  for (const [kind, pos] of Object.entries(groups)) {
    if (!pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    edgesGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: KIND_COL[kind], transparent: true, opacity: 0.9 })));
  }
  edgesGroup.name = 'edges';
  edgesGroup.visible = toggles.edges;
  overlay.add(edgesGroup);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(crit, 3));
  const critLines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xff3030 }));
  critLines.name = 'crit';
  critLines.visible = toggles.crit;
  overlay.add(critLines);
}

// --- Panel / HUD ---------------------------------------------------------------

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:10;display:flex;flex-direction:column;gap:5px;max-height:92vh;overflow-y:auto;';
document.body.appendChild(panel);
const mkBtn = (label: string, onTap: (b: HTMLButtonElement) => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'min-width:104px;padding:8px 9px;border:1px solid #52402a;border-radius:8px;background:#160f0acc;' +
    'color:#ffb85c;font:11px ui-monospace,Menlo,monospace;touch-action:manipulation;text-align:left;';
  b.addEventListener('click', () => onTap(b));
  panel.appendChild(b);
  return b;
};
const lit = (b: HTMLButtonElement, on: boolean): void => {
  b.style.background = on ? '#7a4a1acc' : '#160f0acc';
};
const mkSlider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): void => {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'background:#160f0acc;border:1px solid #52402a;border-radius:8px;padding:5px 8px;color:#ffb85c;font:10px ui-monospace,monospace;';
  const lab = document.createElement('div');
  lab.textContent = `${label}: ${get()}`;
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String(step);
  inp.value = String(get());
  inp.style.width = '104px';
  inp.addEventListener('input', () => {
    set(Number(inp.value));
    lab.textContent = `${label}: ${inp.value}`;
  });
  inp.addEventListener('change', () => rebuild(false));
  wrap.appendChild(lab);
  wrap.appendChild(inp);
  panel.appendChild(wrap);
};

mkBtn('🎲 REGEN', () => rebuild(true));
mkBtn('📊 DATA', (b) => {
  hudOpen = !hudOpen;
  lit(b, hudOpen);
  updateHud();
});
mkBtn('VIBE: off', (b) => {
  setVibe(!vibe);
  b.textContent = vibe ? 'VIBE: on' : 'VIBE: off';
  lit(b, vibe);
});
mkBtn('MODE: TOWER', (b) => {
  mode = mode === 'tower' ? 'slice' : mode === 'slice' ? 'explode' : 'tower';
  b.textContent = `MODE: ${mode.toUpperCase()}`;
  rebuildScene();
  updateHud();
});
mkBtn('FLOOR ▲', () => {
  if (mode !== 'slice') return;
  slice = Math.min(tower.floors - 1, slice + 1);
  rebuildScene();
  updateHud();
});
mkBtn('FLOOR ▼', () => {
  if (mode !== 'slice') return;
  slice = Math.max(0, slice - 1);
  rebuildScene();
  updateHud();
});
const probeBtn = mkBtn('PROBE: off', (b) => {
  if (probe.visible) {
    probe.visible = false;
    probeMarker.visible = false;
    probeArmed = false;
  } else {
    probeArmed = true;
  }
  b.textContent = probe.visible ? 'PROBE: on' : probeArmed ? 'PROBE: tap' : 'PROBE: off';
  lit(b, probe.visible || probeArmed);
});
mkBtn('V-EDGES', (b) => {
  toggles.edges = !toggles.edges;
  overlay.getObjectByName('edges')!.visible = toggles.edges;
  lit(b, toggles.edges);
});
mkBtn('CRIT ASCENT', (b) => {
  toggles.crit = !toggles.crit;
  overlay.getObjectByName('crit')!.visible = toggles.crit;
  lit(b, toggles.crit);
});
mkBtn('VERIFY (slow)', (b) => {
  b.textContent = '…verifying';
  setTimeout(() => {
    updateHud(false);
    b.textContent = 'VERIFY (slow)';
  }, 30);
});
mkSlider('floors', 4, 16, 1, () => params.floorCount, (v) => (params.floorCount = v));
mkSlider('stairCollapse', 0, 0.8, 0.05, () => params.stairCollapse, (v) => (params.stairCollapse = v));
mkSlider('decayT1', 0.4, 0.7, 0.01, () => params.decayT1, (v) => (params.decayT1 = v));
mkSlider('decayT2', 0.55, 0.9, 0.01, () => params.decayT2, (v) => (params.decayT2 = v));
mkSlider('maxDarkRun', 8, 40, 1, () => params.maxDarkRun, (v) => (params.maxDarkRun = v));
mkSlider('decor', 0, 1, 0.1, () => params.decorDensity, (v) => (params.decorDensity = v));

let hudOpen = !COARSE; // phones start collapsed — the wall of text owns a 6" screen
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:8px;left:8px;z-index:10;color:#ffb85c;font:10px/1.45 ui-monospace,Menlo,monospace;' +
  'background:#0a0704d0;padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre-wrap;max-width:calc(100vw - 140px);';
document.body.appendChild(hud);

function updateHud(fast = true): void {
  const s = tower.stats;
  const acc = runTowerAcceptance(tower, fast);
  const full =
    `TOWERLAB  ${tower.name}  seed ${tower.params.seed}\n` +
    `${s.floors} floors · ${s.rooms} rooms · stairs collapsed ${s.stairSegmentsCollapsed} · holes ${s.holes} · climbs ${s.climbs} · ledges ${s.ledges}\n` +
    `ascent ${s.criticalAscent} · improv ${s.improvEdge || '—'} · caches ${s.caches} · lit ${(s.litFraction * 100).toFixed(0)}% · gen ${s.genMs.toFixed(0)}ms\n` +
    (mode === 'slice' ? `SLICE floor ${slice}\n` : '') +
    `— acceptance —\n` +
    acc.map((a) => `${a.pass ? '✓' : '✗'} ${a.name}: ${a.detail}`).join('\n') +
    `\nedges: white=stair green=climb orange=drop cyan=ledge violet=shaft · red=critical`;
  hud.textContent = hudOpen ? full : `${tower.name} · seed ${tower.params.seed} · gen ${s.genMs.toFixed(0)}ms · 📊 DATA for more`;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!probeArmed) return;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const planeY = mode === 'slice' ? yOf(slice) + 0.3 : 0.3;
  const hit = new THREE.Vector3();
  if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY), hit)) {
    probe.position.set(hit.x, planeY + 1.3, hit.z);
    probeMarker.position.copy(probe.position);
    probe.visible = true;
    probeMarker.visible = true;
    probeArmed = false;
    probeBtn.textContent = 'PROBE: on';
  }
});

// --- Boot + loop ------------------------------------------------------------------

rebuild(false);
setVibe(true); // ship-vibe default: a black mass with embers in it

let t = 0;
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  // failing-power flicker: occasional dropout frames, not fire
  for (const d of dynLights) {
    const drop = Math.sin(t * 6.7 + d.phase) > 0.93 && Math.sin(t * 17.3 + d.phase * 3.1) > 0.2;
    d.light.intensity = d.base * (drop ? 0.12 : 1);
  }
  controls.update();
  renderer.render(scene, camera);
});
