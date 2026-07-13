import { assert, dumpLogs, logger, setLogLevel, type LogLevel } from './core/log';
import { DevOverlay } from './ui/DevOverlay';

// Global error trap. Keeps the tab-title breadcrumb (the vite console can drown
// real errors in HMR reconnect spam, and the phones we test on have no console
// at all), and also routes through the logger + a crash overlay once one exists.
const bootLog = logger('boot');
let crashSink: ((err: unknown, message?: string) => void) | null = null;
window.addEventListener('error', (e) => {
  document.title = `wAIver ERR: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`;
  bootLog.error('uncaught', e.error ?? e.message);
  crashSink?.(e.error ?? new Error(e.message), 'An unexpected error interrupted the game.');
});
window.addEventListener('unhandledrejection', (e) => {
  document.title = `wAIver REJ: ${String(e.reason).slice(0, 120)}`;
  bootLog.error('unhandledrejection', e.reason);
  crashSink?.(
    e.reason instanceof Error ? e.reason : new Error(String(e.reason)),
    'A background task failed.',
  );
});

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { VolumetricFogPass } from './render/VolumetricFogPass';
import { GrassField } from './render/GrassField';
import { SkyDome, cloudCoverAt } from './render/SkyDome';
import { GodRaysPass } from './render/GodRaysPass';
import { Camera as CameraConfig, Debug, Light as LightConfig, World } from './config';
import { Input } from './core/Input';
import { haptics } from './core/Haptics';
import { mobileShell } from './core/MobileShell';
import { LightGrid } from './lighting/LightGrid';
import { Orb } from './orb/Orb';
import { OrbMood } from './orb/Mood';
import { createLitMaterial } from './render/litMaterial';
import { LightVolume } from './render/LightVolume';
import { buildChunkGeometry , copySlabsFor, geometryFromArrays } from './render/VoxelMesher';
import { buildSmoothChunkGeometry } from './render/SmoothMesher';
import { Mat } from './world/Materials';
import { Chunk, VoxelWorld } from './world/VoxelWorld';
import { generateReek } from './world/ReekGen';
import { carveTestbeds } from './world/Testbeds';
import { WorldStream } from './world/WorldStream';
import { WorldGen, SEA_LEVEL } from './worldlab/WorldGen';
import { WaterZone } from './render/WaterZone';
import { FireZone } from './render/FireZone';
import { BuildSandbox } from './world/BuildSandbox';
import { FloraLibrary, type FloraName } from './world/FloraAssets';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Menu, type MenuBridge } from './ui/Menu';
import { Minimap } from './ui/Minimap';
import { FolkManager } from './entity/FolkManager';
import { AnimatorUI } from './entity/AnimatorUI';

type Pickup = {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  taken: boolean;
};

type Ward = {
  pos: THREE.Vector3;
  light: THREE.PointLight;
  core: THREE.Mesh;
  /** Reactive membrane — INVISIBLE at rest. It fades in only while a tide
   *  presses on it (and for a breath at placement), so the default read of a
   *  ward is the ground ring + anchor, and the dome means "under attack". */
  dome: THREE.Mesh;
  /** Keeper anchor body: the universal obelisk silhouette (Meshy GLB when
   *  loaded, procedural shard fallback otherwise — see makeWardAnchor). */
  anchor: THREE.Object3D;
  /** Ground rings: the WARD_RADIUS ring is the default visible truth of the
   *  safe circle; a small footprint ring seats the anchor on its plinth. */
  rings: THREE.Group;
  /** Faint vertical light column rising off the lumen core. */
  beam: THREE.Mesh;
  /** Glow-motes drifting inward across the circle — light being gathered. */
  motes: THREE.Points;
  /** Per-mote [angle, radius, height, drift speed], packed 4 floats each. */
  moteState: Float32Array;
  /** 1 at the moment of placement, decays over ~2s: the membrane is born
   *  visible (activation surge), then rests until a tide tests it. */
  activation: number;
  /** Voxel coords + floor height the ward was built at — enough to re-spawn it
   *  exactly when a save is loaded onto a fresh world. */
  vx: number;
  vz: number;
  floorY: number;
};

/** Ward protection radius (voxels). One number: ring size = mechanics = truth. */
const WARD_RADIUS = 12;
/** Anchor body height (units) — the lumen core hangs in its niche at ~2/3. */
const WARD_ANCHOR_HEIGHT = 3.6;

/** The ward is UNIVERSAL: one Keeper-anchor silhouette everywhere — obelisk +
 *  ring + core + motes. The BIOME only skins it (mote/membrane/ring colors,
 *  local particles); add entries here as biomes land. Never fork the ward's
 *  shape per biome — that fragments the design language (docs/MESHY_ward.md). */
const WARD_DRESSING = {
  reek: {
    light: 0x7fffd1,
    core: 0x9dffd8,
    ring: 0x7fffd1,
    dome: 0x7fffd1,
    /** Spore-teal with a violet drift — The Reek's contamination in the light. */
    motes: [0x8fffe0, 0xb695ff],
  },
} as const;

const app = document.querySelector<HTMLDivElement>('#app');
const boot = document.querySelector<HTMLDivElement>('#boot');

/** Update the boot overlay's status line and yield two frames so it PAINTS —
 *  the init below otherwise blocks the main thread for seconds with no
 *  feedback (John: "we need an initial loading on startup"). */
function bootStatus(msg: string): Promise<void> {
  if (boot) {
    let el = boot.querySelector<HTMLDivElement>('.status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'status';
      el.style.cssText = 'position:absolute;margin-top:52px;font-size:10px;letter-spacing:0.22em;color:#3d6a82;';
      boot.appendChild(el);
    }
    el.textContent = msg;
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
assert(app, 'Missing #app root');

// Diagnostics overlay first — so the crash card is reachable from the global
// error handlers above and the frame-loop boundary below.
const devOverlay = new DevOverlay();
crashSink = (err, message) => devOverlay.showCrash(err, message);
/** Set true to stop the render loop: fatal frame errors or WebGL context loss. */
let loopHalted = false;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Start conservative (DRS climbs from here). Booting at 2× on a phone means the
// moment fullscreen reclaims the bars — a bigger viewport — frame time blows the
// 16.6ms budget and 120Hz vsync slams to 30. Begin safe, then sharpen into any
// headroom. See the DRS block below.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'wAIver game canvas');
app.appendChild(renderer.domElement);

// A GPU/driver reset (common on laptops and the phones we test on) fires
// webglcontextlost. Without preventDefault the context can never be restored and
// the game freezes forever, so pause the loop and show a recoverable notice; on
// restore we reload (rebuilding every procedural GPU resource in place is a
// bigger job — tracked as a follow-up).
const glLog = logger('gl');
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  loopHalted = true;
  glLog.warn('WebGL context lost — graphics paused');
  devOverlay.showNotice(
    'Graphics paused',
    'The graphics context was lost (usually a GPU or driver hiccup). It will reload automatically once the context returns.',
  );
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  glLog.info('WebGL context restored — reloading');
  location.reload();
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020205);
// Fog OFF at rest (density 0). The shaders (terrain + flora) already crush
// distance to black themselves; a FogExp2 on top just blends the whole frame
// toward its blue-grey color, flattening everything into mush. The object stays
// so the tide can ramp it up when the dark actually rolls in.
scene.fog = new THREE.FogExp2(0x05080a, 0.0);

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

// Boom length/rise ease toward what the surrounding space allows (see
// updateCamera): full in the open, drawn in + down in caves and tunnels.
let camDistSmooth = CameraConfig.distance;
let camHeightSmooth = CameraConfig.height;
// 0 = adaptive third-person (default), 1 = fixed over-shoulder (press V to A/B).
let camMode: 0 | 1 = 0;
// Set each frame by the chunk-cull roof probe: true when a rock ceiling is
// overhead (in a cave), false under open sky. Shared with the flora cull.
let orbRoofed = false;

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
// composer.addPass(fogPass); // OFF — the full-screen raymarch + depth prepass washed
// the horizon and cost ~30fps. Replaced by GroundFog (a cheap contained plane stack).
const godRays = new GodRaysPass(sceneDepth);
// composer.addPass(godRays);
const VOLUMETRICS_ON = false; // no depth prepass — GroundFog is a mesh, needs neither

// Ground-smoke: OFF (John, 2026-07-06). The plane-stack approach rendered with
// choppy layer lines and juddered on stepped terrain — it needs a real
// ground-conforming design (per-fragment terrain height + weight/pooling in
// dips, stopping at cave mouths) before it comes back. Class kept; not
// instantiated, zero per-frame cost.

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
let waterWakeTimer = 0; // throttles swim-wake ripples (see the water block in frame)
// Controller telemetry is a setup aid, not gameplay UI — OFF by default,
// toggled with P (hides the HUD line and drops the pad segment from metrics).
let showPadDebug = false;
const { material: worldMaterial, uniforms } = createLitMaterial();

// Flora (trees, shrooms, crystals) are MeshStandardMaterials — the terrain's
// echolocation pulse is a custom-shader effect that never touches them, so in
// the dark of a tide they'd read as flat black silhouettes. Patch each flora
// material to catch the SAME pulse ring: as the wavefront sweeps a grove it
// paints the flora in their own albedo, not just shadow. Injected into the
// linear-HDR light (before tonemapping) using the shared pulse uniforms so it
// stays in lockstep with the terrain. Instancing-aware for the leaf cards.
// Leaf clusters route through this SAME patch (userData.leaf), so they get the
// grove's pulse-reveal lighting — PLUS soft spherical normals (a cluster lights
// as a round bush, not flat quads) and GPU wind. Both must live in one
// onBeforeCompile, since a material only gets one.
let leafTimeUniform: { value: number } | null = null;
function addPulseReveal(mat: THREE.MeshStandardMaterial): void {
  const isLeaf = mat.userData.leaf === true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPulseCenter = uniforms.uPulseCenter;
    shader.uniforms.uPulseRadius = uniforms.uPulseRadius;
    shader.uniforms.uPulseThickness = uniforms.uPulseThickness;
    shader.uniforms.uPulseIntensity = uniforms.uPulseIntensity;
    shader.uniforms.uPulseColor = uniforms.uOrbColor; // pulse takes the orb's mood
    // Share the light volume so flora catch the SAME propagating flood-fill light
    // as the terrain — a charged grove, ward or crystal lights the flora around it.
    shader.uniforms.uLightAtlas = uniforms.uLightAtlas;
    shader.uniforms.uLightMin = uniforms.uLightMin;
    shader.uniforms.uLightStep = uniforms.uLightStep;
    shader.uniforms.uLightDim = uniforms.uLightDim;
    shader.uniforms.uLightTiles = uniforms.uLightTiles;
    shader.uniforms.uHeldColor = uniforms.uHeldColor;
    // Charged shrooms light the grove's FLORA too (not just the ground), and
    // ray-march shadows against the same static solidity volume the terrain uses.
    shader.uniforms.uShroomCount = uniforms.uShroomCount;
    shader.uniforms.uShroomPos = uniforms.uShroomPos;
    shader.uniforms.uShroomColor = uniforms.uShroomColor;
    shader.uniforms.uShroomI = uniforms.uShroomI;
    shader.uniforms.uShroomR = uniforms.uShroomR;
    // The orb as a REAL organic light on foliage: half-Lambert wrap + leaf
    // transmission (see the fragment). This is the fix for "flat/black foliage" —
    // pro vegetation shaders (Crysis/SpeedTree/Unreal) light leaves with a
    // transmittance lobe, not plain diffuse that goes black on shaded sides.
    shader.uniforms.uOrbPos = uniforms.uOrbPos;
    shader.uniforms.uOrbColor = uniforms.uOrbColor;
    shader.uniforms.uOrbIntensity = uniforms.uOrbIntensity;
    // UNIFY with the terrain: flora reads the SAME held light-volume (the
    // propagated flood-fill light from charged groves, wards, crystals, biome),
    // faded by the tide exactly like the ground. This is why the fog lit up but
    // the trees didn't — the trees never sampled the environment light.
    shader.uniforms.uTideDark = uniforms.uTideDark;
    let vtxHead = 'varying vec3 vPulseWP;\nvarying vec3 vWNormal;\n';
    if (isLeaf) {
      shader.uniforms.uLeafTime = { value: 0 };
      leafTimeUniform = shader.uniforms.uLeafTime;
      vtxHead += 'uniform float uLeafTime;\n';
    }
    shader.vertexShader = vtxHead + shader.vertexShader;
    if (isLeaf) {
      // Spherical normals: light the cluster as a soft round volume, not as the
      // flat faces of its crossed quads (that flat read is why it looked wrong).
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n objectNormal = normalize(position + vec3(0.0, 0.0015, 0.0));',
      );
    }
    const windCode = isLeaf
      ? `float lph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.5;
         float sway = uv.y * (0.12 * sin(uLeafTime * 1.3 + lph)
                            + 0.06 * sin(uLeafTime * 3.1 + lph * 1.7)
                            + 0.03 * sin(uLeafTime * 6.7 + lph * 2.3));
         transformed.x += sway;
         transformed.z += sway * 0.6;`
      : '';
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
         ${windCode}
         vec4 pulseWP = vec4(transformed, 1.0);
         vec3 wnrm = objectNormal;
         #ifdef USE_INSTANCING
           pulseWP = instanceMatrix * pulseWP;
           wnrm = mat3(instanceMatrix) * wnrm;
         #endif
         vPulseWP = (modelMatrix * pulseWP).xyz;
         vWNormal = normalize(mat3(modelMatrix) * wnrm);`,
    );
    shader.fragmentShader =
      `uniform vec3 uPulseCenter;
       uniform float uPulseRadius;
       uniform float uPulseThickness;
       uniform float uPulseIntensity;
       uniform vec3 uPulseColor;
       uniform sampler2D uLightAtlas;
       uniform vec3 uLightMin;
       uniform float uLightStep;
       uniform vec3 uLightDim;
       uniform vec2 uLightTiles;
       uniform vec3 uHeldColor;
       #define MAX_SHROOMS 8
       uniform int uShroomCount;
       uniform vec3 uShroomPos[MAX_SHROOMS];
       uniform vec3 uShroomColor[MAX_SHROOMS];
       uniform float uShroomI[MAX_SHROOMS];
       uniform float uShroomR[MAX_SHROOMS];
       uniform vec3 uOrbPos;
       uniform vec3 uOrbColor;
       uniform float uOrbIntensity;
       uniform float uTideDark;
       varying vec3 vPulseWP;
       varying vec3 vWNormal;
       // Same 2D-atlas flood-fill sampler as the terrain shader.
       float sampleLightVol(vec3 wp) {
         vec3 v = (wp - uLightMin) / uLightStep;
         float nx = uLightDim.x, ny = uLightDim.y, nz = uLightDim.z;
         float tX = uLightTiles.x, tY = uLightTiles.y;
         float aw = tX * nx, ah = tY * nz;
         float cx = clamp(v.x, 0.5, nx - 0.5);
         float cz = clamp(v.z, 0.5, nz - 0.5);
         float fy = v.y - 0.5;
         float s0 = clamp(floor(fy), 0.0, ny - 1.0);
         float s1 = clamp(s0 + 1.0, 0.0, ny - 1.0);
         float wy = clamp(fy - s0, 0.0, 1.0);
         vec2 t0 = vec2(mod(s0, tX), floor(s0 / tX));
         vec2 t1 = vec2(mod(s1, tX), floor(s1 / tX));
         vec2 uv0 = vec2(t0.x * nx + cx, t0.y * nz + cz) / vec2(aw, ah);
         vec2 uv1 = vec2(t1.x * nx + cx, t1.y * nz + cz) / vec2(aw, ah);
         return mix(texture2D(uLightAtlas, uv0).r, texture2D(uLightAtlas, uv1).r, wy);
       }
       // Solidity (alpha) from the volume — nearest Y-slice. Used to shadow the
       // shroom lights against the same static geometry the terrain marches.
       float sampleSolid(vec3 wp) {
         vec3 v = (wp - uLightMin) / uLightStep;
         float nx = uLightDim.x, ny = uLightDim.y, nz = uLightDim.z;
         float tX = uLightTiles.x, tY = uLightTiles.y;
         float aw = tX * nx, ah = tY * nz;
         float cx = clamp(v.x, 0.5, nx - 0.5);
         float cz = clamp(v.z, 0.5, nz - 0.5);
         float s = clamp(floor(v.y), 0.0, ny - 1.0);
         vec2 t = vec2(mod(s, tX), floor(s / tX));
         vec2 uv = vec2(t.x * nx + cx, t.y * nz + cz) / vec2(aw, ah);
         return texture2D(uLightAtlas, uv).a;
       }
       // Jittered sample offsets — same anti-ring treatment as litMaterial
       // (fixed-step binary marches paint concentric rings around any light
       // near solid voxels). Reach unchanged: walls are 1 voxel thick, so the
       // march must sample right up to the light or it leaks through them.
       float marchJitter(vec3 p) {
         return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
       }
       float ptShadow(vec3 p, vec3 lp) {
         vec3 d = lp - p; float dist = length(d);
         if (dist < 1.5) return 1.0;
         vec3 dir = d / dist;
         float march = min(dist - 1.0, 14.0);
         float j = marchJitter(p);
         for (int i = 1; i <= 14; i++) {
           float s = float(i) + j;
           if (s >= march) break;
           if (sampleSolid(p + dir * s) > 0.5) return 0.0;
         }
         return 1.0;
       }
       // Organic point light on foliage. WRAP (half-Lambert) so shaded sides keep
       // a value floor (never black) — used by ALL flora. TRANSMISSION (light
       // through the thin leaf toward the eye, warm-shifted) is gated by translu
       // and ONLY applied to leaves — a solid rock/trunk is NOT translucent, so
       // giving it a glow-through read as ghostly/transparent. Recipe: Crysis/
       // SpeedTree/Unreal Two-Sided Foliage. Defined AFTER ptShadow it calls —
       // GLSL has no hoisting, so this MUST come last (that ordering bug blanked
       // every flora mesh).
       vec3 floraLight(vec3 albedo, vec3 lp, vec3 lcol, float reach, float power, float translu) {
         vec3 toL = lp - vPulseWP;
         float d = length(toL);
         float atten = 1.0 - clamp(d / reach, 0.0, 1.0);
         atten = atten * atten * power;
         if (atten < 0.001) return vec3(0.0);
         vec3 L = toL / max(d, 1e-4);
         float sh = ptShadow(vPulseWP, lp);
         float wrap = clamp(dot(vWNormal, L) * 0.5 + 0.5, 0.0, 1.0);       // reads on grazing/shaded sides
         vec3 body = albedo * wrap;
         vec3 glow = vec3(0.0);
         if (translu > 0.001) {
           vec3 V = normalize(cameraPosition - vPulseWP);
           float trans = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 2.5); // backlit glow-through
           glow = albedo * vec3(1.15, 1.0, 0.55) * trans * translu * 0.7;   // warm transmitted light (leaves only)
         }
         return (body + glow) * atten * sh * lcol;
       }\n` +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `// Held environment light — the SAME propagated flood-fill the terrain reads
         // (charged groves, wards, crystals, biome light), quadratic response, faded
         // by the tide. This is the unify step: trees standing in lit air now catch
         // the light like the ground (and the mist) do.
         float volL = sampleLightVol(vPulseWP);
         float held = volL * volL * 1.6 * uTideDark;
         outgoingLight += diffuseColor.rgb * held * uHeldColor;
         // Leaves transmit light (translu 1); solid flora (rocks/trunks/caps) do NOT (0).
         float translu = ${isLeaf ? '1.0' : '0.0'};
         // The orb reveals foliage organically: wrap + leaf transmission + real
         // falloff + ray-marched shadow. Reach 15 = the carried bubble on flora.
         outgoingLight += floraLight(diffuseColor.rgb, uOrbPos, uOrbColor, 15.0, 0.6 + uOrbIntensity, translu);
         // Charged shrooms light the grove's flora the same organic way, shadowed
         // by the world so a stem or wall between cap and leaf casts a real shadow.
         for (int si = 0; si < MAX_SHROOMS; si++) {
           if (si >= uShroomCount) break;
           if (uShroomI[si] < 0.001) continue;
           outgoingLight += floraLight(diffuseColor.rgb, uShroomPos[si], uShroomColor[si], uShroomR[si], uShroomI[si] * 1.4, translu);
         }
         // Pulse shell sweep — a bright reveal as the wavefront passes.
         if (uPulseIntensity > 0.0 && uPulseRadius >= 0.0) {
           float pd = distance(vPulseWP, uPulseCenter);
           float ring = 1.0 - clamp(abs(pd - uPulseRadius) / uPulseThickness, 0.0, 1.0);
           ring = ring * ring * uPulseIntensity;
           outgoingLight += diffuseColor.rgb * ring * uPulseColor * 1.7;
         }
         #include <opaque_fragment>
         // DARKNESS IS THE DRAW DISTANCE. Distant flora fall to black — UNLIKE
         // the terrain, flora get NO moon "horizon opens" reprieve: foliage must
         // vanish at range in ALL conditions (John's call), leaving only near-lit
         // flora and, against the lit sky, clean black silhouettes. Linear HDR.
         gl_FragColor.rgb *= exp(-distance(cameraPosition, vPulseWP) * 0.02);`,
      );
  };
  // Leaf variant compiles as its own program; the rest share one cache key.
  mat.customProgramCacheKey = () => (mat.userData.leaf ? 'pulseRevealLeaf' : 'pulseReveal');
}

const chunkMeshes = new Map<Chunk, THREE.Mesh>();
// Terrain skin: BLOCKY voxels (John's call after the surface-nets test read
// as "tunnels" — invest in voxel texturing instead). The smooth path stays
// behind waiver.smooth(true) for a future refinement round.
let smoothTerrain = false;
const pickups: Pickup[] = [];
const wards: Ward[] = [];
const tempVec = new THREE.Vector3();
// The world light the orb is currently bathed in (summed from nearby glow) —
// bled onto the black core so the hero reflects the light it moves through.
const orbWorldLit = new THREE.Color();
// Reused per-frame culling scratch (no per-frame allocations).
const cullFrustum = new THREE.Frustum();
const cullMatrix = new THREE.Matrix4();
const clock = new THREE.Clock();

let spores = 0;
let objective = 'Awaken in The Reek';
// Gameplay is frozen (menu / intro / pause up) until the player takes control.
// The world keeps rendering and idling behind the overlay — only player-driven
// mutation (input, tide timeline, drains, pickups) is gated on this.
let paused = true;
// The Dark Tide runs on a timeline, not a quick swell: blackness sweeps IN
// from far to close (onset), holds total black for a long dread (sustain),
// then lifts (release). tideT is seconds since it began, −1 when none runs.
let tideT = -1;
const TIDE_ONSET = 7; // s — the dark rolls in from the horizon, closing inward
const TIDE_SUSTAIN = 16; // s — held near-total black; the world is swallowed
const TIDE_RELEASE = 6; // s — the world breathes back to its dim night
const TIDE_TOTAL = TIDE_ONSET + TIDE_SUSTAIN + TIDE_RELEASE;
let pulseRadius = -1;
let pulseActive = false;
let pulseCenter = new THREE.Vector3();

// The orb: a REFLECTIVE BLACK sphere — the light lives in the aura around it,
// not in the body. Reflections come from a generated room environment so the
// glassy black reads even though the world shader is custom.
const pmrem = new THREE.PMREMGenerator(renderer);
// The room-image light (IBL) is reserved for the ORB alone — it's the one object
// meant to catch a soft studio reflection. It is deliberately NOT assigned to
// scene.environment: that lights EVERY surface uniformly from all directions
// (all flora, all terrain, at any distance) — the "I can see every plant on the
// map" wash. Nothing but real lights (the orb's bubble, wards, charged glow,
// built) may reveal the world, so the orb carries this map on its own material.
const orbEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = null;

// The moon as a faint global wash: a dim, cool hemisphere light that lifts the
// whole map *remotely* under a fuller/clearer moon and goes pitch black at new
// moon. Its intensity is driven each frame by moonI (phase + cloud cover), so
// flora catch a bare hint of moonlight but stay dark otherwise. (Terrain uses
// its own moon term in the shader; this is for the standard-material flora/orb.)
const moonAmbient = new THREE.HemisphereLight(0x9fb4ff, 0x0a1018, 0);
scene.add(moonAmbient);

const orbGroup = new THREE.Group();
const orbCore = new THREE.Mesh(
  new THREE.SphereGeometry(0.48, 48, 32),
  new THREE.MeshPhysicalMaterial({
    color: 0x0a0a0e, // near-black body
    metalness: 0.22,
    roughness: 0.42, // satin: broad, soft reflections…
    clearcoat: 0.65, // …with a thin glossy coat on top
    clearcoatRoughness: 0.28,
    envMap: orbEnv, // its OWN reflection — scene.environment is null so nothing else catches it
    envMapIntensity: 0.75,
    sheen: 0.4, // faint fabric-like rim softness
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0x2a3a55),
  }),
);
// Aura layer 1: tight rim glow hugging the black core. Its radius is the ONE
// source of truth for the orb's soft-contact hitbox — the band of glowing space
// that immediately surrounds the body is exactly what brushes the flora.
const ORB_HALO_RADIUS = 0.62;
const orbHalo = new THREE.Mesh(
  new THREE.SphereGeometry(ORB_HALO_RADIUS, 32, 18),
  new THREE.MeshBasicMaterial({
    color: 0x50d8ff,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide, // only the rim, so the black face stays black
  }),
);
// Aura layer 2: wide soft glow billboard — the "light around the dark".
// A custom-shader plane (not a Sprite): since the billboard is slid toward the
// camera to clear walls, the opaque core no longer depth-occludes its centre —
// so the shader punches a soft HOLE where the core sits (uHole, driven per
// frame), keeping the body clean satin black with the glow only around it.
const orbAura = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null as THREE.Texture | null }, // set after moteTexture exists below
      uColor: { value: new THREE.Color(0x66d9ff) },
      uOpacity: { value: 0.55 },
      uHole: { value: 0.28 }, // core apparent radius / aura half-size (per-frame)
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uHole;
      varying vec2 vUv;
      void main() {
        vec4 tex = texture2D(uMap, vUv);
        float r = length(vUv - 0.5) * 2.0; // 0 centre -> 1 edge
        float hole = smoothstep(uHole, uHole * 1.35, r); // dark core stays dark
        gl_FragColor = vec4(uColor * tex.rgb, tex.a * uOpacity * hole);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
orbAura.scale.setScalar(3.4);
// Aura + halo are additive glow — they must be SKIPPED by the depth prepass
// (like the trail/spores/pulse). Otherwise the prepass renders their square
// sprite/rim quads as opaque depth, and the fog pass reads that square → a
// boxy fog halo around the orb (the "box glitch"). Core stays on layer 0 so it
// occludes and writes real depth; only the glow layers move to the effects layer.
orbAura.layers.set(1);
orbHalo.layers.set(1);
orbGroup.add(orbAura, orbHalo, orbCore);
// Scratch for the aura's camera-pull (see the frame loop): the billboard is
// slid toward the camera so it never sinks into a wall behind the orb.
const auraOffset = new THREE.Vector3();
const auraQuat = new THREE.Quaternion();
scene.add(orbGroup);

// UNIFIED FALLOFF LAW (the lighting engine rule): every point light in the game
// decays at the physical 1/d² (decay 2) with NO range cutoff — light dies because
// distance kills it, not because a radius window clips it. Non-physical decay
// (1.1) + a range cutoff was still bright when it hit the window, so it died in
// a visible RING — the "false circle" on water/crystal. Intensity is higher to
// compensate (physical falloff eats light fast); the pool is brighter near, dies
// organically, and never draws a circle.
const orbLight = new THREE.PointLight(0x8defff, 8, 0, 2);
scene.add(orbLight);

// Charged shrooms emit REAL light onto everything (imported flora, orb, native
// meshes), not just the terrain shader's own shroom-light path. A small fixed
// POOL of point lights is re-aimed each frame at the brightest charged shrooms
// nearest the orb. Fixed count (always in the scene, intensity 0 when idle) so
// the light total never changes → no per-frame shader recompiles/hitches.
const SHROOM_LIGHT_POOL = 4;
const shroomLights: THREE.PointLight[] = [];
for (let i = 0; i < SHROOM_LIGHT_POOL; i++) {
  const L = new THREE.PointLight(0xffffff, 0, 0, 2); // unified falloff law: 1/d², no cutoff ring
  scene.add(L);
  shroomLights.push(L);
}

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
orbAura.material.uniforms.uMap.value = moteTexture;

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
const sporeCol = new Float32Array(SPORE_MAX * 3); // per-mote brightness (light-gated)
const sporeGeo = new THREE.BufferGeometry();
sporeGeo.setAttribute('position', new THREE.BufferAttribute(sporePos, 3));
sporeGeo.setAttribute('color', new THREE.BufferAttribute(sporeCol, 3));
const sporePoints = new THREE.Points(
  sporeGeo,
  // Motes are DUST, not fireflies: they carry no light of their own. Each frame
  // their color is set from how much light actually reaches them (orb bubble +
  // pulse), so a mote only glints where a beam catches it and is invisible in the
  // dark. Small + reflective (takes the light's own color), never a self-glow.
  new THREE.PointsMaterial({
    size: 0.14,
    map: moteTexture, // soft radial sprite — never hard squares
    vertexColors: true, // brightness driven per-mote by nearby light
    transparent: true,
    opacity: 0.9,
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

    // Light-gate: a dust mote is only visible where light actually reaches it.
    // It CATCHES the orb's glow (tight falloff — only the near air glints) and
    // flares as the pulse shell sweeps past; everywhere else it's black = unseen.
    const dx = sporePos[i * 3] - orb.pos.x;
    const dy = sporePos[i * 3 + 1] - orb.pos.y;
    const dz = sporePos[i * 3 + 2] - orb.pos.z;
    const od = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let lit = Math.max(0, 1 - od / 12); // reach of the orb's bubble
    lit = lit * lit * 1.7; // fades with distance but bright enough to read in the beam
    if (pulseActive && pulseRadius >= 0) {
      const px = sporePos[i * 3] - pulseCenter.x;
      const py = sporePos[i * 3 + 1] - pulseCenter.y;
      const pz = sporePos[i * 3 + 2] - pulseCenter.z;
      const pd = Math.sqrt(px * px + py * py + pz * pz);
      lit += Math.max(0, 1 - Math.abs(pd - pulseRadius) / 3) * 1.2; // the shell lights the air it passes
    }
    lit = Math.min(lit, 1.6);
    // Reflective, not emissive: the mote takes the LIGHT'S colour (the orb mood),
    // dimmed — a fleck catching a beam, not a bulb.
    sporeCol[i * 3] = orbLight.color.r * lit;
    sporeCol[i * 3 + 1] = orbLight.color.g * lit;
    sporeCol[i * 3 + 2] = orbLight.color.b * lit;
  }
  sporeGeo.attributes.position.needsUpdate = true;
  sporeGeo.attributes.color.needsUpdate = true;
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

// --- Full debug overlay (John): per-system frame timings + world counters.
// Toggle by TAPPING the metrics bar (phone) or F4 (desktop).
const perfEma: Record<string, number> = {};
let lastFrameMs = 0;
function perfMark(name: string, ms: number): void {
  perfEma[name] = (perfEma[name] ?? ms) * 0.9 + ms * 0.1;
}
const perfDiv = document.createElement('div');
perfDiv.style.cssText =
  'position:fixed;left:8px;bottom:8px;z-index:60;display:none;color:#9fd6ff;font:10px/1.5 ui-monospace,Menlo,monospace;' +
  'background:#060a10d8;padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre;max-width:92vw;';
document.body.appendChild(perfDiv);
let perfOn = false;
function togglePerf(): void {
  perfOn = !perfOn;
  perfDiv.style.display = perfOn ? 'block' : 'none';
}
metricsBar.style.pointerEvents = 'auto';
metricsBar.addEventListener('click', togglePerf);
// Unmissable toggle (John couldn't find the thin metrics strip — it can hide
// under the Android status bar in fullscreen): a floating 📊 button.
const perfBtn = document.createElement('button');
perfBtn.textContent = '📊';
perfBtn.style.cssText =
  'position:fixed;left:8px;top:40%;z-index:61;width:40px;height:40px;border-radius:50%;' +
  'background:#0d1622aa;border:1px solid #2a3c52;color:#9fd6ff;font-size:16px;touch-action:manipulation;';
perfBtn.addEventListener('click', () => {
  togglePerf();
  perfBtn.style.background = perfOn ? '#3a6ea5cc' : '#0d1622aa';
});
document.body.appendChild(perfBtn);
window.addEventListener('keydown', (e) => {
  if (e.code === 'F4') togglePerf();
});
let perfDivTimer = 0;
function updatePerfDiv(dt: number): void {
  perfDivTimer += dt;
  if (!perfOn || perfDivTimer < 0.33) return;
  perfDivTimer = 0;
  const f = (k: string): string => (perfEma[k] ?? 0).toFixed(1).padStart(5);
  const known =
    (perfEma.stream ?? 0) + (perfEma.mesh ?? 0) + (perfEma.flora ?? 0) + (perfEma.folk ?? 0) + (perfEma.sway ?? 0) + (perfEma.render ?? 0);
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  perfDiv.textContent =
    `frame ${lastFrameMs.toFixed(1)}ms  (${(1000 / Math.max(lastFrameMs, 0.01)).toFixed(0)}fps)\n` +
    `stream ${f('stream')}  mesh ${f('mesh')}  flora ${f('flora')}\n` +
    `folk   ${f('folk')}  sway ${f('sway')}  render ${f('render')}\n` +
    `other  ${(Math.max(0, lastFrameMs - known)).toFixed(1).padStart(5)}  draws ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k\n` +
    `chunks ${world.chunks.size}  meshes ${chunkMeshes.size}  flora ${importedFlora.length}  sway ${swayProps.length}\n` +
    `groveQ ${pendingGroves.length}  treeQ ${pendingTrees.length}  fogL ${fogLightRegistry.length}  scale ${renderScale.toFixed(2)}/${drsCeiling.toFixed(2)}` +
    (heap ? `  heap ${(heap.usedJSHeapSize / 1048576).toFixed(0)}MB` : '') +
    `\ngeo ${renderer.info.memory.geometries}  tex ${renderer.info.memory.textures}  progs ${renderer.info.programs?.length ?? 0}`;
}

// --- Dynamic resolution scaling (DRS) ---------------------------------------
// The S24 is powerful: it should look AMAZING and never cliff to a blurry mess.
// So instead of a one-way "drop to potato" ratchet, we continuously scale the
// RENDER resolution to the crispest the GPU can sustain while holding ≥60fps,
// and spend any spare 60→120Hz headroom on MORE resolution — never on culling
// the effects that make it beautiful. Bloom/grass/glow stay full; only pixel
// density flexes, BOTH directions, so it self-corrects the instant load eases.
const deviceDpr = Math.max(1, window.devicePixelRatio || 1);
const MIN_SCALE = Math.min(deviceDpr, 1.25); // floor that still looks good — never potato
const MAX_SCALE = Math.min(deviceDpr, 2.5); //  ceiling — crisp headroom above the old hard 2×
let renderScale = Math.min(deviceDpr, 1.5); // matches the conservative initial setPixelRatio; DRS climbs
let drsCeiling = MAX_SCALE; // highest scale believed playable; sags lower it, time forgives it
let drsForgive = 0;
let drsTimer = 0;
// Kept only because the world/fire LOD readers still take a tier; pinned to 0
// (full effects) because DRS — not effect-culling — governs sharpness now.
const qualityTier = 0;

function applyRenderScale(scale: number): void {
  renderScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  renderer.setPixelRatio(renderScale);
  const ratio = renderer.getPixelRatio();
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  composer.setPixelRatio(ratio);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  depthRT.setSize(Math.floor((w * ratio) / 2), Math.floor((h * ratio) / 2));
  logger('quality').debug(`render scale ${renderScale.toFixed(2)}×`);
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
  <div id="gamepad-debug" class="gamepad-debug" style="display:none">pad: none</div>
`;
document.body.appendChild(hud);

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
  /* Visible dynamic joystick (CoD-Mobile/Genshin pattern): a ring appears where
     the left thumb lands and the nub tracks the drag. Purely cosmetic — the
     Input class positions it; movement intent still comes from the touch math. */
  .touch-stick-base {
    position: fixed;
    z-index: 22;
    width: 132px;
    height: 132px;
    border-radius: 50%;
    border: 1.5px solid rgba(127, 220, 255, 0.32);
    background: radial-gradient(circle, rgba(80, 216, 255, 0.1), rgba(2, 10, 14, 0.04) 70%);
    box-shadow: inset 0 0 26px rgba(80, 216, 255, 0.1);
    transform: translate(-50%, -50%);
    opacity: 0;
    transition: opacity 0.12s ease;
    pointer-events: none;
  }
  .touch-stick-base.active {
    opacity: 1;
  }
  .touch-stick-nub {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 58px;
    height: 58px;
    border-radius: 50%;
    background: rgba(80, 216, 255, 0.22);
    border: 1px solid rgba(127, 220, 255, 0.6);
    box-shadow: inset 0 0 16px rgba(80, 216, 255, 0.25), 0 0 18px rgba(80, 216, 255, 0.18);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  /* Right-thumb action cluster: a large primary PULSE in the corner (closest to
     a resting right thumb) with the secondary verbs grouped just up-and-left. */
  .touch-actions {
    position: fixed;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(24px, env(safe-area-inset-bottom));
    z-index: 24;
    display: flex;
    align-items: flex-end;
    gap: 16px;
    pointer-events: none;
    touch-action: none;
  }
  /* JUMP · DASH · WARD in a row to the LEFT of PULSE (row-reverse so JUMP — the
     most-tapped verb — sits closest to the big primary and the resting thumb). */
  .touch-secondary {
    display: flex;
    flex-direction: row-reverse;
    align-items: flex-end;
    gap: 12px;
  }
  .touch-action {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #bfefff;
    background: rgba(60, 160, 200, 0.16);
    border: 1px solid rgba(127, 220, 255, 0.45);
    box-shadow: inset 0 0 18px rgba(80, 216, 255, 0.09), 0 0 20px rgba(80, 216, 255, 0.12);
    font: 700 10px/1 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.08em;
    text-shadow: 0 0 8px rgba(127, 220, 255, 0.7);
    pointer-events: auto;
    -webkit-user-select: none;
    user-select: none;
    touch-action: none;
  }
  .touch-action.primary {
    width: 88px;
    height: 88px;
    font-size: 13px;
    color: #eaffff;
    background: rgba(80, 216, 255, 0.24);
    border-color: rgba(159, 232, 255, 0.75);
    box-shadow: inset 0 0 22px rgba(80, 216, 255, 0.2), 0 0 26px rgba(80, 216, 255, 0.22);
  }
  .touch-action.danger {
    color: #ffe2cc;
    background: rgba(176, 80, 40, 0.18);
    border-color: rgba(255, 168, 108, 0.5);
    text-shadow: 0 0 8px rgba(255, 150, 92, 0.75);
  }
  /* Isolated build-time debug trigger — deliberately drab and off on its own so
     it never reads as part of the player action cluster. Delete before ship. */
  .touch-dev {
    position: fixed;
    top: calc(env(safe-area-inset-top) + 54px);
    right: max(8px, env(safe-area-inset-right));
    z-index: 24;
    padding: 5px 9px;
    border-radius: 5px;
    color: rgba(200, 210, 214, 0.72);
    background: rgba(20, 24, 26, 0.55);
    border: 1px dashed rgba(150, 165, 170, 0.4);
    font: 700 9px/1 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.1em;
    pointer-events: auto;
    -webkit-user-select: none;
    user-select: none;
    touch-action: none;
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
    /* Raw controller telemetry is a desktop setup aid — pure noise on a phone. */
    .gamepad-debug {
      display: none;
    }
  }
`;
document.head.appendChild(style);

// --- Smooth flora (hybrid art rule: voxel world, smooth LIFE) ---
// Everything the orb touches now REACTS: shrooms bob stiffly on their stalks,
// trees bend ropily toward the crown, and the pulse washes through them all.

// Thick-stalked glowcaps. Two coupled springs so head and stalk read as one
// living thing but respond separately: a stiff BASE lean (barely moves) and a
// springy CAP wobble on top. High stiffness + near-critical damping = small
// motion, quick rebound. Crowded caps lean apart to make room.
interface ShroomFlora {
  group: THREE.Group; // leaned about the base by (lx,lz)
  cap: THREE.Object3D; // wobbles by (cx,cz) atop the stalk
  gills: THREE.Object3D; // rides with the cap
  capBaseY: number; // cap's rest height (wobble offsets from here)
  x: number;
  z: number;
  h: number;
  capR: number;
  stalkR: number;
  phase: number;
  lx: number; // stalk lean + velocity
  lz: number;
  lvx: number;
  lvz: number;
  cx: number; // cap wobble + velocity
  cz: number;
  cvx: number;
  cvz: number;
  // Crowding neighbours — positions are static, so this is computed once (the
  // first frame the shroom is simulated) and cached, not scanned every frame.
  neighbors: ShroomFlora[] | null;
}
const shroomFlora: ShroomFlora[] = [];
// Spacing registry — caps claim ground so new ones don't spawn interpenetrating.
const shroomBodies: { x: number; z: number; r: number }[] = [];

// Spore-trees: the trunk is an upright Verlet rope shape-matched to its own rest
// curve, so it bends progressively (base rigid, crown loose) and is far stiffer
// than the mycelium. Branches + canopy ride the crown; the canopy can ripple.
interface TreeFlora {
  group: THREE.Group;
  crown: THREE.Group; // branches + canopy; follows the top node's pose
  n: number;
  nodes: Float32Array; // n×3 LOCAL (anchor-relative)
  prev: Float32Array;
  rest: Float32Array; // rest pose the shape-match springs pull back to
  kShape: Float32Array; // per-node shape stiffness (base high → tip low)
  radii: Float32Array;
  segLen: number;
  radial: number;
  tubePos: THREE.BufferAttribute;
  tubeNrm: THREE.BufferAttribute;
  anchor: THREE.Vector3;
  restTop: THREE.Vector3; // crown's rest position (local)
  canopies: { mesh: THREE.Mesh; base: Float32Array; seed: number }[]; // mode-B ripple
  leafInst: THREE.InstancedMesh | null; // mode-A leaf clusters (one draw call)
  leafCount: number;
  // BOUGHS hitbox: the canopy is its own springy mass on the crown, so brushing
  // the foliage sways it independently of the trunk's bend (a second hitbox).
  canopyR: number;
  cwx: number; // crown wobble offset + velocity
  cwz: number;
  cwvx: number;
  cwvz: number;
  phase: number;
  wake: number; // frames of sim left; 0 = asleep (no Verlet, no GPU re-upload)
}
const treeFlora: TreeFlora[] = [];

// Canopy A/B (toggle with the L key): true = leaf cards flutter, false = the
// blob surface ripples. Both react to the pulse; flip to compare.
let canopyLeafMode = true;
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyL') return;
  canopyLeafMode = !canopyLeafMode;
  for (const t of treeFlora) {
    if (t.leafInst) t.leafInst.visible = canopyLeafMode;
    if (canopyLeafMode) {
      // Leaves take over → restore the blobs to their pristine (unrippled) shape.
      for (const c of t.canopies) {
        (c.mesh.geometry.attributes.position.array as Float32Array).set(c.base);
        c.mesh.geometry.attributes.position.needsUpdate = true;
      }
    }
  }
});

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
  /** The shroom's own registry entry (a reference, never an index — the
   *  registry is pruned while roaming and indices shift). */
  fogEntry: { pos: THREE.Vector3; color: THREE.Color; intensity: number };
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
const floraCull: { group: THREE.Group; x: number; y: number; z: number }[] = [];
// Deep-cave render distance (voxels). The dark + light-gated fog hide the
// boundary underground, so this can be tight — it's the main lever keeping the
// deep world cheap: cave chunks/flora past it aren't drawn until the orb nears.
const RENDER_RADIUS = 80;
const RENDER_RADIUS2 = RENDER_RADIUS * RENDER_RADIUS;
// Surface flora keep the original generous radius so the moonlit vista is intact.
const SURFACE_FLORA_VIEW2 = 130 * 130;
let floraCullCursor = 0;

function registerFlora(group: THREE.Group): void {
  // Give every flora material the pulse-reveal patch so the echolocation ring
  // lights them in the dark (see addPulseReveal). Runs at gen time, before the
  // first frame, so no recompile is needed.
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (Array.isArray(m)) {
      for (const sub of m) if (sub instanceof THREE.MeshStandardMaterial) addPulseReveal(sub);
    } else if (m instanceof THREE.MeshStandardMaterial) {
      addPulseReveal(m);
    }
  });
  floraCull.push({ group, x: group.position.x, y: group.position.y, z: group.position.z });
}

function updateFloraCulling(): void {
  if (floraCull.length === 0) return;
  const slice = Math.min(floraCull.length, 500);
  for (let i = 0; i < slice; i++) {
    floraCullCursor = (floraCullCursor + 1) % floraCull.length;
    const f = floraCull[floraCullCursor];
    const dx = f.x - orb.pos.x;
    const dz = f.z - orb.pos.z;
    // Surface flora keep the generous vista radius WHILE the orb is above ground;
    // underground everything (surface flora included) is occluded, so cull tight.
    const r2 = f.y > 0 && !orbRoofed ? SURFACE_FLORA_VIEW2 : RENDER_RADIUS2;
    f.group.visible = dx * dx + dz * dz < r2;
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

  // Head = cap + gills as one body so it can wobble on the stalk on its own.
  const head = new THREE.Group();
  head.position.y = h;
  cap.position.y = 0;
  gills.position.y = -0.04;
  head.add(cap, gills);

  // Spacing: claim ground the size of the cap and shove off any earlier cap so
  // they don't spawn interpenetrating (worldgen stays untouched).
  let px = x + 0.5;
  let pz = z + 0.5;
  const bodyR = capR * 0.8;
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (const b of shroomBodies) {
      const ddx = px - b.x;
      const ddz = pz - b.z;
      const min = bodyR + b.r;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 1e-3;
        const push = (min - d) * 0.5 + 1e-3;
        px += (ddx / d) * push;
        pz += (ddz / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  shroomBodies.push({ x: px, z: pz, r: bodyR });

  g.add(stem, head);
  g.position.set(px, y, pz);
  scene.add(g);
  registerFlora(g);
  shroomFlora.push({
    group: g,
    cap: head,
    gills,
    capBaseY: h,
    x: px,
    z: pz,
    h,
    capR,
    stalkR: stemR * 1.6,
    phase: px * 0.7 + pz * 0.31,
    lx: 0,
    lz: 0,
    lvx: 0,
    lvz: 0,
    cx: 0,
    cz: 0,
    cvx: 0,
    cvz: 0,
    neighbors: null,
  });
  const fogEntry = {
    pos: new THREE.Vector3(px, y + h + 0.8, pz),
    color: glow.clone().multiplyScalar(1 / Math.max(glow.r, glow.g, glow.b)),
    intensity: 0.04, // dark until charged
  };
  fogLightRegistry.push(fogEntry);
  shrooms.push({
    pos: new THREE.Vector3(px, y + h, pz),
    capMat,
    gillMat,
    fogEntry,
    charge: 0.15, // a faint residual charge at world-start
  });
  // Hitboxes, SEPARATE so the head and stalk read as different things: the stem
  // you bump, and the cap you can land on / brush.
  addFloraCollider(px, pz, y, y + h - 0.3, stemR * 1.5);
  addFloraCollider(px, pz, y + h - 0.35, y + h + capR * 0.45, capR * 0.8);
}

// --- Spore-trees: tall curved trunks, freckled canopy near the roof ---
const barkMat = new THREE.MeshStandardMaterial({
  color: 0x3c3226,
  roughness: 0.95,
  metalness: 0,
  envMapIntensity: 0.1,
});
// Leaf clusters (canopy mode A). The billboard cards read as paper; the modern
// game-foliage recipe (EZ-Tree / Codrops 2025, Cyan's foliage shader) is:
//   • each instance is a CLUSTER of intersecting quads (never edge-on),
//   • textured with an alpha-cut leaf-clump image (shape comes from the alpha),
//   • shaded with SPHERICAL normals (normal = dir from clump centre) so the
//     clump lights like a soft round bush, not flat faces,
//   • wind done entirely in the vertex shader (layered sines, tip-weighted).

// Procedurally paint a soft leaf-clump alpha texture (no external asset).
function makeLeafTexture(): THREE.CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, s, s);
  for (let i = 0; i < 11; i++) {
    const a = i * 2.399963;
    const rad = 0.14 + 0.3 * ((i * 7) % 5) / 5;
    const cx = s * (0.5 + Math.cos(a) * rad);
    const cy = s * (0.5 + Math.sin(a) * rad);
    const rr = s * (0.11 + 0.05 * ((i * 3) % 4) / 4);
    const hue = 108 + ((i * 5) % 3) * 12;
    const light = 24 + ((i * 11) % 4) * 6;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a * 1.7);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rr * 1.5);
    g.addColorStop(0, `hsla(${hue},48%,${light + 6}%,0.98)`);
    g.addColorStop(0.65, `hsla(${hue},46%,${light}%,0.85)`);
    g.addColorStop(1, `hsla(${hue},46%,${light - 6}%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, rr * 0.62, rr * 1.4, 0, 0, Math.PI * 2); // leaf-ish teardrop
    ctx.fill();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

// One cluster = 3 intersecting vertical quads (a star), centred at the origin so
// spherical normals work. uv.y (0 base → 1 top) drives the tip-weighted wind.
function makeLeafClusterGeometry(): THREE.BufferGeometry {
  const planes = 3;
  const w = 1.4;
  const h = 1.4;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let v = 0;
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const cx = [-w / 2, w / 2, w / 2, -w / 2];
    const cy = [-h / 2, -h / 2, h / 2, h / 2];
    const cu = [0, 1, 1, 0];
    const cvv = [0, 0, 1, 1];
    for (let k = 0; k < 4; k++) {
      pos.push(cx[k] * ca, cy[k], cx[k] * sa);
      uv.push(cu[k], cvv[k]);
    }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const leafGeo = makeLeafClusterGeometry();
const leafMat = new THREE.MeshStandardMaterial({
  map: makeLeafTexture(), // used only for its ALPHA (the leaf silhouette)
  alphaTest: 0.42, // cut the soft texture into organic leaf edges (opaque, cheap)
  // Dark reek-foliage green — NOT pure black. A zero albedo reflects nothing, so
  // no light (orb, pulse, shroom, held) can ever reveal it: every lighting path
  // multiplies by this color. It must be dark enough to vanish in the black but
  // REFLECTIVE enough to read the moment the orb's beam touches it.
  color: 0x2c4a30,
  roughness: 0.85,
  metalness: 0,
  side: THREE.DoubleSide,
  envMapIntensity: 0.05,
});
// Marked so registerFlora → addPulseReveal gives leaves the grove's pulse
// lighting AND the spherical-normal + wind patch, in one shared onBeforeCompile.
leafMat.userData.leaf = true;

function makeSporeTree(x: number, y: number, z: number, h: number): void {
  const g = new THREE.Group();
  const tseed = Math.abs(Math.sin(x * 3.7 + z * 7.1));

  // Trunk: ONE continuous S-curve — but sampled into a Verlet rope so it can
  // bend. Rest pose IS this curve; shape-match springs (rigid at the base,
  // loose at the crown) pull it home, so it bends progressively and stiffly.
  const lean = 0.5 + tseed * 0.8;
  const dirA = tseed * Math.PI * 2;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(Math.cos(dirA) * lean * 0.35, h * 0.35, Math.sin(dirA) * lean * 0.35),
    new THREE.Vector3(Math.cos(dirA + 0.9) * lean * 0.7, h * 0.72, Math.sin(dirA + 0.9) * lean * 0.6),
    new THREE.Vector3(Math.cos(dirA + 1.4) * lean, h, Math.sin(dirA + 1.4) * lean * 0.9),
  ]);
  const n = 9;
  const radial = 7;
  const pts = curve.getSpacedPoints(n - 1); // arc-length-even → equal links
  const nodes = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  const rest = new Float32Array(n * 3);
  const radii = new Float32Array(n);
  const kShape = new Float32Array(n);
  let segAcc = 0;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    nodes[i * 3] = pts[i].x;
    nodes[i * 3 + 1] = pts[i].y;
    nodes[i * 3 + 2] = pts[i].z;
    prev[i * 3] = pts[i].x;
    prev[i * 3 + 1] = pts[i].y;
    prev[i * 3 + 2] = pts[i].z;
    rest[i * 3] = pts[i].x;
    rest[i * 3 + 1] = pts[i].y;
    rest[i * 3 + 2] = pts[i].z;
    radii[i] = 0.34 - 0.2 * f; // thick trunk tapering to a slim crown-neck
    // Per-FRAME return toward the rest curve (applied once, not per iteration):
    // strong at the base, weak at the crown → bends more up top, springs home.
    kShape[i] = 0.22 * (1 - f) * (1 - f) + 0.015;
    if (i > 0) segAcc += pts[i].distanceTo(pts[i - 1]);
  }
  const segLen = segAcc / (n - 1);

  const tubeGeom = new THREE.BufferGeometry();
  const tubePos = new THREE.BufferAttribute(new Float32Array(n * radial * 3), 3);
  const tubeNrm = new THREE.BufferAttribute(new Float32Array(n * radial * 3), 3);
  tubeGeom.setAttribute('position', tubePos);
  tubeGeom.setAttribute('normal', tubeNrm);
  tubeGeom.setIndex(ropeIndices(n, radial));
  const trunk = new THREE.Mesh(tubeGeom, barkMat);
  trunk.frustumCulled = false;
  // Root flare so it grips the ground instead of poking it.
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.85, 1.1, 9), barkMat);
  flare.position.y = 0.55;
  g.add(trunk, flare);

  // Two branch tubes reaching up-and-out from the upper trunk (static bark).
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

  // Crown: canopy blobs + leaf cards, parented to a group that rides the top
  // node so the whole head leans with the trunk's bend.
  const pal = pickPalette(x, z);
  const glow = new THREE.Color(pal.glow);
  const top = curve.getPoint(1);
  const crown = new THREE.Group();
  crown.position.copy(top);
  // The lumpy icosphere blobs are gone — the leaf clusters ARE the foliage now.
  const canopies: { mesh: THREE.Mesh; base: Float32Array; seed: number }[] = [];

  // Leaf clusters: intersecting-quad clumps filling the whole crown volume, one
  // instanced draw. Wind is GPU-side; these matrices are static (the crown
  // carries them as it sways).
  const leafCount = 30;
  const leafInst = new THREE.InstancedMesh(leafGeo, leafMat, leafCount);
  leafInst.frustumCulled = false;
  const _lm = new THREE.Matrix4();
  const _lq = new THREE.Quaternion();
  const _lp = new THREE.Vector3();
  const _leuler = new THREE.Euler();
  const _lscale = new THREE.Vector3();
  const canopyShell = 2.2 + tseed * 0.8; // sit clumps in the foliage volume
  for (let i = 0; i < leafCount; i++) {
    // Fibonacci-sphere point through the canopy volume, jittered so it's organic.
    const yUnit = 1 - ((i + 0.5) / leafCount) * 1.7; // 1 → -0.7 (mostly upper half)
    const rad = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
    const a = i * 2.399963 + tseed * 6.2; // golden angle
    const jitter = 0.7 + 0.5 * Math.abs(Math.sin(a * 3.1));
    const rr = canopyShell * jitter;
    _lp.set(Math.cos(a) * rad * rr, yUnit * rr - 0.4, Math.sin(a) * rad * rr);
    // Random tilt + roll; the crossed quads read from any angle so this just
    // breaks up uniformity. Scale varies the clump size.
    _leuler.set(Math.sin(a * 1.3) * 0.5, a, Math.cos(a * 0.7) * 0.4);
    _lq.setFromEuler(_leuler);
    const sc = 1.5 + 0.8 * Math.abs(Math.sin(a * 2.1));
    _lscale.set(sc, sc * (1.05 + 0.2 * Math.sin(a)), sc);
    _lm.compose(_lp, _lq, _lscale);
    leafInst.setMatrixAt(i, _lm);
  }
  leafInst.instanceMatrix.needsUpdate = true;
  leafInst.visible = canopyLeafMode;
  crown.add(leafInst);
  g.add(crown);

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
  treeFlora.push({
    group: g,
    crown,
    n,
    nodes,
    prev,
    rest,
    kShape,
    radii,
    segLen,
    radial,
    tubePos,
    tubeNrm,
    anchor: new THREE.Vector3(x + 0.5, y, z + 0.5),
    restTop: top.clone(),
    canopies,
    leafInst,
    leafCount,
    canopyR: 2.4 + tseed * 1.0, // matches the boughs collider footprint
    cwx: 0,
    cwz: 0,
    cwvx: 0,
    cwvz: 0,
    phase: x * 0.23 + z * 0.11,
    wake: 0,
  });
  updateRopeTube({ nodes, n, radii, radial, tubePos, tubeNrm }); // bake rest shape
  fogLightRegistry.push({
    pos: new THREE.Vector3(x, y + h, z),
    color: glow.clone().multiplyScalar(1 / Math.max(glow.r, glow.g, glow.b)),
    intensity: 0.15,
  });
  // Hitboxes: trunk column + the canopy mass.
  addFloraCollider(x + 0.5, z + 0.5, y, y + h, 0.5);
  addFloraCollider(x + 0.5, z + 0.5, y + h - 1.2, y + h + 2.2, 2.4);
}

// --- Micro phosphor glows: button-caps + shelf fungi run the SAME charge
// system as the big shrooms (orb trickle / pulse surge / slow decay / tide
// leach) with MICRO properties: emissive-only glow and a short light reach.
// One lighting engine; per-thing scale. ---
interface MicroGlow {
  pos: THREE.Vector3;
  mat: THREE.MeshStandardMaterial; // shared clump material — the clump glows as one
  baseEmissive: number; // resting "barely alive" glimmer
  charge: number;
}
const microGlows: MicroGlow[] = [];
function registerMicroGlow(
  g: THREE.Group,
  mat: THREE.MeshStandardMaterial,
  yOff: number,
  baseEmissive: number,
): void {
  microGlows.push({
    pos: g.position.clone().add(new THREE.Vector3(0, yOff, 0)),
    mat,
    baseEmissive,
    charge: 0,
  });
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
    emissiveIntensity: 0.05, // PHOSPHORESCENT: near-dark until light charges it
    roughness: 0.85,
    metalness: 0,
    envMapIntensity: 0.04,
  });
  mat.userData.keepGlow = true; // ground caps keep their faint glow (for lighting)
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
  registerMicroGlow(g, mat, 0.3, 0.05); // buttons charge + glow like the big caps, tiny
}

// --- Hanging mycelium strands: a real ROPE, not a rigid rod on a hinge. Each
// strand is a Verlet chain of point-masses pinned at the ceiling and hanging
// under gravity; distance constraints hold the links together, so the thread
// bends at EVERY point along its length. The orb collides with each node, so a
// pass drapes the thread over the glow shell and the spore-balls swing on it
// with real weight. The tube mesh is rebuilt from the node positions each frame.
interface StrandRope {
  group: THREE.Group; // sits at the anchor; never rotated — the nodes carry pose
  anchor: THREE.Vector3;
  n: number; // node count (node 0 is pinned to the anchor)
  nodes: Float32Array; // n×3 LOCAL positions (relative to anchor)
  prev: Float32Array; // n×3 previous positions — Verlet stores velocity as (pos−prev)
  radii: Float32Array; // per-node tube radius
  segLen: number; // rest length between adjacent nodes
  radial: number; // tube cross-section sides
  tubePos: THREE.BufferAttribute; // rewritten each frame from nodes
  tubeNrm: THREE.BufferAttribute;
  beads: THREE.Mesh[]; // spore-balls, each riding a node
  beadNodes: number[];
  phase: number;
  wake: number; // frames of sim left; 0 = asleep (no Verlet, no GPU re-upload)
}
const strandRopes: StrandRope[] = [];

// Triangle indices for an (n-ring, `radial`-sided) tube — built once per shape.
function ropeIndices(n: number, radial: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  }
  return idx;
}

// Rewrite a tube's vertex ring positions + normals to follow the rope nodes.
const _rT = new THREE.Vector3();
const _rN = new THREE.Vector3();
const _rB = new THREE.Vector3();
const _rRef = new THREE.Vector3();
function updateRopeTube(rope: {
  nodes: Float32Array;
  n: number;
  radii: Float32Array;
  radial: number;
  tubePos: THREE.BufferAttribute;
  tubeNrm: THREE.BufferAttribute;
}): void {
  const { nodes, n, radii, radial, tubePos, tubeNrm } = rope;
  const pos = tubePos.array as Float32Array;
  const nrm = tubeNrm.array as Float32Array;
  for (let i = 0; i < n; i++) {
    const i0 = i > 0 ? i - 1 : 0;
    const i1 = i < n - 1 ? i + 1 : n - 1;
    _rT.set(
      nodes[i1 * 3] - nodes[i0 * 3],
      nodes[i1 * 3 + 1] - nodes[i0 * 3 + 1],
      nodes[i1 * 3 + 2] - nodes[i0 * 3 + 2],
    );
    if (_rT.lengthSq() < 1e-9) _rT.set(0, -1, 0);
    _rT.normalize();
    _rRef.set(0, 0, 1);
    if (Math.abs(_rT.z) > 0.9) _rRef.set(1, 0, 0);
    _rN.crossVectors(_rT, _rRef).normalize();
    _rB.crossVectors(_rT, _rN).normalize();
    const cx = nodes[i * 3];
    const cy = nodes[i * 3 + 1];
    const cz = nodes[i * 3 + 2];
    const r = radii[i];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nx = _rN.x * ca + _rB.x * sa;
      const ny = _rN.y * ca + _rB.y * sa;
      const nz = _rN.z * ca + _rB.z * sa;
      const vi = (i * radial + j) * 3;
      pos[vi] = cx + nx * r;
      pos[vi + 1] = cy + ny * r;
      pos[vi + 2] = cz + nz * r;
      nrm[vi] = nx;
      nrm[vi + 1] = ny;
      nrm[vi + 2] = nz;
    }
  }
  tubePos.needsUpdate = true;
  tubeNrm.needsUpdate = true;
}

function makeStrandAt(px: number, py: number, pz: number, len: number): void {
  const g = new THREE.Group();
  const pal = pickPalette(Math.floor(px), Math.floor(pz));
  const glow = new THREE.Color(pal.glow);
  const drift = 0.06 + Math.abs(Math.sin(px * 1.7 + pz * 2.3)) * 0.12; // slight lean
  const dirA = Math.abs(Math.sin(px * 3.1 + pz * 1.3)) * Math.PI * 2;

  // Rope nodes: node count scales with length so segments stay short enough that
  // the orb (r≈0.62) can't slip between two nodes without touching one.
  const n = Math.max(6, Math.min(12, Math.round(len / 0.4) + 1));
  const radial = 5;
  const segLen = len / (n - 1);
  const nodes = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1); // 0 at anchor → 1 at tip
    // Rest pose: straight down with the drift growing toward the tip (catenary).
    nodes[i * 3] = Math.cos(dirA) * drift * f * f;
    nodes[i * 3 + 1] = -len * f;
    nodes[i * 3 + 2] = Math.sin(dirA) * drift * f * f;
    prev[i * 3] = nodes[i * 3];
    prev[i * 3 + 1] = nodes[i * 3 + 1];
    prev[i * 3 + 2] = nodes[i * 3 + 2];
    radii[i] = 0.028 + 0.02 * f; // faint taper, a touch fatter toward the tip
  }

  const strandMat = new THREE.MeshStandardMaterial({
    color: 0x0c1512, // near-black, matching the beads so the mycelium reads dark;
    emissive: glow, //  the faintest bioluminescence — only noticeable up close
    emissiveIntensity: 0.05,
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: 0.03,
    side: THREE.DoubleSide,
  });
  const tubeGeom = new THREE.BufferGeometry();
  const tubePos = new THREE.BufferAttribute(new Float32Array(n * radial * 3), 3);
  const tubeNrm = new THREE.BufferAttribute(new Float32Array(n * radial * 3), 3);
  tubeGeom.setAttribute('position', tubePos);
  tubeGeom.setAttribute('normal', tubeNrm);
  tubeGeom.setIndex(ropeIndices(n, radial));
  const tube = new THREE.Mesh(tubeGeom, strandMat);
  tube.frustumCulled = false; // verts live in the buffer, not the local bounds
  g.add(tube);

  // Spore balls: beads riding chosen nodes, swelling toward the tip.
  const beadMat = new THREE.MeshStandardMaterial({
    color: 0x0c1512,
    emissive: glow,
    emissiveIntensity: 0.1, // spore-ball tips: the faintest glimmer, close-only
    roughness: 0.6,
    metalness: 0,
  });
  const beads: THREE.Mesh[] = [];
  const beadNodes = [
    Math.round((n - 1) * 0.45),
    Math.round((n - 1) * 0.72),
    n - 1,
  ];
  for (let i = 0; i < beadNodes.length; i++) {
    const r = 0.04 + i * 0.035 + len * 0.008; // tip bead is the fattest
    const bead = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), beadMat);
    const ni = beadNodes[i];
    bead.position.set(nodes[ni * 3], nodes[ni * 3 + 1], nodes[ni * 3 + 2]);
    g.add(bead);
    beads.push(bead);
  }

  g.position.set(px, py, pz);
  scene.add(g);
  registerFlora(g);
  // The mycelium is fungus too — strand + spore beads run the SAME phosphor
  // charge law as every other cap (orb trickle / pulse surge / decay / tide
  // leach) at micro scale. Charge points sit down the strand where it actually
  // hangs: mid-rope for the filament, near the tip where the beads cluster.
  registerMicroGlow(g, strandMat, -len * 0.55, 0.05);
  registerMicroGlow(g, beadMat, -len * 0.85, 0.1);

  const rope: StrandRope = {
    group: g,
    anchor: new THREE.Vector3(px, py, pz),
    n,
    nodes,
    prev,
    radii,
    segLen,
    radial,
    tubePos,
    tubeNrm,
    beads,
    beadNodes,
    phase: px * 0.5 + pz * 0.7,
    wake: 0,
  };
  updateRopeTube(rope); // bake the rest pose so it's shaped before first sim
  strandRopes.push(rope);
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
    emissiveIntensity: 0.05, // PHOSPHORESCENT: near-dark until light charges it
    roughness: 0.85,
    metalness: 0,
    envMapIntensity: 0.04,
  });
  mat.userData.keepGlow = true; // shelf fungi keep their faint glow (for lighting)
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
  registerMicroGlow(g, mat, 0.5, 0.05); // shelves charge + glow like the big caps, tiny
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
/** ?world=map boots the game INTO the generated world map (Phase-5 bridge):
 *  the orb + all its verbs, streaming across the real continent. Default
 *  stays the demo arena. ?wr=4000 shrinks the world. */
const MAP_MODE = new URLSearchParams(location.search).get('world') === 'map';
let worldGen: WorldGen | null = null;
let worldStream: WorldStream | null = null;
let streamTick = 0;
let floraCullIdx = 0;
/** MAP_MODE worker meshing: the mesher core runs off-thread; the main thread
 *  only copies slabs out (~0.3ms) and wraps arriving geometry. Kills the
 *  smooth-smooth-SPIKE stutter of 8-15ms in-frame chunk meshes. */
let meshWorker: Worker | null = null;
const meshInFlight = new Map<string, Chunk>();
let meshInstallMs = 0; // arrival-side cost, folded into the perf overlay's mesh line
if (MAP_MODE) {
  meshWorker = new Worker(new URL('./render/mesherWorker.ts', import.meta.url), { type: 'module' });
  meshWorker.onmessage = (e: MessageEvent<{ key: string; arrays?: Parameters<typeof geometryFromArrays>[0] }>) => {
    const t0 = performance.now();
    const { key, arrays } = e.data;
    const c = meshInFlight.get(key);
    meshInFlight.delete(key);
    // Chunk may have streamed out (or been replaced) while the worker ran.
    if (!c || world.chunks.get(key) !== c) return;
    const old = chunkMeshes.get(c);
    if (old) {
      scene.remove(old);
      old.geometry.dispose();
    }
    if (arrays) {
      const CS = World.chunkSize;
      const mesh = new THREE.Mesh(geometryFromArrays(arrays), worldMaterial);
      mesh.position.set(0, 0, 0); // world coords are baked into the geometry
      mesh.userData.aabb = new THREE.Box3(
        new THREE.Vector3(c.cx * CS - 1, c.cy * CS - 1, c.cz * CS - 1),
        new THREE.Vector3((c.cx + 1) * CS + 1, (c.cy + 1) * CS + 1, (c.cz + 1) * CS + 1),
      );
      chunkMeshes.set(c, mesh);
      scene.add(mesh);
    } else {
      chunkMeshes.delete(c);
    }
    meshInstallMs += performance.now() - t0;
  };
}

/** Dispatch dirty+ready chunks to the mesh worker (up to 2 in flight). */
function pumpMeshWorker(): void {
  if (!meshWorker || !worldStream) return;
  for (const c of world.chunks.values()) {
    if (meshInFlight.size >= 2) break;
    if (!c.dirty) continue;
    if (!worldStream.canMesh(c.cx, c.cz)) continue;
    const key = `${c.cx},${c.cy},${c.cz}`;
    if (meshInFlight.has(key)) continue;
    const { mats, light } = copySlabsFor(world, c);
    c.dirty = false;
    meshInFlight.set(key, c);
    const CS = World.chunkSize;
    meshWorker.postMessage(
      { key, mats, light, bx: c.cx * CS, by: c.cy * CS, bz: c.cz * CS },
      [mats.buffer, light.buffer],
    );
  }
}
/** MAP_MODE ocean: one translucent plane at sea level following the orb (the
 *  demo's WaterZone is testbed-specific; the real sea shader comes later). */
let seaPlane: THREE.Mesh | null = null;
// Optimized for performance: reduce initial generation, stream the rest.
// 256×256 = 512²; was causing 30fps. Scale back, rely on streaming for expansion.
const REEK_HALF_INIT = 128; // 256×256 voxel initial area (was 512×512 = too much upfront)

// Hook for POI callbacks
// Trees are now authored GLTF props (see the imported-flora block below). GLTF
// loads asynchronously, but worldgen runs synchronously right here — so the tree
// hook just RECORDS each placement; the models are built once the assets land.
const pendingTrees: { x: number; y: number; z: number; h: number }[] = [];
// Groves are likewise deferred: recorded here, then built as imported multicolour
// asset caps once the GLTFs land (procedural makeGlowcap is the fallback).
const pendingGroves: { x: number; y: number; z: number; h: number }[] = [];

/** Uniform hash — ReekGen's recipe (map-mode decoration must be seeded and
 *  position-deterministic exactly like the demo's worldgen). */
function mapHash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * MAP_MODE: the demo's Reek surface decoration (ReekGen §surface, ported
 * per-column) driving the SAME reekHooks — glowcap groves, crystal nodes,
 * button clumps, spore-trees, reek-grass, pickups, Keeper beacons. The Reek
 * in the world map is FULL demo detail (John); other biomes keep stand-ins.
 */
function decorateMapColumn(ccx: number, ccz: number): void {
  if (!worldGen) return;
  const REEK = 1;
  const x0 = ccx * 32;
  const z0 = ccz * 32;
  // reek-grass per voxel column (sparser than the demo arena — world scale)
  for (let dz = 0; dz < 32; dz++) {
    for (let dx = 0; dx < 32; dx++) {
      const x = x0 + dx;
      const z = z0 + dz;
      if (worldGen.biomeId(x, z) !== REEK) continue;
      if (mapHash(x, z, REEK_SEED + 131) <= 0.8) continue;
      const h = worldGen.height(x, z);
      if (h > SEA_LEVEL) reekHooks.grass(x, h + 1, z);
    }
  }
  // POI lattice (STEP 16): each jittered point is built by the column that
  // contains it, so cross-border POIs are never doubled or dropped.
  const STEP = 16;
  for (let gz = Math.floor((z0 - STEP) / STEP) * STEP; gz < z0 + 32 + STEP; gz += STEP) {
    for (let gx = Math.floor((x0 - STEP) / STEP) * STEP; gx < x0 + 32 + STEP; gx += STEP) {
      const jx = gx + Math.floor((mapHash(gx, gz, REEK_SEED + 53) - 0.5) * 10);
      const jz = gz + Math.floor((mapHash(gz, gx, REEK_SEED + 59) - 0.5) * 10);
      if (jx < x0 || jx >= x0 + 32 || jz < z0 || jz >= z0 + 32) continue;
      if (worldGen.biomeId(jx, jz) !== REEK) continue;
      const fy = worldGen.height(jx, jz) + 1;
      if (fy <= SEA_LEVEL + 1) continue;
      const r = mapHash(gx / STEP, gz / STEP, REEK_SEED + 47);
      if (r < 0.42) {
        // glowcap grove + pickups + button fringe (demo probabilities)
        const count = 2 + Math.floor(mapHash(jx, jz, REEK_SEED + 61) * 3);
        for (let m = 0; m < count; m++) {
          const mx = jx + Math.floor((mapHash(jx + m, jz, REEK_SEED + 67) - 0.5) * 7);
          const mz = jz + Math.floor((mapHash(jz + m, jx, REEK_SEED + 71) - 0.5) * 7);
          const my = worldGen.height(mx, mz) + 1;
          const gh = 2.5 + mapHash(mx, mz, REEK_SEED + 73) * 3;
          reekHooks.grove(mx, my, mz, gh);
          world.set(mx, Math.round(my + gh + 1), mz, Mat.GlowAir);
        }
        if (mapHash(jx, jz, REEK_SEED + 79) > 0.35) reekHooks.pickup(jx + 1, fy + 1.4, jz - 1);
        if (mapHash(jz, jx, REEK_SEED + 83) > 0.6) reekHooks.pickup(jx - 2, fy + 1.6, jz + 2);
        for (let b = 0; b < 2; b++) {
          if (mapHash(jx + b * 7, jz - b * 5, REEK_SEED + 157) > 0.4) {
            const bx = jx + Math.floor((mapHash(jx, b, REEK_SEED + 163) - 0.5) * 12);
            const bz = jz + Math.floor((mapHash(jz, b, REEK_SEED + 167) - 0.5) * 12);
            reekHooks.buttons(bx, worldGen.height(bx, bz) + 1, bz);
          }
        }
      } else if (r < 0.56) {
        // crystal node — cold light + the fog registry
        for (let c = 0; c < 5; c++) {
          const cx = jx + (c % 3) - 1;
          const cz = jz + Math.floor(mapHash(c, jx, REEK_SEED + 89) * 3) - 1;
          const chh = 1 + Math.floor(mapHash(cx, cz, REEK_SEED + 97) * 3);
          const cy = worldGen.height(cx, cz) + 1;
          for (let y = cy; y < cy + chh; y++) world.set(cx, y, cz, Mat.Crystal);
        }
        reekHooks.crystalLight(jx, fy + 2, jz);
      } else if (r < 0.68) {
        reekHooks.buttons(jx, fy, jz);
        if (mapHash(jz, jx, REEK_SEED + 171) > 0.5) {
          reekHooks.buttons(jx + 5, worldGen.height(jx + 5, jz - 3) + 1, jz - 3);
        }
      } else if (r >= 0.72 && r < 0.9) {
        // spore-tree stand
        const count = 1 + Math.floor(mapHash(jx, jz, REEK_SEED + 137) * 2);
        for (let t = 0; t < count; t++) {
          const tx = jx + Math.floor((mapHash(jx + t, jz, REEK_SEED + 139) - 0.5) * 8);
          const tz = jz + Math.floor((mapHash(jz + t, jx, REEK_SEED + 149) - 0.5) * 8);
          const ty = worldGen.height(tx, tz) + 1;
          const th = 7 + mapHash(tx, tz, REEK_SEED + 151) * 4;
          reekHooks.tree(tx, ty, tz, th);
          world.set(tx, Math.round(ty + th + 1), tz, Mat.GlowAir);
        }
      } else if (r > 0.93) {
        // dead Keeper beacon — the worldbuilding whisper
        for (let y = fy; y < fy + 7; y++) world.set(jx, y, jz, Mat.Metal);
        world.set(jx, fy + 7, jz, Mat.Glass);
      }
    }
  }
}

const reekHooks = {
  grove: (x: number, y: number, z: number, h: number) => pendingGroves.push({ x, y, z, h }),
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
  tree: (x: number, y: number, z: number, h: number) => pendingTrees.push({ x, y, z, h }),
  buttons: (x: number, y: number, z: number) =>
    makeButtons(x, smoothSurfaceY(x, z, y) - 0.04, z),
  strand: (x: number, cy: number, z: number, len: number) =>
    makeStrand(x, cy, z, len),
  shelf: (x: number, y: number, z: number, dx: number, dz: number) =>
    makeShelf(x, y, z, dx, dz),
};

// Generate the initial area: the demo arena, or (MAP_MODE) the world map's
// spawn region streamed through the ring ladder.
let reek: { spawn: [number, number, number]; beacons: [number, number, number][]; entrances: [number, number][] };
let testbeds: ReturnType<typeof carveTestbeds> | null = null;
if (MAP_MODE) {
  await bootStatus('reading the world map…');
  worldGen = new WorldGen(REEK_SEED, Number(new URLSearchParams(location.search).get('wr') ?? 6000));
  worldGen.labReekFlora = false; // the demo pipeline (below) dresses the Reek
  worldStream = new WorldStream(world, worldGen, 5, decorateMapColumn);
  logger('world').info(
    `map world "${worldGen.map.names.continents[0]}" · ${worldGen.map.names.ocean} · #${worldGen.map.checksum}`,
  );
  await bootStatus('waking the near dark…');
  let guard = 0;
  while (worldStream.busy(0, 0) && guard++ < 4000) {
    worldStream.update(0, 0, 40);
    if (guard % 6 === 0) await bootStatus(`waking the near dark…`);
  }
  reek = { spawn: [0.5, worldGen.height(0, 0) + 2.5, 0.5], beacons: [], entrances: [] };
  seaPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshBasicMaterial({ color: 0x0e2f3e, transparent: true, opacity: 0.72, depthWrite: false }),
  );
  seaPlane.rotation.x = -Math.PI / 2;
  seaPlane.position.y = SEA_LEVEL + 0.42;
  scene.add(seaPlane);
} else {
  logger('world').info(`generating initial ${REEK_HALF_INIT * 2}×${REEK_HALF_INIT * 2} voxel area…`);
  await bootStatus('growing the reek…');
  reek = generateReek(world, REEK_SEED, REEK_HALF_INIT, reekHooks);
  logger('world').info(`initial area loaded — ${world.chunks.size} chunks`);

  // Elemental testbeds — carve the water / forge / build-sandbox stages into
  // three map corners BEFORE the light flood so their emissives light and mesh
  // with everything else. Skipped in MAP_MODE (they'd blast craters into the
  // real terrain — they return as proper POIs later).
  await bootStatus('carving the testbeds…');
  testbeds = carveTestbeds(world);
  logger('world').info('testbeds carved (water NW · forge NE · sandbox SW)');

  await bootStatus('first light…');
  lightGrid.update();
}
// Meshing is the long block (~600 chunks) — do it in slices with a live
// percentage so the loading screen moves instead of freezing.
{
  let dirtyTotal = 0;
  for (const c of world.chunks.values()) if (c.dirty) dirtyTotal++;
  let done = 0;
  while (done < dirtyTotal) {
    remeshDirtyChunks(36);
    done = Math.min(dirtyTotal, done + 36);
    await bootStatus(`shaping the world… ${Math.round((done / dirtyTotal) * 100)}%`);
  }
}

// Sampled light volume: pack the flood-fill into a 2D atlas the terrain shader
// can read per-fragment. Wired but OFF by default (uLightVolMix = 0) — flip it
// on with waiver.lightVol(1) to A/B it against the baked light before we rely
// on it for dynamic (charge-driven) lighting.
const lightVol = new LightVolume(
  // Reaches down to bedrock (caves now run to y≈-40) so the charge-driven
  // volume covers the full underdark, not just the surface band.
  new THREE.Vector3(-REEK_HALF_INIT, -42, -REEK_HALF_INIT),
  new THREE.Vector3(REEK_HALF_INIT, 20, REEK_HALF_INIT),
  2,
);
lightVol.rebuild(
  (x, y, z) => lightGrid.sample(x, y, z),
  (x, y, z) => world.solid(x, y, z), // solidity → alpha, for ray-marched shadows
);
uniforms.uLightAtlas.value = lightVol.texture;
uniforms.uLightMin.value.copy(lightVol.min);
uniforms.uLightStep.value = lightVol.step;
uniforms.uLightDim.value.copy(lightVol.dim);
uniforms.uLightTiles.value.copy(lightVol.tiles);
logger('lightvol').info(
  `${lightVol.texture.image.width}x${lightVol.texture.image.height} atlas` +
    ` (${lightVol.dim.x}x${lightVol.dim.y}x${lightVol.dim.z} voxels)`,
);

// --- Elemental testbed visual systems (water surface · fire · build editor) ---
// Carved geometry lives in the world; these own the meshes/particles that bring
// each corner to life. All are driven per-frame in frame().
// Fish share the flora's pulse-reveal patch: black shadows in the water until
// the orb's bubble or the echo pulse paints them.
const waterZone = testbeds ? new WaterZone(testbeds.water.pools, moteTexture, addPulseReveal) : null;
// One lighting engine: the water shadow-marches the SAME light-volume the
// terrain/flora shaders hold — shared uniform OBJECTS, so it's always current.
waterZone?.wireLightVolume({
  uLightAtlas: uniforms.uLightAtlas,
  uLightMin: uniforms.uLightMin,
  uLightStep: uniforms.uLightStep,
  uLightDim: uniforms.uLightDim,
  uLightTiles: uniforms.uLightTiles,
});
if (waterZone) scene.add(waterZone.group);
// John's rigged fish (public/assets/fish). Async — a simple placeholder school
// swims until these land, then the rigged bodies take over. If a nose points
// the wrong way, waiver.waterZone.flipFish() spins them 180°.
waterZone
  ?.loadFishModels('assets/fish/bigfish.glb', 'assets/fish/littlefish.glb')
  .catch((err) => logger('water').warn('fish models failed', err));

const fireZone = testbeds ? new FireZone(testbeds.forge.hearths, testbeds.forge.bed, moteTexture) : null;
const fireFogIdx = fogLightRegistry.length;
if (fireZone) {
  scene.add(fireZone.group);
  // The hearth throws real, flickering light — register it so the orb's
  // reflected sheen (and future fog) picks it up. Refreshed each frame.
  fogLightRegistry.push({
    pos: fireZone.light.position.clone(),
    color: new THREE.Color(1.0, 0.5, 0.18),
    intensity: 1.4,
  });
}

// --- Discovery minimap: dark until explored, with the zones marked so the
// corners are findable (John: "I can't find the lake"). Settings live in
// Menu → Settings → Map. Baked AFTER the carve so the lake shows as water.
const minimap = new Minimap(world, REEK_HALF_INIT, (bx, bz) => {
  if (MAP_MODE && worldGen) return worldGen.biomeAt(bx, bz);
  // Zone stages were pushed in carve order: water, forge, sandbox.
  const inRect = (s: { x0: number; z0: number; x1: number; z1: number } | undefined) =>
    !!s && bx >= s.x0 && bx < s.x1 && bz >= s.z0 && bz < s.z1;
  if (inRect(testbeds?.stages[0])) return 'The Reek — The Lake';
  if (inRect(testbeds?.stages[1])) return 'The Reek — The Forge';
  if (inRect(testbeds?.stages[2])) return 'The Reek — The Sandbox';
  return orbRoofed ? 'The Reek — The Deeps' : 'The Reek';
});
minimap.setMarkers(
  testbeds
    ? [
        { x: testbeds.water.center.x, z: testbeds.water.center.z, icon: '◈', label: 'Lake', color: '#54c8ff' },
        { x: testbeds.forge.center.x, z: testbeds.forge.center.z, icon: '◆', label: 'Forge', color: '#ff9a4a' },
        { x: testbeds.sandbox.center.x, z: testbeds.sandbox.center.z, icon: '▣', label: 'Sandbox', color: '#9fe8ff' },
        { x: reek.spawn[0], z: reek.spawn[2], icon: '✦', label: 'Spawn', color: '#7fffd1' },
      ]
    : [{ x: reek.spawn[0], z: reek.spawn[2], icon: '✦', label: 'Spawn', color: '#7fffd1' }],
);

// --- Mushroom folk: the Reek's own people. Meshy-rigged GLBs (assets/folk)
// driven by the channel rig in entity/ — spawned in an arc at the spawn point
// so they're the first living things the orb meets. K opens the Animator UI
// (pose/keyframe/export), M cycles their STILL/WALK/MOVE/ATTACK toggle.
// The orb's DASH and the sandbox FORCE WAVE damage them (see frame loop +
// onForceWave below); their attacks shove the orb but never kill it.
const folk = new FolkManager({
  scene,
  solid: (x, y, z) => world.solid(x, y, z),
  moteTexture,
  getOrbPos: () => orb.pos,
  onOrbHit: (from, power) => {
    const dir = orb.pos.clone().sub(from).setY(0).normalize();
    orb.vel.x += dir.x * power;
    orb.vel.z += dir.z * power;
    orb.vel.y += power * 0.35;
    pulseFlash = Math.max(pulseFlash, 0.5); // the aura flinches
    mood.event('effort');
  },
});
const animatorUI = new AnimatorUI(folk, () => orb.pos);
void folk.load().then(() => {
  folk.spawnAll(
    new THREE.Vector3(reek.spawn[0] + 4.5, reek.spawn[1], reek.spawn[2] - 2),
    new THREE.Vector3(reek.spawn[0], reek.spawn[1], reek.spawn[2]),
  );
});

const buildSandbox = !testbeds ? null : new BuildSandbox({
  scene,
  world,
  moteTexture,
  deck: testbeds!.sandbox.deck, // building/destruction is gated to this footprint
  // world.set() already marks the touched chunk (+boundary neighbours) dirty, so
  // we ONLY remesh those. We deliberately skip the full-world lightGrid.update()
  // here — that global flood-fill was the per-edit stutter. Baked light on the
  // new/removed voxel is left as-is (fine for the sandbox; a live relight is a
  // later refinement, not a per-keystroke cost).
  commit: (edits) => {
    for (const [x, y, z, m] of edits) world.set(x, y, z, m);
    remeshDirtyChunks();
  },
  onForceWave: (origin) => {
    waterZone?.splash(origin);
    folk.applyForceWave(origin); // the wave shoves + hurts the mushroom folk
  },
});

// Dark-game surface pass over every flora material:
//   1. Strip the RoomEnvironment IBL — nothing floats half-lit in the dark.
//   2. DEEPEN bright albedos — in a dark game a surface only shows what light
//      reflects off it, so a bright albedo (the white leaf cards) blows out the
//      instant any light touches it. Clamp each albedo's luminance down so lit
//      surfaces read as a soft reveal, not a glare; already-dark albedos are
//      left alone. Emissive (the bioluminescence) is untouched.
// Materials are shared across flora, so each is processed exactly once.
const ALBEDO_MAX_LUM = 0.5; // deepest a lit flora surface may reflect. With no
// ambient/fog anymore, flora is black until a light touches it — so the albedo
// must be REFLECTIVE enough to actually read in the orb's beam (0.22 was so dark
// nothing but the self-emitting shrooms showed). Darkness comes from no-light,
// not from a crushed albedo.
const seenMats = new Set<THREE.Material>();
for (const f of floraCull) {
  f.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      const m = raw as THREE.MeshStandardMaterial;
      if ('envMapIntensity' in m) m.envMapIntensity = 0;
      if (m.color && !seenMats.has(m)) {
        seenMats.add(m);
        const lum = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
        if (lum > ALBEDO_MAX_LUM) m.color.multiplyScalar(ALBEDO_MAX_LUM / lum);
      }
    }
  });
}

// (Removed the per-frame dynamic re-flood: repacking the whole light atlas ~3×/s
//  spiked frames = the stutter. The volume's solidity — all the shaders need for
//  ray-marched shadows — is static and built once at load. Dynamic sources come
//  back as real shader lights next, not a texture repack.)

// Re-seat pre-carve grass onto the testbed stages: worldgen placed these tufts
// BEFORE carveTestbeds flattened the corners, so anything inside a stage
// floats at the old terrain height. Probe each column for its REAL solid top —
// water voxels are non-solid, so tufts over the lake fall through and seat ON
// the dirt lakebed, waving under the surface.
for (const spot of grassSpots) {
  const vx = Math.floor(spot[0]);
  const vz = Math.floor(spot[2]);
  if (!testbeds || !testbeds.stages.some((s) => vx >= s.x0 && vx < s.x1 && vz >= s.z0 && vz < s.z1)) continue;
  for (let y = 22; y > -8; y--) {
    if (world.solid(vx, y, vz)) {
      spot[1] = y + 1 - 0.06;
      break;
    }
  }
}
// Plant the lakebed itself: a deterministic scatter of extra tufts across the
// wet columns — kelp-like growth swaying under the surface (same wind/orb
// shader as land grass; lit only when light reaches down to it).
if (testbeds) {
  const lake = testbeds.water.pools[0];
  const surfY = Math.floor(lake.surfaceY);
  for (let vx = Math.ceil(lake.cx - lake.halfX); vx < lake.cx + lake.halfX; vx += 2) {
    for (let vz = Math.ceil(lake.cz - lake.halfZ); vz < lake.cz + lake.halfZ; vz += 2) {
      if (((vx * 374761393 + vz * 668265263) >>> 0) % 1000 > 300) continue; // ~30% of sampled columns
      if (world.get(vx, surfY, vz) !== Mat.Water) continue; // dry column
      for (let y = surfY; y > surfY - 10; y--) {
        if (world.solid(vx, y, vz)) {
          grassSpots.push([vx + 0.5, y + 1 - 0.06, vz + 0.5]);
          break;
        }
      }
    }
  }
}

// Grass builds AFTER the light flood so each tuft bakes its held light.
const grassField = new GrassField();
// One lighting engine: grass adopts the shared light-volume uniform objects so
// its orb bubble shadow-marches the same world solidity as everything else.
grassField.uniforms.uLightAtlas = uniforms.uLightAtlas;
grassField.uniforms.uLightMin = uniforms.uLightMin;
grassField.uniforms.uLightStep = uniforms.uLightStep;
grassField.uniforms.uLightDim = uniforms.uLightDim;
grassField.uniforms.uLightTiles = uniforms.uLightTiles;
for (const [gx0, gy0, gz0] of grassSpots) {
  grassField.addTuft(gx0, gy0, gz0, lightGrid.sample(gx0, gy0 + 1, gz0) / 15);
}
const bladeCount = grassField.build(scene);
logger('grass').info(`${bladeCount} blades`);
orb.spawn(reek.spawn[0], reek.spawn[1], reek.spawn[2]);
if (boot) boot.remove();

// Dev handle: inspect/teleport for tuning flora up close.
(window as unknown as { waiver: unknown }).waiver = {
  orb,
  camera,
  scene,
  treeFlora,
  shroomFlora,
  strandRopes,
  /** Warp the orb next to a tree so its canopy fills the view. */
  toTree(i = 0) {
    const t = treeFlora[i];
    if (!t) return 'no tree';
    orb.pos.set(t.anchor.x + 6, t.anchor.y + 9, t.anchor.z + 6);
    orb.vel.set(0, 0, 0);
    return t.anchor.toArray();
  },
};

// --- Imported CC0 flora ---------------------------------------------------
// Authored GLTF props (Quaternius CC0 nature kit — public/assets/flora, see
// CREDITS.txt) replace the procedural spore-trees and add ground foliage. Every
// prop flows through the SAME systems as native flora: the echolocation
// pulse-reveal patch, distance culling, and hit colliders. Trees also get a
// lightweight brush+pulse SWAY (below) so the environment still reacts to the
// orb — full native Verlet doesn't transfer to arbitrary meshes, so instead the
// whole prop leans away when the orb presses in and shudders as the pulse
// passes, then springs back upright.
const floraLib = new FloraLibrary();
const importedFlora: THREE.Group[] = [];

interface SwayProp {
  group: THREE.Group;
  x: number;
  z: number;
  brushR: number; // orb within this radius (voxels) starts a lean
  lx: number; // current lean (radians) + velocity, per axis
  lz: number;
  lvx: number;
  lvz: number;
}
const swayProps: SwayProp[] = [];

// --- Imported-mushroom rig -------------------------------------------------
// A single GLTF mushroom is one mesh, so to move cap and stalk on separate axes
// we SPLIT the mesh at the cap/stalk junction into two hinged pieces: the stalk
// stays under the root group, the cap goes under a pivot at the junction. The
// split pieces are then handed to the SAME native glowcap sim (shroomFlora loop)
// as the procedural placeholders, so an imported shroom moves identically to the
// one it replaces — it is a straight visual swap, no new movement code.

/** Find the local y where the cap begins: bin vertices by height, take the ring
 *  just below the widest one (the cap's overhang crown). */
function findCapStartY(geos: THREE.BufferGeometry[], maxY: number): number {
  const BINS = 16;
  const maxR = new Float32Array(BINS);
  for (const g of geos) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const b = Math.min(BINS - 1, Math.max(0, Math.floor((p.getY(i) / maxY) * BINS)));
      const r = Math.hypot(p.getX(i), p.getZ(i));
      if (r > maxR[b]) maxR[b] = r;
    }
  }
  // Search for the widest ring only in the UPPER structure — a wide mossy base
  // or a low cluster would otherwise be mistaken for the cap crown. Bias to the
  // top ~55% so the junction lands at the real cap/stalk neck.
  const lo = Math.floor(BINS * 0.45);
  let widest = 0;
  let wb = Math.floor(BINS * 0.7);
  for (let b = lo; b < BINS; b++) if (maxR[b] > widest) ((widest = maxR[b]), (wb = b));
  return (Math.max(lo, wb - 2) / BINS) * maxY;
}

/** Partition a geometry's triangles into below/above a local y plane. */
function splitGeometryByY(
  geo: THREE.BufferGeometry,
  splitY: number,
): { lower: THREE.BufferGeometry; upper: THREE.BufferGeometry } {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const col = g.getAttribute('color');
  const lo = { p: [] as number[], n: [] as number[], u: [] as number[], c: [] as number[] };
  const hi = { p: [] as number[], n: [] as number[], u: [] as number[], c: [] as number[] };
  for (let t = 0; t < pos.count; t += 3) {
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const d = cy >= splitY ? hi : lo;
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      d.p.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nrm) d.n.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      if (uv) d.u.push(uv.getX(i), uv.getY(i));
      if (col) d.c.push(col.getX(i), col.getY(i), col.getZ(i));
    }
  }
  const build = (d: { p: number[]; n: number[]; u: number[]; c: number[] }) => {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3));
    if (d.n.length) bg.setAttribute('normal', new THREE.Float32BufferAttribute(d.n, 3));
    if (d.u.length) bg.setAttribute('uv', new THREE.Float32BufferAttribute(d.u, 2));
    if (d.c.length) bg.setAttribute('color', new THREE.Float32BufferAttribute(d.c, 3));
    if (!d.n.length) bg.computeVertexNormals();
    return bg;
  };
  return { lower: build(lo), upper: build(hi) };
}

/** Split an imported mushroom into a leaning stalk + a wobbling cap, in place.
 *  Returns the cap pivot + junction height, or null if it couldn't be split. */
function rigMushroom(group: THREE.Group): { capPivot: THREE.Group; capStartY: number } | null {
  group.updateMatrixWorld(true);
  const groupInv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  if (meshes.length === 0) return null;
  // Bake each mesh's geometry into the group's local space (feet at y≈0).
  const baked: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[] = [];
  let maxY = 1e-4;
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4().multiplyMatrices(groupInv, m.matrixWorld);
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    geo.applyMatrix4(local);
    geo.computeBoundingBox();
    maxY = Math.max(maxY, geo.boundingBox!.max.y);
    baked.push({ geo, mat: m.material });
  }
  const capStartY = findCapStartY(
    baked.map((b) => b.geo),
    maxY,
  );
  if (capStartY <= 0.05 || capStartY >= maxY * 0.97) return null; // no clean split
  const originals = group.children.filter((c) => !(c as THREE.Sprite).isSprite);
  const capPivot = new THREE.Group();
  capPivot.position.y = capStartY;
  const lowers: THREE.Mesh[] = [];
  for (const { geo, mat } of baked) {
    const { lower, upper } = splitGeometryByY(geo, capStartY);
    if (lower.getAttribute('position').count > 0) lowers.push(new THREE.Mesh(lower, mat));
    if (upper.getAttribute('position').count > 0) {
      upper.translate(0, -capStartY, 0); // sit under the pivot, render in place
      capPivot.add(new THREE.Mesh(upper, mat));
    }
  }
  for (const c of originals) group.remove(c); // drop the un-split original meshes
  for (const lm of lowers) group.add(lm);
  group.add(capPivot);
  return { capPivot, capStartY };
}

/** Deterministic 0..1 hash so a given (seed) always scatters the same foliage. */
function frand(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Topmost solid voxel under (x,z), smoothed — a robust seat for scattered props
 *  whose x/z we invent (native flora already know their surface y). */
function groundYAt(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const top = Math.round(reek.spawn[1]);
  for (let y = top + 24; y > top - 48; y--) {
    if (world.solid(ix, y, iz)) return smoothSurfaceY(ix, iz, y);
  }
  return top;
}

interface PlaceOpts {
  height?: number;
  collide?: boolean;
  sway?: boolean;
  brushR?: number;
  /** Sink the base this many units below the ground (only the top pokes out). */
  sink?: number;
  /** Per-instance colour — tints albedo AND emission so the same mesh can appear
   *  (and glow) in many colours across a grove. */
  tint?: THREE.Color;
}
// Which imported props are fungi — these enlist in the phosphorescence loop.
const MUSHROOM_KINDS = new Set<FloraName>(['mushroom_01', 'mushroom_02']);

/** The shroom's own dominant colour, sampled from its base texture — saturation-
 *  weighted so the vivid cap wins over pale spots/stalk, then normalised to a
 *  bright hue. Used to tint the light + halo a phosphorescent shroom emits, so a
 *  blue shroom casts blue, a violet one violet. Null if it can't be read. */
function dominantTextureColor(map: THREE.Texture): THREE.Color | null {
  const img = map.image as CanvasImageSource | undefined;
  if (!img) return null;
  try {
    const S = 24;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let wsum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue; // skip transparent texels
      const rr = d[i] / 255;
      const gg = d[i + 1] / 255;
      const bb = d[i + 2] / 255;
      const sat = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
      const w = 0.12 + sat; // base weight + saturation boost
      r += rr * w;
      g += gg * w;
      b += bb * w;
      wsum += w;
    }
    if (wsum < 1e-3) return null;
    const c = new THREE.Color(r / wsum, g / wsum, b / wsum);
    return c.multiplyScalar(1 / Math.max(c.r, c.g, c.b, 1e-3)); // vivid hue
  } catch {
    return null; // tainted canvas / undrawable image → caller falls back
  }
}

/** Enlist an imported mushroom in the EXISTING phosphorescence system: its own
 *  materials become the charge-driven emissive and it takes a fog-light slot, so
 *  the per-frame charge/glow loop drives it exactly like a native glowcap. This
 *  ADDS a participant to that loop — it does not change the phosphorescence. */
function registerImportedPhosphor(group: THREE.Group, x: number, z: number, capY: number, tint?: THREE.Color): void {
  const pal = pickPalette(x, z);
  const glow = new THREE.Color(pal.glow);
  const mutedGlow = glow.clone().lerp(new THREE.Color(0.5, 0.5, 0.5), 0.3);
  const mats: THREE.MeshStandardMaterial[] = [];
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m instanceof THREE.MeshStandardMaterial) mats.push(m);
    else if (Array.isArray(m)) for (const s of m) if (s instanceof THREE.MeshStandardMaterial) mats.push(s);
  });
  if (mats.length === 0) return;
  // Phosphoresce THROUGH the model's own colours: use its base-colour texture as
  // an emissive map (emissive tint = white so the texture shows true), so the
  // red cap glows red and the pale spots glow pale — instead of one flat palette
  // colour washing the whole mushroom out (which buried the spots). Untextured
  // meshes fall back to the single palette glow. Charge drives emissiveIntensity.
  for (const m of mats) {
    if (m.map) {
      m.emissiveMap = m.map;
      // White → the texture glows its true colours; a tint shifts the whole glow
      // toward that hue (so a tinted grove cap glows its tint).
      m.emissive = tint ? tint.clone() : new THREE.Color(0xffffff);
    } else {
      m.emissive = tint ? tint.clone() : mutedGlow.clone();
    }
    m.emissiveIntensity = 0.05; // barely-alive base, as native caps
    m.needsUpdate = true; // adding the emissive map needs a shader recompile
  }
  // Emission COLOUR = the tint if given, else the shroom's OWN dominant texture
  // colour, so it casts light in that colour (blue shroom → blue light).
  const primaryMap = mats.find((m) => m.map)?.map ?? null;
  const texCol = primaryMap ? dominantTextureColor(primaryMap) : null;
  const emitColor =
    tint?.clone() ?? texCol ?? glow.clone().multiplyScalar(1 / Math.max(glow.r, glow.g, glow.b, 1e-3));
  const fogEntry = {
    pos: new THREE.Vector3(x, capY + 0.4, z),
    color: emitColor,
    intensity: 0.04,
  };
  fogLightRegistry.push(fogEntry);
  const s: Shroom = {
    pos: new THREE.Vector3(x, capY, z),
    capMat: mats[0],
    gillMat: mats[1] ?? mats[0],
    fogEntry,
    charge: 0.15, // a faint residual charge at world-start, like native caps
  };
  shrooms.push(s);
}

function placeImported(
  name: FloraName,
  x: number,
  z: number,
  opts: PlaceOpts = {},
): { height: number; radius: number; gy: number } | null {
  const isShroom = MUSHROOM_KINDS.has(name) || /shroom|mushroom|fungus|fungi/i.test(name);
  // Per-instance size variation — a grove is never uniform (0.72–1.57×).
  const jitter = 0.72 + frand(x * 2.3 + z * 4.1) * 0.85;
  const inst = floraLib.make(name, opts.height, jitter);
  if (!inst) return null;
  const gy = groundYAt(x, z) - (opts.sink ?? 0); // sink → only the top pokes out
  const g = inst.group;
  g.position.set(x, gy, z);
  g.rotation.y = frand(x * 1.7 + z) * Math.PI * 2; // varied facing
  // Per-instance colour tint: multiply every albedo toward the tint hue so one
  // mesh can populate a grove in many colours (emission is tinted to match in
  // registerImportedPhosphor).
  if (opts.tint) {
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      const arr = Array.isArray(m) ? m : m ? [m] : [];
      for (const mm of arr) if ((mm as THREE.MeshStandardMaterial).color) (mm as THREE.MeshStandardMaterial).color.multiply(opts.tint!);
    });
  }
  scene.add(g);
  registerFlora(g); // pulse-reveal patch + distance culling
  importedFlora.push(g);
  if (opts.collide) {
    addFloraCollider(x, z, gy, gy + inst.height * 0.9, Math.max(inst.radius * 0.55, 0.35));
  }
  if (opts.sway) {
    swayProps.push({ group: g, x, z, brushR: opts.brushR ?? inst.radius + 2, lx: 0, lz: 0, lvx: 0, lvz: 0 });
  }
  // Fungi (known or named like one) join the phosphorescence automatically.
  if (isShroom) {
    registerImportedPhosphor(g, x, z, gy + inst.height * 0.65, opts.tint);
    // Rig the bigger shrooms with a cap/stalk two-spring; tiny scatter caps stay
    // static (the split isn't worth it and reads fine still).
    if (inst.height >= 2) {
      const rig = rigMushroom(g);
      if (rig) {
        // Hand the split pieces to the SAME native glowcap sim as the procedural
        // placeholders (group = stalk lean, cap pivot = cap wobble), so this
        // imported shroom moves identically to the one it replaces.
        shroomFlora.push({
          group: g,
          cap: rig.capPivot,
          gills: rig.capPivot, // unused by the sim; kept valid
          capBaseY: rig.capStartY,
          x,
          z,
          h: inst.height,
          capR: inst.radius,
          stalkR: Math.max(inst.radius * 0.28, 0.2),
          phase: x * 0.7 + z * 0.31,
          lx: 0, lz: 0, lvx: 0, lvz: 0,
          cx: 0, cz: 0, cvx: 0, cvz: 0,
          neighbors: null,
        });
      }
    }
  }
  return { height: inst.height, radius: inst.radius, gy };
}

/** A tree plus a small ring of ground foliage clustered at its base. */
function placeTreeCluster(x: number, z: number, h: number, seed: number): void {
  const tree = placeImported(frand(seed) < 0.5 ? 'tree_01' : 'tree_02', x, z, {
    height: h,
    collide: true,
    sway: true,
    brushR: 3,
  });
  // Mycelium drips off the crown — the same Verlet rope strands the procedural
  // spore-trees hung (orb drapes them, pulses whip them). Anchored in WORLD
  // space at the canopy underside so they hang gravity-plumb; deliberately NOT
  // parented to the tree group, or the sway lean would tilt the anchor.
  if (tree) {
    const strandCount = 2 + Math.floor(frand(seed + 23) * 3);
    for (let s = 0; s < strandCount; s++) {
      const sa = frand(seed + 31 + s * 7.7) * Math.PI * 2;
      const sr = 0.6 + frand(seed + 43 + s * 11.3) * Math.max(tree.radius * 0.7, 1.6);
      const sy = tree.gy + h * (0.58 + frand(seed + 53 + s * 13.9) * 0.22);
      makeStrandAt(
        x + Math.cos(sa) * sr,
        sy,
        z + Math.sin(sa) * sr,
        1.4 + frand(seed + 61 + s * 17.1) * 2.2,
      );
    }
  }
  // NB: mushrooms are NOT scattered here anymore — caps come from the groves
  // (spaced + thinned). mushroom_02 (shelf fungus) belongs on cave walls, and
  // dotting mushroom_01 around every tree is what made it feel like "too many".
  const kinds: FloraName[] = ['bush_01', 'fern_01', 'rock_01', 'rock_02', 'grass_01'];
  const n = 2 + Math.floor(frand(seed + 5) * 3); // 2–4 props
  for (let i = 0; i < n; i++) {
    const ang = frand(seed + i * 7.3) * Math.PI * 2;
    const rad = 1.6 + frand(seed + i * 13.1) * 3.4;
    const kind = kinds[Math.floor(frand(seed + i * 5.7) * kinds.length)];
    const collide = kind.startsWith('rock') || kind.startsWith('bush');
    placeImported(kind, x + Math.cos(ang) * rad, z + Math.sin(ang) * rad, { collide });
  }
}

// --- LIVE flora builders (map-mode streaming needs groves/trees to build
// FOREVER, not once at boot — pending queues drain every frame once loaded).
let floraReady = false;
let treesLoaded = false;
let capPool: FloraName[] = [];
let clusterLoaded = false;
const placedCaps: { x: number; z: number; r: number }[] = [];

function buildTreeAt(t: { x: number; y: number; z: number; h: number }): void {
  if (treesLoaded) placeTreeCluster(t.x, t.z, t.h, t.x * 31.1 + t.z * 17.7);
  else makeSporeTree(t.x, smoothSurfaceY(t.x, t.z, t.y) - 0.15, t.z, t.h);
}

function buildGroveAt(gp: { x: number; y: number; z: number; h: number }): void {
  const seed = gp.x * 41.3 + gp.z * 7.7;
  if (capPool.length === 0) {
    makeGlowcap(gp.x, smoothSurfaceY(gp.x, gp.z, gp.y) - 0.08, gp.z, gp.h);
    return;
  }
  if (frand(seed + 1) < 0.45) return; // thin ~45% — worldgen packs groves too dense
  const name = capPool[Math.floor(frand(seed) * capPool.length)];
  const height = 1.3 + frand(seed + 7) * 1.4; // smaller caps, various sizes
  const capR = 0.7 + height * 0.35; // spacing footprint
  // Keep the spacing set bounded on long expeditions: prune far entries.
  if (placedCaps.length > 480) {
    for (let i = placedCaps.length - 1; i >= 0; i--) {
      const b = placedCaps[i];
      if ((b.x - gp.x) ** 2 + (b.z - gp.z) ** 2 > 220 * 220) placedCaps.splice(i, 1);
    }
  }
  let px = gp.x;
  let pz = gp.z;
  for (let it = 0; it < 8; it++) {
    let moved = false;
    for (const b of placedCaps) {
      const dx = px - b.x;
      const dz = pz - b.z;
      const min = capR + b.r;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 1e-3;
        const push = (min - d) * 0.5 + 0.05;
        px += (dx / d) * push;
        pz += (dz / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  if ((px - gp.x) ** 2 + (pz - gp.z) ** 2 > 9) return; // drifted too far → thin out
  placedCaps.push({ x: px, z: pz, r: capR });
  placeImported(name, px, pz, { height, brushR: 2, collide: true });
  // Sparingly: a sunk meshy cluster peeking out of the ground beside a grove.
  if (clusterLoaded && frand(seed + 11) < 0.06) {
    placeImported('meshy_glowshroom_02', px + 1.5, pz + 1.5, {
      height: 1.2 + frand(seed + 13) * 0.5, // current size and smaller
      sink: 1.1 + frand(seed + 17) * 0.6, // base under the voxel — only caps pop
    });
  }
}

void floraLib.preload().then(() => {
  // If the tree GLTFs failed to load, fall back to the native procedural
  // spore-trees so the world is never treeless (assets are best-effort).
  treesLoaded = floraLib.has('tree_01') || floraLib.has('tree_02');
  capPool = (['meshy_glowshroom', 'meshy_glowshroom_03', 'meshy_flatshroom', 'mushroom_01'] as FloraName[]).filter((n) =>
    floraLib.has(n),
  );
  clusterLoaded = floraLib.has('meshy_glowshroom_02');
  floraReady = true;
  // Build everything collected during worldgen (deferred: the GLTF is async).
  for (const t of pendingTrees.splice(0)) buildTreeAt(t);
  for (const gp of pendingGroves.splice(0)) buildGroveAt(gp);
  if (!treesLoaded) {
    logger('flora-assets').warn('tree GLTFs unavailable — fell back to procedural spore-trees');
    return;
  }
  // A guaranteed stand right by spawn so the swap is visible the moment you wake
  // (worldgen tree stands can be some distance off).
  const [sx, , sz] = reek.spawn;
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.4;
    const rad = 12 + (i % 2) * 4;
    placeTreeCluster(sx + Math.cos(ang) * rad, sz + Math.sin(ang) * rad, 8 + i, sx + sz + i * 11);
  }
  // (Grove construction now lives in buildGroveAt above — shared by the boot
  // drain and the per-frame streaming drain.)
  // Showcase row by spawn so the new meshes are easy to eyeball (the cluster is
  // excluded — it now appears sparsely + sunk in the groves).
  const heroShrooms: FloraName[] = ['meshy_glowshroom', 'meshy_glowshroom_03', 'meshy_flatshroom'];
  heroShrooms.forEach((name, i) => {
    if (floraLib.has(name)) placeImported(name, sx + 4 + i * 3.5, sz - 4, { collide: true, brushR: 2.5 });
  });
  logger('flora-assets').info(
    `built ${pendingTrees.length} tree clusters + ${pendingGroves.length} groves → ${importedFlora.length} props, ${swayProps.length} swayable, ${shroomFlora.length} shrooms`,
  );
  // Attach to the dev handle here (in the async callback) so it lands on the
  // FINAL window.waiver — the synchronous handle assignments have all run by now.
  const dev = (window as unknown as { waiver: Record<string, unknown> }).waiver;
  dev.importedFlora = importedFlora;
  dev.toImported = () => {
    orb.pos.set(reek.spawn[0], reek.spawn[1] + 4, reek.spawn[2] + 4);
    orb.vel.set(0, 0, 0);
    return `${importedFlora.length} imported props, ${swayProps.length} swayable`;
  };
});

// Group-level brush + pulse sway for imported props (trees). Cheap: a spring per
// prop, gated on visibility so off-screen props cost nothing. Mirrors the feel
// of the native Verlet trees — lean away from the orb, shudder on the pulse.
const SWAY_STIFF = 42;
const SWAY_DAMP = 7;
const SWAY_MAX_LEAN = 0.22; // radians (~12°) at hardest press
const SWAY_PULSE_KICK = 5;
function updateSwayProps(dt: number): void {
  for (const p of swayProps) {
    if (!p.group.visible) continue;
    const dx = orb.pos.x - p.x;
    const dz = orb.pos.z - p.z;
    const d2 = dx * dx + dz * dz;
    let tx = 0; // target lean about each axis
    let tz = 0;
    if (d2 < p.brushR * p.brushR) {
      const d = Math.sqrt(d2) || 1e-3;
      const push = (1 - d / p.brushR) * SWAY_MAX_LEAN;
      tx = -(dx / d) * push; // lean AWAY from the orb
      tz = -(dz / d) * push;
    }
    if (pulseActive) {
      const pdx = p.x - pulseCenter.x;
      const pdz = p.z - pulseCenter.z;
      const pd = Math.sqrt(pdx * pdx + pdz * pdz) || 1e-3;
      if (Math.abs(pd - pulseRadius) < LightConfig.pulse.thickness + 2) {
        p.lvx += (pdx / pd) * SWAY_PULSE_KICK * dt;
        p.lvz += (pdz / pd) * SWAY_PULSE_KICK * dt;
      }
    }
    // Critically-ish damped spring toward the target lean.
    p.lvx += ((tx - p.lx) * SWAY_STIFF - p.lvx * SWAY_DAMP) * dt;
    p.lvz += ((tz - p.lz) * SWAY_STIFF - p.lvz * SWAY_DAMP) * dt;
    p.lx += p.lvx * dt;
    p.lz += p.lvz * dt;
    // Lean maps to tilt: +x lean tips the crown toward +x → rotate about z.
    p.group.rotation.z = -p.lx;
    p.group.rotation.x = p.lz;
  }
}

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
      // Mint glow held UNDER the bloom threshold (0.62): at full 0x8dffd2 the
      // bloom pass drew a soft halo around every spore — same unnatural read
      // as the removed shroom halos. Dimmer body, same hue, zero corona.
      color: new THREE.Color(0x8dffd2).multiplyScalar(0.55),
      transparent: true,
      opacity: 0.88,
    }),
  );
  mesh.position.set(x, y, z);
  scene.add(mesh);
  pickups.push({ mesh, pos: mesh.position.clone(), taken: false });
}

// --- Ward anchor body: the universal Keeper obelisk (docs/MESHY_ward.md).
// Loaded best-effort at boot; wards raised before it lands (save-restore) or
// without the asset use a procedural shard and are retrofitted on arrival. ---
let wardAnchorRoot: THREE.Object3D | null = null;
new GLTFLoader().load(
  'assets/ward/ward_anchor.glb',
  (gltf) => {
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = (mesh.material as THREE.MeshStandardMaterial).clone();
      // Same dark-game pass as imported flora: matte dielectric, no self-glow,
      // no IBL. Albedo clamped dark-but-NONZERO — a 0x000000 albedo zeroes
      // every light path and can never be lit, and a bright one blows out.
      m.metalness = 0;
      m.roughness = Math.max(m.roughness ?? 1, 0.85);
      m.envMapIntensity = 0;
      if (m.emissive) m.emissive.setRGB(0, 0, 0);
      m.emissiveIntensity = 0;
      if (m.color) {
        const lum = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
        if (lum > 0.4) m.color.multiplyScalar(0.4 / lum);
        else if (lum < 0.04) m.color.setRGB(0.05, 0.062, 0.058);
      }
      mesh.material = m;
    });
    wardAnchorRoot = gltf.scene;
    for (const w of wards) swapWardAnchor(w);
    logger('ward').info('ward_anchor.glb loaded');
  },
  undefined,
  () => logger('ward').warn('ward_anchor.glb unavailable — wards use the procedural shard'),
);

/** Build one anchor body, feet at y=0, centered on x/z, WARD_ANCHOR_HEIGHT
 *  tall: the Meshy obelisk when loaded, else a stand-in shard (dark tapered
 *  pylon + hovering tip with the lumen-core gap between them). */
function makeWardAnchor(): THREE.Object3D {
  if (wardAnchorRoot) {
    const src = wardAnchorRoot.clone(true);
    const bounds = new THREE.Box3().setFromObject(src);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bounds.getSize(size);
    bounds.getCenter(center);
    const scale = WARD_ANCHOR_HEIGHT / Math.max(size.y, 1e-4);
    const group = new THREE.Group();
    src.scale.setScalar(scale);
    src.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    group.add(src);
    group.name = 'ward:anchor';
    return group;
  }
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x232c2a, roughness: 0.92, metalness: 0 });
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.58, 2.2, 4), stone);
  pylon.position.y = 1.1;
  pylon.rotation.y = Math.PI / 4;
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.1, 0.85, 4), stone);
  tip.position.y = 3.15; // hovers above the pylon — the niche gap holds the core
  tip.rotation.y = Math.PI / 4;
  group.add(pylon, tip);
  group.name = 'ward:anchor-fallback';
  return group;
}

/** Replace a ward's stand-in shard with the real obelisk once the GLB lands. */
function swapWardAnchor(w: Ward): void {
  if (!wardAnchorRoot || w.anchor.name !== 'ward:anchor-fallback') return;
  const fresh = makeWardAnchor();
  fresh.position.copy(w.anchor.position);
  scene.remove(w.anchor);
  scene.add(fresh);
  w.anchor = fresh;
}

/** The dome as a REACTIVE membrane: a fresnel rim shell with slow ripple bands
 *  crawling down it — thin at the center of view, bright at the silhouette, so
 *  it reads as a soap-film of light the dark is breaking against rather than a
 *  solid painted bubble. uStrength drives it; 0 = fully invisible (the rest
 *  state). GLSL note: no function hoisting — keep helpers above callers. */
function makeWardDomeMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        // Fresnel rim ONLY — no spatial pattern on the shell. Any repeating
        // bands (the old sin(worldY) ripple) project as concentric rings on
        // the ground from the top-down camera. Liveliness comes from the
        // temporal flicker already driven through uStrength.
        vec3 V = normalize(cameraPosition - vWorld);
        float facing = abs(dot(normalize(vNormalW), V));
        float rim = pow(1.0 - facing, 2.0);
        float a = uStrength * (0.05 + 0.95 * rim);
        gl_FragColor = vec4(uColor * (0.35 + 0.65 * rim), a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Motes per ward — glow-points drifting inward across the circle. */
const WARD_MOTES = 18;
/** Beam height (units) — a faint column, not a searchlight. */
const WARD_BEAM_H = 14;

/** Raise a ward at voxel column (vx,vz) with its glow sunk to floorY. Builds
 *  the terrain + every mesh but charges NO spores — the shared body of both
 *  live placement and save-restore. Silhouette is universal (obelisk + ring +
 *  core + motes); WARD_DRESSING skins it per biome. */
function spawnWard(vx: number, vz: number, floorY: number): void {
  // Sink the glow INTO the floor (replace its top voxels) — never build a
  // platform at the orb's feet, which wedged the player inside solid ground.
  box(vx - 1, floorY, vz - 1, 3, 1, 3, Mat.Glowcap);
  // Localized additive flood + scoped remesh: the old global update() dirtied
  // EVERY chunk and re-meshed the whole map (~5s per ward on the phone).
  const wardSeeds: { x: number; y: number; z: number }[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) wardSeeds.push({ x: vx + dx, y: floorY, z: vz + dz });
  }
  lightGrid.addLight(wardSeeds);
  for (const c of world.chunks.values()) c.lightDirty = false; // no stray flags
  remeshDirtyChunks(); // only the light-touched chunks are dirty now

  const dressing = WARD_DRESSING.reek; // biome hook — only The Reek exists yet
  const base = new THREE.Vector3(vx + 0.5, floorY + 1, vz + 0.5); // top of the sunk slab

  // The anchor body: dark Keeper obelisk, lit only by the light around it.
  const anchor = makeWardAnchor();
  anchor.position.copy(base);

  // The lumen core hangs in the anchor's carved niche at ~2/3 height. The
  // ward's point light lives AT the core — the stone shades itself off it.
  const pos = base.clone();
  pos.y += WARD_ANCHOR_HEIGHT * 0.66;
  const light = new THREE.PointLight(dressing.light, 12, 0, 2); // unified falloff law: 1/d², no cutoff ring
  light.position.copy(pos);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 24, 14),
    new THREE.MeshBasicMaterial({
      color: dressing.core,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    }),
  );
  core.position.copy(pos);

  // Ground rings: the RADIUS ring is the ward's default read — the safe zone
  // is VISIBLE without a dome. A small footprint ring seats the anchor.
  const rings = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({
    color: dressing.ring,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const radiusRing = new THREE.Mesh(
    new THREE.RingGeometry(WARD_RADIUS - 0.28, WARD_RADIUS, 96),
    ringMat,
  );
  const footRing = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.6, 48), ringMat.clone());
  (footRing.material as THREE.MeshBasicMaterial).opacity = 0.3;
  for (const r of [radiusRing, footRing]) {
    r.rotation.x = -Math.PI / 2;
    r.layers.set(1); // effects layer — skipped by the depth prepass
  }
  rings.add(radiusRing, footRing);
  rings.position.set(base.x, base.y + 0.06, base.z); // just above the slab

  // A faint vertical pulse-beam off the core — the ward seen from far ground.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, WARD_BEAM_H, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: dressing.core,
      transparent: true,
      opacity: 0.04,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  beam.position.set(pos.x, pos.y + WARD_BEAM_H / 2, pos.z);
  beam.layers.set(1);

  // Inward-drifting motes: the ward GATHERING light, not hoarding it.
  const moteState = new Float32Array(WARD_MOTES * 4);
  const motePos = new Float32Array(WARD_MOTES * 3);
  const moteCol = new Float32Array(WARD_MOTES * 3);
  const cA = new THREE.Color(dressing.motes[0]);
  const cB = new THREE.Color(dressing.motes[1]);
  const mix = new THREE.Color();
  for (let i = 0; i < WARD_MOTES; i++) {
    moteState[i * 4] = Math.random() * Math.PI * 2; // angle
    moteState[i * 4 + 1] = 2 + Math.random() * (WARD_RADIUS - 2); // radius
    moteState[i * 4 + 2] = 0.2 + Math.random() * 2.4; // height above base
    moteState[i * 4 + 3] = 0.5 + Math.random() * 0.9; // inward drift speed
    mix.copy(cA).lerp(cB, Math.random() * 0.85);
    moteCol[i * 3] = mix.r;
    moteCol[i * 3 + 1] = mix.g;
    moteCol[i * 3 + 2] = mix.b;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute('color', new THREE.BufferAttribute(moteCol, 3));
  const motes = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({
      size: 0.17,
      map: moteTexture, // soft radial sprite — never hard squares
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  motes.frustumCulled = false;
  motes.layers.set(1);

  // The membrane — spawned invisible; the update loop breathes it in under
  // tide pressure and for the activation surge.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(WARD_RADIUS, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
    makeWardDomeMaterial(dressing.dome),
  );
  dome.position.copy(base);

  scene.add(light, anchor, core, rings, beam, motes, dome);
  wards.push({
    pos,
    light,
    core,
    dome,
    anchor,
    rings,
    beam,
    motes,
    moteState,
    activation: 0,
    vx,
    vz,
    floorY,
  });
  fogLightRegistry.push({
    pos: pos.clone(),
    color: new THREE.Color(0.5, 1.0, 0.82),
    intensity: 1.3, // your held light owns the air around it
  });
  // Every ward you raise is a marked location — held light shows on the map.
  minimap.addMarker({ x: vx, z: vz, icon: '❈', label: 'Ward', color: '#7fffd1' });
}

function placeWard(): void {
  if (spores < 3) {
    objective = 'Gather more glowspores before the first ward can hold.';
    return;
  }
  spores -= 3;
  const vx = Math.round(orb.pos.x);
  const vz = Math.round(orb.pos.z);
  let floorY = Math.floor(orb.pos.y);
  while (floorY > -6 && !world.solid(vx, floorY, vz)) floorY--;
  spawnWard(vx, vz, floorY);
  // Placement activation: the membrane is born visible for a breath, then
  // rests — from then on the dome only shows when the dark tests it.
  wards[wards.length - 1].activation = 1;
  mood.event('joy'); // made light — the proudest feeling the orb knows
  objective =
    'The ward holds a circle of light: inside its ring the dark cannot drain you, and your Lumen refills. Press T to test it against a tide.';
}

// --- Save / load: one slot in localStorage. The world is deterministic from a
// fixed seed, so a save only needs the mutable player state + which wards were
// raised where; restore re-spawns them onto the freshly generated world. ---
const SAVE_KEY = 'waiver.save';
interface WaiverSave {
  v: number;
  spores: number;
  orb: [number, number, number];
  lumen: number;
  energy: number;
  objective: string;
  wards: [number, number, number][]; // [vx, vz, floorY] per ward
  savedAt: number;
}
function readSave(): WaiverSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as WaiverSave;
    if (!s || s.v !== 1 || !Array.isArray(s.wards)) {
      logger('save').warn('ignoring corrupt/incompatible save — starting fresh');
      return null;
    }
    return s;
  } catch (err) {
    logger('save').warn('could not read save (storage blocked or corrupt)', err);
    return null;
  }
}
function captureSave(): WaiverSave {
  return {
    v: 1,
    spores,
    orb: [orb.pos.x, orb.pos.y, orb.pos.z],
    lumen: orb.lumen,
    energy: orb.energy,
    objective,
    wards: wards.map((w) => [w.vx, w.vz, w.floorY] as [number, number, number]),
    savedAt: Date.now(),
  };
}
/** Apply a save onto a PRISTINE world (no wards yet) — see Menu's invariant. */
function applySave(s: WaiverSave): void {
  spores = s.spores;
  orb.pos.set(s.orb[0], s.orb[1], s.orb[2]);
  orb.vel.set(0, 0, 0);
  orb.lumen = s.lumen;
  orb.energy = s.energy;
  objective = s.objective || objective;
  for (const [vx, vz, fy] of s.wards) spawnWard(vx, vz, fy);
}

const menuBridge: MenuBridge = {
  hasSave: () => readSave() != null,
  saveInfo: () => {
    const s = readSave();
    return s ? { savedAt: s.savedAt, spores: s.spores, wards: s.wards.length } : null;
  },
  writeSave: () => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(captureSave()));
      logger('save').debug('saved');
    } catch (err) {
      logger('save').warn('could not write save (storage disabled or full)', err);
    }
  },
  loadSaveInPlace: () => {
    const s = readSave();
    if (!s) return false;
    applySave(s);
    return true;
  },
  deleteSave: () => {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (err) {
      logger('save').debug('could not delete save', err);
    }
  },
  setPaused: (p: boolean) => {
    const resuming = paused && !p;
    paused = p;
    // Handing control back: the very keypress/button that dismissed the menu
    // (Space on "Resume", A on the pad) also armed a game action edge in Input.
    // Flush those pending edges so the orb doesn't jump/pulse on frame one of play.
    if (resuming) input.consumeActions();
  },
  // Settings → Map drives the discovery minimap live.
  mapPrefs: () => minimap.getPrefs(),
  setMapPrefs: (p) => minimap.setPrefs(p),
};
const menu = new Menu(menuBridge);

function startTide(): void {
  tideT = 0; // begin the timeline — onset → sustain → release
  mood.event('fear'); // heard-before-seen — the orb goes cold before you do
  haptics.fire('tide'); // low rolling rumble — dread felt before it's seen
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
    if (worldStream && !worldStream.canMesh(c.cx, c.cz)) continue; // ladder gate: data not final yet
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
  if (lumen) lumen.textContent = Math.round(orb.lumen).toString();
  if (energy) energy.textContent = Math.round(orb.energy).toString();
  if (sporeEl) sporeEl.textContent = spores.toString();
  if (obj) obj.textContent = objective;
  if (gamepadDebug) {
    gamepadDebug.style.display = showPadDebug ? '' : 'none';
    if (showPadDebug) gamepadDebug.textContent = input.debugGamepadStatus();
  }
}

/** Set by window.waiver.throwTest() to fault the next N frames on purpose. */
let throwNextFrames = 0;
// --- World border: "the darkness here is impenetrable" (John) ---------------
// Early-build soft wall at the rim cliffs: within EDGE_SOFT of the border the
// dark presses the orb back toward the valley and a whisper explains why.
const EDGE_SOFT = 10; // voxels inside ±REEK_HALF_INIT where the press begins
const edgeWhisper = document.createElement('div');
edgeWhisper.style.cssText =
  'position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:30;color:#6e86a8;' +
  'font:12px ui-monospace,Menlo,monospace;letter-spacing:0.3em;text-transform:uppercase;' +
  'opacity:0;transition:opacity 0.6s;pointer-events:none;text-shadow:0 0 14px #000;';
edgeWhisper.textContent = 'the darkness here is impenetrable';
document.body.appendChild(edgeWhisper);
let edgeWhisperT = 0;

function worldBorder(dt: number): void {
  if (MAP_MODE && worldGen) {
    // At world scale the border IS the Nothing: reaching the rim biome (on
    // land or at sea) presses the orb back toward the world's heart.
    const b = worldGen.biomeId(orb.pos.x, orb.pos.z);
    if (b === 8 /* NOTHING */ || b === 0 /* outside the disc */) {
      const r = Math.hypot(orb.pos.x, orb.pos.z) || 1;
      orb.vel.x -= (orb.pos.x / r) * 26 * dt;
      orb.vel.z -= (orb.pos.z / r) * 26 * dt;
      edgeWhisperT = 2.2;
    }
    edgeWhisperT = Math.max(0, edgeWhisperT - dt);
    edgeWhisper.style.opacity = edgeWhisperT > 0 ? '1' : '0';
    return;
  }
  const limit = REEK_HALF_INIT - EDGE_SOFT;
  const ox = Math.abs(orb.pos.x) - limit;
  const oz = Math.abs(orb.pos.z) - limit;
  const over = Math.max(ox, oz);
  if (over > 0) {
    // Quadratic press back toward the center — firm at the wall, gentle at the
    // fringe; the dark turns you around, it never bonks you.
    const t = Math.min(1, over / EDGE_SOFT);
    const press = 30 * t * t * dt;
    if (ox > 0) orb.vel.x -= Math.sign(orb.pos.x) * press * (ox >= oz ? 1 : 0.4);
    if (oz > 0) orb.vel.z -= Math.sign(orb.pos.z) * press * (oz >= ox ? 1 : 0.4);
    edgeWhisperT = 2.2;
  }
  edgeWhisperT = Math.max(0, edgeWhisperT - dt);
  edgeWhisper.style.opacity = edgeWhisperT > 0 ? '1' : '0';
}

function frame(): void {
  updatePerfDiv(1 / 60);
  if (throwNextFrames > 0) {
    throwNextFrames--;
    throw new Error('waiver.throwTest(): synthetic frame error');
  }
  const dt = Math.min(0.05, clock.getDelta());
  input.update(dt); // poll gamepad + decay wheel impulses
  worldBorder(dt);

  // MAP_MODE: advance the streaming ladder around the orb, mesh what became
  // ready (1 chunk/frame keeps the hitch under the frame), and periodically
  // drop far columns (disposing their meshes).
  if (worldStream) {
    let t0 = performance.now();
    worldStream.update(orb.pos.x, orb.pos.z, 3);
    perfMark('stream', performance.now() - t0);
    // WORKER MESHING: the face loop runs off-thread; here we only dispatch
    // slab copies (~0.3ms each) and the overlay's mesh line absorbs the
    // arrival-side geometry installs. (Smooth-terrain toggle falls back to
    // the old throttled in-frame path — the smooth mesher isn't ported.)
    t0 = performance.now();
    if (meshWorker && !smoothTerrain) pumpMeshWorker();
    else if (lastFrameMs < 15 || (streamTick & 3) === 0) remeshDirtyChunks(1);
    perfMark('mesh', performance.now() - t0 + meshInstallMs);
    meshInstallMs = 0;
    // live flora: streamed columns queue groves/trees — build a few per frame
    // (also headroom-gated: tree clusters are the priciest single build)
    t0 = performance.now();
    if (floraReady) {
      // Trees are single 30-100ms tasks — the "movement feels delayed" spikes.
      // They ONLY build with real headroom; groves are cheap and keep a floor.
      if (pendingTrees.length && lastFrameMs < 13) buildTreeAt(pendingTrees.pop()!);
      if (lastFrameMs < 17 || (streamTick & 7) === 0) {
        for (let i = 0; i < 2 && pendingGroves.length; i++) buildGroveAt(pendingGroves.pop()!);
      }
    }
    // cap the queues: entries >120m streamed away — their columns re-decorate
    // (and re-queue) when revisited, so building them now is pure waste
    if ((streamTick & 31) === 0) {
      const near = (q: { x: number; z: number }[]): void => {
        for (let i = q.length - 1; i >= 0; i--) {
          const dx = q[i].x - orb.pos.x;
          const dz = q[i].z - orb.pos.z;
          if (dx * dx + dz * dz > 120 * 120) q.splice(i, 1);
        }
      };
      near(pendingGroves);
      near(pendingTrees);
    }
    // FLORA DISTANCE CULLING: imported props are individual scene meshes and
    // grow forever while roaming — stagger-cull a slice per frame so far
    // groves stop drawing (and stop swaying: updateSwayProps skips invisible).
    for (let i = 0; i < 48 && importedFlora.length > 0; i++) {
      floraCullIdx = (floraCullIdx + 1) % importedFlora.length;
      const g = importedFlora[floraCullIdx];
      const fdx = g.position.x - orb.pos.x;
      const fdz = g.position.z - orb.pos.z;
      // 55m: beyond this the dark hides flora anyway — halves submissions vs
      // sharing the 80m terrain radius (each object draws in prepass + main).
      g.visible = fdx * fdx + fdz * fdz < 55 * 55;
    }
    perfMark('flora', performance.now() - t0);
    if ((streamTick++ & 63) === 0) {
      for (const c of worldStream.unload(orb.pos.x, orb.pos.z)) {
        const m = chunkMeshes.get(c);
        if (m) {
          scene.remove(m);
          m.geometry.dispose();
          chunkMeshes.delete(c);
        }
      }
      // Lifecycle pruning — flora/colliders/fog lights grew without bound
      // while roaming (overlay: flora 3678, fogL 1482). Geometry + materials
      // are SHARED with the library — far clones are dropped, not disposed.
      if (importedFlora.length > 700) {
        const keep: THREE.Group[] = [];
        const dead = new Set<THREE.Group>();
        for (const g of importedFlora) {
          const dx = g.position.x - orb.pos.x;
          const dz = g.position.z - orb.pos.z;
          if (dx * dx + dz * dz > 130 * 130) {
            scene.remove(g);
            dead.add(g);
          } else keep.push(g);
        }
        importedFlora.length = 0;
        for (const g of keep) importedFlora.push(g);
        for (let i = swayProps.length - 1; i >= 0; i--) if (dead.has(swayProps[i].group)) swayProps.splice(i, 1);
        if (floraCullIdx >= importedFlora.length) floraCullIdx = 0;
      }
      for (const key of [...floraColliders.keys()]) {
        const [bx, bz] = key.split(',').map(Number);
        if ((bx - orb.pos.x) ** 2 + (bz - orb.pos.z) ** 2 > 160 * 160) floraColliders.delete(key);
      }
      // fog lights: slot 0 = the orb; map mode has no fireFogIdx consumer, so
      // distant crystal registrations can be dropped safely.
      for (let i = fogLightRegistry.length - 1; i >= 1; i--) {
        const L = fogLightRegistry[i];
        const dx = L.pos.x - orb.pos.x;
        const dz = L.pos.z - orb.pos.z;
        if (dx * dx + dz * dz > 180 * 180) fogLightRegistry.splice(i, 1);
      }
    }
    seaPlane?.position.set(orb.pos.x, SEA_LEVEL + 0.42, orb.pos.z);
  }

  // Render distance + frustum culling. The world is dark — beyond the orb's lit
  // bubble everything is black — so we only draw chunks whose nearest point is
  // within RENDER_RADIUS of the orb (Minecraft-style), then frustum-test those.
  // This is what keeps the deep cave network from drawing the whole map at once.
  cullMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  cullFrustum.setFromProjectionMatrix(cullMatrix);
  const orbX = orb.pos.x;
  const orbZ = orb.pos.z;
  // Frustum culling has NO occlusion: underground, the whole far surface is still
  // inside the frustum (behind solid rock) and would draw. So the gate keys off
  // the ORB. Open sky overhead = surface → above-ground chunks keep the full
  // moonlit vista (frustum-only). A ROCK ROOF overhead = in a cave → everything
  // past a tight radius is occluded and pitch-black, so cull it hard (the fps
  // fix). Roof-probe, not a y-threshold, so low valley floors still read surface.
  orbRoofed = false;
  {
    const ox = Math.floor(orb.pos.x);
    const oz = Math.floor(orb.pos.z);
    for (let u = 2; u <= 11; u++) {
      if (world.solid(ox, Math.floor(orb.pos.y + u), oz)) {
        orbRoofed = true;
        break;
      }
    }
  }
  const orbUnderground = orbRoofed;
  for (const mesh of chunkMeshes.values()) {
    const aabb = mesh.userData.aabb as THREE.Box3;
    if (!orbUnderground && aabb.max.y > 0) {
      mesh.visible = cullFrustum.intersectsBox(aabb);
    } else {
      const ddx = Math.max(aabb.min.x - orbX, 0, orbX - aabb.max.x);
      const ddz = Math.max(aabb.min.z - orbZ, 0, orbZ - aabb.max.z);
      mesh.visible =
        ddx * ddx + ddz * ddz < RENDER_RADIUS2 && cullFrustum.intersectsBox(aabb);
    }
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
  // Behind the menu the camera slowly drifts — the Reek keeps turning, so the
  // title screen is a live cinematic, not a frozen still.
  if (paused) yawTarget += dt * 0.02;
  const lookEase = Math.min(1, dt * CameraConfig.lookSmoothing);
  yaw += (yawTarget - yaw) * lookEase;
  pitch += (pitchTarget - pitch) * lookEase;
  // Always consume (clears the edge flags) so nothing fires the instant we
  // unpause — but only ACT on input while the player is actually in control.
  const actions = input.consumeActions();

  if (!paused && actions.pulse && orb.canPulse()) {
    orb.spendPulse();
    pulseActive = true;
    pulseRadius = 0;
    pulseCenter.copy(orb.pos);
    pulseFlash = 1; // the orb visibly surges as the wave leaves it
    haptics.fire('pulse'); // crisp tick as the wave leaves the orb
    objective = spores >= 3 ? objective : 'Pulse through the mist. Glowspores answer your light.';
  }
  if (!paused && actions.buildWard) {
    placeWard();
    haptics.fire('ward'); // two-beat confirm — the anchor seats
  }
  if (!paused && actions.tide) startTide();
  // L3 / KeyV flip the camera rig; the pad routes it through here.
  if (!paused && actions.camToggle) {
    camMode = camMode === 0 ? 1 : 0;
    logger('camera').debug(`mode = ${camMode === 1 ? 'shoulder' : 'adaptive'} (pad L3)`);
  }

  orb.pulseRate = mood.pulseRate;
  orb.liftZone = computeLiftZone();
  orb.lookPitch = pitch; // swimming follows the look (dive = aim down + forward)
  // Frozen input while paused — the orb just hovers in place, idling.
  const moveIntent = paused ? { x: 0, z: 0 } : input.moveVector();
  orb.update(
    dt,
    moveIntent,
    yaw,
    !paused && actions.jump,
    !paused && input.sprinting(),
    !paused && actions.dash,
    !paused && input.jumpHeld(),
  );
  if (orb.jumped) {
    pulseFlash = Math.max(pulseFlash, 0.55); // wave-jump = a small pulse
    haptics.fire('jump'); // thump as the downward wave-kick launches the orb
    mood.event('effort');
  }
  if (orb.dashStarted) {
    pulseFlash = Math.max(pulseFlash, 0.7); // the dash surges the aura as it fires
    haptics.fire('dash'); // a blink that lands hard in the thumb
    mood.event('effort');
  }
  // The folk live in the same frame: animation, combat, projectiles. The dash
  // flags make the orb's blink-burst a weapon against them.
  {
    const _t = performance.now();
    folk.update(dt, camera, { paused, dashing: orb.dashing, dashStarted: orb.dashStarted });
    perfMark('folk', performance.now() - _t);
  }
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
  const auraU = orbAura.material.uniforms;
  (auraU.uColor.value as THREE.Color).copy(mood.color);
  auraU.uOpacity.value = 0.55 * orb.breathGlow * mood.brightness;
  // Pull the aura toward the camera: the flat billboard otherwise sinks into
  // any wall behind the orb and the depth test slices a straight edge through
  // the glow. Sliding it up the view ray (scale-compensated, so the on-screen
  // size is unchanged) keeps its depth clear of the wall while real occluders
  // between camera and orb still hide it.
  const camDist = camera.position.distanceTo(orb.pos);
  const auraPull = Math.min(1.3, Math.max(0, camDist - 1.5));
  auraOffset.copy(camera.position).sub(orb.pos).normalize().multiplyScalar(auraPull);
  auraOffset.applyQuaternion(auraQuat.copy(orbGroup.quaternion).invert());
  orbAura.position.copy(auraOffset);
  // Billboard: cancel the parent's lean, then face the camera (a plane, unlike
  // a Sprite, doesn't auto-face).
  orbAura.quaternion.copy(auraQuat).multiply(camera.quaternion);
  const auraScale = 3.4 * orb.breathGlow * flashBoost;
  orbAura.scale.setScalar(auraScale * ((camDist - auraPull) / Math.max(camDist, 1e-3)));
  // The hole tracks the core's APPARENT size inside the pulled billboard. The
  // perspective compensation cancels out of the ratio, so it only depends on
  // the aura's own breathing: hole = coreR / auraHalf, padded slightly.
  auraU.uHole.value = (ORB_HALO_RADIUS * 0.9) / (auraScale * 0.5);
  orbLight.position.copy(orb.pos);
  orbLight.color.copy(mood.color);
  // Physical 1/d² falloff eats light fast, so the base is higher — brightness at
  // mid-bubble (~4 units) matches the old non-physical tune, then dies organically.
  orbLight.intensity = 8 * orb.breathGlow * flashBoost * mood.brightness;

  for (const p of pickups) {
    if (p.taken) continue;
    p.mesh.rotation.y += dt * 1.8;
    p.mesh.position.y = p.pos.y + Math.sin(clock.elapsedTime * 2.3 + p.pos.x) * 0.18;
    if (!paused && p.mesh.position.distanceTo(orb.pos) < 1.45) {
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
    (pulseShell.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t); // brighter shell (was 0.3)
  } else {
    pulseShell.visible = false;
  }

  // --- The Dark Tide envelope: darkness sweeps in from far to close (onset),
  // holds total black (sustain), then lifts (release). tidePress is the 0→1→0
  // darkness level; every tide effect rides it so they black out as one wave.
  let tidePress = 0;
  if (tideT >= 0) {
    if (!paused) tideT += dt; // the tide clock freezes with the menu
    if (tideT >= TIDE_TOTAL) {
      tideT = -1; // the tide has passed
    } else if (tideT < TIDE_ONSET) {
      const u = tideT / TIDE_ONSET; // 0→1: the dark rolls in
      tidePress = u * u * (3 - 2 * u); // smoothstep
    } else if (tideT < TIDE_ONSET + TIDE_SUSTAIN) {
      tidePress = 1; // total black, held — the long dread
    } else {
      const u = (tideT - TIDE_ONSET - TIDE_SUSTAIN) / TIDE_RELEASE; // 0→1
      tidePress = 1 - u * u * (3 - 2 * u); // smoothstep back to night
    }
  }
  const tideActive = tideT >= 0;

  // Keep the orb ~25% brighter THROUGH the tide so it stays clearly visible as
  // the world blacks out — it's your anchor in the dark. (The orb visuals were
  // already set above; scale them up here now that tidePress is known.)
  const orbTideBoost = 1 + 0.25 * tidePress;
  orbLight.intensity *= orbTideBoost;
  (orbHalo.material as THREE.MeshBasicMaterial).opacity *= orbTideBoost;
  orbAura.material.uniforms.uOpacity.value *= orbTideBoost;

  if (tideActive) {
    mood.setThreat(tidePress); // sustained dread rides the darkness
    if (!paused) {
      const protectedByWard = nearestWardDistance() < WARD_RADIUS;
      if (!protectedByWard) {
        orb.lumen = Math.max(0, orb.lumen - dt * 10 * tidePress);
        objective = 'The dark drains fast away from held light.';
      } else if (tideT > TIDE_ONSET + TIDE_SUSTAIN) {
        objective = 'The tide breaks against the ward. The loop is alive.';
      }
    }
  } else if (!paused) {
    orb.lumen = Math.min(100, orb.lumen + dt * (nearestWardDistance() < WARD_RADIUS ? 8 : 2));
  }

  // Total blackness outside held light. uTideDark drives the baked world light
  // + ambient to near-zero; the orb's carried bubble and placed wards are the
  // ONLY terrain light that survives — everything else goes black.
  uniforms.uTideDark.value = 1 - 0.995 * tidePress;
  uniforms.uWardCount.value = Math.min(wards.length, uniforms.uWardPos.value.length);
  for (let i = 0; i < uniforms.uWardCount.value; i++) {
    uniforms.uWardPos.value[i].copy(wards[i].pos);
  }
  // Flora (trees, shrooms) are lit globally by the room-environment image —
  // kill it and only the orb + ward point lights reach them.
  scene.environmentIntensity = uniforms.uTideDark.value;
  // The fog thickens and blackens as the tide rolls in, dissolving DISTANT
  // flora into the dark first — this is the wave you watch consume the horizon
  // and close toward your immediate sphere of light. At peak it's a tight,
  // near-black shroud: nothing beyond the orb's own pool survives.
  const tideFog = scene.fog as THREE.FogExp2;
  tideFog.density = 0; // FOG OFF (John's call). Tide darkness is done via the light dying, not FogExp2.
  tideFog.color.setRGB(0.02 * (1 - tidePress), 0.031 * (1 - tidePress), 0.039 * (1 - tidePress));

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
    // Held light keeps flora charged: inside a ward's dome, caps stay topped up
    // (a ward is permanent light, so its grove is always lit).
    let insideWard = false;
    for (const ward of wards) {
      if (s.pos.distanceToSquared(ward.pos) < WARD_RADIUS * WARD_RADIUS) {
        s.charge += dt * 0.6;
        insideWard = true;
        break;
      }
    }
    // Moonlight trickle-charges surface caps — VERY faint, and it follows the
    // moon: a full clear moon (high moonI) tops them up a touch more than a
    // sliver does. (Cave caps, below the sky, get none.)
    if (s.pos.y > -4) s.charge += dt * moonI * 0.01;
    if (s.charge > 1) s.charge = 1;
    // Afterglow ~30s normally. The Dark Tide leaches stored light far faster —
    // charged caps gutter out — but NOT inside a ward: there the darkness can't
    // reach, so the tide doesn't corrupt and the grove keeps its glow.
    const leech = insideWard ? 1 : 1 + 5 * tidePress; // up to ~5s afterglow at peak
    s.charge *= Math.exp((-dt / 30) * leech); // ~30s afterglow, like phosphor paint
    s.capMat.emissiveIntensity = s.charge * 0.95; // BLACK uncharged; glows only when a light charges it
    s.gillMat.emissiveIntensity = s.charge * 0.65;
    s.fogEntry.intensity = 0.04 + s.charge * 0.65;
  }

  // Micro phosphor caps (buttons + shelf fungi): the SAME charge law as the big
  // shrooms — orb trickle, pulse surge, slow decay, faster leach under the tide —
  // at micro scale: the cap material itself brightens with the charge, never a lamp.
  for (const m of microGlows) {
    const md = m.pos.distanceTo(orb.pos);
    if (md < 6) m.charge += dt * 0.5 * (1 - md / 6);
    if (pulseActive) {
      const pd = m.pos.distanceTo(pulseCenter);
      if (Math.abs(pd - pulseRadius) < 3.2) m.charge += dt * 4.5;
    }
    if (m.charge > 1) m.charge = 1;
    m.charge *= Math.exp((-dt / 26) * (1 + 5 * tidePress));
    m.mat.emissiveIntensity = m.baseEmissive + m.charge * 1.15;
  }

  // Feed the charged glow sources NEAREST the orb to the shader as real point
  // lights (each ray-marches a shadow against the static solidity volume). BIG
  // caps and MICRO caps compete for the same slots — one engine — but each
  // carries its own properties: reach 9 for a grove cap, ~3 for a button clump.
  const litShrooms = shrooms
    .filter((s) => s.charge > 0.06)
    .sort((a, b) => a.pos.distanceToSquared(orb.pos) - b.pos.distanceToSquared(orb.pos))
    .slice(0, uniforms.uShroomPos.value.length);
  const glowFeed: { pos: THREE.Vector3; color: THREE.Color; i: number; r: number }[] = [];
  for (const s of shrooms) {
    if (s.charge > 0.06) glowFeed.push({ pos: s.pos, color: s.capMat.emissive, i: s.charge * 1.4, r: 9 });
  }
  for (const m of microGlows) {
    if (m.charge > 0.12) glowFeed.push({ pos: m.pos, color: m.mat.emissive, i: m.charge * 0.55, r: 3.2 });
  }
  glowFeed.sort((a, b) => a.pos.distanceToSquared(orb.pos) - b.pos.distanceToSquared(orb.pos));
  const nGlow = Math.min(glowFeed.length, uniforms.uShroomPos.value.length);
  uniforms.uShroomCount.value = nGlow;
  for (let i = 0; i < nGlow; i++) {
    uniforms.uShroomPos.value[i].copy(glowFeed[i].pos);
    uniforms.uShroomColor.value[i].copy(glowFeed[i].color);
    uniforms.uShroomI.value[i] = glowFeed[i].i;
    uniforms.uShroomR.value[i] = glowFeed[i].r;
  }
  // Re-aim the REAL point-light pool at the brightest charged shrooms nearest the
  // orb, so a charged grove casts coloured light on ALL geometry (imported flora,
  // orb, native meshes) — not only the terrain shader's own shroom-light path.
  for (let i = 0; i < SHROOM_LIGHT_POOL; i++) {
    const L = shroomLights[i];
    const s = litShrooms[i];
    if (s && s.charge > 0.12) {
      L.position.copy(s.pos);
      L.color.copy(s.fogEntry.color);
      L.intensity = s.charge * 11; // physical 1/d² — higher base, dies naturally (no distance window)
    } else {
      L.intensity = 0;
    }
  }

  for (const ward of wards) {
    const t = clock.elapsedTime;
    const breathe = 1 + Math.sin(t * 2.1 + ward.pos.x) * 0.08;
    ward.core.scale.setScalar(breathe);
    ward.light.intensity = 10 + breathe * 2.8; // ×3.5 for the physical-falloff retune
    ward.activation = Math.max(0, ward.activation - dt * 0.55); // ~2s surge

    // The dome is a REACTIVE membrane, not the default look: invisible at
    // rest, born for a breath at placement, and under a tide it fades in —
    // strongest when you shelter inside it. You SEE the shield only when the
    // dark is actually breaking against it.
    const pressure = tideActive ? 0.25 + 0.75 * tidePress : 0;
    const sheltering = tideActive && ward.pos.distanceTo(orb.pos) < WARD_RADIUS;
    const strain = Math.max(ward.activation, pressure * (sheltering ? 1 : 0.55));
    const domeMat = ward.dome.material as THREE.ShaderMaterial;
    // flicker rises with strain — a membrane under stress, not a steady wall
    domeMat.uniforms.uStrength.value =
      strain * (0.42 + 0.1 * Math.sin(t * 6.3 + ward.pos.z) * (0.4 + 0.6 * strain));
    domeMat.uniforms.uTime.value = t;

    // The radius ring is the ward's default read: it breathes at rest, blooms
    // with the activation surge, and hardens while a tide presses the circle.
    const ringGlow = 0.14 + 0.05 * breathe + 0.35 * ward.activation + 0.14 * pressure;
    const rMats = ward.rings.children.map((c) => (c as THREE.Mesh).material as THREE.MeshBasicMaterial);
    if (rMats[0]) rMats[0].opacity = ringGlow;
    if (rMats[1]) rMats[1].opacity = ringGlow + 0.14;
    ward.rings.rotation.y = t * 0.05; // barely-perceptible slow turn — alive, not mechanical

    // The beam pulses with the core; flares on activation and under pressure.
    (ward.beam.material as THREE.MeshBasicMaterial).opacity =
      0.03 + 0.02 * breathe + 0.22 * ward.activation + 0.05 * pressure;

    // Motes spiral inward across the circle and sink toward the lumen core —
    // gathered light, respawning at the rim so the inflow never stops.
    const mp = ward.motes.geometry.attributes.position.array as Float32Array;
    const st = ward.moteState;
    const baseY = ward.floorY + 1;
    const coreY = ward.pos.y;
    for (let i = 0; i < WARD_MOTES; i++) {
      st[i * 4] += dt * (0.18 + st[i * 4 + 3] * 0.12); // slow spiral
      st[i * 4 + 1] -= dt * st[i * 4 + 3] * (0.6 + 0.6 * ward.activation); // drift inward
      if (st[i * 4 + 1] < 0.5) {
        // reached the core — respawn at the rim
        st[i * 4] = Math.random() * Math.PI * 2;
        st[i * 4 + 1] = WARD_RADIUS * (0.9 + Math.random() * 0.1);
        st[i * 4 + 2] = 0.2 + Math.random() * 2.4;
        st[i * 4 + 3] = 0.5 + Math.random() * 0.9;
      }
      const frac = 1 - st[i * 4 + 1] / WARD_RADIUS; // 0 at rim → 1 at core
      const y =
        baseY +
        st[i * 4 + 2] +
        (coreY - baseY - st[i * 4 + 2]) * frac * frac + // ease up into the niche
        Math.sin(t * 1.7 + i * 2.6) * 0.12; // gentle bob
      mp[i * 3] = ward.anchor.position.x + Math.cos(st[i * 4]) * st[i * 4 + 1];
      mp[i * 3 + 1] = y;
      mp[i * 3 + 2] = ward.anchor.position.z + Math.sin(st[i * 4]) * st[i * 4 + 1];
    }
    ward.motes.geometry.attributes.position.needsUpdate = true;
  }

  uniforms.uOrbPos.value.copy(orb.pos);
  uniforms.uOrbColor.value.copy(mood.color); // the orb's mood paints the world
  uniforms.uOrbIntensity.value =
    LightConfig.orbIntensity * orb.breathGlow * flashBoost * mood.brightness * orbTideBoost;
  uniforms.uPulseCenter.value.copy(pulseCenter);
  uniforms.uPulseRadius.value = pulseActive ? pulseRadius : -1;
  uniforms.uPulseIntensity.value = pulseActive ? LightConfig.pulse.intensity : 0;

  // A soft dark tint closing in with the tide. Kept gentle now that the world
  // itself blacks out through lighting — enough to press, not to smother the
  // orb's own bubble (the refuge must stay legible).
  const veilMaterial = tideVeil.material as THREE.MeshBasicMaterial;
  veilMaterial.opacity = 0.22 * tidePress;
  tideVeil.position.copy(orb.pos);

  // --- The sky: moon orbits slowly, phases over ~8 min, and its light only
  // lands when the CPU-side cloud check says the moon is in a clear pocket.
  const skyT = clock.elapsedTime;
  const az = skyT * 0.006 + 2.1;
  const el = 0.55 + 0.3 * Math.sin(skyT * 0.004);
  moonDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
  const moonPhase = (skyT / 480) % 1; // full cycle every 8 minutes
  // The Dark Tide smothers the whole vault — stars, clouds, and moon sink
  // toward black. The sky is global, so nothing shelters it: this is the tide
  // you SEE coming, above the ward's circle of held light.
  const skyDark = 1 - 0.98 * tidePress;
  sky.update(skyT, camera.position, moonDir, moonPhase, skyDark);
  const fullness = 0.5 - 0.5 * Math.cos(moonPhase * Math.PI * 2); // 0 new → 1 full
  const phaseBright = Math.pow(fullness, 3.5); // ~0 except near a FULL moon
  const moonClear = Math.pow(1 - cloudCoverAt(moonDir, skyT), 2); // only a CLEAR sky counts
  // The moon lifts the world ONLY at a full, cloudless moon (seldom) — otherwise
  // the dark is total. Dies further under the tide.
  const moonTarget = moonClear * phaseBright * 0.5 * (1 - 0.97 * tidePress);
  moonI += (moonTarget - moonI) * Math.min(1, dt * 0.8); // clouds drift, light eases
  uniforms.uMoonDir.value.copy(moonDir);
  uniforms.uMoonI.value = moonI;
  grassField.uniforms.uMoonI.value = moonI;
  // Flora moon wash. A HemisphereLight is a FLAT omnidirectional fill (ART: "no
  // flat ambient fill"), so keep it a whisper — quadratic in moonI so only a
  // genuinely full, clear moon barely lifts flora, and even then it never becomes
  // the blue silhouette-soup that flattened the grove. The orb is the hero light;
  // the moon is a hint, not a floodlight.
  moonAmbient.intensity = moonI * moonI * 0.1;

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
  // (ground-smoke disabled — see the GroundFog note near the composer setup.
  //  The nearest-lights sort below still feeds the orb's reflected-glow sheen,
  //  and is ready to light the fog again when a ground-conforming fog returns.)
  const tideDim = 1 - 0.9 * tidePress;
  const sorted = fogLightRegistry
    .map((l) => ({ l, d: l.pos.distanceToSquared(orb.pos) }))
    .sort((a, b) => a.d - b.d);

  // The hero reflects the world's light: sum the nearby glow at the orb and
  // bleed a faint sheen of it onto the black core — teal in a grove, violet by
  // a crystal, warm inside a ward. Soft reflection on one small object, so it
  // stays occlusion-agnostic; the aura still carries the orb's own mood.
  orbWorldLit.setRGB(0, 0, 0);
  for (let i = 0; i < sorted.length && i < 10; i++) {
    const e = sorted[i];
    const fall = 1 - Math.sqrt(e.d) / 16;
    if (fall <= 0) continue;
    const w = e.l.intensity * fall * fall * tideDim;
    orbWorldLit.r += e.l.color.r * w;
    orbWorldLit.g += e.l.color.g * w;
    orbWorldLit.b += e.l.color.b * w;
  }
  // Bleed a WHISPER of the world's light onto the black core — a reflected mood,
  // never a glow. Clamped so a bright grove can't turn the satin core into a lamp;
  // the orb's light lives in the aura ring, the body stays dark and reflective.
  orbWorldLit.r = Math.min(orbWorldLit.r, 0.4);
  orbWorldLit.g = Math.min(orbWorldLit.g, 0.4);
  orbWorldLit.b = Math.min(orbWorldLit.b, 0.4);
  (orbCore.material as THREE.MeshPhysicalMaterial).emissive.copy(orbWorldLit).multiplyScalar(0.16);

  updateTrail(dt);
  updateSpores(dt, clock.elapsedTime);

  // --- Elemental testbeds: water surface, fire, build editor ---
  // The water is DARK until lit: it only answers to the orb plus whatever live
  // sources sit near the pool (wards, charged groves, crystals — the registry
  // carries them all with their current charge-driven intensity).
  const waterLights: { pos: THREE.Vector3; color: THREE.Color; intensity: number }[] = [
    { pos: orb.pos, color: mood.color, intensity: 1.6 * orb.breathGlow },
  ];
  if (testbeds) {
    const wc = testbeds.water.center;
    for (const l of fogLightRegistry) {
      if (waterLights.length >= 8) break;
      if (l.intensity < 0.25) continue;
      const dxl = l.pos.x - wc.x;
      const dzl = l.pos.z - wc.z;
      if (dxl * dxl + dzl * dzl < 60 * 60) waterLights.push(l);
    }
  }
  waterZone?.update({
    t: clock.elapsedTime,
    orbPos: orb.pos,
    orbColor: mood.color,
    orbIntensity: orbLight.intensity,
    pulseCenter,
    pulseRadius: pulseActive ? pulseRadius : -1,
    pulseIntensity: pulseActive ? LightConfig.pulse.intensity : 0,
    pulseThickness: LightConfig.pulse.thickness,
    moonDir,
    moonI,
    lights: waterLights,
    tier: qualityTier,
  });
  // The orb interacts with the water: crossing the surface hard splashes;
  // swimming drags a wake of expanding ripple rings behind it.
  if (orb.splashed) {
    waterZone?.splash(orb.pos);
    waterZone?.disturb(orb.pos.x, orb.pos.z, 1.3);
    mood.event('effort');
  }
  if (orb.inWater) {
    waterWakeTimer -= dt;
    const swimSpeed = Math.hypot(orb.vel.x, orb.vel.z);
    if (waterWakeTimer <= 0 && swimSpeed > 2) {
      waterZone?.disturb(orb.pos.x, orb.pos.z, 0.22 + swimSpeed * 0.03);
      waterWakeTimer = 0.16;
    }
  }
  if (fireZone) {
    fireZone.update(dt, clock.elapsedTime, camera.position, qualityTier);
    fogLightRegistry[fireFogIdx].intensity = 1.0 + 0.6 * (fireZone.light.intensity / 3);
  }
  if (!paused) buildSandbox?.update(dt, orb.pos, yaw, camera.position);
  // The grass field: wind + parts around the orb + ripples with the pulse.
  grassField.update(
    clock.elapsedTime,
    orb.pos,
    mood.color,
    pulseCenter,
    pulseActive ? pulseRadius : -1,
    pulseActive ? LightConfig.pulse.intensity : 0,
  );
  // --- Shrooms: stiff, quick-rebounding cap-on-stalk. Head and stalk are two
  // coupled springs so they respond separately; neighbours lean apart when they
  // crowd; the orb brushes them and the pulse washes through. High stiffness +
  // near-critical damping = small motion, snappy return (thick, woody things).
  const time = clock.elapsedTime;
  if (leafTimeUniform) leafTimeUniform.value = time; // GPU leaf wind clock
  const sdt = dt < 1 / 30 ? dt : 1 / 30;
  const SH_STALK_STIFF = 120;
  const SH_STALK_DAMP = 8; // underdamped → a natural rock, not a dead snap-back
  const SH_CAP_STIFF = 72;
  const SH_CAP_DAMP = 6;
  const SH_LEAN_MAX = 0.16; // ~9° — barely bends
  const SH_CAP_MAX = 0.3;
  const SH_SIM_R2 = 30 * 30;
  const SH_PULSE_T = LightConfig.pulse.thickness;
  // The wave weakens as it spreads: things near the pulse origin get thrown far,
  // things it reaches late barely stir. Shared by shrooms, trees, and ropes.
  const pulseFalloff = pulseActive
    ? Math.max(0.12, 1 - pulseRadius / LightConfig.pulse.maxRadius)
    : 0;
  for (const s of shroomFlora) {
    if (!s.group.visible) continue;
    const odx = s.x - orb.pos.x;
    const odz = s.z - orb.pos.z;
    const baseY = s.group.position.y;
    let pulseHere = false;
    let pRad = 0;
    if (pulseActive) {
      const px = s.x - pulseCenter.x;
      const py = baseY + s.h - pulseCenter.y;
      const pz = s.z - pulseCenter.z;
      pRad = Math.sqrt(px * px + py * py + pz * pz);
      pulseHere = Math.abs(pRad - pulseRadius) < SH_PULSE_T + s.capR;
    }
    if (odx * odx + odz * odz > SH_SIM_R2 && !pulseHere) continue;

    // Ambient breath so they're never dead-still.
    let tlx = Math.sin(time * 0.6 + s.phase) * 0.006;
    let tlz = Math.cos(time * 0.5 + s.phase * 1.3) * 0.006;
    let tcx = 0;
    let tcz = 0;

    // Neighbour bend: lean away from any cap crowding this one's footprint.
    // Positions are static, so the crowding set is found once and cached.
    if (s.neighbors === null) {
      s.neighbors = [];
      for (const o of shroomFlora) {
        if (o === s) continue;
        const dx = s.x - o.x;
        const dz = s.z - o.z;
        const min = (s.capR + o.capR) * 0.85;
        if (dx * dx + dz * dz < min * min) s.neighbors.push(o);
      }
    }
    for (const o of s.neighbors) {
      const dx = s.x - o.x;
      const dz = s.z - o.z;
      const min = (s.capR + o.capR) * 0.85;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const over = (min - d) / min;
        tlx += (dx / d) * over * 0.12;
        tlz += (dz / d) * over * 0.12;
      }
    }

    // Orb brush — the HEAD (its own hitbox) wobbles; the stalk gives a little.
    const hy = baseY + s.h;
    const hdx = orb.pos.x - s.x;
    const hdy = orb.pos.y - hy;
    const hdz = orb.pos.z - s.z;
    const hR = ORB_HALO_RADIUS + s.capR * 0.7;
    const hd2 = hdx * hdx + hdy * hdy + hdz * hdz;
    if (hd2 < hR * hR) {
      const hd = Math.sqrt(hd2) || 1e-3;
      const pen = hR - hd;
      tcx += (-hdx / hd) * pen * 1.3;
      tcz += (-hdz / hd) * pen * 1.3;
      tlx += (-hdx / hd) * pen * 0.18;
      tlz += (-hdz / hd) * pen * 0.18;
    }
    // Orb brush — the STALK (separate hitbox): closest point up its axis.
    const t = Math.min(1, Math.max(0, (orb.pos.y - baseY) / Math.max(s.h, 0.1)));
    const sdx = orb.pos.x - s.x;
    const sdy = orb.pos.y - (baseY + t * s.h);
    const sdz = orb.pos.z - s.z;
    const sR = ORB_HALO_RADIUS + s.stalkR;
    const sd2 = sdx * sdx + sdy * sdy + sdz * sdz;
    if (sd2 < sR * sR) {
      const sd = Math.sqrt(sd2) || 1e-3;
      const pen = sR - sd;
      tlx += (-sdx / sd) * pen * 0.7 * t;
      tlz += (-sdz / sd) * pen * 0.7 * t;
    }
    // Pulse wash — a small radial shove of head + stalk as the shell passes.
    if (pulseHere) {
      const rx = s.x - pulseCenter.x;
      const rz = s.z - pulseCenter.z;
      const rl = Math.hypot(rx, rz) || 1e-3;
      // Away from the pulse, scaled by shell proximity AND distance falloff.
      const k = (1 - Math.abs(pRad - pulseRadius) / (SH_PULSE_T + s.capR)) * 0.7 * pulseFalloff;
      tcx += (rx / rl) * k;
      tcz += (rz / rl) * k;
      tlx += (rx / rl) * k * 0.5;
      tlz += (rz / rl) * k * 0.5;
    }

    // Stiff, near-critically-damped springs → small move, quick rebound.
    s.lvx += ((tlx - s.lx) * SH_STALK_STIFF - s.lvx * SH_STALK_DAMP) * sdt;
    s.lvz += ((tlz - s.lz) * SH_STALK_STIFF - s.lvz * SH_STALK_DAMP) * sdt;
    s.lx += s.lvx * sdt;
    s.lz += s.lvz * sdt;
    s.cvx += ((tcx - s.cx) * SH_CAP_STIFF - s.cvx * SH_CAP_DAMP) * sdt;
    s.cvz += ((tcz - s.cz) * SH_CAP_STIFF - s.cvz * SH_CAP_DAMP) * sdt;
    s.cx += s.cvx * sdt;
    s.cz += s.cvz * sdt;
    // Clamp: these barely move.
    const ll = Math.hypot(s.lx, s.lz);
    if (ll > SH_LEAN_MAX) {
      const c = SH_LEAN_MAX / ll;
      s.lx *= c;
      s.lz *= c;
    }
    const cl = Math.hypot(s.cx, s.cz);
    if (cl > SH_CAP_MAX) {
      const c = SH_CAP_MAX / cl;
      s.cx *= c;
      s.cz *= c;
    }

    // Upright stalk: rotation.z>0 tips the TOP toward −x, so negate to lean the
    // head toward +x (the "away" direction our targets are built in). This is
    // the fix for shrooms leaning toward the pulse instead of away from it.
    s.group.rotation.z = -s.lx;
    s.group.rotation.x = s.lz;
    s.cap.position.set(s.cx, s.capBaseY, s.cz);
    s.cap.rotation.z = -s.cx * 0.7;
    s.cap.rotation.x = s.cz * 0.7;
  }

  // --- Trees: the trunk is an upright Verlet rope shape-matched to its rest
  // curve — rigid at the base, looser toward the crown, so it bends more up top
  // and is much harder to bend than the mycelium. The orb pressing the trunk
  // and the pulse shell both push the nodes; the crown (canopy + leaves) rides
  // the top node, and the canopy either ripples or flutters its leaves.
  const TREE_DRAG = 0.96; // light damping so a push actually swings the crown
  const TREE_ITER = 8;
  const TREE_MAXSTEP = 0.4;
  const TREE_WAKE = 50; // frames a disturbed tree keeps simulating, then sleeps
  const TREE_CONTACT = 0.5 + ORB_HALO_RADIUS; // trunk collider + glow shell
  const TREE_PULSE_ACC = 150 * (LightConfig.pulse.intensity / 0.8);
  // Boughs = the crown's own springy mass (second hitbox): softer + swingier
  // than the trunk, so brushing the foliage sways it on its own.
  const CROWN_STIFF = 4; // loose — the boughs swing freely
  const CROWN_DAMP = 0.35; // barely damped → long, lazy sway before it settles
  const CROWN_MAX = 1.7;
  const tdtc = dt < 1 / 60 ? dt : 1 / 60;
  const tdt2 = tdtc * tdtc;
  const _tCur = new THREE.Vector3();
  const _tRest = new THREE.Vector3();
  const _tQuat = new THREE.Quaternion();
  const _tWobQ = new THREE.Quaternion();
  const _tWobEuler = new THREE.Euler();
  for (const tree of treeFlora) {
    if (!tree.group.visible) continue;
    const { nodes, prev, rest, kShape, radii, n, radial } = tree;
    const last = n - 1;
    const adx = tree.anchor.x - orb.pos.x;
    const adz = tree.anchor.z - orb.pos.z;
    const nearOrb = adx * adx + adz * adz < 20 * 20;
    // Pulse centre in the tree's local frame.
    const pcx = pulseCenter.x - tree.anchor.x;
    const pcy = pulseCenter.y - tree.anchor.y;
    const pcz = pulseCenter.z - tree.anchor.z;
    // Should the shell be touching ANY part of this trunk right now? Widen the
    // band by the whole trunk span (base→crown), so a far tree wakes up while
    // the wave is anywhere along it — not only when it reaches the crown.
    let pulseHere = false;
    if (pulseActive) {
      const dBase = Math.sqrt(pcx * pcx + pcy * pcy + pcz * pcz);
      const span = rest[last * 3 + 1] + 4; // ~trunk height + margin
      pulseHere = Math.abs(dBase - pulseRadius) < LightConfig.pulse.thickness + span;
    }
    // Sleep-gating: only simulate (and re-upload the trunk tube) while disturbed
    // plus a short settle tail; idle trees sleep in their rest pose for free.
    if (nearOrb || pulseHere) tree.wake = TREE_WAKE;
    if (tree.wake <= 0) continue;
    tree.wake--;

    const olx = orb.pos.x - tree.anchor.x;
    const oly = orb.pos.y - tree.anchor.y;
    const olz = orb.pos.z - tree.anchor.z;

    // 1) Integrate free nodes (no gravity — rest curve holds it up).
    for (let i = 1; i < n; i++) {
      const k = i * 3;
      let sx = (nodes[k] - prev[k]) * TREE_DRAG;
      let sy = (nodes[k + 1] - prev[k + 1]) * TREE_DRAG;
      let sz = (nodes[k + 2] - prev[k + 2]) * TREE_DRAG;
      // Per-NODE shell test (not gated on the crown): as the wavefront climbs
      // the trunk it shoves each node in turn, so the bend travels UP the trunk
      // instead of only kicking the crown.
      if (pulseActive) {
        const rx = nodes[k] - pcx;
        const ry = nodes[k + 1] - pcy;
        const rz = nodes[k + 2] - pcz;
        const rd = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-4;
        const shell = Math.abs(rd - pulseRadius);
        if (shell < LightConfig.pulse.thickness) {
          const a =
            (TREE_PULSE_ACC * (1 - shell / LightConfig.pulse.thickness) * pulseFalloff * tdt2) / rd;
          sx += rx * a;
          sy += ry * a;
          sz += rz * a;
        }
      }
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl > TREE_MAXSTEP) {
        const c = TREE_MAXSTEP / sl;
        sx *= c;
        sy *= c;
        sz *= c;
      }
      prev[k] = nodes[k];
      prev[k + 1] = nodes[k + 1];
      prev[k + 2] = nodes[k + 2];
      nodes[k] += sx;
      nodes[k + 1] += sy;
      nodes[k + 2] += sz;
    }

    // 2) Relax: hold link lengths and shove nodes out of the orb pressing the
    //    trunk (both iterated so they converge). Shape-match to the rest curve
    //    is applied ONCE, after — running it every iteration cancelled every
    //    push in the same frame, which is why the trees did nothing.
    for (let it = 0; it < TREE_ITER; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = i * 3;
        const b = (i + 1) * 3;
        const rlx = rest[b] - rest[a];
        const rly = rest[b + 1] - rest[a + 1];
        const rlz = rest[b + 2] - rest[a + 2];
        const rl = Math.sqrt(rlx * rlx + rly * rly + rlz * rlz) || 1e-4;
        const dx = nodes[b] - nodes[a];
        const dy = nodes[b + 1] - nodes[a + 1];
        const dz = nodes[b + 2] - nodes[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
        const diff = (d - rl) / d;
        const w0 = i === 0 ? 0 : 0.5;
        const w1 = i === 0 ? 1 : 0.5;
        nodes[a] += dx * diff * w0;
        nodes[a + 1] += dy * diff * w0;
        nodes[a + 2] += dz * diff * w0;
        nodes[b] -= dx * diff * w1;
        nodes[b + 1] -= dy * diff * w1;
        nodes[b + 2] -= dz * diff * w1;
      }
      for (let i = 1; i < n; i++) {
        const k = i * 3;
        const dx = nodes[k] - olx;
        const dy = nodes[k + 1] - oly;
        const dz = nodes[k + 2] - olz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < TREE_CONTACT * TREE_CONTACT) {
          const d = Math.sqrt(d2) || 1e-4;
          const push = (TREE_CONTACT - d) / d;
          nodes[k] += dx * push;
          nodes[k + 1] += dy * push;
          nodes[k + 2] += dz * push;
        }
      }
    }
    // Shape-match ONCE per frame: pull each node a little toward its rest-curve
    // spot. Base kShape is strong (rigid trunk), crown kShape tiny (bends far,
    // springs home slowly) — so a push registers, then eases back over frames.
    for (let i = 1; i < n; i++) {
      const k = i * 3;
      const ks = kShape[i];
      nodes[k] += (rest[k] - nodes[k]) * ks;
      nodes[k + 1] += (rest[k + 1] - nodes[k + 1]) * ks;
      nodes[k + 2] += (rest[k + 2] - nodes[k + 2]) * ks;
    }

    updateRopeTube({ nodes, n, radii, radial, tubePos: tree.tubePos, tubeNrm: tree.tubeNrm });

    // --- BOUGHS: the crown is its own hitbox. It rides the top trunk node but
    // ALSO carries a softer, swingier spring, so a brush of the foliage (or the
    // pulse washing the canopy) sways the boughs independently of the trunk.
    const topX = nodes[last * 3];
    const topY = nodes[last * 3 + 1];
    const topZ = nodes[last * 3 + 2];
    const crownWX = tree.anchor.x + topX;
    const crownWY = tree.anchor.y + topY;
    const crownWZ = tree.anchor.z + topZ;
    let tcwx = 0; // crown-wobble target
    let tcwz = 0;
    let pulseSwell = 0;
    // Orb brushing the boughs (their own hitbox radius) shoves them aside.
    const cbx = orb.pos.x - crownWX;
    const cby = orb.pos.y - crownWY;
    const cbz = orb.pos.z - crownWZ;
    const cbR = ORB_HALO_RADIUS + tree.canopyR;
    const cb2 = cbx * cbx + cby * cby + cbz * cbz;
    if (cb2 < cbR * cbR) {
      const cbd = Math.sqrt(cb2) || 1e-3;
      const pen = cbR - cbd;
      tcwx += (-cbx / cbd) * pen;
      tcwz += (-cbz / cbd) * pen;
    }
    // Pulse washing the canopy → sway outward + feed the foliage ripple/flutter.
    if (pulseActive) {
      const dC = Math.hypot(crownWX - pulseCenter.x, crownWY - pulseCenter.y, crownWZ - pulseCenter.z);
      const band = LightConfig.pulse.thickness + 3;
      const shell = Math.abs(dC - pulseRadius);
      if (shell < band) {
        pulseSwell = 1 - shell / band;
        const rx = crownWX - pulseCenter.x;
        const rz = crownWZ - pulseCenter.z;
        const rl = Math.hypot(rx, rz) || 1e-3;
        tcwx += (rx / rl) * pulseSwell * pulseFalloff * 1.4;
        tcwz += (rz / rl) * pulseSwell * pulseFalloff * 1.4;
      }
    }
    // Soft, underdamped crown spring — the boughs swing and settle on their own.
    tree.cwvx += ((tcwx - tree.cwx) * CROWN_STIFF - tree.cwvx * CROWN_DAMP) * tdtc;
    tree.cwvz += ((tcwz - tree.cwz) * CROWN_STIFF - tree.cwvz * CROWN_DAMP) * tdtc;
    tree.cwx += tree.cwvx * tdtc;
    tree.cwz += tree.cwvz * tdtc;
    const cwl = Math.hypot(tree.cwx, tree.cwz);
    if (cwl > CROWN_MAX) {
      const c = CROWN_MAX / cwl;
      tree.cwx *= c;
      tree.cwz *= c;
    }

    // Crown transform: follow the top node + wobble offset; tilt = trunk bend +
    // a lean from the wobble so the boughs read as a hinged, swinging mass.
    tree.crown.position.set(topX + tree.cwx, topY, topZ + tree.cwz);
    _tCur.set(topX - nodes[(last - 1) * 3], topY - nodes[(last - 1) * 3 + 1], topZ - nodes[(last - 1) * 3 + 2]);
    _tRest.set(
      rest[last * 3] - rest[(last - 1) * 3],
      rest[last * 3 + 1] - rest[(last - 1) * 3 + 1],
      rest[last * 3 + 2] - rest[(last - 1) * 3 + 2],
    );
    if (_tCur.lengthSq() > 1e-9 && _tRest.lengthSq() > 1e-9) {
      _tQuat.setFromUnitVectors(_tRest.normalize(), _tCur.normalize());
    } else {
      _tQuat.identity();
    }
    _tWobEuler.set(tree.cwz * 0.16, 0, -tree.cwx * 0.16);
    _tWobQ.setFromEuler(_tWobEuler);
    tree.crown.quaternion.copy(_tQuat).multiply(_tWobQ);

    // Mode A leaves need no CPU work — wind runs in their vertex shader and the
    // crown already carries + sways them. Mode B ripples the blob surface as the
    // wavefront passes (only while the shell is on the canopy).
    if (!canopyLeafMode && pulseSwell > 0) {
      for (const c of tree.canopies) {
        const arr = c.mesh.geometry.attributes.position.array as Float32Array;
        const base = c.base;
        for (let v = 0; v < arr.length; v += 3) {
          const wob =
            1 +
            pulseSwell *
              0.12 *
              (0.5 + 0.5 * Math.sin(base[v] * 3 + base[v + 1] * 3 + base[v + 2] * 3 + time * 12 + c.seed));
          arr[v] = base[v] * wob;
          arr[v + 1] = base[v + 1] * wob;
          arr[v + 2] = base[v + 2] * wob;
        }
        c.mesh.geometry.attributes.position.needsUpdate = true;
      }
    }
  }
  // Hanging strands = Verlet ROPES: a chain of point-masses pinned at the ceiling
  // and hanging under gravity, so the thread bends at every link, not rigidly
  // about the anchor. The orb collides with each node (its glow spheroid, radius
  // ORB_HALO_RADIUS), so a pass drapes the thread over the shell and the
  // spore-balls swing on it. Momentum is automatic: shoving a node out of the
  // orb without touching its prev-position IS a velocity kick, so a fast pass
  // flings the thread and it swings back on its own. The PULSE shell shoves the
  // same nodes radially as its wavefront washes over them — so a pulse whips the
  // strands exactly like a physical brush. Only near / pulse-lit ropes simulate.
  const ROPE_GRAV = 17; //   local down-accel — sets how firmly it hangs plumb
  const ROPE_DRAG = 0.986; // velocity kept per frame — <1 so swings settle
  const ROPE_ITER = 12; //   constraint relaxation passes (stiffer thread)
  const ROPE_MAXSTEP = 0.5; // per-frame node step cap — kills blow-ups
  const ROPE_SIM_R2 = 14 * 14; // wake ropes only when the orb is near enough to touch
  const ROPE_WAKE = 50; // frames a disturbed rope keeps simulating, then sleeps
  const PULSE_THICK = LightConfig.pulse.thickness; // shell half-width (voxels)
  const PULSE_ACC = 78 * (LightConfig.pulse.intensity / 0.8); // wavefront shove
  const dtc = dt < 1 / 60 ? dt : 1 / 60; // clamp for a stable integrator
  const dt2 = dtc * dtc;
  for (const rope of strandRopes) {
    if (!rope.group.visible) continue;
    const { nodes, prev, radii, n, segLen } = rope;
    const ropeLen = (n - 1) * segLen;
    const rdx = rope.anchor.x - orb.pos.x;
    const rdz = rope.anchor.z - orb.pos.z;
    const nearOrb = rdx * rdx + rdz * rdz <= ROPE_SIM_R2;
    // Pulse centre in the rope's local frame; is the shell currently over us?
    const pcx = pulseCenter.x - rope.anchor.x;
    const pcy = pulseCenter.y - rope.anchor.y;
    const pcz = pulseCenter.z - rope.anchor.z;
    let pulseHere = false;
    if (pulseActive) {
      const dA = Math.sqrt(pcx * pcx + pcy * pcy + pcz * pcz);
      // Anchor within the shell band, widened by the rope's reach below it.
      pulseHere = Math.abs(dA - pulseRadius) < PULSE_THICK + ropeLen + 3;
    }
    // Sleep-gating: a rope only simulates (and re-uploads its tube to the GPU)
    // while it's being disturbed, plus a short tail to settle — then it sleeps
    // in its rest pose and costs nothing. This is what keeps idle groves free.
    if (nearOrb || pulseHere) rope.wake = ROPE_WAKE;
    if (rope.wake <= 0) continue;
    rope.wake--;

    // Orb centre in the rope's local frame (anchor at origin).
    const olx = orb.pos.x - rope.anchor.x;
    const oly = orb.pos.y - rope.anchor.y;
    const olz = orb.pos.z - rope.anchor.z;

    // 1) Verlet integrate every free node (node 0 stays pinned to the anchor).
    for (let i = 1; i < n; i++) {
      const k = i * 3;
      let sx = (nodes[k] - prev[k]) * ROPE_DRAG;
      let sy = (nodes[k + 1] - prev[k + 1]) * ROPE_DRAG - ROPE_GRAV * dt2;
      let sz = (nodes[k + 2] - prev[k + 2]) * ROPE_DRAG;
      // Pulse wavefront: while the expanding shell sits on this node, push it
      // radially OUTWARD from the pulse centre — same shove the orb gives, so
      // strands whip when a pulse rolls through and swing back on their own.
      if (pulseHere) {
        const rx = nodes[k] - pcx;
        const ry = nodes[k + 1] - pcy;
        const rz = nodes[k + 2] - pcz;
        const rd = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-4;
        const shell = Math.abs(rd - pulseRadius);
        if (shell < PULSE_THICK) {
          const a = (PULSE_ACC * (1 - shell / PULSE_THICK) * pulseFalloff * dt2) / rd;
          sx += rx * a;
          sy += ry * a;
          sz += rz * a;
        }
      }
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl > ROPE_MAXSTEP) {
        const c = ROPE_MAXSTEP / sl;
        sx *= c;
        sy *= c;
        sz *= c;
      }
      prev[k] = nodes[k];
      prev[k + 1] = nodes[k + 1];
      prev[k + 2] = nodes[k + 2];
      nodes[k] += sx;
      nodes[k + 1] += sy;
      nodes[k + 2] += sz;
    }

    // 2) Relax: hold each link at rest length, then push nodes out of the orb.
    for (let it = 0; it < ROPE_ITER; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = i * 3;
        const b = (i + 1) * 3;
        const dx = nodes[b] - nodes[a];
        const dy = nodes[b + 1] - nodes[a + 1];
        const dz = nodes[b + 2] - nodes[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = (d - segLen) / d;
        // Node 0 is pinned: segment 0 moves only its lower end; else split.
        const w0 = i === 0 ? 0 : 0.5;
        const w1 = i === 0 ? 1 : 0.5;
        nodes[a] += dx * diff * w0;
        nodes[a + 1] += dy * diff * w0;
        nodes[a + 2] += dz * diff * w0;
        nodes[b] -= dx * diff * w1;
        nodes[b + 1] -= dy * diff * w1;
        nodes[b + 2] -= dz * diff * w1;
      }
      // Orb collision: shove any node inside the glow shell back to its surface.
      for (let i = 1; i < n; i++) {
        const k = i * 3;
        const dx = nodes[k] - olx;
        const dy = nodes[k + 1] - oly;
        const dz = nodes[k + 2] - olz;
        const R = ORB_HALO_RADIUS + radii[i];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < R * R) {
          const d = Math.sqrt(d2) || 1e-4;
          const push = (R - d) / d;
          nodes[k] += dx * push;
          nodes[k + 1] += dy * push;
          nodes[k + 2] += dz * push;
        }
      }
    }

    // 3) Reshape the visible tube + ride each spore-ball on its node.
    updateRopeTube(rope);
    for (let i = 0; i < rope.beads.length; i++) {
      const ni = rope.beadNodes[i] * 3;
      rope.beads[i].position.set(nodes[ni], nodes[ni + 1], nodes[ni + 2]);
    }
  }
  updateFloraCulling();
  {
    const _t = performance.now();
    updateSwayProps(dt); // imported trees lean from the orb + shudder on the pulse
    perfMark('sway', performance.now() - _t);
  }
  // (dynamic light-volume re-flood removed — it repacked the whole atlas ~3×/s
  //  and spiked frames = the stutter. Solidity for shadows is static, built once
  //  at load; dynamic sources come back as real shader lights, not a repack.)
  updateCamera(dt);
  updateHud();
  minimap.update(dt, orb.pos, yaw);
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
  {
    const _t = performance.now();
    composer.render();
    perfMark('render', performance.now() - _t);
  }

  // Metrics strip (throttled to 4 Hz so it doesn't churn the DOM).
  fpsEma += (1 / Math.max(dt, 1e-4) - fpsEma) * 0.06;
  metricsTimer += dt;
  let metricsFresh = false;
  if (metricsTimer > 0.25) {
    metricsFresh = true;
    metricsTimer = 0;
    const info = renderer.info.render;
    metricsBar.textContent =
      `${fpsEma.toFixed(0)} fps · ${(1000 / Math.max(fpsEma, 1)).toFixed(1)} ms · ` +
      `${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · ` +
      `${chunkMeshes.size} chunks · ${fogLightRegistry.length + 1} lights · ${renderScale.toFixed(2)}×` +
      (showPadDebug ? ` · ${input.debugGamepadStatus()}` : '');
  }

  if (metricsFresh && (window.innerWidth < 720 || window.matchMedia('(pointer: coarse)').matches)) {
    const info = renderer.info.render;
    metricsBar.textContent =
      `${fpsEma.toFixed(0)} fps | ${(1000 / Math.max(fpsEma, 1)).toFixed(1)} ms | ` +
      `${(info.triangles / 1000).toFixed(0)}k tri | ${renderScale.toFixed(2)}×` +
      (showPadDebug ? ` | ${input.debugGamepadStatus()}` : '');
  }

  // Dynamic resolution: converge on the crispest scale that holds ≥60fps, and
  // climb toward MAX when there's 60→120Hz headroom to spend. A hard sag (e.g.
  // the viewport jump when fullscreen reclaims the bars) gets a BIG immediate
  // cut checked faster, so it never sits stuck at a vsync-quantised 30; mild
  // moves use a 58–74fps dead-band + small steps so it settles, not hunts.
  // Every scale change is a setPixelRatio buffer REALLOCATION — a stutter and
  // often a one-frame black flash. So changes must be RARE: climbs happen on a
  // slow cadence, never while the menu is up (cheap menu frames read as 100fps
  // and used to send the scale to a ceiling play can't hold — the "3s after
  // New Game" freeze), and a sag REMEMBERS the scale that failed (drsCeiling)
  // instead of hunting back up to it every dead-band excursion.
  drsTimer += dt;
  drsForgive += dt;
  if (drsForgive > 45) {
    // the tipping point drifts (chunk count, flora) — retry one notch per 45s
    drsForgive = 0;
    drsCeiling = Math.min(MAX_SCALE, drsCeiling + 0.05);
  }
  const drsInterval = fpsEma < 50 ? 0.25 : fpsEma < 58 ? 0.55 : 3.0;
  if (drsTimer > drsInterval) {
    drsTimer = 0;
    let next = renderScale;
    if (fpsEma < 45) {
      next = renderScale * 0.8; // hard sag → big cut, recover in ~1s
      drsCeiling = Math.max(MIN_SCALE, Math.min(drsCeiling, renderScale - 0.05));
    } else if (fpsEma < 58) {
      next = renderScale - 0.1; // mild sag → ease density down
      drsCeiling = Math.max(MIN_SCALE, Math.min(drsCeiling, renderScale - 0.05));
    } else if (!paused && fpsEma > 74 && renderScale < Math.min(MAX_SCALE, drsCeiling)) {
      next = renderScale + 0.08; // spare GPU → sharpen up (slow cadence)
    }
    next = Math.round(Math.max(MIN_SCALE, Math.min(next, MAX_SCALE, drsCeiling)) * 20) / 20;
    if (Math.abs(next - renderScale) > 0.001) applyRenderScale(next);
  }
}

// Crash boundary for the render loop. frame() no longer schedules itself; this
// wrapper does, in a finally-free path that only re-arms rAF when we haven't
// halted. A single throw is a hiccup we log and skip; a sustained run of them is
// a broken frame that would otherwise re-throw 60×/s into a frozen black screen
// and a flooded console, so after frameErrorLimit we stop and show the crash card.
const frameLog = logger('frame');
let frameErrors = 0;
function frameLoop(): void {
  if (loopHalted) return;
  try {
    const _f0 = performance.now();
    frame();
    // TRUE CPU frame cost (excludes the vsync wait) — drives the perf overlay
    // and the streaming/mesh headroom throttle.
    lastFrameMs = lastFrameMs * 0.85 + (performance.now() - _f0) * 0.15;
    frameErrors = 0; // a clean frame clears the streak
  } catch (err) {
    frameErrors++;
    frameLog.throttle('threw', 1000, 'error', `frame threw (${frameErrors})`, err);
    if (frameErrors >= Debug.frameErrorLimit) {
      loopHalted = true;
      frameLog.error(`halting render loop after ${frameErrors} consecutive errors`);
      devOverlay.showCrash(err, 'The render loop hit repeated errors and was stopped.');
      return; // do NOT re-arm — the loop is dead until reload
    }
  }
  requestAnimationFrame(frameLoop);
}

const camOrigin = new THREE.Vector3();
const camDir = new THREE.Vector3();

/** How open the space around the orb is, 0 (snug tunnel) … 1 (open sky).
 *  Reads BOTH the ceiling clearance and the horizontal room, and takes the
 *  tighter of the two — a low roof OR near walls both count as enclosed. */
function orbOpenness(): number {
  const ox = Math.floor(orb.pos.x);
  const oy = orb.pos.y;
  const oz = Math.floor(orb.pos.z);
  // Ceiling clearance.
  let head = 0;
  for (; head < CameraConfig.headroomOpen + 2; head++) {
    if (world.solid(ox, Math.floor(oy + 1.4 + head), oz)) break;
  }
  // Horizontal clearance: shortest reach across 8 compass directions.
  let minClear = CameraConfig.lateralOpen + 2;
  for (let a = 0; a < 8; a++) {
    const dx = Math.cos((a / 8) * Math.PI * 2);
    const dz = Math.sin((a / 8) * Math.PI * 2);
    let d = 0;
    for (; d < CameraConfig.lateralOpen + 2; d++) {
      if (world.solid(Math.floor(orb.pos.x + dx * (1.2 + d)), Math.floor(oy + 0.4), Math.floor(orb.pos.z + dz * (1.2 + d)))) break;
    }
    if (d < minClear) minClear = d;
  }
  const headO = Math.min(1, head / CameraConfig.headroomOpen);
  const latO = Math.min(1, minClear / CameraConfig.lateralOpen);
  return Math.min(headO, latO);
}

// Entrance columns (surface→cave shafts) as a flat [x,z,x,z,…] for cheap tests.
const ENTRANCE_R2 = 11 * 11; // a touch wider than the carved funnel radius (9)
const entranceCols = reek.entrances;

/** True when the orb sits in a climbable vertical shaft: open air overhead with
 *  enclosing walls (a chimney), OR anywhere inside an entrance funnel. Either
 *  way there's a route up, so the free-jump climb turns on. Surface only needs
 *  it near shafts, so we gate to below ground. */
function computeLiftZone(): boolean {
  if (orb.pos.y > 3) return false; // above ground — normal jump economy
  const ox = Math.floor(orb.pos.x);
  const oy = orb.pos.y;
  const oz = Math.floor(orb.pos.z);
  // Inside an entrance funnel? Guaranteed to reach the surface.
  for (let e = 0; e < entranceCols.length; e++) {
    const dx = orb.pos.x - entranceCols[e][0];
    const dz = orb.pos.z - entranceCols[e][1];
    if (dx * dx + dz * dz < ENTRANCE_R2) return true;
  }
  // A chimney: tall open air above AND enclosed on ≥2 sides (not an open room).
  for (let up = 1; up <= 4; up++) {
    if (world.solid(ox, Math.floor(oy + 1.2 + up), oz)) return false;
  }
  let walls = 0;
  const D: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of D) {
    for (let s = 1; s <= 2; s++) {
      if (world.solid(Math.floor(orb.pos.x + dx * s), Math.floor(oy + 0.3), Math.floor(orb.pos.z + dz * s))) {
        walls++;
        break;
      }
    }
  }
  return walls >= 2;
}

function updateCamera(dt: number): void {
  const open = orbOpenness();
  // Ease boom length/rise between the open-sky rig and the snug-cave rig so the
  // camera never *wants* to sit where geometry forbids (the old whip/clip).
  const tDist = camMode === 1
    ? CameraConfig.shoulderDistance
    : CameraConfig.tightDistance + (CameraConfig.distance - CameraConfig.tightDistance) * open;
  const tHeight = camMode === 1
    ? CameraConfig.shoulderHeight
    : CameraConfig.tightHeight + (CameraConfig.height - CameraConfig.tightHeight) * open;
  const ease = Math.min(1, dt * CameraConfig.enclosureLerp);
  camDistSmooth += (tDist - camDistSmooth) * ease;
  camHeightSmooth += (tHeight - camHeightSmooth) * ease;
  const distance = camDistSmooth;
  const height = camHeightSmooth;
  tempVec.set(
    orb.pos.x + Math.sin(yaw) * Math.cos(pitch) * distance,
    orb.pos.y + height + Math.sin(pitch) * distance,
    orb.pos.z + Math.cos(yaw) * Math.cos(pitch) * distance,
  );
  // Over-shoulder alt-rig: nudge the boom sideways so the orb isn't dead-centre.
  if (camMode === 1) {
    tempVec.x += Math.cos(yaw) * CameraConfig.shoulderSide;
    tempVec.z += -Math.sin(yaw) * CameraConfig.shoulderSide;
  }

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
  applyRenderScale(renderScale); // keep the current DRS density; just re-fit the buffers
});

// Decide the opening beat (resume a save, or show the title) BEFORE the first
// frame, so `paused` is correct from frame one.
menu.boot();
// Take the phone: hold the screen awake, and on touch reclaim the browser/OS
// bars by going fullscreen on the first tap (no-ops on desktop + iPhone).
mobileShell.start();
frameLoop();

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
  // --- Elemental testbeds (John's corners): warp to each + drive the sandbox.
  // These MUST live on THIS object — it's the final `waiver` assignment; an
  // earlier duplicate assignment gets clobbered (that's why toWater() didn't
  // exist and the lake was unfindable).
  toWater: () => testbeds && orb.pos.copy(testbeds.water.teleport),
  toForge: () => testbeds && orb.pos.copy(testbeds.forge.teleport),
  toSandbox: () => testbeds && orb.pos.copy(testbeds.sandbox.teleport),
  build: {
    place: () => buildSandbox?.place(),
    remove: () => buildSandbox?.remove(),
    cycle: () => buildSandbox?.cycleMat(),
    force: () => buildSandbox?.forceWave(orb.pos.clone()),
  },
  testbeds, // dev: inspect carved zone metadata
  waterZone, // dev: live-tune the water shader uniforms + flipFish()
  fireZone, // dev: inspect the hearth
  folk, // dev: mushroom folk — folk.setMode('attack'), folk.folk[0].damage(…), folk.clips()
  animator: animatorUI, // dev: the K panel — animator.toggle() from the console
  minimap, // dev: map prefs/markers from the console
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
    logger('terrain').debug(`${v ? 'smooth' : 'blocky'} remesh in ${(performance.now() - t0).toFixed(0)}ms`);
  },
  /** A/B the sampled light volume against the baked terrain light. 0 = baked
   *  (default), 1 = fully volume-driven. If terrain looks the same at 1, the
   *  volume is correct and ready to carry dynamic (charge) light. */
  lightVol(mix: number): void {
    uniforms.uLightVolMix.value = mix;
    logger('lightvol').debug(`mix = ${mix}`);
  },
  /** A/B the cave camera: 'adaptive' (default) draws the boom in as the space
   *  tightens; 'shoulder' is a fixed close over-shoulder chase. Or press V. */
  camMode(mode: 'adaptive' | 'shoulder'): void {
    camMode = mode === 'shoulder' ? 1 : 0;
    logger('camera').debug(`mode = ${mode}`);
  },
  // --- diagnostics (see core/log.ts, ui/DevOverlay.ts) ---
  setLogLevel: (level: LogLevel) => setLogLevel(level),
  showLogs: () => devOverlay.show(),
  hideLogs: () => devOverlay.hide(),
  /** Copyable text of the whole ring buffer (also returned for the console). */
  dumpLogs: () => dumpLogs(),
  /** Exercise the frame-loop crash boundary: throw on the next `n` frames so the
   *  boundary logs, streaks, and (at the limit) halts + shows the crash card. */
  throwTest: (n: number = Debug.frameErrorLimit) => {
    const wasHalted = loopHalted;
    loopHalted = false;
    frameErrors = 0;
    throwNextFrames = n;
    frameLog.warn(`throwTest: erroring on the next ${n} frame(s)`);
    if (wasHalted) requestAnimationFrame(frameLoop);
  },
};

// Press V to flip the cave camera between adaptive and over-shoulder (A/B).
// Press P to toggle the controller telemetry (HUD line + metrics pad segment).
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV') {
    camMode = camMode === 0 ? 1 : 0;
    logger('camera').debug(`mode = ${camMode === 1 ? 'shoulder' : 'adaptive'}`);
  }
  if (e.code === 'KeyP') {
    showPadDebug = !showPadDebug;
    logger('input').debug(`pad telemetry ${showPadDebug ? 'ON' : 'OFF'}`);
  }
});

// Testbed build controls for the SW sandbox. F/B/T/Q/V/L are already bound
// (see core/Input.ts), so the build verbs use the free keys:
//   G = force wave (scatters your placed blocks) · E = place · R = remove
//   C = cycle build material. The wire-box cursor floats in front of the orb.
window.addEventListener('keydown', (e) => {
  if (paused || e.repeat) return;
  switch (e.code) {
    case 'KeyG':
      buildSandbox?.forceWave(orb.pos.clone());
      break;
    case 'KeyE':
      buildSandbox?.place();
      break;
    case 'KeyR':
      buildSandbox?.remove();
      break;
    case 'KeyC':
      if (buildSandbox) logger('build').info(`material → ${buildSandbox.cycleMat()}`);
      break;
  }
});
