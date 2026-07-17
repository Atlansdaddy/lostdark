/**
 * WaterSim — the interaction layer for ALL of wAIver's water (waterlab v1).
 *
 * The classic heightfield wave equation (v += c²∇²u; u += v) on a per-body
 * grid, upgraded from the demo's WaterZone port:
 *   · finer cells (0.5 m default vs 1 m) — crisper rings, sharper splash detail
 *   · fixed-timestep accumulator so wave speed is framerate-independent
 *   · shore mask from the REAL basin floor: waves reflect off actual banks
 *   · churn field |v| exported alongside height — the renderer/spray systems
 *     read it for foam/droplets without a second pass
 *   · momentum-scaled entry impulses + directional drag wakes
 *   · optional "breath of wind": rare, drifting, near-imperceptible micro
 *     ripple patches (John judges glass-still vs breath by eye — HUD toggle)
 *
 * Design rule (John): calm is the identity. The surface is DEAD STILL until
 * something touches it; every ring must be traceable to a cause.
 */

import * as THREE from 'three';

export interface WaterSimOpts {
  /** World-space min corner (x,z) of the body's bounding rect. */
  minX: number;
  minZ: number;
  /** Rect size in metres. */
  sizeX: number;
  sizeZ: number;
  /** Water surface height (world y). */
  level: number;
  /** Grid cell size in metres (0.5 = crisp lake rings). */
  cell?: number;
  /** floor(x,z) → terrain height; cells with floor >= level are DRY (shore). */
  floor: (x: number, z: number) => number;
}

export class WaterSim {
  readonly w: number;
  readonly d: number;
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly level: number;

  /** Height + velocity fields. */
  private readonly u: Float32Array;
  private readonly v: Float32Array;
  /** 1 = water cell, 0 = shore/dry (waves reflect off the boundary). */
  private readonly wet: Uint8Array;
  /** v2 FLUID personality, per cell: wave speed follows depth (shallow = slow
   *  → waves refract and pile toward banks) and banks absorb (lapping dies at
   *  the shore instead of ringing off an invisible container wall). */
  private readonly c2f: Float32Array;
  private readonly dampF: Float32Array;
  /** Scratch for the viscosity diffusion pass. */
  private readonly vTmp: Float32Array;
  /** Half-float staging for the GPU texture (iOS-safe linear filtering). */
  private readonly half: Uint16Array<ArrayBuffer>;
  /** RG texture: R = height, G = churn (|v|) for foam/spray. */
  readonly texture: THREE.DataTexture;

  private acc = 0;
  /** Fixed sim step — 120 Hz keeps fast splashes stable at cell 0.5 m. */
  private static readonly STEP = 1 / 120;
  /** Wave speed factor (c²·dt² pre-baked for the fixed step). */
  private static readonly C2 = 0.30;
  private static readonly DAMP_V = 0.9905;
  private static readonly DAMP_U = 0.9992;
  private static readonly CLAMP = 1.6;

  /** Breath-of-wind state (off by default — glass is the reference). */
  breath = false;
  private breathT = 0;
  private breathX = 0;
  private breathZ = 0;

  /** Last-step churn total — cheap "is anything happening" probe for LOD. */
  energy = 0;

  constructor(opts: WaterSimOpts) {
    this.cell = opts.cell ?? 0.5;
    this.minX = opts.minX;
    this.minZ = opts.minZ;
    this.level = opts.level;
    this.w = Math.max(8, Math.round(opts.sizeX / this.cell));
    this.d = Math.max(8, Math.round(opts.sizeZ / this.cell));
    const n = this.w * this.d;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.wet = new Uint8Array(n);
    this.c2f = new Float32Array(n);
    this.dampF = new Float32Array(n);
    this.vTmp = new Float32Array(n);
    this.half = new Uint16Array(new ArrayBuffer(n * 8)); // RGBA half floats
    for (let k = 0; k < this.d; k++) {
      for (let i = 0; i < this.w; i++) {
        const wx = this.minX + (i + 0.5) * this.cell;
        const wz = this.minZ + (k + 0.5) * this.cell;
        this.wet[k * this.w + i] = opts.floor(wx, wz) < this.level - 0.02 ? 1 : 0;
      }
    }
    // B channel: static shore proximity (1 at the waterline fading over ~2m)
    // — the surface can outline itself so a body of water READS as one.
    for (let k = 0; k < this.d; k++) {
      for (let i = 0; i < this.w; i++) {
        const idx = k * this.w + i;
        if (!this.wet[idx]) continue;
        let minD = 99;
        const span = Math.ceil(2.2 / this.cell);
        for (let dk = -span; dk <= span && minD > 0; dk++) {
          for (let di = -span; di <= span; di++) {
            const ii = i + di;
            const kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= this.w || kk >= this.d) continue;
            if (!this.wet[kk * this.w + ii]) {
              const dd = Math.hypot(di, dk) * this.cell;
              if (dd < minD) minD = dd;
            }
          }
        }
        const shoreV = Math.max(0, 1 - minD / 2.2);
        this.half[idx * 4 + 2] = toHalf(shoreV);
        // A channel: normalized water-column depth — the shader's medium
        // thickness for volumetric scatter + shallow-edge transparency.
        const wx2 = this.minX + (i + 0.5) * this.cell;
        const wz2 = this.minZ + (k + 0.5) * this.cell;
        const depthN = Math.min(1, (this.level - opts.floor(wx2, wz2)) / 6);
        this.half[idx * 4 + 3] = toHalf(depthN);
        // Shallow-water celerity: c² scales with depth, so wave fronts bend
        // and slow as the bed rises — the real-lake refraction look.
        this.c2f[idx] = WaterSim.C2 * (0.30 + 0.70 * Math.min(1, depthN * 1.8));
        // Sponge shoreline: up to ~3% extra velocity loss per step at the
        // waterline — waves LAP and die there rather than mirror back.
        this.dampF[idx] = WaterSim.DAMP_V - shoreV * shoreV * 0.030;
      }
    }
    const tex = new THREE.DataTexture(this.half, this.w, this.d, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    this.texture = tex;
  }

  /** World xz → grid index, or -1 outside/dry. */
  private cellAt(wx: number, wz: number): number {
    const i = Math.floor((wx - this.minX) / this.cell);
    const k = Math.floor((wz - this.minZ) / this.cell);
    if (i < 1 || k < 1 || i >= this.w - 1 || k >= this.d - 1) return -1;
    const idx = k * this.w + i;
    return this.wet[idx] ? idx : -1;
  }

  /** True if the world point is over this body's water. */
  contains(wx: number, wz: number): boolean {
    return this.cellAt(wx, wz) >= 0;
  }

  /** Surface height (world y) at a point — level + wave displacement. */
  heightAt(wx: number, wz: number): number {
    const idx = this.cellAt(wx, wz);
    return this.level + (idx >= 0 ? this.u[idx] : 0);
  }

  /** Vertical surface speed (m/s, + = rising) — the "ride the swell" read. */
  surfaceVelAt(wx: number, wz: number): number {
    const idx = this.cellAt(wx, wz);
    return idx >= 0 ? this.v[idx] / WaterSim.STEP : 0;
  }

  /**
   * Surface slope (∂u/∂x, ∂u/∂z, rise-over-run) into `out`. A body in the
   * water is shoved DOWNHILL from crests (F ≈ −g·∇h) — this is the read that
   * lets an arriving ring shoulder the orb along its direction of travel.
   */
  slopeAt(wx: number, wz: number, out: { x: number; z: number }): void {
    out.x = 0;
    out.z = 0;
    const idx = this.cellAt(wx, wz);
    if (idx < 0) return;
    const { u, wet, w } = this;
    const uc = u[idx];
    // cellAt never returns border cells, so ±1/±w stay in bounds; dry
    // neighbours mirror the cell (zero slope into the bank, same as the sim).
    const uL = wet[idx - 1] ? u[idx - 1] : uc;
    const uR = wet[idx + 1] ? u[idx + 1] : uc;
    const uD = wet[idx - w] ? u[idx - w] : uc;
    const uU = wet[idx + w] ? u[idx + w] : uc;
    out.x = (uR - uL) / (2 * this.cell);
    out.z = (uU - uD) / (2 * this.cell);
  }

  /**
   * Gaussian impulse. `strength` in height units (negative = push down —
   * an entering body displaces water DOWN under it, up around it comes free
   * from the wave equation). `radius` in metres.
   */
  impulse(wx: number, wz: number, strength: number, radius = 1.2): void {
    const ci = (wx - this.minX) / this.cell;
    const ck = (wz - this.minZ) / this.cell;
    const r = Math.max(1, radius / this.cell);
    const span = Math.ceil(r * 2);
    for (let dk = -span; dk <= span; dk++) {
      for (let di = -span; di <= span; di++) {
        const i = Math.round(ci + di);
        const k = Math.round(ck + dk);
        if (i < 1 || k < 1 || i >= this.w - 1 || k >= this.d - 1) continue;
        const idx = k * this.w + i;
        if (!this.wet[idx]) continue;
        const g = Math.exp(-(di * di + dk * dk) / (r * r * 0.7));
        this.v[idx] += strength * g;
      }
    }
  }

  /**
   * A body punching through the surface: crater scaled by its momentum.
   * `speed` m/s along travel, `mass` ~ orb ≈ 1. Returns splash vigor 0..1
   * for the droplet/audio layer.
   */
  splashEntry(wx: number, wz: number, speed: number, mass = 1, radius = 1.4): number {
    const vigor = Math.min(1, (speed * mass) / 18);
    this.impulse(wx, wz, -2.4 * vigor - 0.15, radius * (0.8 + vigor));
    return vigor;
  }

  /** Drag wake while moving in/on the water — call per frame with velocity. */
  wake(wx: number, wz: number, vx: number, vz: number, dt: number): void {
    const sp = Math.hypot(vx, vz);
    if (sp < 0.4) return;
    const s = Math.min(0.9, sp * 0.09) * dt * 60;
    // Push down at the body, slightly ahead — the bow wave falls out naturally.
    this.impulse(wx, wz, -0.11 * s, 0.9);
    this.impulse(wx + (vx / sp) * 0.8, wz + (vz / sp) * 0.8, -0.05 * s, 0.7);
  }

  update(dt: number): void {
    this.acc += Math.min(dt, 0.1);
    let stepped = false;
    while (this.acc >= WaterSim.STEP) {
      this.acc -= WaterSim.STEP;
      this.step();
      stepped = true;
    }
    if (stepped) this.upload();
  }

  private step(): void {
    const { u, v, wet, w, d } = this;
    if (this.breath) this.breathe();
    let energy = 0;
    for (let k = 1; k < d - 1; k++) {
      const row = k * w;
      for (let i = 1; i < w - 1; i++) {
        const idx = row + i;
        if (!wet[idx]) continue;
        // Dry neighbours mirror the cell itself → reflective shoreline.
        const uL = wet[idx - 1] ? u[idx - 1] : u[idx];
        const uR = wet[idx + 1] ? u[idx + 1] : u[idx];
        const uD = wet[idx - w] ? u[idx - w] : u[idx];
        const uU = wet[idx + w] ? u[idx + w] : u[idx];
        const lap = uL + uR + uD + uU - 4 * u[idx];
        v[idx] += this.c2f[idx] * lap;
        v[idx] *= this.dampF[idx];
      }
    }
    // Viscosity: momentum diffuses to neighbours, so rings thicken and round
    // off instead of staying glassy-sharp — the "liquid, not membrane" term.
    const vt = this.vTmp;
    vt.set(v);
    const NU = 0.14;
    for (let k = 1; k < d - 1; k++) {
      const row = k * w;
      for (let i = 1; i < w - 1; i++) {
        const idx = row + i;
        if (!wet[idx]) continue;
        const vL = wet[idx - 1] ? vt[idx - 1] : vt[idx];
        const vR = wet[idx + 1] ? vt[idx + 1] : vt[idx];
        const vD = wet[idx - w] ? vt[idx - w] : vt[idx];
        const vU = wet[idx + w] ? vt[idx + w] : vt[idx];
        v[idx] = vt[idx] + NU * 0.25 * (vL + vR + vD + vU - 4 * vt[idx]);
      }
    }
    for (let idx = 0; idx < u.length; idx++) {
      if (!wet[idx]) continue;
      u[idx] += v[idx];
      u[idx] *= WaterSim.DAMP_U;
      if (u[idx] > WaterSim.CLAMP) u[idx] = WaterSim.CLAMP;
      else if (u[idx] < -WaterSim.CLAMP) u[idx] = -WaterSim.CLAMP;
      const a = Math.abs(v[idx]);
      if (a > energy) energy = a;
    }
    this.energy = energy;
  }

  /** Rare drifting micro-patch — deliberately at the edge of perception. */
  private breathe(): void {
    this.breathT -= WaterSim.STEP;
    if (this.breathT <= 0) {
      this.breathT = 2.5 + Math.random() * 5;
      this.breathX = this.minX + Math.random() * this.w * this.cell;
      this.breathZ = this.minZ + Math.random() * this.d * this.cell;
    }
    this.breathX += WaterSim.STEP * 0.7; // patch drifts like a gust
    this.impulse(
      this.breathX + (Math.random() - 0.5) * 3,
      this.breathZ + (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 0.012,
      1.6,
    );
  }

  /** Pack u→R, |v|→G as half floats (B/A are static) and flag the texture. */
  private upload(): void {
    const { u, v, half } = this;
    for (let idx = 0; idx < u.length; idx++) {
      half[idx * 4] = toHalf(u[idx]);
      half[idx * 4 + 1] = toHalf(Math.min(1, Math.abs(v[idx]) * 6));
    }
    this.texture.needsUpdate = true;
  }
}

// Compact float→half converter (positive/negative smalls only — wave heights).
const _hf = new Float32Array(1);
const _hi = new Uint32Array(_hf.buffer);
function toHalf(x: number): number {
  _hf[0] = x;
  const bits = _hi[0];
  const s = (bits >> 16) & 0x8000;
  let e = ((bits >> 23) & 0xff) - 112;
  const m = (bits >> 13) & 0x3ff;
  if (e <= 0) return s; // flush denormals — waves this small are invisible
  if (e > 30) return s | 0x7bff;
  return s | (e << 10) | m;
}
