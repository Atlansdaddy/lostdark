/**
 * WORLDLAB — the streaming testbed. Runs at /worldlab.html, fully separate
 * from the game (imports game modules read-only; never touches main.ts).
 *
 * Stage 1: prove the ring ladder on a dumb heightfield.
 * Pass = fly any direction for minutes: no seams, no hitches, scene mesh
 * count always equals tracked mesh count, memory flat after warmup.
 *
 * Controls
 *   desktop: click to lock · WASD move · Space/C up/down · Shift sprint
 *   touch:   left half = move stick · right half = look · buttons: ▲ ▼ ⚡
 *   both:    B chunk borders · F fog · T teleport 500m ahead · R respawn
 *            - / = mesh radius down/up
 */

import * as THREE from 'three';
import { World } from '../config';
import { logger } from '../core/log';
import { buildChunkGeometry } from '../render/VoxelMesher';
import { buildSmoothChunkGeometry } from '../render/SmoothMesher';
import { HeightfieldGen, WATER_Y } from './HeightfieldGen';
import { WorldGen } from './WorldGen';
import { ChunkManager, ColState } from './ChunkManager';
import { InstancedProps, createPropMaterial } from './Props';

const log = logger('worldlab');
const CS = World.chunkSize;

const params = new URLSearchParams(location.search);
const SEED = Number(params.get('seed') ?? 20250703);
const RADIUS = Number(params.get('r') ?? 6);
const BUDGET_MS = Number(params.get('budget') ?? 6);

// --- Renderer / scene ------------------------------------------------------

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// Phones: cap DPR at 1.5 — S24-class screens are ~3.75x and even 2x is a lot
// of fragment work for a streaming testbed (the game proper has DRS for this).
const BASE_DPR = Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.5 : 2);
renderer.setPixelRatio(BASE_DPR);
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0x10161f);
scene.background = FOG_COLOR;

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 1400);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Terrain material: fullbright-ish sun + AO + distance fog --------------
// The game's litMaterial needs the whole light stack; the lab wants geometry
// legible above all else, so shading is normals + baked AO only.

const DARK_FOG = new THREE.Color(0x04060a);

const uniforms = {
  fogColor: { value: FOG_COLOR.clone() },
  fogDensity: { value: 0.004 },
  sunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
  /** 0 = fullbright lab shading · 1 = the game's premise: baked flood light
   *  + the orb's carried bubble, darkness everywhere else. */
  uDark: { value: 0 },
  uOrbPos: { value: new THREE.Vector3() },
  uTime: { value: 0 },
};

const terrainMat = new THREE.ShaderMaterial({
  uniforms,
  vertexColors: true,
  vertexShader: /* glsl */ `
    attribute float aao;
    attribute float alight;
    varying vec3 vColor;
    varying float vAO;
    varying float vLight;
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying float vDist;
    void main() {
      vColor = color;
      vAO = aao;
      vLight = alight;
      vNormal = normal;
      vWorld = position; // geometry is baked in world coordinates
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDist = length(mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform vec3 sunDir;
    uniform float uDark;
    uniform vec3 uOrbPos;
    varying vec3 vColor;
    varying float vAO;
    varying float vLight;
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying float vDist;
    void main() {
      vec3 n = normalize(vNormal);
      float sun = clamp(dot(n, sunDir), 0.0, 1.0);
      float sky = 0.5 + 0.5 * n.y;
      vec3 day = vColor * (0.35 + 0.5 * sun + 0.3 * sky) * vAO;
      // Night: baked flood light (squared for a punchier falloff) + the
      // carried bubble + a whisper of ambient so black isn't a void.
      float bubble = clamp(1.0 - length(vWorld - uOrbPos) / 14.0, 0.0, 1.0);
      vec3 night = vColor * vAO * (vLight * sqrt(vLight) * 1.5 + bubble * bubble * 1.1 + 0.015);
      vec3 col = mix(day, night, uDark);
      float f = 1.0 - exp(-fogDensity * fogDensity * vDist * vDist);
      gl_FragColor = vec4(mix(col, fogColor, clamp(f, 0.0, 1.0)), 1.0);
    }
  `,
});

// --- World ------------------------------------------------------------------

// THE INTEGRATION: the maplab skeleton drives the streamed world by default.
// ?gen=height brings back the standalone biome heightfield testbed.
const useMap = params.get('gen') !== 'height';
const gen = useMap ? new WorldGen(SEED, Number(params.get('wr') ?? 6000)) : new HeightfieldGen(SEED);
if (gen instanceof WorldGen) {
  const n = gen.map.names;
  log.info(`world "${n.continents[0]}" · ${n.ocean} · map ${gen.map.genMs.toFixed(0)}ms · #${gen.map.checksum}`);
}
const props = new InstancedProps(createPropMaterial(uniforms));
scene.add(props.group);
const manager = new ChunkManager(gen, terrainMat, RADIUS, props);
scene.add(manager.group);

const SPAWN = new THREE.Vector3(0.5, gen.height(0, 0) + 16, 0.5);
camera.position.copy(SPAWN);

// One shared water plane at sea level, following the camera — terrain that
// dips below WATER_Y reads as lake/sea for one draw call. (The game proper
// uses the WaterZone wave shader; this is lab stand-in water.)
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(2400, 2400),
  new THREE.MeshBasicMaterial({ color: 0x1a4a66, transparent: true, opacity: 0.62, depthWrite: false }),
);
water.rotation.x = -Math.PI / 2;
scene.add(water);

// --- Fly camera --------------------------------------------------------------

let yaw = 0;
let pitch = -0.25;
const vel = new THREE.Vector3();
const keys = new Set<string>();
let sprintTouch = false;
const stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 }; // move
const lookT = { active: false, id: -1, lx: 0, ly: 0 }; // look
let touchUp = 0; // -1 | 0 | 1 from the ▲▼ buttons

// --- Actions: one implementation behind both hotkeys and UI buttons ---------

// John's design lock: the fog wall sits a ring or two INSIDE the mesh radius,
// so the streaming edge is never visible — the world reads as endless.
// exp2 fog is ~98% opaque where (d·ρ)=2, so ρ = 2 / wall-distance.
const fogDensityFor = (radius: number): number => 2 / ((radius - 1.5) * CS);

const actions = {
  borders: (): boolean => {
    setBorders(!bordersOn);
    return bordersOn;
  },
  fog: (): boolean => {
    uniforms.fogDensity.value = uniforms.fogDensity.value > 0 ? 0 : fogDensityFor(manager.radius);
    return uniforms.fogDensity.value > 0;
  },
  teleport: (): void => {
    camera.position.addScaledVector(lookDir(), 500);
    log.info(`teleport → ${fmtPos()}`);
  },
  respawn: (): void => {
    camera.position.copy(SPAWN);
    vel.set(0, 0, 0);
  },
  radius: (delta: number): void => {
    manager.setRadius(manager.radius + delta);
    if (uniforms.fogDensity.value > 0) uniforms.fogDensity.value = fogDensityFor(manager.radius);
  },
  // GPU-bound or not? (the timer extension is refused on this browser, so:)
  // halve resolution — if fps jumps, the ceiling is GPU fill; if it doesn't,
  // the frame time lives elsewhere (thermal, scene noise, CPU).
  halfRes: (): boolean => {
    const half = renderer.getPixelRatio() >= BASE_DPR;
    renderer.setPixelRatio(half ? BASE_DPR * 0.5 : BASE_DPR);
    return half;
  },
  dark: (): boolean => {
    const on = uniforms.uDark.value === 0;
    uniforms.uDark.value = on ? 1 : 0;
    uniforms.fogColor.value.copy(on ? DARK_FOG : FOG_COLOR);
    scene.background = on ? DARK_FOG : FOG_COLOR;
    return on;
  },
  sweep: (): void => {
    sweep.active = true;
    sweep.t = 0;
    sweep.yaw0 = yaw;
    sweep.maxDraws = 0;
    sweep.maxTris = 0;
    sweep.maxSubmit = 0;
    sweepResult = 'sweeping…';
  },
};

// --- Max-draws sweep: scripted 360° yaw + two pitch waves, recording the
// worst frame — the honest draw/submit ceiling for this spot. (A stationary
// reading is only the floor; the ceiling depends on view direction.)
const SWEEP_SECS = 8;
const sweep = { active: false, t: 0, yaw0: 0, maxDraws: 0, maxTris: 0, maxSubmit: 0 };
let sweepResult = '';

function updateSweep(dt: number): void {
  if (!sweep.active) return;
  sweep.t += dt;
  const p = sweep.t / SWEEP_SECS;
  if (p >= 1) {
    sweep.active = false;
    sweepResult =
      `sweep max: draws ${sweep.maxDraws} · tris ${(sweep.maxTris / 1000).toFixed(0)}k · ` +
      `submit ${sweep.maxSubmit.toFixed(1)}ms`;
    log.info(sweepResult);
    return;
  }
  yaw = sweep.yaw0 + p * Math.PI * 2; // one full turn…
  pitch = Math.sin(p * Math.PI * 4) * 0.7 - 0.12; // …with two pitch waves
}

uniforms.fogDensity.value = fogDensityFor(manager.radius); // start with the wall in place

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyB') actions.borders();
  if (e.code === 'KeyF') actions.fog();
  if (e.code === 'KeyN') actions.dark();
  if (e.code === 'KeyT') actions.teleport();
  if (e.code === 'KeyR') actions.respawn();
  if (e.code === 'Minus') actions.radius(-1);
  if (e.code === 'Equal') actions.radius(1);
  if (e.code === 'KeyK') actions.sweep();
});
addEventListener('keyup', (e) => keys.delete(e.code));

renderer.domElement.addEventListener('click', () => {
  if (!coarse) renderer.domElement.requestPointerLock();
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0024;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0024, -1.45, 1.45);
});

const coarse = matchMedia('(pointer: coarse)').matches;
if (coarse) setupTouch();

function lookDir(): THREE.Vector3 {
  return new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
}

function updateCamera(dt: number): void {
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || sprintTouch;
  const speed = sprint ? 60 : 14;
  const fwd = lookDir();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x).normalize();

  const wish = new THREE.Vector3();
  if (keys.has('KeyW')) wish.add(fwd);
  if (keys.has('KeyS')) wish.sub(fwd);
  if (keys.has('KeyD')) wish.add(right);
  if (keys.has('KeyA')) wish.sub(right);
  if (keys.has('Space')) wish.y += 1;
  if (keys.has('KeyC')) wish.y -= 1;
  if (stick.active) {
    wish.addScaledVector(fwd, -stick.y);
    wish.addScaledVector(right, stick.x);
  }
  wish.y += touchUp;
  if (wish.lengthSq() > 1) wish.normalize();

  vel.lerp(wish.multiplyScalar(speed), 1 - Math.exp(-8 * dt));
  camera.position.addScaledVector(vel, dt);
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

// --- Touch controls (the S24 is the real test rig) --------------------------

function setupTouch(): void {
  const btn = (label: string, right: number, bottom: number): HTMLDivElement => {
    const b = document.createElement('div');
    b.textContent = label;
    b.style.cssText =
      `position:fixed;right:${right}px;bottom:${bottom}px;width:52px;height:52px;` +
      'display:flex;align-items:center;justify-content:center;border-radius:50%;' +
      'background:#1c2836cc;color:#9fd6ff;font-size:22px;z-index:10;touch-action:none;';
    document.body.appendChild(b);
    return b;
  };
  const up = btn('▲', 14, 150);
  const down = btn('▼', 14, 88);
  const sprint = btn('⚡', 14, 26);
  const hold = (el: HTMLDivElement, on: () => void, off: () => void): void => {
    el.addEventListener('touchstart', (e) => (e.preventDefault(), on()), { passive: false });
    el.addEventListener('touchend', off);
    el.addEventListener('touchcancel', off);
  };
  hold(up, () => (touchUp = 1), () => (touchUp = 0));
  hold(down, () => (touchUp = -1), () => (touchUp = 0));
  sprint.addEventListener('touchstart', (e) => {
    e.preventDefault();
    sprintTouch = !sprintTouch;
    sprint.style.background = sprintTouch ? '#3a6ea5cc' : '#1c2836cc';
  });

  const el = renderer.domElement;
  el.addEventListener(
    'touchstart',
    (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < innerWidth * 0.45 && !stick.active) {
          stick.active = true;
          stick.id = t.identifier;
          stick.ox = t.clientX;
          stick.oy = t.clientY;
        } else if (!lookT.active) {
          lookT.active = true;
          lookT.id = t.identifier;
          lookT.lx = t.clientX;
          lookT.ly = t.clientY;
        }
      }
    },
    { passive: false },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (stick.active && t.identifier === stick.id) {
          stick.x = THREE.MathUtils.clamp((t.clientX - stick.ox) / 60, -1, 1);
          stick.y = THREE.MathUtils.clamp((t.clientY - stick.oy) / 60, -1, 1);
        } else if (lookT.active && t.identifier === lookT.id) {
          yaw -= (t.clientX - lookT.lx) * 0.005;
          pitch = THREE.MathUtils.clamp(pitch - (t.clientY - lookT.ly) * 0.005, -1.45, 1.45);
          lookT.lx = t.clientX;
          lookT.ly = t.clientY;
        }
      }
    },
    { passive: false },
  );
  const endTouch = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stick.id) Object.assign(stick, { active: false, id: -1, x: 0, y: 0 });
      if (t.identifier === lookT.id) Object.assign(lookT, { active: false, id: -1 });
    }
  };
  el.addEventListener('touchend', endTouch);
  el.addEventListener('touchcancel', endTouch);
}

// --- Chunk-border overlay: watch the ladder ring outward --------------------
// One wireframe box per column, coloured by state. Rebuilt (throttled) when
// the manager reports change — mirrors manager state, owns no logic.

const bordersGroup = new THREE.Group();
scene.add(bordersGroup);
let bordersOn = false;
let bordersVersion = -1;
let bordersT = 0;

const STATE_COLORS: Record<ColState, THREE.LineBasicMaterial> = {
  [ColState.Generated]: new THREE.LineBasicMaterial({ color: 0xd0453f }), // red
  [ColState.Decorated]: new THREE.LineBasicMaterial({ color: 0xd0a03f }), // amber
  [ColState.Lit]: new THREE.LineBasicMaterial({ color: 0x5fa0d8 }), // blue
  [ColState.Meshed]: new THREE.LineBasicMaterial({ color: 0x4fc06a }), // green
};
const colHeight = (gen.cyMax - gen.cyMin + 1) * CS;
const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(CS, colHeight, CS));

function setBorders(on: boolean): void {
  bordersOn = on;
  bordersGroup.visible = on;
  if (!on) rebuildBorders(true);
}

function rebuildBorders(clearOnly = false): void {
  for (const child of [...bordersGroup.children]) bordersGroup.remove(child);
  if (clearOnly) return;
  manager.forEachColumn((cx, cz, state) => {
    const line = new THREE.LineSegments(borderGeo, STATE_COLORS[state]);
    line.position.set((cx + 0.5) * CS, gen.cyMin * CS + colHeight / 2, (cz + 0.5) * CS);
    line.updateMatrix();
    line.matrixAutoUpdate = false;
    bordersGroup.add(line);
  });
  bordersVersion = manager.version;
}

// --- HUD ---------------------------------------------------------------------

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:8px;left:8px;z-index:10;color:#9fd6ff;font:11px/1.5 ui-monospace,Menlo,monospace;' +
  'max-width:calc(100vw - 108px);' + // never extend under the button column (the hidden-heap bug)
  'background:#060a10c0;padding:8px 10px;border-radius:8px;pointer-events:none;' +
  'white-space:pre-wrap;'; // pre-WRAP: plain pre ignores max-width and ran under the buttons
document.body.appendChild(hud);

// --- Control panel: every lab option tappable (phone has no hotkeys) --------

const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;top:8px;right:8px;z-index:10;display:flex;flex-direction:column;gap:6px;';
document.body.appendChild(panel);

function panelBtn(label: string, onTap: (el: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'min-width:74px;padding:9px 10px;border:1px solid #2a3c52;border-radius:8px;' +
    'background:#0d1622cc;color:#9fd6ff;font:11px ui-monospace,Menlo,monospace;' +
    'letter-spacing:0.06em;touch-action:manipulation;';
  b.addEventListener('click', () => onTap(b));
  panel.appendChild(b);
  return b;
}

const lit = (b: HTMLButtonElement, on: boolean): void => {
  b.style.background = on ? '#3a6ea5cc' : '#0d1622cc';
};

panelBtn('BORDERS', (b) => lit(b, actions.borders()));
const fogBtn = panelBtn('FOG ON', (b) => {
  const on = actions.fog();
  b.textContent = on ? 'FOG ON' : 'FOG OFF';
  lit(b, !on);
});
lit(fogBtn, false);
panelBtn('DARK', (b) => lit(b, actions.dark()));
panelBtn('RES ½', (b) => lit(b, actions.halfRes()));
let smooth = false;
panelBtn('BLOCKY', (b) => {
  smooth = !smooth;
  manager.setMesher(smooth ? buildSmoothChunkGeometry : buildChunkGeometry);
  b.textContent = smooth ? 'SMOOTH' : 'BLOCKY';
  lit(b, smooth);
});
panelBtn('SWEEP', () => actions.sweep());
panelBtn('TP +500', () => actions.teleport());
panelBtn('RESPAWN', () => actions.respawn());
const radiusLabel = panelBtn(`R = ${manager.radius}`, () => void 0);
radiusLabel.style.opacity = '0.75';
const syncRadius = (): void => {
  radiusLabel.textContent = `R = ${manager.radius}`;
};
panelBtn('R −', () => (actions.radius(-1), syncRadius()));
panelBtn('R +', () => (actions.radius(1), syncRadius()));

// --- The two budgets new content actually spends (draw calls / GPU time) ----
// CPU "submit" = blocking time of renderer.render(): single-threaded WebGL
// draw-submission overhead — the axis that scales with mesh/prop count and
// that a desktop GPU does NOT rescue. GPU time via timer query where the
// browser allows it (many Android builds disable the extension → n/a).
const glCtx = renderer.getContext() as WebGL2RenderingContext;
const timerExt = glCtx.getExtension('EXT_disjoint_timer_query_webgl2') as {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
} | null;
const gpuQueries: WebGLQuery[] = [];
let gpuMs = -1;
let submitMs = 0;
let submitRaw = 0; // last frame's un-smoothed submit — the sweep records maxima

function timedRender(): void {
  let q: WebGLQuery | null = null;
  if (timerExt && gpuQueries.length < 8) {
    q = glCtx.createQuery();
    if (q) glCtx.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
  }
  const t0 = performance.now();
  renderer.render(scene, camera);
  submitRaw = performance.now() - t0;
  submitMs = submitMs * 0.9 + submitRaw * 0.1;
  if (timerExt && q) {
    glCtx.endQuery(timerExt.TIME_ELAPSED_EXT);
    gpuQueries.push(q);
  }
  while (timerExt && gpuQueries.length) {
    const oldest = gpuQueries[0];
    if (!glCtx.getQueryParameter(oldest, glCtx.QUERY_RESULT_AVAILABLE)) break;
    const ns = glCtx.getQueryParameter(oldest, glCtx.QUERY_RESULT) as number;
    if (!glCtx.getParameter(timerExt.GPU_DISJOINT_EXT)) {
      const ms = ns / 1e6;
      gpuMs = gpuMs < 0 ? ms : gpuMs * 0.9 + ms * 0.1;
    }
    glCtx.deleteQuery(oldest);
    gpuQueries.shift();
  }
}

let fps = 60;
let hudT = 0;

const fmtPos = (): string =>
  `${camera.position.x.toFixed(0)},${camera.position.y.toFixed(0)},${camera.position.z.toFixed(0)}`;

function updateHud(stats: ReturnType<ChunkManager['update']>): void {
  const sceneMeshes = manager.group.children.length;
  const ok = sceneMeshes === stats.meshesTracked;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  hud.textContent =
    `WORLDLAB ${gen instanceof WorldGen ? '·' + gen.map.names.continents[0] : 's1.5·regions'}  seed ${SEED}  R=${manager.radius}\n` +
    `${fps.toFixed(0)} fps   pos ${fmtPos()}   ${gen.biomeAt(camera.position.x, camera.position.z)}\n` +
    `cols  gen ${stats.byState[0]} · deco ${stats.byState[1]} · lit ${stats.byState[2]} · meshed ${stats.byState[3]}\n` +
    `chunks ${stats.chunksLoaded}   meshes scene ${sceneMeshes} / tracked ${stats.meshesTracked} ${ok ? '✓' : '✗ MISMATCH'}\n` +
    `work ${stats.frameMs.toFixed(1)}ms/f (budget ${BUDGET_MS})   gen ${stats.genMsAvg.toFixed(1)}   lit ${stats.litMsAvg.toFixed(1)}   mesh ${stats.meshMsAvg.toFixed(1)}ms\n` +
    `draws ${renderer.info.render.calls}   tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k   ` +
    `submit ${submitMs.toFixed(1)}ms   gpu ${gpuMs < 0 ? 'n/a' : gpuMs.toFixed(1) + 'ms'}\n` +
    `props ${props.instances} in ${props.pools} pools   queue ${stats.queued}   disposed ${stats.columnsDisposed}` +
    (heap ? `   heap ${(heap.usedJSHeapSize / 1048576).toFixed(0)}MB` : '') +
    (sweepResult ? `\n${sweepResult}` : '') +
    `\n[B]orders [F]og [N]dark s[K]sweep [T]eleport [R]espawn [-/=] radius`;
  hud.style.color = ok ? '#9fd6ff' : '#ff7066';
}

// --- Main loop ---------------------------------------------------------------

log.info(`worldlab up — seed ${SEED}, radius ${RADIUS}, budget ${BUDGET_MS}ms`);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

  updateSweep(dt);
  updateCamera(dt);
  uniforms.uOrbPos.value.copy(camera.position);
  uniforms.uTime.value += dt;
  water.position.set(camera.position.x, WATER_Y + 0.42, camera.position.z);
  const stats = manager.update(camera.position.x, camera.position.z, BUDGET_MS);
  props.update();

  if (bordersOn && manager.version !== bordersVersion && now - bordersT > 250) {
    bordersT = now;
    rebuildBorders();
  }

  hudT += dt;
  if (hudT > 0.25) {
    hudT = 0;
    updateHud(stats); // reads last frame's renderer.info — post-render values
  }

  timedRender();
  if (sweep.active) {
    sweep.maxDraws = Math.max(sweep.maxDraws, renderer.info.render.calls);
    sweep.maxTris = Math.max(sweep.maxTris, renderer.info.render.triangles);
    sweep.maxSubmit = Math.max(sweep.maxSubmit, submitRaw);
  }
});
