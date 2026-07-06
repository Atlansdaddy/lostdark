/**
 * BuildSandbox — the SW corner's place/remove editor + force wave.
 *
 * The game ships no block-editing (wards are the only voxel mutation), so this
 * builds a minimal creative loop for the testbed:
 *   • CURSOR   — a wire box floating just in front of the orb, snapped to the top
 *                of the column it points at (build stacks up, remove peels down).
 *   • PLACE/REMOVE/CYCLE — edit one voxel at the cursor; cycle the material.
 *   • FORCE WAVE — an expanding shockwave from the orb that scatters PLAYER-PLACED
 *                  voxels (only — the real world is never destroyed) into
 *                  material-coloured debris that flies out and falls.
 *
 * main.ts owns the actual voxel write + relight + remesh via the `commit`
 * callback, so this module stays free of the chunk/light plumbing.
 */

import * as THREE from 'three';
import { Mat, MATERIALS } from './Materials';
import type { Slab } from './Testbeds';
import type { VoxelWorld } from './VoxelWorld';

export interface SandboxDeps {
  scene: THREE.Scene;
  world: VoxelWorld;
  /** Building + destruction are confined to this footprint (the SW zone). */
  deck: Slab;
  /** Apply a batch of voxel writes + remesh (main.ts owns the plumbing). */
  commit: (edits: [number, number, number, Mat][]) => void;
  moteTexture: THREE.Texture;
  /** Called when a force wave fires, so the caller can splash water / stir embers. */
  onForceWave?: (origin: THREE.Vector3) => void;
}

const PALETTE: Mat[] = [Mat.Stone, Mat.Wood, Mat.Metal, Mat.Glass, Mat.Ice, Mat.Crystal, Mat.Glowcap];
const REACH = 3; // voxels in front of the orb the cursor floats

export class BuildSandbox {
  private readonly d: SandboxDeps;
  private readonly cursor: THREE.LineSegments;
  private matIdx = 0;
  private readonly placed = new Map<string, [number, number, number]>();
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private targetInZone = false;

  // Force-wave shockwave.
  private shockActive = false;
  private shockR = 0;
  private readonly shockOrigin = new THREE.Vector3();
  private readonly shockMesh: THREE.Mesh;
  private readonly SHOCK_SPEED = 26;
  private readonly SHOCK_MAX = 34;
  private lastShockR = 0;

  // Debris pool.
  private readonly DEB_MAX = 300;
  private readonly debPos: Float32Array;
  private readonly debCol: Float32Array;
  private readonly debVel: Float32Array;
  private readonly debLife: Float32Array;
  private readonly debBase: Float32Array; // un-lit material tint (color = base × light)
  private debHead = 0;
  private readonly debGeo: THREE.BufferGeometry;

  constructor(deps: SandboxDeps) {
    this.d = deps;

    // Build cursor: a soft cyan wire box.
    this.cursor = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
      new THREE.LineBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.6, depthTest: false }),
    );
    this.cursor.renderOrder = 5;
    this.cursor.layers.set(1);
    this.cursor.visible = false; // shown only once inside the zone (update())
    deps.scene.add(this.cursor);

    // Shockwave shell (additive), hidden until fired.
    this.shockMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.MeshBasicMaterial({
        color: 0xbfe6ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.shockMesh.visible = false;
    this.shockMesh.frustumCulled = false;
    this.shockMesh.layers.set(1);
    deps.scene.add(this.shockMesh);

    // Debris points.
    this.debPos = new Float32Array(this.DEB_MAX * 3).fill(-9999);
    this.debCol = new Float32Array(this.DEB_MAX * 3);
    this.debVel = new Float32Array(this.DEB_MAX * 3);
    this.debLife = new Float32Array(this.DEB_MAX);
    this.debBase = new Float32Array(this.DEB_MAX * 3);
    this.debGeo = new THREE.BufferGeometry();
    this.debGeo.setAttribute('position', new THREE.BufferAttribute(this.debPos, 3));
    this.debGeo.setAttribute('color', new THREE.BufferAttribute(this.debCol, 3));
    const deb = new THREE.Points(
      this.debGeo,
      new THREE.PointsMaterial({ size: 0.28, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }),
    );
    deb.frustumCulled = false;
    deb.layers.set(1);
    deps.scene.add(deb);
  }

  get materialName(): string {
    return MATERIALS[PALETTE[this.matIdx]].name;
  }

  /** Is this column inside the designated build zone? */
  private inZone(x: number, z: number): boolean {
    const d = this.d.deck;
    return x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1;
  }

  /** Highest solid voxel in a column, searching down from yStart. Returns its Y. */
  private columnTop(x: number, z: number, yStart: number): number {
    for (let y = yStart + 6; y > yStart - 24; y--) {
      if (this.d.world.solid(x, y, z)) return y;
    }
    return yStart - 24;
  }

  update(dt: number, orbPos: THREE.Vector3, yaw: number, camPos: THREE.Vector3): void {
    // Cursor target: a column REACH voxels ahead of the orb, snapped to its top.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    this.tx = Math.floor(orbPos.x + fx * REACH);
    this.tz = Math.floor(orbPos.z + fz * REACH);
    const top = this.columnTop(this.tx, this.tz, Math.floor(orbPos.y));
    this.ty = top + 1; // sit on top of the stack
    // The cursor only shows (and edits only fire) inside the designated zone.
    this.targetInZone = this.inZone(this.tx, this.tz);
    this.cursor.visible = this.targetInZone;
    this.cursor.position.set(this.tx + 0.5, this.ty + 0.5, this.tz + 0.5);
    const cm = this.cursor.material as THREE.LineBasicMaterial;
    cm.opacity = 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(performance.now() * 0.005));

    // Advance the shockwave; scatter placed voxels the wavefront crosses.
    if (this.shockActive) {
      this.lastShockR = this.shockR;
      this.shockR += this.SHOCK_SPEED * dt;
      const t = this.shockR / this.SHOCK_MAX;
      this.shockMesh.visible = true;
      this.shockMesh.position.copy(this.shockOrigin);
      this.shockMesh.scale.setScalar(this.shockR);
      (this.shockMesh.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - t);
      const edits: [number, number, number, Mat][] = [];
      for (const [key, [vx, vy, vz]] of this.placed) {
        const d = Math.hypot(vx + 0.5 - this.shockOrigin.x, vy + 0.5 - this.shockOrigin.y, vz + 0.5 - this.shockOrigin.z);
        if (d > this.lastShockR && d <= this.shockR) {
          edits.push([vx, vy, vz, Mat.Air]);
          this.spawnDebris(vx, vy, vz, this.d.world.get(vx, vy, vz));
          this.placed.delete(key);
        }
      }
      if (edits.length) this.d.commit(edits);
      if (this.shockR > this.SHOCK_MAX) {
        this.shockActive = false;
        this.shockMesh.visible = false;
      }
    }

    // Advance debris (ballistic + gravity + fade). Colour = material tint × a
    // death fade × orb-light gate, rebuilt each frame from the stored base tint.
    for (let i = 0; i < this.DEB_MAX; i++) {
      if (this.debLife[i] <= 0) continue;
      this.debLife[i] -= dt;
      this.debVel[i * 3 + 1] -= 16 * dt;
      this.debPos[i * 3] += this.debVel[i * 3] * dt;
      this.debPos[i * 3 + 1] += this.debVel[i * 3 + 1] * dt;
      this.debPos[i * 3 + 2] += this.debVel[i * 3 + 2] * dt;
      const fade = Math.min(1, this.debLife[i] / 0.4);
      const dx = this.debPos[i * 3] - orbPos.x;
      const dy = this.debPos[i * 3 + 1] - orbPos.y;
      const dz = this.debPos[i * 3 + 2] - orbPos.z;
      const lit = Math.max(0.15, 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / 16);
      const b = fade * lit;
      this.debCol[i * 3] = this.debBase[i * 3] * b;
      this.debCol[i * 3 + 1] = this.debBase[i * 3 + 1] * b;
      this.debCol[i * 3 + 2] = this.debBase[i * 3 + 2] * b;
      if (this.debLife[i] <= 0) this.debPos[i * 3 + 1] = -9999;
    }
    this.debGeo.attributes.position.needsUpdate = true;
    this.debGeo.attributes.color.needsUpdate = true;
    void camPos;
  }

  private spawnDebris(vx: number, vy: number, vz: number, mat: Mat): void {
    const col = MATERIALS[mat]?.color ?? [0.5, 0.5, 0.5];
    for (let n = 0; n < 5; n++) {
      const idx = this.debHead;
      this.debHead = (this.debHead + 1) % this.DEB_MAX;
      this.debPos[idx * 3] = vx + 0.5 + (Math.random() - 0.5) * 0.6;
      this.debPos[idx * 3 + 1] = vy + 0.5 + (Math.random() - 0.5) * 0.6;
      this.debPos[idx * 3 + 2] = vz + 0.5 + (Math.random() - 0.5) * 0.6;
      const dirx = vx + 0.5 - this.shockOrigin.x;
      const dirz = vz + 0.5 - this.shockOrigin.z;
      const len = Math.hypot(dirx, dirz) || 1;
      const spd = 5 + Math.random() * 6;
      this.debVel[idx * 3] = (dirx / len) * spd + (Math.random() - 0.5) * 2;
      this.debVel[idx * 3 + 1] = 3 + Math.random() * 5;
      this.debVel[idx * 3 + 2] = (dirz / len) * spd + (Math.random() - 0.5) * 2;
      this.debLife[idx] = 1.2 + Math.random() * 1.2;
      this.debBase[idx * 3] = col[0];
      this.debBase[idx * 3 + 1] = col[1];
      this.debBase[idx * 3 + 2] = col[2];
      this.debCol[idx * 3] = col[0];
      this.debCol[idx * 3 + 1] = col[1];
      this.debCol[idx * 3 + 2] = col[2];
    }
  }

  // --- input verbs (main.ts binds keys) ---

  place(): void {
    if (!this.targetInZone) return; // building is confined to the zone
    if (this.d.world.solid(this.tx, this.ty, this.tz)) return; // already filled
    const mat = PALETTE[this.matIdx];
    this.d.commit([[this.tx, this.ty, this.tz, mat]]);
    this.placed.set(`${this.tx},${this.ty},${this.tz}`, [this.tx, this.ty, this.tz]);
  }

  remove(): void {
    if (!this.targetInZone) return; // destruction is confined to the zone
    // Peel the topmost solid just below the cursor.
    const y = this.ty - 1;
    if (!this.d.world.solid(this.tx, y, this.tz)) return;
    this.d.commit([[this.tx, y, this.tz, Mat.Air]]);
    this.placed.delete(`${this.tx},${y},${this.tz}`);
  }

  cycleMat(): string {
    this.matIdx = (this.matIdx + 1) % PALETTE.length;
    return this.materialName;
  }

  forceWave(origin: THREE.Vector3): void {
    this.shockOrigin.copy(origin);
    this.shockR = 0;
    this.lastShockR = 0;
    this.shockActive = true;
    this.d.onForceWave?.(origin);
  }
}
