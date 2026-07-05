// Dev error trap: surface boot-time failures in the tab title (the vite
// console can drown real errors in HMR reconnect spam).
window.addEventListener('error', (e) => {
  document.title = `wAIver ERR: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`;
});
window.addEventListener('unhandledrejection', (e) => {
  document.title = `wAIver REJ: ${String(e.reason).slice(0, 120)}`;
});

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { VolumetricFogPass, MAX_FOG_LIGHTS } from './render/VolumetricFogPass';
import { GrassField } from './render/GrassField';
import { SkyDome, cloudCoverAt } from './render/SkyDome';
import { GodRaysPass } from './render/GodRaysPass';
import { Camera as CameraConfig, Light as LightConfig, World } from './config';
import { Input } from './core/Input';
import { LightGrid } from './lighting/LightGrid';
import { Orb } from './orb/Orb';
import { OrbMood } from './orb/Mood';
import { createLitMaterial } from './render/litMaterial';
import { buildChunkGeometry } from './render/VoxelMesher';
import { buildSmoothChunkGeometry } from './render/SmoothMesher';
import { Mat } from './world/Materials';
import { Chunk, VoxelWorld } from './world/VoxelWorld';
import { generateReek } from './world/ReekGen';

type Pickup = {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  taken: boolean;
};

type Ward = {
  pos: THREE.Vector3;
  light: THREE.PointLight;
  core: THREE.Mesh;
  /** The visible field of protection — a soft dome showing WHERE you're safe. */
  dome: THREE.Mesh;
};

/** Ward protection radius (voxels). One number: dome size = mechanics = truth. */
const WARD_RADIUS = 12;

const app = document.querySelector<HTMLDivElement>('#app');
const boot = document.querySelector<HTMLDivElement>('#boot');
if (!app) throw new Error('Missing #app root');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // crisp without 2.5² fragment cost
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'wAIver game canvas');
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020205);
scene.fog = new THREE.FogExp2(0x05080a, 0.024);

// The night above The Reek: clouds, star pockets, a cycling moon.
const sky = new SkyDome();
scene.add(sky.mesh);
const moonDir = new THREE.Vector3(0.3, 0.7, 0.2).normalize();
let moonI = 0; // eased moonlight strength (0 = clouded over)
const moonWorld = new THREE.Vector3();
const moonNdc = new THREE.Vector3();
const moonScreen = new THREE.Vector2();

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 240);
let yaw = -0.55;
let pitch = -0.28;
// Drags move the TARGET; the actual view eases toward it (soft look).
let yawTarget = yaw;
let pitchTarget = pitch;

// HDR bloom → ACES output. The glowing orb and emissives NEED this to read
// as light sources instead of flat sprites (GDD §5j: non-negotiable).
// Depth prepass: the volumetric pass needs scene depth, but reading a depth
// texture attached to the composer's own targets is a GPU feedback loop.
// So depth lives in a dedicated prepass target the composer never binds.
// Depth prepass runs at HALF resolution — the fog it feeds is soft anyway,
// and this halves the cost of rendering the scene twice.
const dpr = renderer.getPixelRatio();
const depthW = Math.floor((window.innerWidth * dpr) / 2);
const depthH = Math.floor((window.innerHeight * dpr) / 2);
const sceneDepth = new THREE.DepthTexture(depthW, depthH);
const depthRT = new THREE.WebGLRenderTarget(depthW, depthH, {
  depthTexture: sceneDepth,
});
// The prepass only needs DEPTH — render it with a flat, color-less material so
// we don't pay the full lit terrain shader twice per frame (that was the
// "double rendering" fps sink).
const depthPrepassMat = new THREE.MeshBasicMaterial({ colorWrite: false });
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// Reek-mist + moon god-rays: two raymarched fullscreen passes fed by a full
// extra scene render (the depth prepass). They were auto-disabled under load
// (no visible fog), so paying that whole cost bought nothing. DISABLED for
// performance — the objects still exist so their per-frame setters are no-ops
// and re-enabling later is just un-commenting these addPass calls + the prepass.
const fogPass = new VolumetricFogPass(camera, sceneDepth);
// composer.addPass(fogPass);
const godRays = new GodRaysPass(sceneDepth);
// composer.addPass(godRays);
const VOLUMETRICS_ON = false; // master switch for the fog/god-ray atmosphere

/** Static fog lights (glowcaps, crystals, wards) — slot 0 is the orb, live. */
const fogLightRegistry: { pos: THREE.Vector3; color: THREE.Color; intensity: number }[] = [];
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55, // strength — glow, not blowout
  0.45, // radius
  0.62, // threshold — only genuinely bright things bloom
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const input = new Input(renderer.domElement);
(window as any).input = input; // for console debugging
const world = new VoxelWorld();
const lightGrid = new LightGrid(world);
const orb = new Orb(world);
orb.extraCollide = (p, r) => floraCollides(p, r);
const mood = new OrbMood();
let landSquash = 0; // landing squash impulse, decays fast
let wasGrounded = true;
const { material: worldMaterial, uniforms } = createLitMaterial();

const chunkMeshes = new Map<Chunk, THREE.Mesh>();
// Terrain skin: BLOCKY voxels (John's call after the surface-nets test read
// as "tunnels" — invest in voxel texturing instead). The smooth path stays
// behind waiver.smooth(true) for a future refinement round.
let smoothTerrain = false;
const pickups: Pickup[] = [];
const wards: Ward[] = [];
const tempVec = new THREE.Vector3();
// Reused per-frame culling scratch (no per-frame allocations).
const cullFrustum = new THREE.Frustum();
const cullMatrix = new THREE.Matrix4();
const clock = new THREE.Clock();

let spores = 0;
let objective = 'Awaken in The Reek';
let tide = 0;
let pulseRadius = -1;
let pulseActive = false;
let pulseCenter = new THREE.Vector3();

// The orb: a REFLECTIVE BLACK sphere — the light lives in the aura around it,
// not in the body. Reflections come from a generated room environment so the
// glassy black reads even though the world shader is custom.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const orbGroup = new THREE.Group();
const orbCore = new THREE.Mesh(
  new THREE.SphereGeometry(0.48, 48, 32),
  new THREE.MeshPhysicalMaterial({
    color: 0x0a0a0e, // near-black body
    metalness: 0.22,
    roughness: 0.42, // satin: broad, soft reflections…
    clearcoat: 0.65, // …with a thin glossy coat on top
    clearcoatRoughness: 0.28,
    envMapIntensity: 0.75,
    sheen: 0.4, // faint fabric-like rim softness
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0x2a3a55),
  }),
);
// Aura layer 1: tight rim glow hugging the black core.
const orbHalo = new THREE.Mesh(
  new THREE.SphereGeometry(0.62, 32, 18),
  new THREE.MeshBasicMaterial({
    color: 0x50d8ff,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide, // only the rim, so the black face stays black
  }),
);
// Aura layer 2: wide soft glow sprite — the "light around the dark".
const orbAura = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: null, // set after moteTexture exists below
    color: 0x66d9ff,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
orbAura.scale.setScalar(3.4);
orbGroup.add(orbAura, orbHalo, orbCore);
scene.add(orbGroup);

const orbLight = new THREE.PointLight(0x8defff, 2.8, 18, 1.7);
scene.add(orbLight);

// --- Orb trail: drifting light-motes in the orb's wake (secondary motion —
// the single cheapest "it's alive" signal per RESEARCH_orb_life). ---
const TRAIL_MAX = 160;
const trailPos = new Float32Array(TRAIL_MAX * 3);
const trailCol = new Float32Array(TRAIL_MAX * 3);
const trailLife = new Float32Array(TRAIL_MAX);
const trailDrift = new Float32Array(TRAIL_MAX * 3);
trailPos.fill(-999);
let trailHead = 0;
// Soft radial sprite so motes render as glow-points, not hard squares.
const moteCanvas = document.createElement('canvas');
moteCanvas.width = moteCanvas.height = 64;
{
  const ctx = moteCanvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
}
const moteTexture = new THREE.CanvasTexture(moteCanvas);
(orbAura.material as THREE.SpriteMaterial).map = moteTexture;
(orbAura.material as THREE.SpriteMaterial).needsUpdate = true;

const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
const trailPoints = new THREE.Points(
  trailGeo,
  new THREE.PointsMaterial({
    size: 0.6,
    map: moteTexture,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  }),
);
trailPoints.frustumCulled = false;
trailPoints.layers.set(1); // effects layer — skipped by the depth prepass
scene.add(trailPoints);

function emitTrail(count: number): void {
  for (let i = 0; i < count; i++) {
    const idx = trailHead;
    trailHead = (trailHead + 1) % TRAIL_MAX;
    trailPos[idx * 3] = orb.pos.x + (Math.random() - 0.5) * 0.5;
    trailPos[idx * 3 + 1] = orb.pos.y + (Math.random() - 0.5) * 0.5;
    trailPos[idx * 3 + 2] = orb.pos.z + (Math.random() - 0.5) * 0.5;
    trailDrift[idx * 3] = (Math.random() - 0.5) * 0.4;
    trailDrift[idx * 3 + 1] = 0.25 + Math.random() * 0.35; // motes rise
    trailDrift[idx * 3 + 2] = (Math.random() - 0.5) * 0.4;
    trailLife[idx] = 1;
  }
}

// --- Ambient spore-motes: The Reek's air is alive (ART.md §4). A fixed pool
// of drifting particles wrapped around the orb so the air always shimmers. ---
const SPORE_MAX = 220;
const SPORE_RANGE = 26;
const sporePos = new Float32Array(SPORE_MAX * 3);
const sporeSeed = new Float32Array(SPORE_MAX * 2);
for (let i = 0; i < SPORE_MAX; i++) {
  sporePos[i * 3] = (Math.random() - 0.5) * SPORE_RANGE * 2;
  sporePos[i * 3 + 1] = Math.random() * 10;
  sporePos[i * 3 + 2] = (Math.random() - 0.5) * SPORE_RANGE * 2;
  sporeSeed[i * 2] = Math.random() * 100;
  sporeSeed[i * 2 + 1] = 0.15 + Math.random() * 0.3;
}
const sporeGeo = new THREE.BufferGeometry();
sporeGeo.setAttribute('position', new THREE.BufferAttribute(sporePos, 3));
const sporePoints = new THREE.Points(
  sporeGeo,
  new THREE.PointsMaterial({
    size: 0.22,
    map: moteTexture, // soft radial sprite — never hard squares
    color: 0x7fffc8,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  }),
);
sporePoints.frustumCulled = false;
sporePoints.layers.set(1); // effects layer — skipped by the depth prepass
scene.add(sporePoints);

function updateSpores(dt: number, t: number): void {
  for (let i = 0; i < SPORE_MAX; i++) {
    const s = sporeSeed[i * 2];
    const drift = sporeSeed[i * 2 + 1];
    sporePos[i * 3] += Math.sin(t * 0.3 + s) * drift * dt;
    sporePos[i * 3 + 1] += Math.cos(t * 0.22 + s * 1.7) * drift * dt * 0.6 + dt * 0.12;
    sporePos[i * 3 + 2] += Math.cos(t * 0.26 + s) * drift * dt;
    // Wrap around the orb so the field follows without popping.
    for (let a = 0; a < 3; a += 2) {
      const rel = sporePos[i * 3 + a] - (a === 0 ? orb.pos.x : orb.pos.z);
      if (rel > SPORE_RANGE) sporePos[i * 3 + a] -= SPORE_RANGE * 2;
      if (rel < -SPORE_RANGE) sporePos[i * 3 + a] += SPORE_RANGE * 2;
    }
    if (sporePos[i * 3 + 1] > 12) sporePos[i * 3 + 1] = 0.3;
  }
  sporeGeo.attributes.position.needsUpdate = true;
}

function updateTrail(dt: number): void {
  const speed = orb.vel.length();
  emitTrail(speed > 4 ? 3 : 1);
  for (let i = 0; i < TRAIL_MAX; i++) {
    if (trailLife[i] <= 0) continue;
    trailLife[i] = Math.max(0, trailLife[i] - dt * 0.9);
    const l = trailLife[i];
    trailPos[i * 3] += trailDrift[i * 3] * dt;
    trailPos[i * 3 + 1] += trailDrift[i * 3 + 1] * dt;
    trailPos[i * 3 + 2] += trailDrift[i * 3 + 2] * dt;
    // The wake carries the mood it was left with, fading as it ages.
    trailCol[i * 3] = mood.color.r * l * l;
    trailCol[i * 3 + 1] = mood.color.g * l * l;
    trailCol[i * 3 + 2] = mood.color.b * l;
    if (l === 0) trailPos[i * 3 + 1] = -999;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;
}

// --- Pulse shell: the visible wavefront leaving the orb. Without this the
// pulse only exists where it hits geometry (the floor first) and feels like it
// comes from the ground. The shell + an orb flash make the emission read. ---
const pulseShell = new THREE.Mesh(
  new THREE.SphereGeometry(1, 48, 32),
  new THREE.MeshBasicMaterial({
    color: 0x7fdcff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
pulseShell.visible = false;
pulseShell.frustumCulled = false;
pulseShell.layers.set(1); // effects layer — skipped by the depth prepass
scene.add(pulseShell);
let pulseFlash = 0; // orb over-glow at the moment of firing, decays fast

const tideVeil = new THREE.Mesh(
  new THREE.SphereGeometry(80, 48, 24),
  new THREE.MeshBasicMaterial({
    color: 0x020205,
    transparent: true,
    opacity: 0,
    side: THREE.BackSide,
    depthWrite: false,
  }),
);
scene.add(tideVeil);

// Perf metrics strip — always visible at the top while we build (John's ask).
const metricsBar = document.createElement('div');
metricsBar.className = 'metrics-bar';
metricsBar.textContent = '— fps';
document.body.appendChild(metricsBar);
renderer.info.autoReset = false; // we reset per frame so counts span ALL passes
let fpsEma = 60;
let metricsTimer = 0;

// Adaptive quality (GDD §5f graceful degradation): if fps sags, step down —
// resolution first, volumetrics second. Reduce fidelity, never break rules.
let qualityTier = 0; // 0 = full, 1 = lower res, 2 = no volumetrics
let lowFpsTime = 0;
function applyQualityTier(): void {
  if (qualityTier === 1) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.3));
  } else if (qualityTier === 2) {
    renderer.setPixelRatio(1);
    fogPass.enabled = false;
    bloomPass.strength = 0.4;
  }
  const ratio = renderer.getPixelRatio();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(ratio);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
  depthRT.setSize(Math.floor((window.innerWidth * ratio) / 2), Math.floor((window.innerHeight * ratio) / 2));
  console.info(`[quality] tier ${qualityTier}`);
}

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <div class="title">wAIver / The Reek</div>
  <div class="meters">
    <div><span>Lumen</span><b id="lumen">100</b></div>
    <div><span>Energy</span><b id="energy">100</b></div>
    <div><span>Glowspores</span><b id="spores">0</b></div>
  </div>
  <div id="objective" class="objective"></div>
  <div id="gamepad-debug" class="gamepad-debug">pad: none</div>
`;
document.body.appendChild(hud);

const controllerStatus = document.createElement('button');
controllerStatus.type = 'button';
controllerStatus.className = 'controller-status';
controllerStatus.textContent = 'Controller: click to arm';
controllerStatus.addEventListener('pointerdown', () => input.activateGamepadSurface());
controllerStatus.addEventListener('click', () => input.activateGamepadSurface());
document.body.appendChild(controllerStatus);

const style = document.createElement('style');
style.textContent = `
  canvas {
    outline: none;
  }
  .metrics-bar {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    max-width: calc(100vw - 16px);
    padding: 4px 14px;
    border-radius: 0 0 8px 8px;
    background: rgba(2, 6, 7, 0.72);
    border: 1px solid rgba(127, 220, 255, 0.25);
    border-top: none;
    color: #9fe8ff;
    font: 10.5px/1.4 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.04em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .hud {
    position: fixed;
    left: 18px;
    top: 16px;
    color: #dffcf1;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    text-shadow: 0 0 18px rgba(80, 255, 202, 0.35);
    pointer-events: none;
  }
  .title {
    color: #7fffd1;
    font-size: 12px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .meters {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .meters div {
    min-width: 92px;
    padding: 7px 8px;
    border-left: 2px solid rgba(127, 255, 209, 0.65);
    background: rgba(2, 6, 7, 0.5);
    box-shadow: inset 0 0 16px rgba(54, 226, 177, 0.08);
  }
  .meters span {
    display: block;
    color: rgba(223, 252, 241, 0.64);
    font-size: 10px;
    line-height: 1.25;
  }
  .meters b {
    font-size: 16px;
    font-weight: 600;
  }
  .objective {
    margin-top: 10px;
    max-width: min(430px, calc(100vw - 36px));
    color: #f6fff6;
    font-size: 13px;
    line-height: 1.45;
  }
  .gamepad-debug {
    margin-top: 8px;
    max-width: min(520px, calc(100vw - 36px));
    padding: 6px 8px;
    color: rgba(159, 232, 255, 0.92);
    background: rgba(3, 10, 14, 0.48);
    border-left: 2px solid rgba(127, 220, 255, 0.45);
    font-size: 10px;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .controller-status {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    z-index: 80;
    max-width: calc(100vw - 24px);
    padding: 8px 12px;
    color: #dffcf1;
    background: rgba(2, 6, 7, 0.84);
    border: 1px solid rgba(127, 220, 255, 0.42);
    border-radius: 6px;
    box-shadow: 0 0 18px rgba(80, 216, 255, 0.12);
    font: 10.5px/1.35 ui-monospace, Menlo, Consolas, monospace;
    text-align: center;
    white-space: normal;
    cursor: pointer;
  }
  .touch-actions {
    position: fixed;
    right: max(12px, env(safe-area-inset-right));
    bottom: max(14px, env(safe-area-inset-bottom));
    z-index: 24;
    display: grid;
    grid-template-columns: repeat(2, 62px);
    gap: 10px;
    pointer-events: auto;
    touch-action: none;
  }
  .touch-action {
    width: 62px;
    height: 62px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #bfefff;
    background: rgba(60, 160, 200, 0.16);
    border: 1px solid rgba(127, 220, 255, 0.45);
    box-shadow: inset 0 0 18px rgba(80, 216, 255, 0.09), 0 0 20px rgba(80, 216, 255, 0.12);
    font: 700 10.5px/1 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.08em;
    text-shadow: 0 0 8px rgba(127, 220, 255, 0.7);
    -webkit-user-select: none;
    user-select: none;
    touch-action: none;
  }
  .touch-action.danger {
    color: #ffe2cc;
    background: rgba(176, 80, 40, 0.18);
    border-color: rgba(255, 168, 108, 0.5);
    text-shadow: 0 0 8px rgba(255, 150, 92, 0.75);
  }
  @media (max-width: 720px), (pointer: coarse) {
    .metrics-bar {
      left: 8px;
      right: 8px;
      transform: none;
      max-width: none;
      padding: 4px 8px;
      border-radius: 0 0 7px 7px;
      font-size: 10px;
      text-align: center;
    }
    .hud {
      left: max(10px, env(safe-area-inset-left));
      top: 28px;
      max-width: min(62vw, 360px);
    }
    .title {
      font-size: 10px;
      margin-bottom: 7px;
    }
    .meters {
      gap: 5px;
    }
    .meters div {
      min-width: 68px;
      padding: 5px 6px;
    }
    .meters span {
      font-size: 8.5px;
    }
    .meters b {
      font-size: 13px;
    }
    .objective {
      margin-top: 7px;
      max-width: min(62vw, 360px);
      font-size: 10.5px;
      line-height: 1.35;
    }
    .gamepad-debug {
      margin-top: 6px;
      max-width: min(62vw, 360px);
      padding: 5px 6px;
      font-size: 8.5px;
      line-height: 1.3;
    }
    .controller-status {
      bottom: 82px;
      padding: 6px 8px;
      font-size: 8.5px;
    }
    .touch-actions {
      grid-template-columns: repeat(2, 58px);
      gap: 9px;
    }
    .touch-action {
      width: 58px;
      height: 58px;
      font-size: 9.5px;
    }
  }
`;
document.head.appendChild(style);

// --- Smooth flora (hybrid art rule: voxel world, smooth LIFE) ---
const glowcapSway: { group: THREE.Group; phase: number }[] = [];

// (Spot textures retired — John's call: clean satin surfaces, color from glow.)

/** The Reek's flora palette — muted, moss-dark; the GLOW carries the color
 *  (and only when charged). Albedo whispers, phosphorescence speaks. */
const CAP_PALETTE = [
  { cap: 0x16302a, glow: 0x2fe89c, w: 0.46 }, // moss-green
  { cap: 0x122b31, glow: 0x27b8c9, w: 0.29 }, // deep teal
  { cap: 0x201a33, glow: 0x8a5fd6, w: 0.14 }, // dusk violet
  { cap: 0x2b1d10, glow: 0xd98d3f, w: 0.11 }, // ember — the warm pocket
];

/** Phosphorescent shrooms: charged by light exposure, glowing as they fade. */
interface Shroom {
  pos: THREE.Vector3;
  capMat: THREE.MeshStandardMaterial;
  gillMat: THREE.MeshStandardMaterial;
  fogIdx: number;
  charge: number;
}
const shrooms: Shroom[] = [];

// --- Flora hitboxes: vertical cylinders in a spatial hash (8-unit buckets).
// The environment has WEIGHT — you bump a stem, you land on a cap. ---
interface FloraCollider {
  x: number;
  z: number;
  y0: number;
  y1: number;
  r: number;
}
const floraColliders = new Map<string, FloraCollider[]>();
function addFloraCollider(x: number, z: number, y0: number, y1: number, r: number): void {
  const key = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
  let arr = floraColliders.get(key);
  if (!arr) {
    arr = [];
    floraColliders.set(key, arr);
  }
  arr.push({ x, z, y0, y1, r });
}
function floraCollides(p: THREE.Vector3, radius: number): boolean {
  const bx = Math.floor(p.x / 8);
  const bz = Math.floor(p.z / 8);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const arr = floraColliders.get(`${bx + dx},${bz + dz}`);
      if (!arr) continue;
      for (const c of arr) {
        if (p.y + radius < c.y0 || p.y - radius > c.y1) continue;
        const ddx = p.x - c.x;
        const ddz = p.z - c.z;
        const rr = c.r + radius;
        if (ddx * ddx + ddz * ddz < rr * rr) return true;
      }
    }
  }
  return false;
}

/** Organic cap: lathe profile with a curled rim + lumpy displacement.
 *  Three species silhouettes: 0 = bell, 1 = wide flat parasol, 2 = tall spire. */
function makeCapGeometry(capR: number, seed: number, kind = 0): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const STEPS = 9;
  // Species profile: [radius scale, profile exponent, height scale]
  const P = kind === 1 ? [1.35, 0.5, 0.42] : kind === 2 ? [0.62, 1.15, 1.5] : [1, 0.72, 1];
  for (let i = 0; i <= STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 0.52;
    const r = capR * P[0] * Math.pow(Math.sin(a), P[1]);
    let yy = capR * 0.72 * P[2] * Math.cos(a);
    if (i >= STEPS - 1) yy -= capR * 0.09; // rim curls under
    pts.push(new THREE.Vector2(r, yy));
  }
  const geo = new THREE.LatheGeometry(pts, 14);
  // Lumpy, asymmetric — grown, not manufactured.
  const posAttr = geo.attributes.position;
  const vcol = new Float32Array(posAttr.count * 3);
  const maxY = capR * 0.72;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    const n = Math.sin(vx * 5.3 + seed) * Math.cos(vz * 4.7 + seed * 1.7) * 0.05 * capR;
    posAttr.setXYZ(i, vx + n, vy + n * 0.7, vz + n);
    // Crown → rim gradient: pale top, darker curled edge (organic read).
    const t = 1 - Math.max(0, Math.min(1, vy / Math.max(maxY, 1e-3)));
    const shade = 1.15 - 0.6 * t * t;
    vcol[i * 3] = shade;
    vcol[i * 3 + 1] = shade;
    vcol[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(vcol, 3));
  geo.computeVertexNormals();
  return geo;
}
function pickPalette(x: number, z: number) {
  let r = Math.abs(Math.sin(x * 127.1 + z * 311.7)) % 1;
  for (const p of CAP_PALETTE) {
    if (r < p.w) return p;
    r -= p.w;
  }
  return CAP_PALETTE[0];
}

const stemBaseMat = new THREE.MeshStandardMaterial({
  color: 0x574632,
  roughness: 0.85,
  metalness: 0,
  envMapIntensity: 0.15,
});

// --- Flora distance culling ---------------------------------------------
// Thousands of individual flora meshes are the render loop's biggest draw-call
// cost, and past the fog wall none of them are visible anyway. Every placed
// group registers here and is toggled by distance, a slice per frame.
const floraCull: { group: THREE.Group; x: number; z: number }[] = [];
const FLORA_VIEW2 = 130 * 130; // culling radius² — safely past the fog wall
let floraCullCursor = 0;

function registerFlora(group: THREE.Group): void {
  floraCull.push({ group, x: group.position.x, z: group.position.z });
}

function updateFloraCulling(): void {
  if (floraCull.length === 0) return;
  const slice = Math.min(floraCull.length, 500);
  for (let i = 0; i < slice; i++) {
    floraCullCursor = (floraCullCursor + 1) % floraCull.length;
    const f = floraCull[floraCullCursor];
    const dx = f.x - orb.pos.x;
    const dz = f.z - orb.pos.z;
    f.group.visible = dx * dx + dz * dz < FLORA_VIEW2;
  }
}

function makeGlowcap(x: number, y: number, z: number, h: number): void {
  const g = new THREE.Group();
  const pal = pickPalette(x, z);
  const glow = new THREE.Color(pal.glow);
  const tseed = x * 12.9898 + z * 78.233;

  // Stem: earthy and matte, slightly bowed; a whisper of the cap's light.
  const stemR = 0.16 + h * 0.05;
  const stemMat = stemBaseMat.clone();
  stemMat.emissive = glow.clone().multiplyScalar(0.3);
  stemMat.emissiveIntensity = 0.08;
  stemMat.roughness = 0.95;
  stemMat.envMapIntensity = 0.04;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(stemR * 0.7, stemR * 1.6, h, 10), stemMat);
  stem.position.y = h / 2;
  stem.rotation.z = (Math.sin(tseed) % 1) * 0.08;

  // Cap: organic lathe bell — SOLID and satiny. Muted glow lives in the skin
  // itself (no spots); charge is what brings the color up.
  const capR = 0.8 + h * 0.28;
  const mutedGlow = glow.clone().lerp(new THREE.Color(0.5, 0.5, 0.5), 0.3);
  const capMat = new THREE.MeshStandardMaterial({
    color: pal.cap,
    vertexColors: true, // crown→rim gradient baked into the lathe
    emissive: mutedGlow,
    emissiveIntensity: 0.05, // uncharged: barely alive
    roughness: 0.78, // satin: soft broad sheen, never shiny
    metalness: 0,
    envMapIntensity: 0.06,
    side: THREE.DoubleSide, // no see-through shells
  });
  // Species: mostly bells, with parasols and spires mixed through the groves.
  const kindRoll = Math.abs(Math.sin(tseed * 3.7));
  const kind = kindRoll < 0.55 ? 0 : kindRoll < 0.82 ? 1 : 2;
  const cap = new THREE.Mesh(makeCapGeometry(capR, tseed, kind), capMat);
  cap.position.y = h;
  cap.scale.x = 1 + (Math.sin(tseed * 1.7) % 1) * 0.12; // slightly oval

  // Underside: a SOLID dark gill-disc (opaque — the transparency read is gone),
  // with its own faint emissive that follows the charge.
  const gillMat = new THREE.MeshStandardMaterial({
    color: 0x0b1410,
    emissive: mutedGlow,
    emissiveIntensity: 0.04,
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: 0.03,
    side: THREE.DoubleSide,
  });
  const gills = new THREE.Mesh(new THREE.CircleGeometry(capR * 0.9, 18), gillMat);
  gills.rotation.x = -Math.PI / 2;
  gills.position.y = h - 0.04;

  g.add(stem, cap, gills);
  g.rotation.z = (Math.sin(tseed) % 1) * 0.14;
  g.position.set(x + 0.5, y, z + 0.5);
  scene.add(g);
  registerFlora(g);
  glowcapSway.push({ group: g, phase: x * 0.7 + z * 0.31 });
  const fogIdx =
    fogLightRegistry.push({
      pos: new THREE.Vector3(x + 0.5, y + h + 0.8, z + 0.5),
      color: glow.clone().multiplyScalar(1 / Math.max(glow.r, glow.g, glow.b)),
      intensity: 0.04, // dark until charged
    }) - 1;
  shrooms.push({
    pos: new THREE.Vector3(x + 0.5, y + h, z + 0.5),
    capMat,
    gillMat,
    fogIdx,
    charge: 0.15, // a faint residual charge at world-start
  });
  // Hitboxes: the stem you bump, the cap you can land on.
  addFloraCollider(x + 0.5, z + 0.5, y, y + h - 0.3, stemR * 1.5);
  addFloraCollider(x + 0.5, z + 0.5, y + h - 0.35, y + h + capR * 0.45, capR * 0.8);
}

// --- Spore-trees: tall curved trunks, freckled canopy near the roof ---
const barkMat = new THREE.MeshStandardMaterial({
  color: 0x3c3226,
  roughness: 0.95,
  metalness: 0,
  envMapIntensity: 0.1,
});

/** A lumpy organic canopy blob: displaced icosphere, dark and moody. */
function makeCanopyBlob(r: number, seed: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(r, 2);
  const posAttr = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    const n =
      1 +
      Math.sin(v.x * 2.1 + seed) * Math.cos(v.z * 1.8 + seed * 1.3) * 0.18 +
      Math.sin(v.y * 3.2 + seed * 2.1) * 0.1;
    v.multiplyScalar(n);
    posAttr.setXYZ(i, v.x, v.y * 0.55, v.z); // flattened, wind-carved
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

function makeSporeTree(x: number, y: number, z: number, h: number): void {
  const g = new THREE.Group();
  const tseed = Math.abs(Math.sin(x * 3.7 + z * 7.1));

  // Trunk: ONE continuous tube along a gentle S-curve — a grown thing.
  const lean = 0.5 + tseed * 0.8;
  const dirA = tseed * Math.PI * 2;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(Math.cos(dirA) * lean * 0.35, h * 0.35, Math.sin(dirA) * lean * 0.35),
    new THREE.Vector3(Math.cos(dirA + 0.9) * lean * 0.7, h * 0.72, Math.sin(dirA + 0.9) * lean * 0.6),
    new THREE.Vector3(Math.cos(dirA + 1.4) * lean, h, Math.sin(dirA + 1.4) * lean * 0.9),
  ]);
  const trunk = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.3, 7), barkMat);
  // Root flare so it grips the ground instead of poking it.
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.85, 1.1, 9), barkMat);
  flare.position.y = 0.55;
  g.add(trunk, flare);

  // Two branch tubes reaching up-and-out from the upper trunk.
  for (let b = 0; b < 2; b++) {
    const bt = 0.55 + b * 0.22;
    const start = curve.getPoint(bt);
    const ba = dirA + 2.1 + b * 2.4;
    const branch = new THREE.CatmullRomCurve3([
      start,
      start.clone().add(new THREE.Vector3(Math.cos(ba) * 1.1, h * 0.12, Math.sin(ba) * 1.1)),
      start.clone().add(new THREE.Vector3(Math.cos(ba) * 2.0, h * 0.3, Math.sin(ba) * 2.0)),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(branch, 6, 0.11, 5), barkMat));
  }

  // Canopy: dark, lumpy, desaturated — reads as foliage mass in the gloom,
  // with the faintest freckle-glow (spores nesting in it).
  const pal = pickPalette(x, z);
  const glow = new THREE.Color(pal.glow);
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x0d1d18,
    emissive: glow.clone().lerp(new THREE.Color(0.5, 0.5, 0.5), 0.3),
    emissiveIntensity: 0.05,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.03,
  });
  const top = curve.getPoint(1);
  for (let i = 0; i < 3; i++) {
    const cr = 1.9 + tseed * 1.0 + i * 0.3;
    const blob = makeCanopyBlob(cr, tseed * 7 + i * 3.1, canopyMat);
    blob.position.set(
      top.x + Math.sin(i * 2.4 + tseed * 9) * cr * 0.45,
      top.y - 0.6 + i * 0.5,
      top.z + Math.cos(i * 2.1 + tseed * 5) * cr * 0.4,
    );
    g.add(blob);
  }
  g.position.set(x + 0.5, y, z + 0.5);
  scene.add(g);
  registerFlora(g);
  // Mycelium hangs from the canopy: 2–4 strands dripping off the undersides,
  // gravity-plumb in WORLD space (they must not tilt with the tree's sway).
  const strandCount = 2 + Math.floor(tseed * 3);
  for (let s = 0; s < strandCount; s++) {
    const sa = tseed * 11 + s * 2.4;
    const sr = 1.2 + Math.abs(Math.sin(sa * 3.7)) * 1.6;
    const sx = x + 0.5 + top.x + Math.cos(sa) * sr;
    const sz = z + 0.5 + top.z + Math.sin(sa) * sr;
    const sy = y + top.y - 0.7 - Math.abs(Math.sin(sa * 1.9)) * 0.6;
    makeStrandAt(sx, sy, sz, 1.4 + Math.abs(Math.sin(sa * 5.1)) * 2.2);
  }
  glowcapSway.push({ group: g, phase: x * 0.23 + z * 0.11 });
  fogLightRegistry.push({
    pos: new THREE.Vector3(x, y + h, z),
    color: glow.clone().multiplyScalar(1 / Math.max(glow.r, glow.g, glow.b)),
    intensity: 0.15,
  });
  // Hitboxes: trunk column + the canopy mass.
  addFloraCollider(x + 0.5, z + 0.5, y, y + h, 0.5);
  addFloraCollider(x + 0.5, z + 0.5, y + h - 1.2, y + h + 2.2, 2.4);
}

// --- Button-caps: tiny ground fungi in clumps (silhouette #2) ---
function makeButtons(x: number, y: number, z: number): void {
  const g = new THREE.Group();
  const pal = pickPalette(x, z);
  const glow = new THREE.Color(pal.glow);
  const n = 3 + Math.floor(Math.abs(Math.sin(x * 5.7 + z * 3.1)) * 3);
  const mat = new THREE.MeshStandardMaterial({
    color: pal.cap,
    emissive: glow.clone().lerp(new THREE.Color(0.5, 0.5, 0.5), 0.35),
    emissiveIntensity: 0.4, // always faintly alive — noticeable, never a lamp
    roughness: 0.85,
    metalness: 0,
    envMapIntensity: 0.04,
  });
  for (let i = 0; i < n; i++) {
    const s = Math.abs(Math.sin(x * 3.3 + i * 7.9));
    const r = 0.1 + s * 0.16;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    cap.scale.y = 0.75;
    cap.position.set(
      (Math.abs(Math.sin(i * 12.3 + z)) - 0.5) * 1.4,
      0.02 + s * 0.22,
      (Math.abs(Math.sin(i * 9.1 + x)) - 0.5) * 1.4,
    );
    g.add(cap);
  }
  g.position.set(x + 0.5, y, z + 0.5);
  scene.add(g);
  registerFlora(g);
}

// --- Hanging mycelium strands: gravity-hung, pendulum sway, spore-ball beads.
// Strands anchor to a point (ceiling OR tree canopy) and hang PLUMB — a
// near-vertical drop with a slight catenary drift, beads swelling toward the
// tip. Sway is a pendulum: longer strands swing slower (√(g/L)), tiny angles.
const strandSway: { group: THREE.Group; phase: number; rate: number; amp: number }[] = [];

function makeStrandAt(px: number, py: number, pz: number, len: number): void {
  const g = new THREE.Group();
  const pal = pickPalette(Math.floor(px), Math.floor(pz));
  const glow = new THREE.Color(pal.glow);
  const drift = 0.06 + Math.abs(Math.sin(px * 1.7 + pz * 2.3)) * 0.12; // slight lean
  const dirA = Math.abs(Math.sin(px * 3.1 + pz * 1.3)) * Math.PI * 2;
  // Gravity: straight down, drift growing quadratically (catenary-ish tail).
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(Math.cos(dirA) * drift * 0.25, -len * 0.5, Math.sin(dirA) * drift * 0.25),
    new THREE.Vector3(Math.cos(dirA) * drift, -len, Math.sin(dirA) * drift),
  ]);
  const strandMat = new THREE.MeshStandardMaterial({
    color: 0x2a3a30,
    emissive: glow,
    emissiveIntensity: 0.32, // hanging strands: always a soft, faint glow
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: 0.03,
  });
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 6, 0.03, 4), strandMat));
  // Spore balls: beads along the strand, swelling toward the tip.
  const beadMat = new THREE.MeshStandardMaterial({
    color: 0x0c1512,
    emissive: glow,
    emissiveIntensity: 0.6, // spore-ball tips: soft, below the bloom threshold
    roughness: 0.6,
    metalness: 0,
  });
  const beadTs = [0.45, 0.72, 1.0];
  for (let i = 0; i < beadTs.length; i++) {
    const r = 0.04 + i * 0.035 + len * 0.008; // tip bead is the fattest
    const bead = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), beadMat);
    bead.position.copy(curve.getPoint(beadTs[i]));
    g.add(bead);
  }
  g.position.set(px, py, pz);
  scene.add(g);
  registerFlora(g);
  // Pendulum: ω = √(g/L) scaled way down; longer = slower + smaller angle.
  strandSway.push({
    group: g,
    phase: px * 0.5 + pz * 0.7,
    rate: Math.sqrt(9.8 / Math.max(len, 0.5)) * 0.35,
    amp: 0.1 / (0.8 + len * 0.4),
  });
}

function makeStrand(x: number, ceilingY: number, z: number, len: number): void {
  makeStrandAt(x + 0.5, ceilingY, z + 0.5, len);
}

// --- Shelf mycelium: plates jutting from cave walls (silhouette #4) ---
function makeShelf(x: number, y: number, z: number, dx: number, dz: number): void {
  const g = new THREE.Group();
  const pal = pickPalette(Math.floor(x), Math.floor(z));
  const glow = new THREE.Color(pal.glow);
  const mat = new THREE.MeshStandardMaterial({
    color: pal.cap,
    emissive: glow.clone().lerp(new THREE.Color(0.5, 0.5, 0.5), 0.35),
    emissiveIntensity: 0.22,
    roughness: 0.85,
    metalness: 0,
    envMapIntensity: 0.04,
  });
  const facing = Math.atan2(dx, dz);
  const n = 2 + Math.floor(Math.abs(Math.sin(x * 7.7 + z * 3.9)) * 2);
  for (let i = 0; i < n; i++) {
    const r = 0.45 + Math.abs(Math.sin(x * 2.1 + i * 5.3)) * 0.5;
    // A squashed ellipsoid; its back half buries into the wall.
    const plate = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 7), mat);
    plate.scale.set(0.95, 0.22, 0.62);
    plate.rotation.y = facing;
    plate.position.set(dx * (0.15 + i * 0.08), i * 0.42, dz * (0.15 + i * 0.08));
    g.add(plate);
  }
  g.position.set(x, y, z);
  scene.add(g);
  registerFlora(g);
}

// --- Reek-grass: collected during generation, instanced after (1 draw call) ---
const grassSpots: [number, number, number][] = [];

/**
 * The exact height of the SMOOTH terrain skin at a column — the same density
 * crossing the surface-nets mesher extracts. Everything that stands on the
 * ground (grass, flora, pickups) is seated on THIS, not on voxel tops.
 */
function smoothSurfaceY(x: number, z: number, yHint: number): number {
  const dAt = (y: number) => {
    let s = 0;
    for (let dy = -1; dy <= 0; dy++) {
      for (let dz = -1; dz <= 0; dz++) {
        for (let dx = -1; dx <= 0; dx++) {
          if (world.solid(x + dx, y + dy, z + dz)) s++;
        }
      }
    }
    return s / 8;
  };
  let upper = dAt(yHint + 3);
  for (let y = yHint + 3; y > yHint - 4; y--) {
    const lower = dAt(y - 1);
    if (lower >= 0.5 && upper < 0.5) {
      const t = (lower - 0.5) / Math.max(lower - upper, 1e-4);
      return y - 1 + t;
    }
    upper = lower;
  }
  return yHint;
}

// --- Initialize infinite streaming world ---
const REEK_SEED = 20250703;
// Optimized for performance: reduce initial generation, stream the rest.
// 256×256 = 512²; was causing 30fps. Scale back, rely on streaming for expansion.
const REEK_HALF_INIT = 128; // 256×256 voxel initial area (was 512×512 = too much upfront)

// Hook for POI callbacks
const reekHooks = {
  grove: (x: number, y: number, z: number, h: number) =>
    makeGlowcap(x, smoothSurfaceY(x, z, y) - 0.08, z, h),
  crystalLight: (x: number, y: number, z: number) =>
    fogLightRegistry.push({
      pos: new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5),
      color: new THREE.Color(0.55, 0.4, 0.95),
      intensity: 0.5,
    }),
  pickup: (x: number, y: number, z: number) =>
    addPickup(x, smoothSurfaceY(Math.floor(x), Math.floor(z), Math.floor(y)) + 1.3, z),
  grass: (x: number, y: number, z: number) =>
    grassSpots.push([x, smoothSurfaceY(x, z, y) - 0.06, z]),
  tree: (x: number, y: number, z: number, h: number) =>
    makeSporeTree(x, smoothSurfaceY(x, z, y) - 0.15, z, h),
  buttons: (x: number, y: number, z: number) =>
    makeButtons(x, smoothSurfaceY(x, z, y) - 0.04, z),
  strand: (x: number, cy: number, z: number, len: number) =>
    makeStrand(x, cy, z, len),
  shelf: (x: number, y: number, z: number, dx: number, dz: number) =>
    makeShelf(x, y, z, dx, dz),
};

// Generate the large initial area with full POI placement.
console.info(`[world] Generating initial ${REEK_HALF_INIT * 2}×${REEK_HALF_INIT * 2} voxel area...`);
const reek = generateReek(world, REEK_SEED, REEK_HALF_INIT, reekHooks);
console.info(`[world] Initial area loaded. Chunks: ${world.chunks.size}`);

lightGrid.update();
remeshDirtyChunks();

// Grass builds AFTER the light flood so each tuft bakes its held light.
const grassField = new GrassField();
for (const [gx0, gy0, gz0] of grassSpots) {
  grassField.addTuft(gx0, gy0, gz0, lightGrid.sample(gx0, gy0 + 1, gz0) / 15);
}
const bladeCount = grassField.build(scene);
console.info(`[grass] ${bladeCount} blades`);
orb.spawn(reek.spawn[0], reek.spawn[1], reek.spawn[2]);
if (boot) boot.remove();

function box(x: number, y: number, z: number, w: number, h: number, d: number, m: Mat): void {
  for (let ix = x; ix < x + w; ix++) {
    for (let iy = y; iy < y + h; iy++) {
      for (let iz = z; iz < z + d; iz++) world.set(ix, iy, iz, m);
    }
  }
}

function addPickup(x: number, y: number, z: number): void {
  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.38, 1),
    new THREE.MeshBasicMaterial({
      color: 0x8dffd2,
      transparent: true,
      opacity: 0.88,
    }),
  );
  mesh.position.set(x, y, z);
  scene.add(mesh);
  pickups.push({ mesh, pos: mesh.position.clone(), taken: false });
}

function placeWard(): void {
  if (spores < 3) {
    objective = 'Gather more glowspores before the first ward can hold.';
    return;
  }
  spores -= 3;
  const x = Math.round(orb.pos.x);
  const z = Math.round(orb.pos.z);
  // Sink the glow INTO the floor (replace its top voxels) — never build a
  // platform at the orb's feet, which wedged the player inside solid ground.
  let floorY = Math.floor(orb.pos.y);
  while (floorY > -6 && !world.solid(x, floorY, z)) floorY--;
  box(x - 1, floorY, z - 1, 3, 1, 3, Mat.Glowcap);
  lightGrid.update();
  remeshDirtyChunks();

  const pos = new THREE.Vector3(x + 0.5, floorY + 2.3, z + 0.5);
  const light = new THREE.PointLight(0x7fffd1, 3.4, 24, 1.4);
  light.position.copy(pos);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.75, 24, 14),
    new THREE.MeshBasicMaterial({
      color: 0x9dffd8,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
    }),
  );
  core.position.copy(pos);
  // The dome: a soft, breathing shell of light showing exactly where the
  // ward's protection reaches. The safe zone is VISIBLE, not implied.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(WARD_RADIUS, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x7fffd1,
      transparent: true,
      opacity: 0.045,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  dome.position.set(pos.x, pos.y - 2.3, pos.z);
  scene.add(light, core, dome);
  wards.push({ pos, light, core, dome });
  fogLightRegistry.push({
    pos: pos.clone(),
    color: new THREE.Color(0.5, 1.0, 0.82),
    intensity: 1.3, // your held light owns the air around it
  });
  mood.event('joy'); // made light — the proudest feeling the orb knows
  objective =
    'The ward holds a circle of light: inside its dome the dark cannot drain you, and your Lumen refills. Press T to test it against a tide.';
}

function startTide(): void {
  tide = 1;
  mood.event('fear'); // heard-before-seen — the orb goes cold before you do
  objective = 'The first Dark Tide is here. Stay near held light.';
}

/**
 * Rebuild meshes for dirty chunks. `maxChunks` spreads the work over frames
 * for the budgeted callers; the startup call runs unbudgeted so the whole
 * area exists before the first frame. NEVER frustum-cull here — a chunk
 * skipped "because it's off-screen" but marked clean simply never appears
 * (that was the missing-floor bug). Visibility is the render loop's job.
 */
function remeshDirtyChunks(maxChunks = Infinity): void {
  const CS = World.chunkSize;
  let meshed = 0;
  for (const c of world.chunks.values()) {
    if (!c.dirty) continue;
    if (meshed >= maxChunks) break;

    const old = chunkMeshes.get(c);
    if (old) {
      scene.remove(old);
      old.geometry.dispose();
    }
    const geo = smoothTerrain
      ? buildSmoothChunkGeometry(world, lightGrid, c)
      : buildChunkGeometry(world, lightGrid, c);
    if (geo) {
      const mesh = new THREE.Mesh(geo, worldMaterial);
      // Both meshers bake WORLD coordinates into the geometry, so the mesh
      // stays at the origin. Offsetting by the chunk origin here would double
      // it — distant chunks fly out, underground chunks drop below the floor.
      mesh.position.set(0, 0, 0);
      // Precompute the chunk's world AABB once (±1 pad for the smooth mesher's
      // bulge) so per-frame frustum culling is a cheap box test, not a full
      // per-vertex bounds rebuild every frame.
      mesh.userData.aabb = new THREE.Box3(
        new THREE.Vector3(c.cx * CS - 1, c.cy * CS - 1, c.cz * CS - 1),
        new THREE.Vector3((c.cx + 1) * CS + 1, (c.cy + 1) * CS + 1, (c.cz + 1) * CS + 1),
      );
      chunkMeshes.set(c, mesh);
      scene.add(mesh);
    } else {
      chunkMeshes.delete(c);
    }
    c.dirty = false;
    meshed++;
  }
}

function nearestWardDistance(): number {
  let best = Infinity;
  for (const ward of wards) best = Math.min(best, ward.pos.distanceTo(orb.pos));
  return best;
}

function updateHud(): void {
  const lumen = document.querySelector<HTMLSpanElement>('#lumen');
  const energy = document.querySelector<HTMLSpanElement>('#energy');
  const sporeEl = document.querySelector<HTMLSpanElement>('#spores');
  const obj = document.querySelector<HTMLDivElement>('#objective');
  const gamepadDebug = document.querySelector<HTMLDivElement>('#gamepad-debug');
  const padStatus = input.debugGamepadStatus();
  if (lumen) lumen.textContent = Math.round(orb.lumen).toString();
  if (energy) energy.textContent = Math.round(orb.energy).toString();
  if (sporeEl) sporeEl.textContent = spores.toString();
  if (obj) obj.textContent = objective;
  if (gamepadDebug) gamepadDebug.textContent = padStatus;
  controllerStatus.textContent = `Controller: ${padStatus}`;
}

function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  input.update(dt); // poll gamepad + decay wheel impulses

  // Frustum culling: hide chunks outside camera view — a cheap test against
  // each chunk's precomputed world AABB (no per-vertex bounds rebuild).
  cullMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  cullFrustum.setFromProjectionMatrix(cullMatrix);
  for (const mesh of chunkMeshes.values()) {
    mesh.visible = cullFrustum.intersectsBox(mesh.userData.aabb as THREE.Box3);
  }

  // Horizontal: drag right → yaw left (John's tested preference, R2).
  // Vertical: drag up → look up. Deltas move the target; view eases in.
  const orbit = input.consumeOrbit();
  yawTarget -= orbit.dx * CameraConfig.orbitSpeed;
  pitchTarget = THREE.MathUtils.clamp(
    pitchTarget + orbit.dy * CameraConfig.orbitSpeed,
    CameraConfig.minPitch,
    CameraConfig.maxPitch,
  );
  const lookEase = Math.min(1, dt * CameraConfig.lookSmoothing);
  yaw += (yawTarget - yaw) * lookEase;
  pitch += (pitchTarget - pitch) * lookEase;
  const actions = input.consumeActions();

  if (actions.pulse && orb.canPulse()) {
    orb.spendPulse();
    pulseActive = true;
    pulseRadius = 0;
    pulseCenter.copy(orb.pos);
    pulseFlash = 1; // the orb visibly surges as the wave leaves it
    objective = spores >= 3 ? objective : 'Pulse through the mist. Glowspores answer your light.';
  }
  if (actions.buildWard) placeWard();
  if (actions.tide) startTide();

  orb.pulseRate = mood.pulseRate;
  orb.update(dt, input.moveVector(), yaw, actions.jump, input.sprinting());
  if (orb.jumped) {
    pulseFlash = Math.max(pulseFlash, 0.55); // wave-jump = a small pulse
    mood.event('effort');
  }
  if (actions.dash) mood.event('effort'); // sprint start still reads as effort
  // Landing: a quick squash — weight without weight.
  if (!wasGrounded && orb.grounded) landSquash = 1;
  wasGrounded = orb.grounded;
  landSquash = Math.max(0, landSquash - dt * 6);
  mood.update(dt);

  pulseFlash = Math.max(0, pulseFlash - dt * 3.5); // fast decay after the surge
  const flashBoost = 1 + 1.8 * pulseFlash;
  orbGroup.position.copy(orb.pos);
  // The black body stays solid — the AURA is what breathes, surges, squashes.
  orbGroup.scale.setScalar(1);
  // Lean into motion — the body language of intent (gaze-proxy via lean).
  orbGroup.rotation.z = THREE.MathUtils.clamp(-orb.vel.x * 0.011, -0.22, 0.22);
  orbGroup.rotation.x = THREE.MathUtils.clamp(orb.vel.z * 0.011, -0.22, 0.22);
  const haloBase = (1.05 + Math.sin(clock.elapsedTime * 2.7) * 0.06) * orb.breathGlow * flashBoost;
  orbHalo.scale.set(
    haloBase * (1 + 0.2 * landSquash),
    haloBase * (1 - 0.32 * landSquash),
    haloBase * (1 + 0.2 * landSquash),
  );
  const haloMat = orbHalo.material as THREE.MeshBasicMaterial;
  haloMat.color.copy(mood.color);
  haloMat.opacity = 0.3 * orb.breathGlow * flashBoost * mood.brightness;
  const auraMat = orbAura.material as THREE.SpriteMaterial;
  auraMat.color.copy(mood.color);
  auraMat.opacity = 0.55 * orb.breathGlow * mood.brightness;
  orbAura.scale.setScalar(3.4 * orb.breathGlow * flashBoost);
  orbLight.position.copy(orb.pos);
  orbLight.color.copy(mood.color);
  orbLight.intensity = 2.4 * orb.breathGlow * flashBoost * mood.brightness;

  for (const p of pickups) {
    if (p.taken) continue;
    p.mesh.rotation.y += dt * 1.8;
    p.mesh.position.y = p.pos.y + Math.sin(clock.elapsedTime * 2.3 + p.pos.x) * 0.18;
    if (p.mesh.position.distanceTo(orb.pos) < 1.45) {
      p.taken = true;
      spores += 1;
      scene.remove(p.mesh);
      mood.event('joy'); // found light — the orb flushes warm gold
      objective = spores >= 3 ? 'Enough glowspores. Shape the first ward.' : 'The Reek gives light back.';
    }
  }

  if (pulseActive) {
    pulseRadius += LightConfig.pulse.speed * dt;
    if (pulseRadius > LightConfig.pulse.maxRadius) pulseActive = false;
  }
  // The visible wavefront: expands with the light ring, fading as it thins.
  if (pulseActive && pulseRadius > 0.01) {
    const t = pulseRadius / LightConfig.pulse.maxRadius;
    pulseShell.visible = true;
    pulseShell.position.copy(pulseCenter);
    pulseShell.scale.setScalar(pulseRadius);
    (pulseShell.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - t);
  } else {
    pulseShell.visible = false;
  }

  if (tide > 0) {
    tide = Math.max(0, tide - dt * 0.08);
    mood.setThreat(Math.sin(Math.min(1, tide) * Math.PI)); // sustained dread
    const protectedByWard = nearestWardDistance() < WARD_RADIUS;
    if (!protectedByWard) {
      orb.lumen = Math.max(0, orb.lumen - dt * 10);
      objective = 'The dark drains fast away from held light.';
    } else if (tide < 0.35) {
      objective = 'The tide breaks against the ward. The loop is alive.';
    }
  } else {
    orb.lumen = Math.min(100, orb.lumen + dt * (nearestWardDistance() < WARD_RADIUS ? 8 : 2));
  }

  // --- Phosphorescence: glowcaps charge under light, glow as they fade. ---
  // Orb proximity trickle-charges; the PULSE charges hard as its shell passes
  // — so pulsing through a grove paints a lit path to travel by.
  for (const s of shrooms) {
    const d = s.pos.distanceTo(orb.pos);
    if (d < 9) s.charge += dt * 0.45 * (1 - d / 9);
    if (pulseActive) {
      const pd = s.pos.distanceTo(pulseCenter);
      if (Math.abs(pd - pulseRadius) < 3.2) s.charge += dt * 4.5;
    }
    if (s.charge > 1) s.charge = 1;
    s.charge *= Math.exp(-dt / 30); // ~30s afterglow, like real phosphor paint
    s.capMat.emissiveIntensity = 0.05 + s.charge * 0.85;
    s.gillMat.emissiveIntensity = 0.04 + s.charge * 0.6;
    fogLightRegistry[s.fogIdx].intensity = 0.04 + s.charge * 0.65;
  }

  for (const ward of wards) {
    const breathe = 1 + Math.sin(clock.elapsedTime * 2.1 + ward.pos.x) * 0.08;
    ward.core.scale.setScalar(breathe);
    ward.light.intensity = 2.8 + breathe * 0.8;
    // The dome breathes faintly; when a tide presses and you shelter inside,
    // it flares — you SEE the ward holding the dark off.
    const domeMat = ward.dome.material as THREE.MeshBasicMaterial;
    const sheltering = tide > 0 && ward.pos.distanceTo(orb.pos) < WARD_RADIUS;
    const press = tide > 0 ? Math.sin(Math.min(1, tide) * Math.PI) : 0;
    domeMat.opacity = sheltering
      ? 0.1 + 0.1 * press + 0.03 * Math.sin(clock.elapsedTime * 6)
      : 0.03 + 0.02 * breathe;
  }

  uniforms.uOrbPos.value.copy(orb.pos);
  uniforms.uOrbColor.value.copy(mood.color); // the orb's mood paints the world
  uniforms.uOrbIntensity.value = LightConfig.orbIntensity * orb.breathGlow * flashBoost * mood.brightness;
  uniforms.uPulseCenter.value.copy(pulseCenter);
  uniforms.uPulseRadius.value = pulseActive ? pulseRadius : -1;
  uniforms.uPulseIntensity.value = pulseActive ? LightConfig.pulse.intensity : 0;

  const veilMaterial = tideVeil.material as THREE.MeshBasicMaterial;
  veilMaterial.opacity = tide > 0 ? 0.48 * Math.sin(tide * Math.PI) : 0;
  tideVeil.position.copy(orb.pos);

  // --- The sky: moon orbits slowly, phases over ~8 min, and its light only
  // lands when the CPU-side cloud check says the moon is in a clear pocket.
  const skyT = clock.elapsedTime;
  const az = skyT * 0.006 + 2.1;
  const el = 0.55 + 0.3 * Math.sin(skyT * 0.004);
  moonDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
  const moonPhase = (skyT / 480) % 1; // full cycle every 8 minutes
  sky.update(skyT, camera.position, moonDir, moonPhase);
  const phaseBright = 0.25 + 0.75 * (0.5 - 0.5 * Math.cos(moonPhase * Math.PI * 2));
  const moonClear = 1 - cloudCoverAt(moonDir, skyT);
  // The Dark Tide smothers even the moon — the sky itself goes hostile.
  const moonTarget =
    moonClear * phaseBright * 0.42 * (tide > 0 ? 1 - 0.85 * Math.sin(Math.min(1, tide) * Math.PI) : 1);
  moonI += (moonTarget - moonI) * Math.min(1, dt * 0.8); // clouds drift, light eases
  uniforms.uMoonDir.value.copy(moonDir);
  uniforms.uMoonI.value = moonI;
  grassField.uniforms.uMoonI.value = moonI;

  // God-rays: project the moon to screen; rays fire only when it's ahead of
  // the camera and the clouds are open (moonI already folds in phase + cover).
  moonWorld.copy(camera.position).addScaledVector(moonDir, 400);
  moonNdc.copy(moonWorld).project(camera);
  const camFwd = tempVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const moonAhead = camFwd.dot(moonDir) > 0.15 && moonNdc.z < 1;
  moonScreen.set(moonNdc.x * 0.5 + 0.5, moonNdc.y * 0.5 + 0.5);
  godRays.setMoon(
    moonScreen,
    moonAhead ? 0.6 + 3.4 * moonI : 0, // even a dim moon spears through
    camera.aspect,
  );
  fogPass.setOrb(orb.pos); // low fog parts around the orb
  fogPass.setMoon(moonI); // fog banks silver under an open moon

  // --- Fog lights: orb in slot 0, then the nearest world lights. During a
  // tide the mist itself recoils — the air dims with the world. And when a
  // pulse fires, the whole atmosphere blooms for a breath.
  fogPass.setBoost(1 + 0.45 * pulseFlash); // a breath of bloom, not a floodlight
  const tideDim = tide > 0 ? 1 - 0.7 * Math.sin(tide * Math.PI) : 1;
  fogPass.lightPos[0].copy(orb.pos);
  fogPass.lightColor[0].copy(mood.color); // even the air takes the orb's mood
  fogPass.lightIntensity[0] = 1.15 * orb.breathGlow * flashBoost * tideDim * mood.brightness;
  const sorted = fogLightRegistry
    .map((l) => ({ l, d: l.pos.distanceToSquared(orb.pos) }))
    .sort((a, b) => a.d - b.d);
  for (let i = 1; i < MAX_FOG_LIGHTS; i++) {
    const entry = sorted[i - 1];
    if (entry) {
      fogPass.lightPos[i].copy(entry.l.pos);
      fogPass.lightColor[i].copy(entry.l.color);
      fogPass.lightIntensity[i] = entry.l.intensity * tideDim;
    } else {
      fogPass.lightIntensity[i] = 0;
    }
  }

  updateTrail(dt);
  updateSpores(dt, clock.elapsedTime);
  // The grass field: wind + parts around the orb + ripples with the pulse.
  grassField.update(
    clock.elapsedTime,
    orb.pos,
    mood.color,
    pulseCenter,
    pulseActive ? pulseRadius : -1,
    pulseActive ? LightConfig.pulse.intensity : 0,
  );
  // Flora sway: slow, irregular, alive.
  for (const s of glowcapSway) {
    s.group.rotation.z =
      Math.sin(clock.elapsedTime * 0.55 + s.phase) * 0.035 +
      Math.sin(clock.elapsedTime * 1.3 + s.phase * 2.1) * 0.012;
  }
  // Strand pendulums: gravity-true — anchored at the top, swinging with
  // their own period (longer = slower), in two slightly detuned axes so the
  // motion traces a lazy ellipse, never a metronome.
  for (const s of strandSway) {
    s.group.rotation.z = Math.sin(clock.elapsedTime * s.rate + s.phase) * s.amp;
    s.group.rotation.x = Math.sin(clock.elapsedTime * s.rate * 0.93 + s.phase * 1.7) * s.amp * 0.7;
  }
  updateFloraCulling();
  updateCamera(dt);
  updateHud();
  renderer.info.reset();
  // Depth prepass ONLY feeds the volumetric fog/god-rays. With those off it's a
  // whole wasted scene render per frame, so skip it entirely.
  if (VOLUMETRICS_ON) {
    camera.layers.set(0);
    scene.overrideMaterial = depthPrepassMat; // depth-only: no lit shader, no color
    renderer.setRenderTarget(depthRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
  }
  // ALWAYS render the full composite with every layer on (the sky and other
  // non-terrain objects live on higher layers — the prepass narrows to layer 0
  // and this restores it, so it must run whether or not the prepass did).
  camera.layers.enableAll();
  composer.render();

  // Metrics strip (throttled to 4 Hz so it doesn't churn the DOM).
  fpsEma += (1 / Math.max(dt, 1e-4) - fpsEma) * 0.06;
  metricsTimer += dt;
  let metricsFresh = false;
  if (metricsTimer > 0.25) {
    metricsFresh = true;
    metricsTimer = 0;
    const info = renderer.info.render;
    const padStatus = input.debugGamepadStatus();
    metricsBar.textContent =
      `${fpsEma.toFixed(0)} fps · ${(1000 / Math.max(fpsEma, 1)).toFixed(1)} ms · ` +
      `${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · ` +
      `${chunkMeshes.size} chunks · ${fogLightRegistry.length + 1} lights` +
      (qualityTier > 0 ? ` · Q${qualityTier}` : '') +
      ` · ${padStatus}`;
  }

  if (metricsFresh && (window.innerWidth < 720 || window.matchMedia('(pointer: coarse)').matches)) {
    const info = renderer.info.render;
    const padStatus = input.debugGamepadStatus();
    metricsBar.textContent =
      `${fpsEma.toFixed(0)} fps | ${(1000 / Math.max(fpsEma, 1)).toFixed(1)} ms | ` +
      `${(info.triangles / 1000).toFixed(0)}k tri | Q${qualityTier} | ${padStatus}`;
  }

  // Adaptive step-down: sustained low fps drops one tier at a time.
  if (fpsEma < 35 && qualityTier < 2) {
    lowFpsTime += dt;
    if (lowFpsTime > 2.5) {
      qualityTier++;
      lowFpsTime = 0;
      applyQualityTier();
    }
  } else {
    lowFpsTime = Math.max(0, lowFpsTime - dt);
  }
}

const camOrigin = new THREE.Vector3();
const camDir = new THREE.Vector3();

function updateCamera(dt: number): void {
  const distance = CameraConfig.distance;
  const height = CameraConfig.height;
  tempVec.set(
    orb.pos.x + Math.sin(yaw) * Math.cos(pitch) * distance,
    orb.pos.y + height + Math.sin(pitch) * distance,
    orb.pos.z + Math.cos(yaw) * Math.cos(pitch) * distance,
  );

  // Collision: march from just above the orb toward the desired position and
  // stop short of the first solid voxel — the camera never leaves the level.
  camOrigin.set(orb.pos.x, orb.pos.y + 1.6, orb.pos.z);
  camDir.copy(tempVec).sub(camOrigin);
  const want = camDir.length();
  camDir.normalize();
  let reach = want;
  for (let d = 0.75; d <= want; d += 0.35) {
    const px = camOrigin.x + camDir.x * d;
    const py = camOrigin.y + camDir.y * d;
    const pz = camOrigin.z + camDir.z * d;
    if (world.solid(Math.floor(px), Math.floor(py), Math.floor(pz))) {
      // Wider margin: the smooth skin bulges up to ~0.5 past voxel bounds.
      reach = Math.max(1.5, d - 1.4);
      break;
    }
  }
  tempVec.copy(camOrigin).addScaledVector(camDir, reach);
  // Floor safety: the camera may drop LOW behind the orb (so you can tilt up
  // and drink in the sky) but never sinks below the ground beneath it. Probe
  // straight down from the desired spot to the first solid, and sit above it.
  {
    const cxf = Math.floor(tempVec.x);
    const czf = Math.floor(tempVec.z);
    let groundY = -Infinity;
    for (let gy = Math.ceil(tempVec.y); gy > tempVec.y - 14; gy--) {
      if (world.solid(cxf, gy, czf)) {
        groundY = gy + 1;
        break;
      }
    }
    if (groundY > -Infinity) tempVec.y = Math.max(tempVec.y, groundY + 0.6);
  }

  // Chase faster when the camera is being pushed in by a wall, so it doesn't
  // linger inside geometry while lerping.
  const chase = reach < want ? CameraConfig.followLerp * 2.5 : CameraConfig.followLerp;
  camera.position.lerp(tempVec, Math.min(1, dt * chase));
  // If the lerp still left us inside a solid (fast orbit into a pillar), snap.
  if (
    world.solid(
      Math.floor(camera.position.x),
      Math.floor(camera.position.y),
      Math.floor(camera.position.z),
    )
  ) {
    camera.position.copy(tempVec);
  }
  camera.lookAt(orb.pos.x, orb.pos.y + 2.2, orb.pos.z);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (qualityTier === 1) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.3));
  } else if (qualityTier >= 2) {
    renderer.setPixelRatio(1);
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  const ratio = renderer.getPixelRatio();
  composer.setPixelRatio(ratio);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
  depthRT.setSize(Math.floor((window.innerWidth * ratio) / 2), Math.floor((window.innerHeight * ratio) / 2));
});

frame();

// Dev console handle (GDD §8c sandbox tooling): drive the camera / fire actions
// deterministically from the console or automation.
(window as unknown as { waiver: unknown }).waiver = {
  setView(y: number, p: number): void {
    yaw = yawTarget = y;
    pitch = pitchTarget = p;
  },
  pulse(): void {
    pulseActive = true;
    pulseRadius = 0;
    pulseCenter.copy(orb.pos);
  },
  teleport(x: number, y: number, z: number): void {
    orb.pos.set(x, y, z);
  },
  tide: startTide,
  ward: placeWard,
  read: () => ({
    orb: orb.pos.toArray(),
    yaw,
    pitch,
    spores,
    lumen: orb.lumen,
  }),
  scene, // dev: inspect the scene graph from the console
  camera, // dev: inspect view state
  renderer, // dev: render-path bisection
  composer, // dev: render-path bisection
  fog: fogPass, // dev: live-tune volumetric uniforms
  smooth(v: boolean): void {
    // The grain benchmark: A/B smooth vs blocky terrain live.
    smoothTerrain = v;
    uniforms.uVoxelDetail.value = v ? 0 : 1; // seams/blocky tint only on blocky
    for (const c of world.chunks.values()) c.dirty = true;
    const t0 = performance.now();
    remeshDirtyChunks();
    console.info(`[terrain] ${v ? 'smooth' : 'blocky'} remesh in ${(performance.now() - t0).toFixed(0)}ms`);
  },
};
