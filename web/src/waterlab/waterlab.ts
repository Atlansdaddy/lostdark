/**
 * waterlab — the dedicated water testbed (John's process: iterate here until
 * the water is RIGHT, then port to the game). v1 = the freshwater tier:
 * a lake (divable) + a pond (wade-depth) in a dark basin.
 *
 * What v1 must prove, in John's words:
 *   · "calm unless I disturb them" — dead-still black mirrors
 *   · "very good splash and displacement physics" — momentum craters, wakes,
 *     rings that cross the whole body and reflect off the real shore
 *   · dense orb: sinks by default, swim-up is the effort
 *
 * Dark-game water law (John): the surface is BLACK until a light is near —
 * moon glints on disturbance slopes + the orb's own light are the only reveals.
 *
 * Serve on the DEDICATED water port:
 *   npx vite --host 127.0.0.1 --port 5179 --strictPort   → /waterlab.html
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { WaterSim } from './WaterSim';
import { PlanarReflector } from './PlanarReflector';

// ---------------------------------------------------------------- scene ----
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// THE GAME'S LIGHT ENGINE output: HDR bloom → ACES (main.ts values verbatim).
// The glow look IS this chain — raw linear output reads flat and dead.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020205);
scene.fog = new THREE.FogExp2(0x020205, 0.016);

const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 400);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.55, // strength — glow, not blowout
  0.45, // radius
  0.62, // threshold — only genuinely bright things bloom
));
composer.addPass(new OutputPass());

// Permanent night with a REAL moon: bright enough to silver the banks, and a
// visible disc in the sky so reflections and Snell's window have an anchor.
const moonDir = new THREE.Vector3(0.35, 0.8, 0.25).normalize();
const moon = new THREE.DirectionalLight(0x9fb4d8, 0.85);
moon.position.copy(moonDir.clone().multiplyScalar(50));
const amb = new THREE.AmbientLight(0x223344, 0.16);
const hemi = new THREE.HemisphereLight(0x2c3a52, 0x0a0f0c, 0.28);
scene.add(moon, amb, hemi);
{
  const disc = new THREE.Mesh(
    new THREE.SphereGeometry(7, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xdce8ff, fog: false }),
  );
  disc.position.copy(moonDir.clone().multiplyScalar(320));
  scene.add(disc);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(13, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x93a8cc, transparent: true, opacity: 0.16, fog: false }),
  );
  halo.position.copy(disc.position);
  scene.add(halo);
}

// ---------------------------------------------------------------- basin ----
// Procedural floor: rolling dark ground with a deep lake bowl + shallow pond.
const LAKE = { x: 0, z: 0, rx: 24, rz: 17, depth: 9, level: 0 };
const POND = { x: 34, z: -20, rx: 5.5, rz: 4.5, depth: 1.1, level: 0.15 };

function floorY(x: number, z: number): number {
  let h = 1.6 + Math.sin(x * 0.05) * Math.cos(z * 0.045) * 1.1 + Math.sin(x * 0.013 + 2) * 1.4;
  const lk = ((x - LAKE.x) / LAKE.rx) ** 2 + ((z - LAKE.z) / LAKE.rz) ** 2;
  if (lk < 1.6) h -= (LAKE.depth + 2) * Math.max(0, 1 - lk) ** 1.4;
  const pd = ((x - POND.x) / POND.rx) ** 2 + ((z - POND.z) / POND.rz) ** 2;
  if (pd < 1.8) h -= (POND.depth + 1.2) * Math.max(0, 1 - pd) ** 1.6;
  return h;
}

{
  const size = 220;
  const seg = 220;
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, floorY(pos.getX(i), pos.getZ(i)));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1e2620, roughness: 0.95 });
  scene.add(new THREE.Mesh(g, mat));
}

// ------------------------------------------------------------- dressing ----
// Environmental cues (John: "no way to know that's a body of water"): glowing
// shore life ringing each body, crystals on the banks, bioluminescent plants
// down IN the lake (they populate the internal mirror when you look up from
// under), and fireflies. The reflections are only as alive as the world is.
const fireflyBase: THREE.Vector3[] = [];
{
  const capGeo = new THREE.SphereGeometry(0.34, 12, 10);
  const stemGeo = new THREE.CylinderGeometry(0.08, 0.14, 0.8, 8);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.9 });
  const teal = new THREE.MeshStandardMaterial({
    color: 0x0d332a, emissive: 0x2fe8b0, emissiveIntensity: 1.6, roughness: 0.6,
  });
  const placeCaps = (cx: number, cz: number, rx: number, rz: number, n: number, every: number) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.sin(i * 7.3) * 0.5;
      const rr = 1.12 + Math.abs(Math.sin(i * 3.7)) * 0.25;
      const x = cx + Math.cos(a) * rx * rr;
      const z = cz + Math.sin(a) * rz * rr;
      const y = floorY(x, z);
      if (y < LAKE.level) continue; // stay on the bank
      const g = new THREE.Group();
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.y = 0.4;
      const cap = new THREE.Mesh(capGeo, teal);
      cap.position.y = 0.85;
      cap.scale.setScalar(0.7 + Math.abs(Math.sin(i * 5.1)) * 0.7);
      g.add(stem, cap);
      g.position.set(x, y, z);
      scene.add(g);
      if (i % every === 0) {
        const pl = new THREE.PointLight(0x2fe8b0, 2.6, 0, 2);
        pl.position.set(x, y + 1.1, z);
        scene.add(pl);
      }
    }
  };
  placeCaps(LAKE.x, LAKE.z, LAKE.rx, LAKE.rz, 16, 5);
  placeCaps(POND.x, POND.z, POND.rx, POND.rz, 7, 3);

  // Bank crystals — cold violet counterpoint.
  const cryMat = new THREE.MeshStandardMaterial({
    color: 0x1a1030, emissive: 0x8a5cf0, emissiveIntensity: 1.3, roughness: 0.3,
  });
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4 + 0.7;
    const x = LAKE.x + Math.cos(a) * (LAKE.rx + 4 + i);
    const z = LAKE.z + Math.sin(a) * (LAKE.rz + 3 + (i % 3));
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 + (i % 3) * 0.3, 0), cryMat);
    c.position.set(x, floorY(x, z) + 0.3, z);
    c.rotation.set(i, i * 2.1, i * 0.7);
    scene.add(c);
    if (i % 2 === 0) {
      const pl = new THREE.PointLight(0x8a5cf0, 1.8, 0, 2);
      pl.position.set(x, floorY(x, z) + 1, z);
      scene.add(pl);
    }
  }

  // Bioluminescent plants down in the lake bowl — the dive has destinations
  // and the under-surface mirror has content.
  const kelpMat = new THREE.MeshStandardMaterial({
    color: 0x06231c, emissive: 0x19c9de, emissiveIntensity: 1.5, roughness: 0.7,
  });
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9;
    const x = LAKE.x + Math.cos(a) * LAKE.rx * 0.55;
    const z = LAKE.z + Math.sin(a) * LAKE.rz * 0.55;
    const y = floorY(x, z);
    const h = 1.2 + (i % 3) * 0.9;
    const k = new THREE.Mesh(new THREE.ConeGeometry(0.16, h, 7), kelpMat);
    k.position.set(x, y + h / 2, z);
    scene.add(k);
  }
  const uw1 = new THREE.PointLight(0x19c9de, 2.2, 0, 2);
  uw1.position.set(LAKE.x + 6, floorY(LAKE.x + 6, LAKE.z) + 1.4, LAKE.z);
  const uw2 = new THREE.PointLight(0x19c9de, 2.2, 0, 2);
  uw2.position.set(LAKE.x - 7, floorY(LAKE.x - 7, LAKE.z - 4) + 1.4, LAKE.z - 4);
  scene.add(uw1, uw2);

  // Fireflies — drifting warm-teal points above the banks.
  for (let i = 0; i < 42; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.9 + Math.random() * 0.5;
    const x = LAKE.x + Math.cos(a) * LAKE.rx * r;
    const z = LAKE.z + Math.sin(a) * LAKE.rz * r;
    fireflyBase.push(new THREE.Vector3(x, Math.max(floorY(x, z), LAKE.level) + 0.8 + Math.random() * 2.2, z));
  }
}
const flyPos = new Float32Array(fireflyBase.length * 3);
const flyGeo = new THREE.BufferGeometry();
flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
const fireflies = new THREE.Points(
  flyGeo,
  new THREE.PointsMaterial({
    size: 0.12, color: 0x9fffe0, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }),
);
fireflies.frustumCulled = false;
scene.add(fireflies);

// ---------------------------------------------------------------- water ----
const lakeSim = new WaterSim({
  minX: LAKE.x - LAKE.rx - 2, minZ: LAKE.z - LAKE.rz - 2,
  sizeX: LAKE.rx * 2 + 4, sizeZ: LAKE.rz * 2 + 4,
  level: LAKE.level, cell: 0.5, floor: floorY,
});
const pondSim = new WaterSim({
  minX: POND.x - POND.rx - 1, minZ: POND.z - POND.rz - 1,
  sizeX: POND.rx * 2 + 2, sizeZ: POND.rz * 2 + 2,
  level: POND.level, cell: 0.35, floor: floorY,
});
const sims = [lakeSim, pondSim];

const orbLightPos = new THREE.Vector3();
const orbLightColor = new THREE.Color(0x8defff);

// Reflection engine, planar provider: ONE half-res mirrored render per frame,
// aimed at whichever body the camera is over (the other keeps the rim look).
const reflector = new PlanarReflector(0.5);

function waterMesh(sim: WaterSim): THREE.Mesh {
  const sx = sim.w * sim.cell;
  const sz = sim.d * sim.cell;
  const g = new THREE.PlaneGeometry(sx, sz, sim.w, sim.d);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uWave: { value: sim.texture },
      uTexel: { value: new THREE.Vector2(1 / sim.w, 1 / sim.d) },
      uCell: { value: sim.cell },
      uMoonDir: { value: moonDir },
      uOrbPos: { value: orbLightPos },
      uOrbColor: { value: orbLightColor },
      uTime: { value: 0 },
      // Reflection engine (planar provider): shared RT + projective matrix.
      uReflMap: { value: reflector.texture },
      uReflMatrix: { value: reflector.textureMatrix },
      uReflOn: { value: 0 }, // frame loop enables it for the active body only
      uReflBelow: { value: 0 }, // 1 = RT holds the internal (underwater) mirror
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uWave;
      uniform vec2 uTexel;
      uniform float uCell;
      uniform mat4 uReflMatrix;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vChurn;
      varying vec4 vRefl;
      varying vec2 vUv;
      varying float vShore;
      varying float vDepth;
      varying float vH;
      void main() {
        vec2 uvc = uv;
        vUv = uv;
        vec4 wv4 = texture2D(uWave, uvc);
        vec2 wv = wv4.rg;
        vShore = wv4.b;
        vDepth = wv4.a;
        vH = wv4.r;
        vec3 p = position;
        p.y += wv.r;
        // Analytic normal from height-field neighbours.
        float hl = texture2D(uWave, uvc - vec2(uTexel.x, 0.0)).r;
        float hr = texture2D(uWave, uvc + vec2(uTexel.x, 0.0)).r;
        float hd = texture2D(uWave, uvc - vec2(0.0, uTexel.y)).r;
        float hu = texture2D(uWave, uvc + vec2(0.0, uTexel.y)).r;
        vNormal = normalize(vec3(hl - hr, 2.0 * uCell, hd - hu));
        vChurn = wv.g;
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        vRefl = uReflMatrix * w;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uMoonDir;
      uniform vec3 uOrbPos;
      uniform vec3 uOrbColor;
      uniform sampler2D uReflMap;
      uniform float uReflOn;
      uniform float uReflBelow;
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vChurn;
      varying vec4 vRefl;
      varying vec2 vUv;
      varying float vShore;
      varying float vDepth;
      varying float vH;
      void main() {
        vec3 N = normalize(vNormal);
        // LIQUID MICRO-SHIMMER — water is never optically still. Tiny always-on
        // normal ripple makes every glint and reflection tremble; this is the
        // single strongest "that's liquid" cue and it costs four sins.
        vec2 mr = vec2(
          sin(vWorld.x * 7.3 + uTime * 2.2) + sin(vWorld.z * 5.1 - uTime * 1.5),
          sin(vWorld.z * 6.7 + uTime * 1.9) + sin(vWorld.x * 4.3 + uTime * 1.2)
        ) * 0.014;
        N = normalize(vec3(N.x + mr.x, N.y, N.z + mr.y));
        vec3 V = normalize(cameraPosition - vWorld);
        // The medium: shallow water is a lit turquoise, deep water swallows.
        vec3 tint = mix(vec3(0.14, 0.52, 0.55), vec3(0.02, 0.09, 0.13), vDepth);
        // VOLUMETRIC SCATTER — the water picks up nearby light and disperses
        // it through the column (WaterPro's SSS line, John's core ask). Wide
        // soft falloff, more medium = more glow, from EITHER side of the
        // surface: approach → bloom spreads; submerge → the lake lights up.
        float dOrb = distance(uOrbPos, vWorld);
        float sc = exp(-dOrb * 0.085); // long throw — the bloom leads you in
        float column = 0.30 + 0.70 * vDepth;
        vec3 scatter = uOrbColor * tint * sc * column * 5.0;
        // Transmission through crests: a submerged light glows brightest
        // where the surface bulges (a thin lens of water above the light).
        float submerged = clamp((vWorld.y - uOrbPos.y) * 1.2, 0.0, 1.0);
        scatter += uOrbColor * max(vH, 0.0) * sc * 3.2 * (0.3 + 0.7 * submerged);
        // ---- UNDERWATER, LOOKING UP: the killer shot (John). Outside
        // Snell's window (~48.6° from vertical) the surface is a TOTAL
        // internal mirror of the underwater world; inside the window the
        // night sky + moon refract through, smeared by every ripple. ----
        if (!gl_FrontFacing) {
          vec3 W = -V;                    // view ray, camera → surface
          float up = clamp(W.y, 0.0, 1.0); // cos(angle to vertical)
          float window = smoothstep(0.60, 0.74, up); // 1 inside Snell cone
          vec2 ruv = vRefl.xy / vRefl.w + N.xz * 0.4;
          vec3 mirror = uReflOn > 0.5 ? texture2D(uReflMap, ruv).rgb
                                       : vec3(0.004, 0.012, 0.018);
          // Refracted night sky: near-black gradient + the moon, wobbling
          // with the surface slope.
          vec3 dir = normalize(W + vec3(N.x, 0.0, N.z) * 0.8);
          float moon = pow(max(dot(dir, uMoonDir), 0.0), 500.0);
          vec3 sky = vec3(0.010, 0.016, 0.028) + vec3(0.7, 0.8, 1.0) * moon * 3.0
                   + vec3(0.05, 0.07, 0.10) * pow(max(dot(dir, uMoonDir), 0.0), 8.0);
          vec3 colU = mix(mirror * vec3(0.85, 0.95, 1.0), sky, window);
          colU += scatter * 1.7; // your light glows the ceiling from below
          colU *= 1.0 + vChurn * 1.2;
          gl_FragColor = vec4(colU, 0.97);
          return;
        }
        // The medium is never void: moonlight alone gives the volume a faint
        // presence, and every nearby light blooms through it (scatter).
        vec3 col = tint * 0.05;
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        if (uReflOn > 0.5 && uReflBelow < 0.5) {
          // TRUE mirrored-scene reflection: every ripple smears the world.
          // Fresnel-weighted so looking straight down stays abyss-black —
          // the still lake is a dark mirror, not a bright one.
          vec2 ruv = vRefl.xy / vRefl.w + N.xz * 0.35;
          vec3 refl = texture2D(uReflMap, ruv).rgb;
          col += refl * (0.25 + 0.75 * fres);
        } else {
          // Fresnel rim fallback — the surface exists as an edge.
          col += vec3(0.10, 0.14, 0.18) * fres;
        }
        // Moon glint: only where a slope tilts the mirror at you — a still
        // lake shows ONE distant streak; disturbance scatters silver.
        vec3 H = normalize(uMoonDir + V);
        float spec = pow(max(dot(N, H), 0.0), 700.0);
        col += vec3(0.75, 0.85, 1.0) * spec * 2.2;
        // Orb light: diffuse wash + tight moving glint, 1/d² falloff.
        vec3 toO = uOrbPos - vWorld;
        float d2 = dot(toO, toO);
        vec3 L = toO * inversesqrt(max(d2, 1e-4));
        float att = 9.0 / max(d2, 0.6);
        col += uOrbColor * 0.05 * max(dot(N, L), 0.0) * att;
        vec3 HO = normalize(L + V);
        col += uOrbColor * pow(max(dot(N, HO), 0.0), 240.0) * att * 1.6;
        // The volume glow itself.
        col += scatter;
        // Shoreline shimmer: a living band where water meets land — the cue
        // that says "this is a body of water" without lighting the whole lake.
        float lap = 0.55 + 0.45 * sin(uTime * 1.6 + vWorld.x * 1.9 + vWorld.z * 1.4);
        col += vec3(0.35, 0.95, 0.78) * vShore * vShore * 0.10 * lap;
        // Churn: agitated water catches everything a little brighter.
        col *= 1.0 + vChurn * 1.5;
        // Transparency is physical: shallow edges show their bed, and the
        // column turns glassy where your light penetrates it.
        float alpha = mix(0.55, 0.95, vDepth);
        alpha = clamp(alpha + fres * 0.25 - sc * 0.35 * (1.0 - vDepth * 0.5), 0.30, 0.97);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, // the surface must exist from below — Snell's window
  });
  const m = new THREE.Mesh(g, mat);
  m.position.set(sim.minX + sx / 2, sim.level, sim.minZ + sz / 2);
  scene.add(m);
  return m;
}
const waterMeshes = sims.map(waterMesh);
const waterMats = waterMeshes.map((m) => m.material as THREE.ShaderMaterial);

// ------------------------------------------------------------- droplets ----
const dropCanvas = document.createElement('canvas');
dropCanvas.width = dropCanvas.height = 32;
{
  const c = dropCanvas.getContext('2d')!;
  const gr = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(210,235,255,1)');
  gr.addColorStop(1, 'rgba(210,235,255,0)');
  c.fillStyle = gr;
  c.fillRect(0, 0, 32, 32);
}
const DROPS = 400;
const dropPos = new Float32Array(DROPS * 3).fill(-999);
const dropVel = new Float32Array(DROPS * 3);
const dropLife = new Float32Array(DROPS);
let dropHead = 0;
const dropGeo = new THREE.BufferGeometry();
dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
const drops = new THREE.Points(
  dropGeo,
  new THREE.PointsMaterial({
    size: 0.09, map: new THREE.CanvasTexture(dropCanvas), transparent: true,
    opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xaad4ee,
  }),
);
drops.frustumCulled = false;
scene.add(drops);

function burst(x: number, y: number, z: number, vigor: number, outVx = 0, outVz = 0): void {
  const n = Math.floor(8 + vigor * 60);
  for (let i = 0; i < n; i++) {
    const idx = dropHead;
    dropHead = (dropHead + 1) % DROPS;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.7 * (0.5 + vigor);
    dropPos[idx * 3] = x + Math.cos(a) * r;
    dropPos[idx * 3 + 1] = y + 0.05;
    dropPos[idx * 3 + 2] = z + Math.sin(a) * r;
    const up = (1.6 + Math.random() * 3.4) * (0.4 + vigor);
    dropVel[idx * 3] = Math.cos(a) * (0.6 + Math.random()) * (0.5 + vigor * 1.6) + outVx * 0.35;
    dropVel[idx * 3 + 1] = up;
    dropVel[idx * 3 + 2] = Math.sin(a) * (0.6 + Math.random()) * (0.5 + vigor * 1.6) + outVz * 0.35;
    dropLife[idx] = 0.9 + Math.random() * 0.7;
  }
}

function stepDrops(dt: number): void {
  for (let i = 0; i < DROPS; i++) {
    if (dropLife[i] <= 0) continue;
    dropLife[i] -= dt;
    dropVel[i * 3 + 1] -= 12.5 * dt;
    dropPos[i * 3] += dropVel[i * 3] * dt;
    dropPos[i * 3 + 1] += dropVel[i * 3 + 1] * dt;
    dropPos[i * 3 + 2] += dropVel[i * 3 + 2] * dt;
    if (dropLife[i] <= 0 || dropPos[i * 3 + 1] < -12) dropPos[i * 3 + 1] = -999;
    // A droplet landing back on water rings it — closes the loop.
    for (const s of sims) {
      if (dropPos[i * 3 + 1] < s.level && dropPos[i * 3 + 1] > s.level - 0.3 &&
          s.contains(dropPos[i * 3], dropPos[i * 3 + 2])) {
        s.impulse(dropPos[i * 3], dropPos[i * 3 + 2], -0.02, 0.35);
        dropLife[i] = 0;
        dropPos[i * 3 + 1] = -999;
      }
    }
  }
  dropGeo.attributes.position.needsUpdate = true;
}

// ------------------------------------------------------------------ orb ----
// OUR orb (per the game, main.ts): a REFLECTIVE BLACK sphere — the light
// lives in the AURA around it, never in the core. Tight rim glow hugging the
// body + a wide soft billboard glow with a dark hole where the core sits,
// and a wake of drifting light-motes. Dense diver: sinks; swim-up is effort.
function auraTexture(holeFrac: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)'); // the hole — the core stays dark
  g.addColorStop(Math.max(0.01, holeFrac), 'rgba(255,255,255,0)');
  g.addColorStop(Math.min(1, holeFrac + 0.12), 'rgba(255,255,255,0.9)');
  g.addColorStop(Math.min(1, holeFrac + 0.4), 'rgba(255,255,255,0.30)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}
const orb = new THREE.Group();
const orbCore = new THREE.Mesh(
  new THREE.SphereGeometry(0.42, 28, 20),
  new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 0.12, metalness: 0.55 }),
);
const orbRim = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: auraTexture(0.42), color: 0x8defff, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }),
);
orbRim.scale.setScalar(1.25);
const orbAura = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: auraTexture(0.16), color: 0x66d9ff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }),
);
orbAura.scale.setScalar(3.2);
orb.add(orbCore, orbRim, orbAura);
const orbLight = new THREE.PointLight(0x8defff, 8, 0, 2);
orb.add(orbLight);
scene.add(orb);
const orbPos = new THREE.Vector3(-14, 6, 26);
const orbVel = new THREE.Vector3();
const slopeTmp = { x: 0, z: 0 };
let wasUnder = false;

// Wake of light-motes (the game's cheapest "it's alive" signal).
const TRAIL = 48;
const trailPos = new Float32Array(TRAIL * 3).fill(-999);
const trailLife = new Float32Array(TRAIL);
let trailHead = 0;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
const trail = new THREE.Points(
  trailGeo,
  new THREE.PointsMaterial({
    size: 0.3, map: auraTexture(0.0), color: 0x8defff, transparent: true,
    opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
  }),
);
trail.frustumCulled = false;
scene.add(trail);
function stepTrail(dt: number, speed: number): void {
  if (speed > 2.5) {
    const i = trailHead;
    trailHead = (trailHead + 1) % TRAIL;
    trailPos[i * 3] = orbPos.x + (Math.random() - 0.5) * 0.4;
    trailPos[i * 3 + 1] = orbPos.y + (Math.random() - 0.5) * 0.4;
    trailPos[i * 3 + 2] = orbPos.z + (Math.random() - 0.5) * 0.4;
    trailLife[i] = 1;
  }
  for (let i = 0; i < TRAIL; i++) {
    if (trailLife[i] <= 0) continue;
    trailLife[i] -= dt * 0.8;
    trailPos[i * 3 + 1] += dt * 0.35; // motes rise
    if (trailLife[i] <= 0) trailPos[i * 3 + 1] = -999;
  }
  trailGeo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------- marine snow ----
// Water is a MEDIUM, not a void — suspended particulate drifting in the
// column is the strongest "I'm inside something" cue, and from above it puts
// a faint living depth under the surface. Brightens when the camera submerges.
const SNOW = 340;
const snowPos = new Float32Array(SNOW * 3);
const snowSeed = new Float32Array(SNOW);
for (let i = 0; i < SNOW; i++) {
  let x = 0; let z = 0;
  do {
    x = LAKE.x + (Math.random() * 2 - 1) * LAKE.rx;
    z = LAKE.z + (Math.random() * 2 - 1) * LAKE.rz;
  } while (((x - LAKE.x) / LAKE.rx) ** 2 + ((z - LAKE.z) / LAKE.rz) ** 2 > 0.92);
  const f = floorY(x, z);
  snowPos[i * 3] = x;
  snowPos[i * 3 + 1] = f + 0.3 + Math.random() * Math.max(0.3, LAKE.level - 0.5 - f);
  snowPos[i * 3 + 2] = z;
  snowSeed[i] = Math.random() * 100;
}
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowMat = new THREE.PointsMaterial({
  size: 0.055, map: new THREE.CanvasTexture(dropCanvas), transparent: true,
  opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xa8dceb,
});
const snow = new THREE.Points(snowGeo, snowMat);
snow.frustumCulled = false;
scene.add(snow);
function stepSnow(dt: number, t: number): void {
  for (let i = 0; i < SNOW; i++) {
    const s = snowSeed[i];
    snowPos[i * 3] += Math.sin(t * 0.4 + s) * 0.06 * dt;
    snowPos[i * 3 + 1] -= (0.03 + (s % 1) * 0.05) * dt; // lazy sink
    snowPos[i * 3 + 2] += Math.cos(t * 0.33 + s * 1.7) * 0.06 * dt;
    if (snowPos[i * 3 + 1] < floorY(snowPos[i * 3], snowPos[i * 3 + 2]) + 0.15) {
      snowPos[i * 3 + 1] = LAKE.level - 0.3 - Math.random() * 0.8; // recycle near the top
    }
  }
  snowGeo.attributes.position.needsUpdate = true;
}

// -------------------------------------------------------------- bubbles ----
// The orb breathes underwater: a steady dribble of bubbles that rises,
// wobbles, and RINGS THE SURFACE where it pops — sim and render closing the
// loop again. Emission scales with effort (speed / swim-up), bursts on entry.
const BUBS = 140;
const bubPos = new Float32Array(BUBS * 3).fill(-999);
const bubLife = new Float32Array(BUBS);
const bubSeed = new Float32Array(BUBS);
let bubHead = 0;
let bubAcc = 0;
const bubGeo = new THREE.BufferGeometry();
bubGeo.setAttribute('position', new THREE.BufferAttribute(bubPos, 3));
const bubbles = new THREE.Points(
  bubGeo,
  new THREE.PointsMaterial({
    size: 0.07, map: new THREE.CanvasTexture(dropCanvas), transparent: true,
    opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xcfeaff,
  }),
);
bubbles.frustumCulled = false;
scene.add(bubbles);
function emitBubbles(x: number, y: number, z: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const idx = bubHead;
    bubHead = (bubHead + 1) % BUBS;
    bubPos[idx * 3] = x + (Math.random() - 0.5) * 0.5;
    bubPos[idx * 3 + 1] = y + (Math.random() - 0.5) * 0.4;
    bubPos[idx * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
    bubLife[idx] = 6; // plenty — they die at the surface, not by timer
    bubSeed[idx] = Math.random() * 100;
  }
}
function stepBubbles(dt: number, t: number): void {
  for (let i = 0; i < BUBS; i++) {
    if (bubLife[i] <= 0) continue;
    bubLife[i] -= dt;
    bubPos[i * 3] += Math.sin(t * 3.1 + bubSeed[i]) * 0.25 * dt;
    bubPos[i * 3 + 1] += (0.7 + (bubSeed[i] % 1) * 0.5) * dt;
    bubPos[i * 3 + 2] += Math.cos(t * 2.7 + bubSeed[i] * 1.3) * 0.25 * dt;
    const x = bubPos[i * 3]; const y = bubPos[i * 3 + 1]; const z = bubPos[i * 3 + 2];
    for (const s of sims) {
      if (y >= s.level && s.contains(x, z)) {
        s.impulse(x, z, -0.012, 0.22); // pop: a pin-prick ring
        bubLife[i] = 0;
        bubPos[i * 3 + 1] = -999;
      }
    }
    if (bubLife[i] <= 0) bubPos[i * 3 + 1] = -999;
  }
  bubGeo.attributes.position.needsUpdate = true;
}

// ------------------------------------------------------------- controls ----
let yaw = -0.6;
let pitch = -0.25;
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
let dragging = false;
let lx = 0; let ly = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (stick.active && e.pointerId === stick.id) return;
  dragging = true; lx = e.clientX; ly = e.clientY;
});
addEventListener('pointerup', () => (dragging = false));
addEventListener('pointermove', (e) => {
  if (!dragging || (stick.active && e.pointerId === stick.id)) return;
  yaw -= (e.clientX - lx) * 0.0042;
  pitch = Math.max(-1.35, Math.min(1.35, pitch - (e.clientY - ly) * 0.0042));
  lx = e.clientX; ly = e.clientY;
});
// Left-half virtual stick (phone move).
const stick = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.clientX < innerWidth * 0.38 && !stick.active) {
    stick.active = true; stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY;
    dragging = false;
  }
});
addEventListener('pointermove', (e) => {
  if (stick.active && e.pointerId === stick.id) {
    stick.dx = Math.max(-1, Math.min(1, (e.clientX - stick.ox) / 60));
    stick.dy = Math.max(-1, Math.min(1, (e.clientY - stick.oy) / 60));
  }
});
addEventListener('pointerup', (e) => {
  if (e.pointerId === stick.id) { stick.active = false; stick.dx = stick.dy = 0; }
});

// ---------------------------------------------------------------- HUD ------
const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:8px;left:8px;z-index:10;color:#9fd6ff;font:12px/1.6 ui-monospace,Menlo,monospace;' +
  'background:#05080cd9;padding:8px 10px;border-radius:8px;border:1px solid #1c2c3c;white-space:pre;';
document.body.appendChild(hud);
const mkBtn = (label: string, right: number, bottom: number): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    `position:fixed;right:${right}px;bottom:${bottom}px;z-index:10;width:74px;height:56px;border-radius:12px;` +
    'background:#0d1622cc;border:1px solid #2a3c52;color:#9fd6ff;font:14px ui-monospace,monospace;touch-action:manipulation;';
  document.body.appendChild(b);
  return b;
};
const swimBtn = mkBtn('▲ swim', 10, 84);
const dashBtn = mkBtn('⇢ dash', 10, 12);
let swimHeld = false;
swimBtn.addEventListener('pointerdown', () => (swimHeld = true));
addEventListener('pointerup', () => (swimHeld = false));
let dashQueued = false;
dashBtn.addEventListener('pointerdown', () => (dashQueued = true));
// Underwater lens: full-screen teal vignette that fades in when the camera
// submerges — the instant "your EYES are in the water now" read the fog swap
// alone never delivered. DOM overlay = zero render cost.
const uwLens = document.createElement('div');
uwLens.style.cssText =
  'position:fixed;inset:0;z-index:4;pointer-events:none;opacity:0;transition:opacity .3s;' +
  'background:radial-gradient(ellipse at 50% 56%, rgba(16,74,96,0.10) 38%, rgba(5,34,48,0.5) 100%);';
document.body.appendChild(uwLens);

const breathBtn = mkBtn('breath\noff', 92, 12);
breathBtn.addEventListener('click', () => {
  const on = !sims[0].breath;
  for (const s of sims) s.breath = on;
  breathBtn.textContent = on ? 'breath\nON' : 'breath\noff';
});
// Tap the water (two-finger tap or T key aim) → splash where you look.
const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('dblclick', (e) => splashAt(e.clientX, e.clientY));
function splashAt(cx: number, cy: number): void {
  raycaster.setFromCamera(
    new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1), camera);
  for (const s of sims) {
    const t = (s.level - raycaster.ray.origin.y) / raycaster.ray.direction.y;
    if (t > 0) {
      const px = raycaster.ray.origin.x + raycaster.ray.direction.x * t;
      const pz = raycaster.ray.origin.z + raycaster.ray.direction.z * t;
      if (s.contains(px, pz)) {
        s.impulse(px, pz, -0.9, 1.1);
        burst(px, s.level, pz, 0.45);
      }
    }
  }
}

// ---------------------------------------------------------------- frame ----
const clock = new THREE.Clock();
let simMs = 0;
const CAM_BOOM_MAX = 7;
let camBoom = CAM_BOOM_MAX;
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());

  // --- orb movement (fly above water; dense diver below) ---
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const rgt = new THREE.Vector3(-fwd.z, 0, fwd.x);
  let mx = stick.dx; let mz = -stick.dy;
  if (keys.has('KeyW')) mz += 1;
  if (keys.has('KeyS')) mz -= 1;
  if (keys.has('KeyD')) mx += 1;
  if (keys.has('KeyA')) mx -= 1;
  const inWater = sims.find((s) => s.contains(orbPos.x, orbPos.z) && orbPos.y < s.heightAt(orbPos.x, orbPos.z));
  const accel = inWater ? 14 : 26;
  orbVel.addScaledVector(fwd, mz * accel * dt);
  orbVel.addScaledVector(rgt, mx * accel * dt);
  if (dashQueued || keys.has('ShiftLeft')) {
    dashQueued = false;
    orbVel.addScaledVector(new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)), 16);
    keys.delete('ShiftLeft');
  }
  if (inWater) {
    // DENSE but not a stone (John): a slow drifting settle with a terminal
    // sink speed — you never plummet, but you never float either.
    orbVel.y -= 1.7 * dt; // gravity minus near-neutral buoyancy
    if (swimHeld || keys.has('Space')) orbVel.y += 10.5 * dt;
    orbVel.multiplyScalar(Math.max(0, 1 - 2.2 * dt));
    if (orbVel.y < -1.1) orbVel.y = -1.1; // terminal sink: a settle, not a drop
    // Wake + churn while moving near the surface.
    const s = inWater;
    if (orbPos.y > s.level - 1.2) s.wake(orbPos.x, orbPos.z, orbVel.x, orbVel.z, dt);
    // TWO-WAY COUPLING — the water moves YOU. Waves are a surface
    // phenomenon, so all three forces fade exponentially with depth; a deep
    // diver feels nothing, a body at the surface is owned by the swell.
    const surfH = s.heightAt(orbPos.x, orbPos.z);
    const near = Math.exp(-Math.max(0, surfH - orbPos.y) * 0.75);
    // Heave: a crest overhead is extra water column = extra lift; a trough
    // drops you. This is what makes a passing ring BOB the orb.
    orbVel.y += (surfH - s.level) * 6.0 * near * dt;
    // Ride: drag-couple to the surface's own vertical motion — the swell
    // carries what floats in it (also reads as faint surface tension).
    // Clamped: raw v spikes ±14 m/s at a fresh impulse and would yank the orb.
    const vs = THREE.MathUtils.clamp(s.surfaceVelAt(orbPos.x, orbPos.z), -2.5, 2.5);
    orbVel.y += (vs - orbVel.y) * Math.min(1, 2.0 * dt) * near;
    // Shove: crests push downhill (F ≈ −g·∇h) — a ring arriving from your
    // splash, a wake, or a neighbour shoulders you along its travel.
    s.slopeAt(orbPos.x, orbPos.z, slopeTmp);
    orbVel.x -= slopeTmp.x * 22 * near * dt;
    orbVel.z -= slopeTmp.z * 22 * near * dt;
  } else {
    orbVel.y -= 16 * dt; // airborne: real gravity
    if (swimHeld || keys.has('Space')) orbVel.y += 24 * dt; // hover-glide assist
    orbVel.multiplyScalar(Math.max(0, 1 - 1.1 * dt));
  }
  orbPos.addScaledVector(orbVel, dt);
  const ground = floorY(orbPos.x, orbPos.z) + 0.45;
  if (orbPos.y < ground) { orbPos.y = ground; if (orbVel.y < 0) orbVel.y = 0; }

  // --- surface crossing: momentum splash both ways ---
  const surf = sims.find((s) => s.contains(orbPos.x, orbPos.z));
  if (surf) {
    const under = orbPos.y < surf.heightAt(orbPos.x, orbPos.z);
    if (under !== wasUnder) {
      const vigor = surf.splashEntry(orbPos.x, orbPos.z, orbVel.length());
      burst(orbPos.x, surf.level, orbPos.z, vigor, orbVel.x, orbVel.z);
      if (under) emitBubbles(orbPos.x, orbPos.y, orbPos.z, Math.floor(8 + vigor * 24));
    }
    wasUnder = under;
  } else wasUnder = false;

  orb.position.copy(orbPos);
  orbLightPos.copy(orbPos);
  // In the medium the AURA blooms — the core stays black; the water gets the
  // light. The point light reaches further so kelp and bed pick it up.
  const auraMat = orbAura.material as THREE.SpriteMaterial;
  if (inWater) {
    orbAura.scale.setScalar(THREE.MathUtils.lerp(orbAura.scale.x, 6.5, 0.08));
    auraMat.opacity = THREE.MathUtils.lerp(auraMat.opacity, 0.75, 0.08);
    orbLight.intensity = THREE.MathUtils.lerp(orbLight.intensity, 18, 0.08);
  } else {
    orbAura.scale.setScalar(THREE.MathUtils.lerp(orbAura.scale.x, 3.2, 0.1));
    auraMat.opacity = THREE.MathUtils.lerp(auraMat.opacity, 0.5, 0.1);
    orbLight.intensity = THREE.MathUtils.lerp(orbLight.intensity, 8, 0.1);
  }
  stepTrail(dt, orbVel.length());

  // Bubble emission scales with effort — swimming hard = working = breathing.
  if (inWater && orbPos.y < (inWater.level - 0.3)) {
    bubAcc += dt * (1.5 + orbVel.length() * 1.2 + (swimHeld || keys.has('Space') ? 5 : 0));
    while (bubAcc >= 1) { bubAcc -= 1; emitBubbles(orbPos.x, orbPos.y + 0.3, orbPos.z, 1); }
  }

  // --- sims ---
  const t0 = performance.now();
  for (const s of sims) s.update(dt);
  simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
  stepDrops(dt);
  stepSnow(dt, clock.elapsedTime);
  stepBubbles(dt, clock.elapsedTime);

  // --- camera chases the orb, colliding instead of clipping ---
  const camDir = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch), Math.sin(-pitch) + 0.25, Math.cos(yaw) * Math.cos(pitch),
  ).normalize();
  // Walk the boom out from the orb and stop short of terrain (banks, bed).
  let boomHit = CAM_BOOM_MAX;
  for (let d = 0.6; d <= CAM_BOOM_MAX; d += 0.3) {
    const px = orbPos.x + camDir.x * d;
    const py = orbPos.y + camDir.y * d;
    const pz = orbPos.z + camDir.z * d;
    if (py < floorY(px, pz) + 0.45) { boomHit = Math.max(0.6, d - 0.3); break; }
  }
  // Snap IN fast (never inside a wall), ease back OUT so it doesn't pump.
  camBoom = THREE.MathUtils.lerp(camBoom, boomHit, boomHit < camBoom ? 0.6 : 0.05);
  camera.position.copy(orbPos).addScaledVector(camDir, camBoom);
  camera.position.y = Math.max(camera.position.y, floorY(camera.position.x, camera.position.z) + 0.4);
  // Never let the eye straddle the surface plane — that's the flicker zone.
  for (const s of sims) {
    if (!s.contains(camera.position.x, camera.position.z)) continue;
    const gap = camera.position.y - s.level;
    if (Math.abs(gap) < 0.22) {
      camera.position.y = s.level + 0.22 * (orbPos.y < s.level ? -1 : 1);
    }
  }
  const camUnder = sims.find((s) => s.contains(camera.position.x, camera.position.z) &&
    camera.position.y < s.level);
  if (camUnder) {
    // Buoyant sway: the eye is suspended in the medium, never rigidly parked.
    const t = clock.elapsedTime;
    camera.position.x += Math.sin(t * 0.9) * 0.06;
    camera.position.y += Math.sin(t * 1.35 + 2.0) * 0.05;
    camera.position.z += Math.cos(t * 0.75 + 1.1) * 0.06;
  }
  camera.lookAt(orbPos);
  // Refraction widens the view a touch — classic underwater FOV shift.
  const fovTarget = camUnder ? 70 : 64;
  if (Math.abs(camera.fov - fovTarget) > 0.05) {
    camera.fov = THREE.MathUtils.lerp(camera.fov, fovTarget, 0.07);
    camera.updateProjectionMatrix();
  }
  uwLens.style.opacity = camUnder ? '1' : '0';
  snowMat.opacity = THREE.MathUtils.lerp(snowMat.opacity, camUnder ? 0.55 : 0.2, 0.06);
  // Underwater is a BLUE VOLUME you can see through, not a black room: bright
  // teal fog at moderate density + the same tint on the sky = submerged.
  scene.fog = camUnder ? new THREE.FogExp2(0x0a3346, 0.055) : new THREE.FogExp2(0x020205, 0.012);
  (scene.background as THREE.Color).set(camUnder ? 0x0a3346 : 0x020205);

  for (const m of waterMats) m.uniforms.uTime.value = clock.elapsedTime;

  // Fireflies drift — tiny figure-eights, each on its own clock.
  for (let i = 0; i < fireflyBase.length; i++) {
    const b = fireflyBase[i];
    const t = clock.elapsedTime * (0.4 + (i % 5) * 0.12) + i * 2.4;
    flyPos[i * 3] = b.x + Math.sin(t) * 0.8;
    flyPos[i * 3 + 1] = b.y + Math.sin(t * 1.7) * 0.35;
    flyPos[i * 3 + 2] = b.z + Math.cos(t * 0.8) * 0.8;
  }
  flyGeo.attributes.position.needsUpdate = true;

  // --- reflections: one mirrored render per frame, two personalities ---
  // Above water: the world reflects INTO the surface. Underwater: the
  // underwater scene reflects BACK DOWN (total internal reflection).
  let reflIdx = -1;
  let reflBelow = false;
  if (camUnder) {
    reflIdx = sims.indexOf(camUnder);
    reflBelow = true;
    reflector.render(renderer, scene, camera, camUnder.level, [...waterMeshes, drops], true);
  } else {
    reflIdx = pondSim.contains(camera.position.x, camera.position.z) ? 1 : 0;
    const s = sims[reflIdx];
    if (camera.position.y > s.level + 0.2) {
      reflector.render(renderer, scene, camera, s.level, [...waterMeshes, drops]);
    } else reflIdx = -1;
  }
  waterMats.forEach((m, i) => {
    m.uniforms.uReflOn.value = i === reflIdx ? 1 : 0;
    m.uniforms.uReflBelow.value = reflBelow ? 1 : 0;
  });

  hud.textContent =
    `waterlab v1.4 — lake+pond · 2-way coupling\n` +
    `sim ${simMs.toFixed(2)}ms  fps ${(1 / Math.max(dt, 1e-3)).toFixed(0)}` +
    `  ${inWater ? (orbPos.y < (surf?.level ?? 0) - 0.6 ? 'DIVING' : 'in water') : 'airborne'}\n` +
    `WASD/stick move · drag look · Space/▲ swim up · Shift/⇢ dash · dbl-tap water = splash`;

  composer.render();
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
frame();
