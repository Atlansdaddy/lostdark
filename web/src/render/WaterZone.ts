/**
 * WaterZone — the NW testbed pool (one long 72×12 lane).
 *
 * Dark-game water (John's rule): the surface is BLACK until a light is near —
 * the orb, a charged grove, a ward, any live source. What survives in the dark
 * is a REFLECTIVE EDGE only: a grazing-angle fresnel rim + a whisper of moon
 * glint, so the pool reads as a surface without ever glowing on its own.
 *
 *   • PHYSICAL WAVES — layered directional sines displace the mesh; analytic
 *     normals so light glints ride the crests.
 *   • LIGHT-GATED BODY — the water's volume colour appears only inside a light's
 *     falloff (diffuse), and each light draws a sharp mirror streak (specular).
 *   • RIM FOAM — a shore band that shimmers, its brightness gated by the same
 *     nearby light so it dies with the dark.
 *   • DROPLETS — mist/splash points; the echo pulse and force-wave burst spray.
 *   • FISH — a small school swims Lissajous laps under the surface. Their
 *     material runs the same pulse-reveal patch as the flora, so the pulse
 *     paints them and the orb's bubble lights them; otherwise they're shadows.
 *
 * All per-frame state arrives through update(); this module owns no game state.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { logger } from '../core/log';
import type { Pool } from '../world/Testbeds';

const log = logger('water');

const MAX_LIGHTS = 8; // orb + nearby charged flora / wards mirrored on the surface

export interface WaterFrame {
  t: number;
  orbPos: THREE.Vector3;
  orbColor: THREE.Color;
  orbIntensity: number;
  pulseCenter: THREE.Vector3;
  pulseRadius: number; // <0 when no pulse
  pulseIntensity: number;
  pulseThickness: number;
  moonDir: THREE.Vector3;
  moonI: number;
  /** Live lights the surface answers to (world pos/color/intensity). */
  lights: { pos: THREE.Vector3; color: THREE.Color; intensity: number }[];
  /** Quality tier: 0 = full, 1+ = trimmed (fewer droplets). */
  tier: number;
}

/** One spine bone enlisted in the procedural swim wave. */
interface BoneWag {
  bone: THREE.Bone;
  /** Bind-pose local rotation the wave multiplies onto. */
  base: THREE.Quaternion;
  /** Bone-local axis that maps to world-up — sway around it = lateral tail sweep. */
  axis: THREE.Vector3;
  /** 0 at the nose → 1 at the tail; drives amplitude + phase lag. */
  zn: number;
}

/** A fish is a CHEAP steering agent (~30 flops/frame): velocity + a handful of
 *  accelerations (wander, shore containment, separation, orb-fright). No
 *  pathing, no allocations — so the school can grow without costing anything. */
interface Fish {
  mesh: THREE.Object3D;
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  /** Cruise speed (world units/s); fright multiplies it. */
  speed: number;
  /** Personal phase — de-syncs wander/bob/tail across the school. */
  phase: number;
  /** Tail-wave base frequency. */
  wig: number;
  /** Throttle for the surface-wake impulses this fish feeds the wave sim. */
  wakeT: number;
  /** 1 right after a fright, easing back to 0 — drives burst speed + diving. */
  scare: number;
  /** Eased facing (radians) — the body turns toward its velocity at a limited
   *  rate so it banks like a fish instead of snapping (kills the twitch). */
  heading: number;
  /** Rigged spine (GLB fish) — undefined on the procedural placeholders. */
  bones?: BoneWag[];
  /** Inner GLB clone, for flipFish() if a model's nose points the wrong way. */
  model?: THREE.Object3D;
  /** Draw-cost rank for quality-tier culling (0 = cheapest, keep longest). */
  rank: number;
}

export class WaterZone {
  readonly group = new THREE.Group();
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly pools: Pool[];
  private readonly fish: Fish[] = [];
  private readonly patchMat?: (m: THREE.MeshStandardMaterial) => void;
  /** Placeholder school assets, disposed once the GLB fish arrive. */
  private protoGeo: THREE.BufferGeometry | null = null;
  private protoMat: THREE.MeshStandardMaterial | null = null;
  private readonly tmpQ = new THREE.Quaternion();
  private lastPulseR = -1;
  /** Shader clock from the last update() — used to derive a stable dt. */
  private lastT = 0;

  // --- Surface wave SIMULATION (ported from wave_destruction_2d/water.py):
  // the classic heightfield wave equation on the lake's own depth grid —
  //   v += c²∇²u · damping;  u += v
  // Land cells hold u = 0, so waves REFLECT off the real shoreline. The lake
  // is glass-still until an impulse touches it (splash, wake, force wave,
  // fish); ~2k cells, a few adds each — it costs next to nothing.
  private simW = 0;
  private simD = 0;
  private u!: Float32Array;
  private v!: Float32Array;
  private wet!: Uint8Array;
  /** Half-float staging for the GPU upload (iOS-safe linear filtering). */
  private waveHalf!: Uint16Array<ArrayBuffer>;
  private waveTex!: THREE.DataTexture;
  private simAcc = 0;

  // Droplet/mist pool (shared across all pools).
  private readonly DROP_MAX = 420;
  private readonly dropPos: Float32Array;
  private readonly dropCol: Float32Array;
  private readonly dropVel: Float32Array;
  private readonly dropLife: Float32Array;
  private dropHead = 0;
  private readonly dropGeo: THREE.BufferGeometry;

  constructor(
    pools: Pool[],
    moteTexture: THREE.Texture,
    /** Material patch applied to the fish (main.ts passes the flora pulse-reveal). */
    patchMat?: (m: THREE.MeshStandardMaterial) => void,
  ) {
    this.pools = pools;

    const baseUniforms = () => ({
      uTime: { value: 0 },
      uHalf: { value: new THREE.Vector2(1, 1) },
      // The live wave-sim heightfield (R16F) + its texel size and world scale.
      uWave: { value: null as THREE.Texture | null },
      uWaveTexel: { value: new THREE.Vector2(1, 1) },
      uWaveAmp: { value: 0.42 },
      // Per-column water depth over the bbox (R8): 0 = land, 1 = deepest.
      uDepth: { value: null as THREE.Texture | null },
      uPulseCenter: { value: new THREE.Vector3() },
      uPulseRadius: { value: -1 },
      uPulseThick: { value: 4.5 },
      uPulseI: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0.3, 0.7, 0.2).normalize() },
      uMoonI: { value: 0 },
      uDeep: { value: new THREE.Color(0x02141f) },
      uShallow: { value: new THREE.Color(0x0d4f63) },
      uFoam: { value: new THREE.Color(0x9fe8ff) },
      uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
      uLightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color()) },
      uLightI: { value: new Float32Array(MAX_LIGHTS) },
      uLightCount: { value: 0 },
      // Shared light-volume atlas (wired by wireLightVolume — the SAME uniform
      // objects the terrain/flora/grass use). Alpha = world solidity; every
      // light term shadow-marches it so no glow crosses solid ground.
      uLightAtlas: { value: null as THREE.Texture | null },
      uLightMin: { value: new THREE.Vector3(-128, -14, -128) },
      uLightStep: { value: 2 },
      uLightDim: { value: new THREE.Vector3(1, 1, 1) },
      uLightTiles: { value: new THREE.Vector2(1, 1) },
    });

    const vertexShader = /* glsl */ `
      uniform sampler2D uWave;   // the LIVE wave-equation heightfield (CPU sim)
      uniform vec2 uWaveTexel;
      uniform float uWaveAmp;
      uniform vec2 uHalf;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vLocal; // plane-local XZ (−half..half)

      // NO ambient waves: the surface is glass-still except where the sim was
      // disturbed (splash-in, swim wake, force wave, fish). Height + normal
      // both come from the simulated field, so ripples propagate, interfere
      // and reflect off the real shoreline — the 2D sandbox's water, in 3D.
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec2 wuv = position.xz / (2.0 * uHalf) + 0.5;
        float h  = texture2D(uWave, wuv).r;
        float hx = texture2D(uWave, wuv + vec2(uWaveTexel.x, 0.0)).r
                 - texture2D(uWave, wuv - vec2(uWaveTexel.x, 0.0)).r;
        float hz = texture2D(uWave, wuv + vec2(0.0, uWaveTexel.y)).r
                 - texture2D(uWave, wuv - vec2(0.0, uWaveTexel.y)).r;
        wp.y += h * uWaveAmp;
        vNormal = normalize(vec3(-hx * uWaveAmp * 1.6, 1.0, -hz * uWaveAmp * 1.6));
        vWorld = wp.xyz;
        vLocal = position.xz; // plane is built centered, so this is −half..half
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;

    const fragmentShader = /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vLocal;
      uniform float uTime;
      uniform vec2 uHalf;
      uniform vec3 uPulseCenter; uniform float uPulseRadius; uniform float uPulseThick; uniform float uPulseI;
      uniform vec3 uMoonDir; uniform float uMoonI;
      uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam;
      uniform sampler2D uDepth;
      uniform vec3 uLightPos[${MAX_LIGHTS}];
      uniform vec3 uLightColor[${MAX_LIGHTS}];
      uniform float uLightI[${MAX_LIGHTS}];
      uniform int uLightCount;
      uniform sampler2D uLightAtlas;
      uniform vec3 uLightMin;
      uniform float uLightStep;
      uniform vec3 uLightDim;
      uniform vec2 uLightTiles;

      // World solidity from the shared light-volume atlas (alpha) — the same
      // data every other surface in the game shadow-marches against.
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
      // A wall of land between the water surface and a light blocks it — kills
      // the unoccluded radius discs the orb/crystal/wards drew on the water.
      // Jittered sample offsets — same anti-ring treatment as litMaterial
      // (fixed-step binary marches paint concentric rings around any light
      // near solid voxels). Reach unchanged: walls are 1 voxel thick, so the
      // march must sample right up to the light or it leaks through them.
      float marchJitter(vec3 p) {
        return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      }
      // Continuous transmittance march (matches litMaterial): binary hit tests
      // made the jitter read as grain at light-pool edges; smooth accumulated
      // occlusion doesn't.
      float ptShadow(vec3 p, vec3 lp) {
        vec3 d = lp - p;
        float dist = length(d);
        if (dist < 1.5) return 1.0;
        vec3 dir = d / dist;
        float march = min(dist - 1.0, 12.0);
        float j = marchJitter(p);
        float trans = 1.0;
        for (int i = 1; i <= 12; i++) {
          float s = float(i) + j;
          if (s >= march) break;
          trans *= 1.0 - smoothstep(0.25, 0.75, sampleSolid(p + dir * s));
          if (trans < 0.03) return 0.0;
        }
        return trans;
      }

      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorld);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        // Fresnel (Schlick) — grazing angles turn mirror-bright.
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);

        // DARK UNTIL LIT: everything below accumulates from the live lights.
        vec3 col = vec3(0.0);
        float litNear = 0.0; // how much light actually reaches this fragment

        // Plain Lambert, NOT half-wrap: wrap lit the whole sheet evenly and read
        // as a volumetric glow slab. Lambert on the wave normals means light
        // lives on the crests facing the source and dies across the surface —
        // it reads as a thin lit SKIN over dark water.
        // REAL depth read: the lakebed's carved bowl tints the body — bright
        // shallows over the shelf, falling to the deep colour over the middle.
        float wdepth = texture2D(uDepth, vLocal / (2.0 * uHalf) + 0.5).r; // 0 = land
        vec3 body = mix(uShallow, uDeep, smoothstep(0.05, 0.8, wdepth));
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= uLightCount) break;
          vec3 toL = uLightPos[i] - vWorld;
          float d = length(toL);
          vec3 L = toL / max(d, 1e-4);
          float atten = 1.0 - clamp(d / 17.0, 0.0, 1.0);
          atten *= atten;
          // The broad volumetric soak reaches past the direct term, so the
          // occlusion test must run for any light within ITS reach too.
          if (atten < 0.001 && d > 32.0) continue;
          // Unified law: NO light crosses solid ground. One march gates the
          // direct skin light AND the volumetric soak below.
          if (ptShadow(vWorld + vec3(0.0, 0.35, 0.0), uLightPos[i]) < 0.5) continue;
          float diff = clamp(dot(N, L), 0.0, 1.0);
          float spec = pow(clamp(dot(R, L), 0.0, 1.0), 240.0); // tight mirror streak
          vec3 c = uLightColor[i] * uLightI[i] * atten;
          col += body * diff * c * 0.4;                  // lit water skin
          col += c * spec * (1.0 + 3.0 * fres) * 2.4;    // reflection of the light itself
          litNear += uLightI[i] * atten * diff;

          // VOLUMETRIC DIFFUSION: a small body of water is one translucent
          // MASS — a light close to (or IN) it soaks the whole pool, and thin
          // water transmits more, so the shallow EDGES catch light first and
          // brightest. This is what makes the pool visibly answer your
          // approach instead of staying a black sheet.
          float vol = 1.0 - clamp(d / 32.0, 0.0, 1.0); // broad reach — the whole body
          vol *= vol;
          float thin = 1.0 - smoothstep(0.05, 0.85, wdepth); // shallow = translucent
          // Submerged light (the orb diving in) lights the volume from inside.
          float inside = 1.0 + 0.9 * (1.0 - smoothstep(-0.2, 1.4, uLightPos[i].y - vWorld.y));
          col += (uShallow * 0.6 + uLightColor[i] * 0.4) * uLightI[i] * vol * inside * (0.3 + 0.75 * thin);
          litNear += uLightI[i] * vol * 0.6; // the glow also wakes the shore foam
        }

        // THE REFLECTIVE EDGE that survives the dark: a whisper of fresnel rim
        // (so the surface reads as a surface) + the moon's mirror glint.
        col += vec3(0.035, 0.06, 0.09) * fres * (0.3 + min(litNear, 1.5));
        float moonSpec = pow(clamp(dot(R, normalize(uMoonDir)), 0.0, 1.0), 240.0);
        col += vec3(0.75, 0.82, 1.0) * moonSpec * (0.15 + 2.2 * uMoonI) * fres;

        // Shore foam: hugs the REAL shoreline (the shallow shelf columns of the
        // carved bowl), shimmering — gated by nearby light like everything else.
        float band = (1.0 - smoothstep(0.03, 0.22, wdepth)) * step(0.004, wdepth);
        float shimmer = 0.6 + 0.4 * sin(uTime * 1.7 + vLocal.x * 2.3 + vLocal.y * 2.9);
        col += uFoam * band * shimmer * (0.015 + 0.3 * min(litNear, 1.2));

        // Pulse reveal — the echolocation shell sweeps a bright ring across it.
        if (uPulseI > 0.0 && uPulseRadius >= 0.0) {
          float pd = distance(vWorld, uPulseCenter);
          float ring = 1.0 - clamp(abs(pd - uPulseRadius) / uPulseThick, 0.0, 1.0);
          col += uFoam * ring * ring * uPulseI * 1.4;
        }

        // Alpha: mostly transparent body; grazing fresnel + foam solidify the
        // rim. Over LAND the sheet vanishes — the plane spans the bbox but the
        // water only exists where the bowl was carved.
        float alpha = clamp(0.34 + 0.5 * fres + band * 0.18, 0.0, 1.0);
        alpha *= smoothstep(0.002, 0.012, wdepth);

        // From BELOW (swimming under it) the sheet must not read as a glowing
        // wall — the underside is a dim, mostly-clear ceiling you look up through.
        if (!gl_FrontFacing) {
          col *= 0.25;
          alpha *= 0.4;
        }

        // Darkness is the draw distance (match terrain/flora).
        col *= exp(-distance(cameraPosition, vWorld) * 0.02);
        gl_FragColor = vec4(col, alpha);
      }
    `;

    // One wave-plane per pool (a single long lane today), sized per pool.
    for (const p of pools) {
      const mat = new THREE.ShaderMaterial({
        uniforms: baseUniforms(),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader,
        fragmentShader,
      });
      (mat.uniforms.uHalf.value as THREE.Vector2).set(p.halfX, p.halfZ);
      // The carved bowl's depth grid → an R8 texture (linear-filtered so the
      // shoreline reads smooth, not voxel-stepped).
      const depthTex = new THREE.DataTexture(p.depth, p.depthW, p.depthD, THREE.RedFormat, THREE.UnsignedByteType);
      depthTex.magFilter = THREE.LinearFilter;
      depthTex.minFilter = THREE.LinearFilter;
      depthTex.needsUpdate = true;
      mat.uniforms.uDepth.value = depthTex;
      this.mats.push(mat);
      const geo = new THREE.PlaneGeometry(p.halfX * 2, p.halfZ * 2, Math.min(96, p.halfX * 2), Math.min(32, p.halfZ * 2));
      geo.rotateX(-Math.PI / 2); // face up; local XZ spans ±half
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.cx, p.surfaceY, p.cz);
      mesh.renderOrder = 2; // draw after opaque terrain
      this.group.add(mesh);
    }

    // --- Wave sim buffers, on the FIRST pool's grid (the lake). Wet mask from
    // the carved depth grid: land cells are reflecting walls, like the 2D
    // sandbox's solid_mask. Half-float texture so LinearFilter is phone-safe.
    {
      const p0 = pools[0];
      this.simW = p0.depthW;
      this.simD = p0.depthD;
      const n = this.simW * this.simD;
      this.u = new Float32Array(n);
      this.v = new Float32Array(n);
      this.wet = new Uint8Array(n);
      for (let i = 0; i < n; i++) this.wet[i] = p0.depth[i] > 0 ? 1 : 0;
      this.waveHalf = new Uint16Array(n);
      this.waveTex = new THREE.DataTexture(
        this.waveHalf,
        this.simW,
        this.simD,
        THREE.RedFormat,
        THREE.HalfFloatType,
      );
      this.waveTex.magFilter = THREE.LinearFilter;
      this.waveTex.minFilter = THREE.LinearFilter;
      this.waveTex.needsUpdate = true;
      for (const mat of this.mats) {
        mat.uniforms.uWave.value = this.waveTex;
        (mat.uniforms.uWaveTexel.value as THREE.Vector2).set(1 / this.simW, 1 / this.simD);
      }
    }

    // --- Fish: a placeholder school of simple bodies, swimming from frame one.
    // The rigged GLB fish (loadFishModels) replace these the moment they load —
    // dark slate albedo either way: shadows in the black water until the orb's
    // bubble or a pulse reveals them (same organic reveal the flora get).
    this.patchMat = patchMat;
    this.protoGeo = new THREE.SphereGeometry(1, 10, 7);
    this.protoGeo.scale(0.09, 0.14, 0.3); // slim body, nose along +Z
    this.protoMat = new THREE.MeshStandardMaterial({ color: 0x2a3742, roughness: 0.35, metalness: 0.15 });
    patchMat?.(this.protoMat);
    for (const p of pools) {
      const count = Math.min(12, Math.max(6, Math.floor(p.halfX / 3)));
      for (let i = 0; i < count; i++) {
        const mesh = new THREE.Mesh(this.protoGeo, this.protoMat);
        mesh.scale.setScalar(0.8 + Math.random() * 0.7);
        this.addFish(p, mesh, i, 0.9 + Math.random() * 0.5);
      }
    }

    // Droplet/mist pool.
    this.dropPos = new Float32Array(this.DROP_MAX * 3).fill(-9999);
    this.dropCol = new Float32Array(this.DROP_MAX * 3);
    this.dropVel = new Float32Array(this.DROP_MAX * 3);
    this.dropLife = new Float32Array(this.DROP_MAX);
    this.dropGeo = new THREE.BufferGeometry();
    this.dropGeo.setAttribute('position', new THREE.BufferAttribute(this.dropPos, 3));
    this.dropGeo.setAttribute('color', new THREE.BufferAttribute(this.dropCol, 3));
    const dropPoints = new THREE.Points(
      this.dropGeo,
      new THREE.PointsMaterial({
        size: 0.12,
        map: moteTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    dropPoints.frustumCulled = false;
    dropPoints.layers.set(1); // effects layer — skipped by the depth prepass
    this.group.add(dropPoints);
  }

  /** Register a fish agent in pool `p`, spawned on a wet column mid-bowl. */
  private addFish(p: Pool, mesh: THREE.Object3D, rank: number, speedMul: number): Fish {
    let x = p.cx;
    let z = p.cz;
    for (let tries = 0; tries < 12; tries++) {
      const tx = p.cx + (Math.random() * 2 - 1) * p.halfX * 0.6;
      const tz = p.cz + (Math.random() * 2 - 1) * p.halfZ * 0.6;
      if (this.depthAt(p, tx, tz) > 0.35) {
        x = tx;
        z = tz;
        break;
      }
    }
    const ang = Math.random() * Math.PI * 2;
    const speed = (1.6 + Math.random() * 1.0) * speedMul;
    const f: Fish = {
      mesh,
      x,
      z,
      y: p.surfaceY - (1.2 + Math.random() * 1.4),
      vx: Math.cos(ang) * speed * 0.6,
      vz: Math.sin(ang) * speed * 0.6,
      speed,
      phase: Math.random() * Math.PI * 2,
      wig: 6 + Math.random() * 4,
      wakeT: Math.random(),
      scare: 0,
      heading: Math.atan2(Math.cos(ang), Math.sin(ang)),
      // Rigged clones carry their spine + inner model in userData (buildRigged).
      bones: mesh.userData.bones as BoneWag[] | undefined,
      model: mesh.userData.model as THREE.Object3D | undefined,
      rank,
    };
    mesh.userData.pool = p;
    this.fish.push(f);
    this.group.add(mesh);
    return f;
  }

  /** Normalized water depth (0 = land … 1 = deepest) at a world position. */
  private depthAt(p: Pool, x: number, z: number): number {
    const ix = Math.floor(x - (p.cx - p.halfX));
    const iz = Math.floor(z - (p.cz - p.halfZ));
    if (ix < 0 || iz < 0 || ix >= p.depthW || iz >= p.depthD) return 0;
    return p.depth[iz * p.depthW + ix] / 255;
  }

  // --- wave sim (wave_destruction_2d/water.py's update, in spirit) -----------

  /** One fixed step: v += c²∇²u (damped), then u += v. Land cells hold u = 0,
   *  so waves REFLECT off the real shoreline. ~2k cells — microseconds. */
  private stepWave(): void {
    const W = this.simW;
    const D = this.simD;
    const u = this.u;
    const v = this.v;
    const wet = this.wet;
    for (let z = 1; z < D - 1; z++) {
      const row = z * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        if (!wet[i]) continue;
        const lap = u[i - 1] + u[i + 1] + u[i - W] + u[i + W] - 4 * u[i];
        v[i] += 0.28 * lap;
        v[i] *= 0.988;
      }
    }
    for (let i = 0; i < u.length; i++) {
      if (!wet[i]) continue;
      u[i] += v[i];
      u[i] *= 0.999;
      if (u[i] > 1.4) u[i] = 1.4;
      else if (u[i] < -1.4) u[i] = -1.4;
    }
  }

  /** Drop a gaussian impulse into the heightfield at a world position. */
  private impulse(wx: number, wz: number, strength: number, radius = 2): void {
    const p = this.pools[0];
    if (!p) return;
    const cx = wx - (p.cx - p.halfX);
    const cz = wz - (p.cz - p.halfZ);
    const R = Math.ceil(radius);
    for (let dz = -R; dz <= R; dz++) {
      const iz = Math.round(cz + dz);
      if (iz <= 0 || iz >= this.simD - 1) continue;
      for (let dx = -R; dx <= R; dx++) {
        const ix = Math.round(cx + dx);
        if (ix <= 0 || ix >= this.simW - 1) continue;
        const i = iz * this.simW + ix;
        if (!this.wet[i]) continue;
        this.u[i] += strength * Math.exp(-(dx * dx + dz * dz) / (radius * radius * 0.7));
      }
    }
  }

  /**
   * Swap the placeholder school for John's rigged GLB fish.
   *
   * The models ship a UniRig skeleton but NO animation clips, so the swim is
   * driven procedurally through the bones: a traveling sine wave down the spine
   * (amplitude and phase-lag grow nose→tail), which reads as real tail
   * propulsion. Each clone goes through the dark-game material pass + the
   * caller's pulse-reveal patch so fish obey the black-until-lit rule.
   */
  async loadFishModels(bigUrl: string, littleUrl: string): Promise<void> {
    const loader = new GLTFLoader();
    const load = (url: string) =>
      new Promise<THREE.Group | null>((resolve) => {
        loader.load(
          url,
          (gltf) => resolve(gltf.scene),
          undefined,
          (err) => {
            log.warn(`failed to load ${url}`, err);
            resolve(null); // keep the placeholder school for this species
          },
        );
      });
    const [big, little] = await Promise.all([load(bigUrl), load(littleUrl)]);
    if (!big && !little) return; // both failed — placeholders stay

    // Retire the placeholder school.
    for (const f of this.fish) this.group.remove(f.mesh);
    this.fish.length = 0;
    this.protoGeo?.dispose();
    this.protoGeo = null;
    this.protoMat?.dispose();
    this.protoMat = null;

    // These are film-res meshes (255k / 80k tris) — the counts here are the
    // whole budget. rank orders tier-culling: big=1, littles 2… (0 = cheapest).
    const p = this.pools[0];
    if (big) {
      // The big fish patrols the deep middle of the bowl, slow and heavy, with a
      // brighter bioluminescent wash + side-lines than the school.
      const f = this.addFish(p, this.buildRigged(big, 2.6, new THREE.Color(0x74ffe6), 0.5), 1, 0.5);
      f.y = p.surfaceY - 3.0;
      f.wig = 3.5; // a big fish sweeps its tail slowly
    }
    if (little) {
      // Post-decimation (~9.6k tris each) the school can be a SCHOOL.
      const n = big ? 9 : 10;
      for (let i = 0; i < n; i++) {
        this.addFish(p, this.buildRigged(little, 1.1, new THREE.Color(0x46d8ff), 0.28), 2 + i, 1.15);
      }
    }
    log.info(`rigged fish in the water (${this.fish.length})`);
  }

  /** Clone + normalize one GLB fish: scale to `targetLen` (nose→tail along Z),
   *  recenter the pivot, run the dark-game material pass, and enlist its spine
   *  bones in the swim wave. */
  private buildRigged(src: THREE.Group, targetLen: number, glow: THREE.Color, bodyEmissive = 0): THREE.Object3D {
    // SkinnedMesh needs SkeletonUtils.clone — a plain .clone() shares/breaks rigs.
    const model = skeletonClone(src);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // The lap keeps fish inside the basin; a skinned mesh's auto-bounds lag the
      // bones, so skip the (mis-sized) frustum test rather than pay to fix it.
      mesh.frustumCulled = false;
      const skin = (m: THREE.MeshStandardMaterial) => {
        const dm = this.darkFishMat(m);
        // Phosphorescence PIXEL-FOR-PIXEL from the skin: the base texture drives an
        // emissive map (emissive tint white → true skin colours glow), so the
        // markings on the flanks light up on their own instead of a pasted-on bar.
        // Kept subtle; the big fish glows a touch brighter.
        if (dm.map) {
          dm.emissiveMap = dm.map;
          dm.emissive.setRGB(1, 1, 1);
        } else if (dm.emissive) {
          dm.emissive.copy(glow);
        }
        dm.emissiveIntensity = bodyEmissive;
        dm.needsUpdate = true;
        return dm;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => skin(m as THREE.MeshStandardMaterial))
        : skin(mesh.material as THREE.MeshStandardMaterial);
    });

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = targetLen / Math.max(size.z, 1e-4); // fish length runs along Z
    const holder = new THREE.Group();
    model.scale.setScalar(s);
    model.position.set(-center.x * s, -center.y * s, -center.z * s);
    holder.add(model);
    holder.userData.model = model; // for flipFish()

    // Enlist the spine: every bone, weighted by how far down the body it sits.
    holder.updateMatrixWorld(true);
    const bones: BoneWag[] = [];
    const seen = new Set<THREE.Bone>();
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    model.traverse((o) => {
      const sk = o as THREE.SkinnedMesh;
      if (!(sk as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
      for (const bone of sk.skeleton.bones) {
        if (seen.has(bone)) continue;
        seen.add(bone);
        bone.getWorldPosition(wp); // holder-local (holder isn't in the scene yet)
        const zn = THREE.MathUtils.clamp(0.5 - wp.z / targetLen, 0, 1); // nose 0 → tail 1
        bone.getWorldQuaternion(wq);
        const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(wq.invert()).normalize();
        bones.push({ bone, base: bone.quaternion.clone(), axis, zn });
      }
    });
    // Only hand over a REAL spine — an empty array is truthy and would route
    // an unrigged model into the bone-wave path with a dead (rigid) tail.
    holder.userData.bones = bones.length > 0 ? bones : undefined;
    return holder;
  }

  /** Dark-game pass for the imported fish materials (mirrors FloraAssets):
   *  matte dielectric, no self-glow, albedo deepened, plus the pulse-reveal. */
  private darkFishMat(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const m = src.clone();
    m.metalness = 0;
    m.roughness = Math.max(m.roughness ?? 1, 0.55); // wet skin keeps a little sheen
    m.envMapIntensity = 0;
    if (m.emissive) m.emissive.setRGB(0, 0, 0);
    m.emissiveIntensity = 0;
    if (m.color) {
      const lum = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
      if (lum > 0.5) m.color.multiplyScalar(0.5 / lum);
    }
    this.patchMat?.(m);
    return m;
  }

  /** Dev affordance: if the models' noses point the wrong way, spin them 180°
   *  (waiver.waterZone.flipFish() in the console). */
  flipFish(): void {
    for (const f of this.fish) {
      const model = f.mesh.userData.model as THREE.Object3D | undefined;
      if (model) model.rotation.y += Math.PI;
    }
  }

  /** Spray droplets over a pool (splash on pulse / force-wave, faint mist idle). */
  private emit(count: number, p: Pool, up: number): void {
    for (let i = 0; i < count; i++) {
      // Pick a WET column — the bbox includes shore land the mist must skip.
      const rx = (Math.random() * 2 - 1) * p.halfX;
      const rz = (Math.random() * 2 - 1) * p.halfZ;
      const ix = Math.floor(rx + p.halfX);
      const iz = Math.floor(rz + p.halfZ);
      if (p.depth[iz * p.depthW + ix] === 0) continue; // land — no water here
      const idx = this.dropHead;
      this.dropHead = (this.dropHead + 1) % this.DROP_MAX;
      this.dropPos[idx * 3] = p.cx + rx;
      this.dropPos[idx * 3 + 1] = p.surfaceY + 0.1;
      this.dropPos[idx * 3 + 2] = p.cz + rz;
      this.dropVel[idx * 3] = (Math.random() * 2 - 1) * 0.8;
      this.dropVel[idx * 3 + 1] = up * (0.5 + Math.random());
      this.dropVel[idx * 3 + 2] = (Math.random() * 2 - 1) * 0.8;
      this.dropLife[idx] = 0.6 + Math.random() * 0.7;
    }
  }

  /** Kick a physical impulse into the wave SIM at (x,z) — entering the water,
   *  swimming wakes, force waves. Strength ~0.2 (wake) … 1.5 (dive). The sim
   *  does the rest: propagation, interference, shoreline reflection. */
  disturb(x: number, z: number, strength = 1): void {
    this.impulse(x, z, strength * 0.9, strength > 0.8 ? 2.5 : 1.6);
  }

  /** Force-wave / external disturbance: burst spray from pools near center. */
  splash(center: THREE.Vector3): void {
    for (const p of this.pools) {
      const d = Math.hypot(p.cx - center.x, p.cz - center.z);
      if (d < p.halfX + 24) {
        this.emit(16, p, 4);
        this.disturb(center.x, center.z, 1.4);
      }
    }
  }

  /** Adopt the game's shared light-volume uniform OBJECTS (the same ones the
   *  terrain/flora/grass shaders hold) so the water shadow-marches the same
   *  world solidity — one lighting engine, no per-system light data. */
  wireLightVolume(shared: {
    uLightAtlas: THREE.IUniform;
    uLightMin: THREE.IUniform;
    uLightStep: THREE.IUniform;
    uLightDim: THREE.IUniform;
    uLightTiles: THREE.IUniform;
  }): void {
    for (const mat of this.mats) {
      mat.uniforms.uLightAtlas = shared.uLightAtlas;
      mat.uniforms.uLightMin = shared.uLightMin;
      mat.uniforms.uLightStep = shared.uLightStep;
      mat.uniforms.uLightDim = shared.uLightDim;
      mat.uniforms.uLightTiles = shared.uLightTiles;
    }
  }

  update(f: WaterFrame): void {
    const dt = Math.min(0.05, Math.max(0.001, f.t - this.lastT));
    this.lastT = f.t;

    // --- Wave sim: fixed 60 Hz steps, then upload the field (half-float). ---
    this.simAcc = Math.min(this.simAcc + dt, 4 / 60);
    while (this.simAcc >= 1 / 60) {
      this.simAcc -= 1 / 60;
      this.stepWave();
    }
    for (let i = 0; i < this.u.length; i++) {
      this.waveHalf[i] = THREE.DataUtils.toHalfFloat(this.u[i]);
    }
    this.waveTex.needsUpdate = true;

    for (const mat of this.mats) {
      const u = mat.uniforms;
      u.uTime.value = f.t;
      (u.uPulseCenter.value as THREE.Vector3).copy(f.pulseCenter);
      u.uPulseRadius.value = f.pulseRadius;
      u.uPulseThick.value = f.pulseThickness;
      u.uPulseI.value = f.pulseIntensity;
      (u.uMoonDir.value as THREE.Vector3).copy(f.moonDir);
      u.uMoonI.value = f.moonI;
      const lp = u.uLightPos.value as THREE.Vector3[];
      const lc = u.uLightColor.value as THREE.Color[];
      const li = u.uLightI.value as Float32Array;
      const n = Math.min(MAX_LIGHTS, f.lights.length);
      for (let i = 0; i < n; i++) {
        lp[i].copy(f.lights[i].pos);
        lc[i].copy(f.lights[i].color);
        li[i] = f.lights[i].intensity;
      }
      u.uLightCount.value = n;
    }

    // Fish: smooth Lissajous laps inside the basin; heading follows the path's
    // derivative. Placeholders wiggle the whole body; rigged fish swim for real —
    // a traveling sine wave down the spine (amplitude + phase lag grow toward
    // the tail = tail propulsion, not a rocking toy). Zero allocations.
    for (const fsh of this.fish) {
      // Film-res meshes: on lower quality tiers only the cheapest fish survive.
      fsh.mesh.visible = f.tier === 0 || fsh.rank <= (f.tier === 1 ? 3 : 2);
      if (!fsh.mesh.visible) continue;
      const p = fsh.mesh.userData.pool as Pool;

      // STEERING — wander swirl + shore containment + separation + orb-fright.
      // Slow, low-amplitude wander so cruising reads as a lazy glide, not a jitter.
      let ax = Math.cos(f.t * 0.22 + fsh.phase * 1.7) * 0.5;
      let az = Math.sin(f.t * 0.19 + fsh.phase) * 0.5;
      if (this.depthAt(p, fsh.x, fsh.z) < 0.3) {
        // Shallows ahead — bend back toward the deep middle.
        ax += (p.cx - fsh.x) * 0.15;
        az += (p.cz - fsh.z) * 0.15;
      }
      // The orb close by sends them darting away (and diving, below).
      const odx = fsh.x - f.orbPos.x;
      const odz = fsh.z - f.orbPos.z;
      const od2 = odx * odx + odz * odz;
      if (od2 < 42 && Math.abs(f.orbPos.y - fsh.y) < 7) {
        const od = Math.sqrt(od2) || 1e-3;
        ax += (odx / od) * 14;
        az += (odz / od) * 14;
        fsh.scare = 1;
      }
      fsh.scare = Math.max(0, fsh.scare - dt * 0.5);
      // Separation — the school is small, the n² is pocket change.
      for (const g of this.fish) {
        if (g === fsh) continue;
        const sx = fsh.x - g.x;
        const sz = fsh.z - g.z;
        const s2 = sx * sx + sz * sz;
        if (s2 < 2.2 && s2 > 1e-4) {
          const s = Math.sqrt(s2);
          ax += (sx / s) * 1.3; // gentler spacing — no panicky darting apart
          az += (sz / s) * 1.3;
        }
      }
      fsh.vx += ax * dt;
      fsh.vz += az * dt;
      // Speed band: never dead in the water, bursts when frightened.
      const vmax = fsh.speed * (1 + 2.4 * fsh.scare);
      const vmin = fsh.speed * 0.45;
      const sp = Math.hypot(fsh.vx, fsh.vz) || 1e-4;
      if (sp > vmax) {
        fsh.vx *= vmax / sp;
        fsh.vz *= vmax / sp;
      } else if (sp < vmin) {
        fsh.vx *= vmin / sp;
        fsh.vz *= vmin / sp;
      }
      // Advance — but never onto land; a blocked nose bounces off the shore.
      const nx = fsh.x + fsh.vx * dt;
      const nz = fsh.z + fsh.vz * dt;
      if (this.depthAt(p, nx, nz) > 0.08) {
        fsh.x = nx;
        fsh.z = nz;
      } else {
        fsh.vx *= -0.5;
        fsh.vz *= -0.5;
      }
      // Depth: cruise mid-water on a slow personal cycle; frightened fish
      // hug the bed. The bed rises at the shore, so clamp by LOCAL depth.
      const localDeep = this.depthAt(p, fsh.x, fsh.z) * p.maxDepth;
      const cruise = 0.9 + (0.5 + 0.5 * Math.sin(f.t * 0.13 + fsh.phase)) * Math.max(0.4, localDeep - 1.6);
      const yT = p.surfaceY - (fsh.scare > 0.4 ? Math.max(1.2, localDeep - 0.7) : cruise);
      fsh.y += (yT - fsh.y) * Math.min(1, 1.8 * dt);
      fsh.mesh.position.set(fsh.x, fsh.y, fsh.z);
      // Ease the facing toward the velocity at a LIMITED turn rate — a fish banks
      // through a turn, it doesn't snap. Slow when cruising, sharp when fleeing.
      const targetHeading = Math.atan2(fsh.vx, fsh.vz);
      let dh = targetHeading - fsh.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const maxTurn = (2.0 + fsh.scare * 7) * dt; // rad this frame
      if (dh > maxTurn) dh = maxTurn;
      else if (dh < -maxTurn) dh = -maxTurn;
      fsh.heading += dh;
      const bank = THREE.MathUtils.clamp((dh / Math.max(dt, 1e-3)) / 6, -0.5, 0.5); // lean in

      // Near-surface swimming FEEDS THE WAVE SIM — fish write their own wakes.
      fsh.wakeT -= dt;
      if (fsh.wakeT <= 0 && p.surfaceY - fsh.y < 1.1 && sp > 0.8) {
        fsh.wakeT = 0.3;
        this.impulse(fsh.x, fsh.z, 0.06 + sp * 0.03, 1.6);
      }

      if (fsh.bones) {
        fsh.mesh.rotation.y = fsh.heading;
        fsh.mesh.rotation.z = bank * 0.6 + Math.sin(f.t * fsh.wig * 0.4 + fsh.phase) * 0.05; // bank + faint roll
        // Tail wave — a steady gentle undulation at cruise; only a fright (or a
        // hard burst) speeds the kick. SKIP the bone work when far from the player.
        if (od2 < 34 * 34) {
          const wagF = fsh.wig * (0.5 + Math.min(sp, 3) * 0.16 + fsh.scare * 0.9);
          for (const b of fsh.bones) {
            const ang =
              Math.sin(f.t * wagF - b.zn * 3.2 + fsh.phase) * 0.4 * (0.12 + b.zn * b.zn);
            this.tmpQ.setFromAxisAngle(b.axis, ang);
            b.bone.quaternion.copy(b.base).multiply(this.tmpQ);
          }
        }
      } else {
        // Placeholder body: gentle whole-body undulation, no twitchy yaw wobble.
        fsh.mesh.rotation.y = fsh.heading;
        fsh.mesh.rotation.z = bank * 0.5 + Math.sin(f.t * fsh.wig * 0.5 + fsh.phase) * 0.06;
      }
    }

    // Idle mist (thinned on lower tiers) + splash when the pulse shell crosses.
    const mist = f.tier === 0 ? 1 : 0;
    for (const p of this.pools) {
      if (mist && Math.random() < 0.35) this.emit(mist, p, 0.6);
      const pr = f.pulseRadius;
      if (pr >= 0 && this.lastPulseR >= 0) {
        const dr = Math.hypot(p.cx - f.pulseCenter.x, p.cz - f.pulseCenter.z);
        if (this.lastPulseR < dr && pr >= dr) {
          this.emit(12, p, 3);
          this.impulse(p.cx, p.cz, 0.5, 3); // the wavefront stirs the water too
        }
      }
    }
    this.lastPulseR = f.pulseRadius;

    // Advance droplets (ballistic, gravity), colour = orb-light gated.
    for (let i = 0; i < this.DROP_MAX; i++) {
      if (this.dropLife[i] <= 0) continue;
      this.dropLife[i] -= dt;
      this.dropVel[i * 3 + 1] -= 9.0 * dt; // gravity
      this.dropPos[i * 3] += this.dropVel[i * 3] * dt;
      this.dropPos[i * 3 + 1] += this.dropVel[i * 3 + 1] * dt;
      this.dropPos[i * 3 + 2] += this.dropVel[i * 3 + 2] * dt;
      const l = Math.max(0, this.dropLife[i]);
      const dx = this.dropPos[i * 3] - f.orbPos.x;
      const dy = this.dropPos[i * 3 + 1] - f.orbPos.y;
      const dz = this.dropPos[i * 3 + 2] - f.orbPos.z;
      // Droplets are dust-rule particles: visible ONLY where light reaches them.
      const lit = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / 14);
      const b = lit * lit * l * 1.8;
      this.dropCol[i * 3] = (0.5 + 0.5 * f.orbColor.r) * b;
      this.dropCol[i * 3 + 1] = (0.7 + 0.3 * f.orbColor.g) * b;
      this.dropCol[i * 3 + 2] = (0.9 + 0.1 * f.orbColor.b) * b;
      if (this.dropLife[i] <= 0) this.dropPos[i * 3 + 1] = -9999;
    }
    this.dropGeo.attributes.position.needsUpdate = true;
    this.dropGeo.attributes.color.needsUpdate = true;
  }
}
