/**
 * CAVELAB — scene builder + control panel for the cave generator (pure
 * presentation; all layout logic lives in CaveGen.ts). Spec: darkness is the
 * default — the scene reads as void punctured by light. Orthographic overhead
 * default + perspective orbit toggle; pulse probe (tap-to-place warm light with
 * radius slider) to judge layouts at actual player visibility; debug overlays;
 * acceptance tests run and print on every regenerate.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Cave, CaveParams, CAVE_DEFAULTS, Cell, FLAG_SQUEEZE, FLAG_BRINK, generateCave, runAcceptance } from './CaveGen';

// --- Renderer / cameras -------------------------------------------------------

const app = document.getElementById('app')!;

// Any runtime error on-device prints where a phone can see it (no devtools).
const errBox = document.createElement('div');
errBox.style.cssText =
  'position:fixed;bottom:8px;left:8px;right:8px;z-index:99;color:#ff8080;font:10px/1.4 ui-monospace,monospace;' +
  'background:#200608ee;padding:6px 8px;border-radius:6px;white-space:pre-wrap;display:none;';
document.body.appendChild(errBox);
const showErr = (msg: string): void => {
  errBox.style.display = 'block';
  errBox.textContent = `⚠ ${msg}\n${errBox.textContent}`.slice(0, 800);
};
addEventListener('error', (e) => showErr(`${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => showErr(String(e.reason)));

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const COARSE = matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.2 : 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e16);
// VIBE mode's fog (unlit geometry vanishes ~14 tiles) is ground-level math —
// from the 120-unit overhead camera it fogs the whole map to black. So fog +
// darkness live behind the VIBE toggle; LAYOUT mode (default) stays readable.
const VIBE_FOG = new THREE.FogExp2(0x020308, 0.055);
let vibe = false;

const persp = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 600);
const orthoSize = 70;
const ortho = new THREE.OrthographicCamera(0, 0, 0, 0, -200, 400);
let overhead = true;

function sizeCameras(): void {
  const a = innerWidth / innerHeight;
  persp.aspect = a;
  persp.updateProjectionMatrix();
  ortho.left = -orthoSize * a;
  ortho.right = orthoSize * a;
  ortho.top = orthoSize;
  ortho.bottom = -orthoSize;
  ortho.updateProjectionMatrix();
}
sizeCameras();
addEventListener('resize', () => {
  sizeCameras();
  renderer.setSize(innerWidth, innerHeight);
});

persp.position.set(40, 55, 70);
ortho.position.set(0, 120, 0);
ortho.up.set(0, 0, -1); // straight-down view: default up is parallel to the
ortho.lookAt(0, 0, 0); //  view axis and degenerates the matrix (black screen)

const ctlPersp = new OrbitControls(persp, renderer.domElement);
const ctlOrtho = new OrbitControls(ortho, renderer.domElement);
ctlOrtho.enableRotate = false; // overhead stays overhead; pan/zoom only
ctlPersp.enabled = false;

// LAYOUT: bright flat ambient so the BAKED colors read as authored.
// VIBE: barely-there deep blue — void punctured by light (the spec's look).
const ambient = new THREE.AmbientLight(0xffffff, 2.4);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0x1a2440, 0x05070e, 0.22);
scene.add(hemi);

// Reference geometry that is ALWAYS visible (basic material, no fog): if you
// see this ring but no cave, it's a shading problem; if not even the ring,
// it's a camera problem. Diagnosis in one glance.
const refRing = new THREE.Mesh(
  new THREE.RingGeometry(3, 3.4, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8c3a, fog: false, side: THREE.DoubleSide }),
);
refRing.position.y = 0.6;
scene.add(refRing);

function setVibe(on: boolean): void {
  vibe = on;
  scene.fog = on ? VIBE_FOG : null;
  scene.background = new THREE.Color(on ? 0x020308 : 0x0a0e16);
  ambient.intensity = on ? 0.3 : 2.4;
}

// --- State -----------------------------------------------------------------------

const params: CaveParams = { ...CAVE_DEFAULTS, seed: 20250703 };
let cave: Cave;
let group = new THREE.Group();
const overlayGroup = new THREE.Group();
scene.add(overlayGroup);
const dynLights: { light: THREE.PointLight; phase: number; base: number }[] = [];
let floorMesh: THREE.InstancedMesh | null = null;
let floorBase: Float32Array | null = null; // per-instance base color for heatmap swaps
let floorCells: number[] = [];
const toggles = { graph: false, crit: false, lightHeat: false, depthHeat: false, darkRun: false };

// Pulse probe
const probe = new THREE.PointLight(0xfff2c9, 1.6, 18, 1.6);
probe.visible = false;
scene.add(probe);
const probeMarker = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff2c9 }));
probeMarker.visible = false;
scene.add(probeMarker);
let probeArmed = false;

// --- Build -------------------------------------------------------------------------

const KIND_GEO: Record<string, THREE.BufferGeometry> = {
  stalagmite: new THREE.ConeGeometry(0.34, 1.5, 6),
  stalactite: new THREE.ConeGeometry(0.28, 1.3, 6).rotateX(Math.PI),
  crystal: new THREE.OctahedronGeometry(0.42, 0),
  glowmoss: new THREE.SphereGeometry(0.4, 8, 5).scale(1, 0.35, 1),
  sporesac: new THREE.SphereGeometry(0.32, 8, 6),
  pool: new THREE.CircleGeometry(0.85, 12).rotateX(-Math.PI / 2),
  vein: new THREE.OctahedronGeometry(0.3, 0).scale(1, 1.7, 1),
  wardstone: new THREE.CylinderGeometry(0.28, 0.42, 1.7, 6),
};
const KIND_MAT: Record<string, THREE.Material> = {
  stalagmite: new THREE.MeshLambertMaterial({ color: 0x3a3f4c }),
  stalactite: new THREE.MeshLambertMaterial({ color: 0x333844 }),
  crystal: new THREE.MeshBasicMaterial({ color: 0x53e0ff }),
  glowmoss: new THREE.MeshBasicMaterial({ color: 0x9dffb0 }),
  sporesac: new THREE.MeshLambertMaterial({ color: 0x5a4f6a, emissive: 0x241a30 }),
  pool: new THREE.MeshBasicMaterial({ color: 0x0e2f3a, transparent: true, opacity: 0.85 }),
  vein: new THREE.MeshBasicMaterial({ color: 0xbfffe8 }),
  wardstone: new THREE.MeshBasicMaterial({ color: 0xcfa9ff }),
};
const SPAWN_COLOR: Record<string, number> = { skitter: 0x5c6470, snuffer: 0xb05050, breacher: 0x9a5cff };

function rebuild(newSeed: boolean): void {
  if (newSeed) params.seed = (Math.random() * 1e9) | 0;
  scene.remove(group);
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !Object.values(KIND_GEO).includes(m.geometry)) m.geometry.dispose();
  });
  for (const d of dynLights) scene.remove(d.light);
  dynLights.length = 0;
  group = new THREE.Group();
  scene.add(group);

  cave = generateCave(params);
  const { W, H, grid, flags, ceiling, light, chambers } = cave;
  const cx0 = W / 2;
  const cy0 = H / 2;

  // --- Floor + walls + chasm pit, instanced, baked shading ---
  let nFloor = 0;
  let nWall = 0;
  let nChasm = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === Cell.FLOOR || grid[i] === Cell.CROSSING) nFloor++;
    else if (grid[i] === Cell.WALL) nWall++;
    else if (grid[i] === Cell.CHASM) nChasm++;
  }
  const floorGeo = new THREE.BoxGeometry(1, 0.3, 1);
  floorMesh = new THREE.InstancedMesh(floorGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), nFloor);
  const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), nWall);
  const chasmMesh = new THREE.InstancedMesh(floorGeo, new THREE.MeshLambertMaterial({ color: 0x05060a }), nChasm);
  floorBase = new Float32Array(nFloor * 3);
  floorCells = new Array(nFloor);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  // per-cell chamber tint lookup via nearest chamber (cheap approximation)
  const tintOf = (x: number, y: number): [number, number, number] => {
    let best = 0;
    let bd = Infinity;
    // nearest by center (chambers are few)
    for (let i = 0; i < chambers.length; i++) {
      const c = chambers[i];
      const d = (c.cx - x) ** 2 + (c.cy - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return chambers[best].tint;
  };
  // Chamber centers are in the generator's pre-offset coordinate space while
  // tiles/props are grid-space. Recover the offset by matching a wardstone
  // prop (grid-space) to its chamber (pre-offset); fall back to anchoring the
  // nest chamber onto the deepest BFS cells.
  let OXe = 0;
  let OYe = 0;
  const ward = cave.props.find((p) => p.kind === 'wardstone');
  const wardCh = chambers.find((c) => c.type === 'wardstone');
  if (ward && wardCh) {
    OXe = Math.round(wardCh.cx - ward.x);
    OYe = Math.round(wardCh.cy - ward.y);
  } else {
    const nest = chambers.find((c) => c.type === 'nest')!;
    // nest tile = argmin bfs from... fallback: centroid of deepest bfs cells
    let sx = 0;
    let sy = 0;
    let n = 0;
    let maxD = 0;
    for (let i = 0; i < cave.bfs.length; i++) maxD = Math.max(maxD, cave.bfs[i]);
    for (let i = 0; i < cave.bfs.length; i++) {
      if (cave.bfs[i] > maxD * 0.95) {
        sx += i % W;
        sy += (i / W) | 0;
        n++;
      }
    }
    if (n) {
      OXe = Math.round(nest.cx - sx / n);
      OYe = Math.round(nest.cy - sy / n);
    }
  }

  let fi = 0;
  let wi = 0;
  let ci = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const g = grid[idx];
      const wx = x - cx0;
      const wz = y - cy0;
      if (g === Cell.FLOOR || g === Cell.CROSSING) {
        m4.makeTranslation(wx, -0.15, wz);
        floorMesh.setMatrixAt(fi, m4);
        // baked: base × (0.25 + 0.75·light) × wall-crowding AO ± noise, tinted
        let walls8 = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (grid[(y + dy) * W + (x + dx)] === Cell.WALL) walls8++;
          }
        }
        const l = light[idx];
        const ao = 1 - 0.09 * Math.min(walls8, 4);
        const jitter = 0.95 + ((x * 31 + y * 17) % 10) / 100;
        const tint = tintOf(x + OXe, y + OYe);
        let r = 0.42;
        let gg = 0.45;
        let b = 0.52;
        r = (r * 0.85 + tint[0] * 0.15) * (0.25 + 0.75 * l) * ao * jitter;
        gg = (gg * 0.85 + tint[1] * 0.15) * (0.25 + 0.75 * l) * ao * jitter;
        b = (b * 0.85 + tint[2] * 0.15) * (0.25 + 0.75 * l) * ao * jitter;
        if (g === Cell.CROSSING) {
          r += 0.06;
          gg += 0.05;
        }
        if (flags[idx] & FLAG_BRINK) r += 0.045; // faint warm edge on kill terrain
        if (flags[idx] & FLAG_SQUEEZE) b += 0.05;
        floorMesh.setColorAt(fi, col.setRGB(r, gg, b));
        floorBase[fi * 3] = r;
        floorBase[fi * 3 + 1] = gg;
        floorBase[fi * 3 + 2] = b;
        floorCells[fi] = idx;
        fi++;
      } else if (g === Cell.WALL) {
        // wall pillar height from tallest adjacent ceiling
        let hMax = 2;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = (y + dy) * W + (x + dx);
          if (ni >= 0 && ni < ceiling.length && ceiling[ni]) hMax = Math.max(hMax, ceiling[ni] + 1);
        }
        m4.makeScale(1, hMax, 1);
        m4.setPosition(wx, hMax / 2 - 0.3, wz);
        wallMesh.setMatrixAt(wi, m4);
        const shade = 0.16 + ((x * 13 + y * 7) % 8) / 90;
        wallMesh.setColorAt(wi, col.setRGB(shade, shade * 1.05, shade * 1.25));
        wi++;
      } else if (g === Cell.CHASM) {
        m4.makeTranslation(wx, -3.4, wz);
        chasmMesh.setMatrixAt(ci, m4);
        ci++;
      }
    }
  }
  for (const m of [floorMesh, wallMesh, chasmMesh]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
    group.add(m);
  }

  // --- Props, one InstancedMesh per kind ---
  const byKind = new Map<string, { x: number; y: number; rot: number; scale: number }[]>();
  for (const p of cave.props) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind)!.push(p);
  }
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  for (const [kind, recs] of byKind) {
    const inst = new THREE.InstancedMesh(KIND_GEO[kind], KIND_MAT[kind], recs.length);
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const idx = rec.y * W + rec.x;
      const yPos = kind === 'stalactite' ? ceiling[idx] + 0.4 : kind === 'pool' ? 0.03 : 0.35 * rec.scale;
      q.setFromAxisAngle(UP, rec.rot);
      m4.compose(new THREE.Vector3(rec.x - cx0, yPos, rec.y - cy0), q, new THREE.Vector3().setScalar(rec.scale));
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    group.add(inst);
  }
  // spawn markers (single instanced mesh, per-instance tier color)
  if (cave.spawns.length) {
    const sm = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.3), new THREE.MeshBasicMaterial({ color: 0xffffff }), cave.spawns.length);
    for (let i = 0; i < cave.spawns.length; i++) {
      const sp = cave.spawns[i];
      m4.makeTranslation(sp.x - cx0, 0.4, sp.y - cy0);
      sm.setMatrixAt(i, m4);
      sm.setColorAt(i, col.setHex(SPAWN_COLOR[sp.tier]));
    }
    sm.instanceMatrix.needsUpdate = true;
    if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
    sm.frustumCulled = false;
    group.add(sm);
  }

  // --- Dynamic lights: importance + farthest-point sample, ≤12 ---
  const KIND_LIGHT: Record<string, { color: number; score: number }> = {
    crystal: { color: 0x53e0ff, score: 2 },
    glowmoss: { color: 0x9dffb0, score: 1 },
    wardstone: { color: 0xcfa9ff, score: 3 },
    vein: { color: 0xbfffe8, score: 1.5 },
  };
  const chosen: typeof cave.emitters = [];
  const pool = [...cave.emitters];
  while (chosen.length < (COARSE ? 5 : 12) && pool.length) {
    let bi = 0;
    let bScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      let minD = Infinity;
      for (const c of chosen) minD = Math.min(minD, Math.hypot(c.x - e.x, c.y - e.y));
      const sc = KIND_LIGHT[e.kind].score * (chosen.length ? Math.min(minD, 40) : 1);
      if (sc > bScore) {
        bScore = sc;
        bi = i;
      }
    }
    chosen.push(pool.splice(bi, 1)[0]);
  }
  for (const e of chosen) {
    const L = new THREE.PointLight(KIND_LIGHT[e.kind].color, e.intensity * 2.2, e.radius * 2.4, 1.7);
    L.position.set(e.x - cx0, 1.6, e.y - cy0);
    scene.add(L);
    dynLights.push({ light: L, phase: (e.x * 7 + e.y * 13) % 6.28, base: e.intensity * 2.2 });
  }

  buildOverlays(cx0, cy0, OXe, OYe);
  applyHeatmap();
  updateHud();
}

// --- Overlays ------------------------------------------------------------------------

function buildOverlays(cx0: number, cy0: number, OXe: number, OYe: number): void {
  for (const child of [...overlayGroup.children]) {
    overlayGroup.remove(child);
    (child as THREE.LineSegments).geometry?.dispose();
  }
  const mkLines = (pairs: [number, number][], colHex: number, opacity: number, y: number): THREE.LineSegments => {
    const pos: number[] = [];
    for (const [a, b] of pairs) {
      const A = cave.chambers[a];
      const B = cave.chambers[b];
      pos.push(A.cx - OXe - cx0, y, A.cy - OYe - cy0, B.cx - OXe - cx0, y, B.cy - OYe - cy0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: colHex, transparent: true, opacity }));
  };
  const mstKeys = new Set(cave.mstEdges.map((e) => `${Math.min(...e)}_${Math.max(...e)}`));
  const loopEdges = cave.edges.filter((e) => !mstKeys.has(`${Math.min(...e)}_${Math.max(...e)}`));
  const graph = new THREE.Group();
  graph.add(mkLines(cave.delaunayEdges, 0x3a4258, 0.25, 4.4));
  graph.add(mkLines(cave.mstEdges, 0xffffff, 0.8, 4.6));
  graph.add(mkLines(loopEdges, 0x53e0ff, 0.9, 4.8));
  graph.name = 'graph';
  graph.visible = toggles.graph;
  overlayGroup.add(graph);

  const critPos: number[] = [];
  for (let i = 0; i < cave.criticalPath.length - 1; i += 1) {
    const a = cave.criticalPath[i];
    const b = cave.criticalPath[i + 1];
    critPos.push((a % cave.W) - cx0, 3.6, ((a / cave.W) | 0) - cy0, (b % cave.W) - cx0, 3.6, ((b / cave.W) | 0) - cy0);
  }
  const critGeo = new THREE.BufferGeometry();
  critGeo.setAttribute('position', new THREE.Float32BufferAttribute(critPos, 3));
  const crit = new THREE.LineSegments(critGeo, new THREE.LineBasicMaterial({ color: 0xff4040 }));
  crit.name = 'crit';
  crit.visible = toggles.crit;
  overlayGroup.add(crit);
}

function applyHeatmap(): void {
  if (!floorMesh || !floorBase) return;
  const col = new THREE.Color();
  let maxD = 1;
  if (toggles.depthHeat) for (let i = 0; i < cave.bfs.length; i++) maxD = Math.max(maxD, cave.bfs[i]);
  const critSet = toggles.darkRun ? new Set(cave.criticalPath) : null;
  for (let i = 0; i < floorCells.length; i++) {
    const idx = floorCells[i];
    if (toggles.lightHeat) {
      const l = cave.light[idx];
      col.setRGB(l, l * 0.35 + 0.05, (1 - l) * 0.5);
    } else if (toggles.depthHeat) {
      const t = Math.max(0, cave.bfs[idx]) / maxD;
      col.setRGB(t, 0.12 + 0.3 * (1 - t), 0.55 * (1 - t));
    } else {
      col.setRGB(floorBase[i * 3], floorBase[i * 3 + 1], floorBase[i * 3 + 2]);
    }
    if (critSet && critSet.has(idx) && cave.light[idx] < cave.params.minLight * 1.25) col.setRGB(1, 0.1, 0.1);
    floorMesh.setColorAt(i, col);
  }
  floorMesh.instanceColor!.needsUpdate = true;
}

// --- Panel / HUD -----------------------------------------------------------------------

const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;top:8px;right:8px;z-index:10;display:flex;flex-direction:column;gap:5px;max-height:92vh;overflow-y:auto;';
document.body.appendChild(panel);
const mkBtn = (label: string, onTap: (b: HTMLButtonElement) => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'min-width:104px;padding:8px 9px;border:1px solid #2a3c52;border-radius:8px;background:#0d1622cc;' +
    'color:#9fd6ff;font:11px ui-monospace,Menlo,monospace;touch-action:manipulation;text-align:left;';
  b.addEventListener('click', () => onTap(b));
  panel.appendChild(b);
  return b;
};
const lit = (b: HTMLButtonElement, on: boolean): void => {
  b.style.background = on ? '#3a6ea5cc' : '#0d1622cc';
};
const mkSlider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): void => {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'background:#0d1622cc;border:1px solid #2a3c52;border-radius:8px;padding:5px 8px;color:#9fd6ff;font:10px ui-monospace,monospace;';
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
mkBtn('VERIFY (slow)', (b) => {
  b.textContent = '…verifying';
  setTimeout(() => {
    updateHud(false);
    b.textContent = 'VERIFY (slow)';
  }, 30);
});
mkBtn('VIEW: 2D', (b) => {
  overhead = !overhead;
  b.textContent = overhead ? 'VIEW: 2D' : 'VIEW: 3D';
  ctlPersp.enabled = !overhead;
  ctlOrtho.enabled = overhead;
});
const probeBtn = mkBtn('PROBE: off', (b) => {
  probeArmed = !probe.visible ? true : false;
  if (probe.visible) {
    probe.visible = false;
    probeMarker.visible = false;
    probeArmed = false;
  }
  b.textContent = probe.visible ? 'PROBE: on' : probeArmed ? 'PROBE: tap map' : 'PROBE: off';
  lit(b, probe.visible || probeArmed);
});
mkSlider('probe radius', 4, 40, 1, () => probe.distance, (v) => {
  probe.distance = v;
});
mkBtn('GRAPH', (b) => {
  toggles.graph = !toggles.graph;
  overlayGroup.getObjectByName('graph')!.visible = toggles.graph;
  lit(b, toggles.graph);
});
mkBtn('CRIT PATH', (b) => {
  toggles.crit = !toggles.crit;
  overlayGroup.getObjectByName('crit')!.visible = toggles.crit;
  lit(b, toggles.crit);
});
mkBtn('LIGHT HEAT', (b) => {
  toggles.lightHeat = !toggles.lightHeat;
  toggles.depthHeat = false;
  applyHeatmap();
  lit(b, toggles.lightHeat);
});
mkBtn('DEPTH HEAT', (b) => {
  toggles.depthHeat = !toggles.depthHeat;
  toggles.lightHeat = false;
  applyHeatmap();
  lit(b, toggles.depthHeat);
});
mkBtn('DARK RUNS', (b) => {
  toggles.darkRun = !toggles.darkRun;
  applyHeatmap();
  lit(b, toggles.darkRun);
});
mkSlider('chambers', 12, 60, 1, () => params.chamberCount, (v) => (params.chamberCount = v));
mkSlider('loops', 0, 0.5, 0.05, () => params.loopChance, (v) => (params.loopChance = v));
mkSlider('wander', 0, 6, 0.5, () => params.tunnelWander, (v) => (params.tunnelWander = v));
mkSlider('maxDarkRun', 8, 40, 1, () => params.maxDarkRun, (v) => (params.maxDarkRun = v));
mkSlider('decor', 0, 1, 0.1, () => params.decorDensity, (v) => (params.decorDensity = v));

let hudOpen = !COARSE; // phones start collapsed — the wall of text owns a 6" screen
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:8px;left:8px;z-index:10;color:#9fd6ff;font:10px/1.45 ui-monospace,Menlo,monospace;' +
  'background:#060a10d0;padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre-wrap;max-width:calc(100vw - 140px);';
document.body.appendChild(hud);

function updateHud(fast = true): void {
  const s = cave.stats;
  const acc = runAcceptance(cave, fast); // full determinism check via VERIFY
  const accLines = acc.map((a) => `${a.pass ? '✓' : '✗'} ${a.name}: ${a.detail}`).join('\n');
  const full =
    `CAVELAB  “${cave.name}”  seed ${cave.params.seed}\n` +
    `${s.chambers} chambers · ${s.edges} edges · ${s.loops} loops · crit ${s.criticalLength} · ${s.floorTiles} tiles\n` +
    `lit ${(s.litFraction * 100).toFixed(0)}% · darkest run ${s.longestDarkRun}/${cave.params.maxDarkRun} · veins ${s.veins} · gen ${s.genMs.toFixed(0)}ms\n` +
    `render: draws ${renderer.info.render.calls} · tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k · cam ${overhead ? '2D' : '3D'}\n` +
    `— acceptance —\n${accLines}\n` +
    `legend: cyan=crystal green=moss violet=wardstone pale=vein · red edge=BRINK blue=SQUEEZE\n` +
    `spawn tiers: grey=skitter red=snuffer purple=breacher`;
  hud.textContent = hudOpen ? full : `“${cave.name}” · seed ${cave.params.seed} · gen ${s.genMs.toFixed(0)}ms · 📊 DATA for more`;
}

// Probe placement: tap the map while armed.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!probeArmed) return;
  const ray = new THREE.Raycaster();
  const cam = overhead ? ortho : persp;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), cam);
  const hit = new THREE.Vector3();
  if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.4), hit)) {
    probe.position.set(hit.x, 1.4, hit.z);
    probeMarker.position.copy(probe.position);
    probe.visible = true;
    probeMarker.visible = true;
    probeArmed = false;
    probeBtn.textContent = 'PROBE: on';
  }
});

// --- Boot + loop ---------------------------------------------------------------------------

rebuild(false);

let t = 0;
let hudT = 0;
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  // bioluminescence breathes — slow sinusoidal pulse, seeded phase
  for (const d of dynLights) d.light.intensity = d.base * (0.82 + 0.18 * Math.sin(t * 0.9 + d.phase));
  (overhead ? ctlOrtho : ctlPersp).update();
  renderer.render(scene, overhead ? ortho : persp);
  hudT += dt;
  if (hudT > 1) {
    hudT = 0;
    updateHud();
  }
});
