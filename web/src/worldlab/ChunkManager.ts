/**
 * WORLDLAB ChunkManager — the ring ladder.
 *
 * The one load-bearing idea of streaming voxel worlds: chunks advance through
 * STATES, and each state is only reachable at a smaller radius than the state
 * before it, so every stage can trust that its dependencies already exist:
 *
 *   radius:   R+3         R+2         R+1      R
 *   state:  GENERATED → DECORATED → LIT → MESHED
 *
 * Each rung reaches ONE RING FURTHER than the rung above it — a column can
 * only advance when all 8 neighbours hold the previous state, so equal radii
 * would deadlock the outermost ring (found by the headless invariant test).
 *
 *   • generate  — raw voxels from pure (x,y,z,seed) fields, per column
 *   • decorate  — POIs/flora that write across borders; every neighbour is
 *                 already Generated, so cross-border writes always land
 *   • light     — local flood over Decorated neighbours (stage-4 work; the
 *                 rung exists now so the ladder shape never changes)
 *   • mesh      — every voxel the mesher samples is final. Seams are
 *                 impossible BY CONSTRUCTION, not patched after the fact.
 *
 * The ladder also makes "decorate writes into a meshed chunk" impossible:
 * a neighbour can only be Meshed if ALL its neighbours (including us) were
 * already Lit ≥ Decorated — so nobody meshes before we've written into them.
 *
 * All work is drained from a single nearest-first queue under a per-frame
 * millisecond budget. Columns beyond the unload radius dispose their meshes
 * and voxel data (with hysteresis so walking a border doesn't thrash).
 * Exactly one mesh handle per chunk lives here — geometry enters and leaves
 * the scene through this class or not at all (the double-render killer).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { World } from '../config';
import { Chunk, VoxelWorld } from '../world/VoxelWorld';
import { LightGrid } from '../lighting/LightGrid';
import { buildChunkGeometry } from '../render/VoxelMesher';
import { logger } from '../core/log';
import { lightColumn } from './LabLight';
import { PropRecord } from './Props';
import { ColumnGenerator } from './HeightfieldGen';

const log = logger('chunkmgr');
const CS = World.chunkSize;

/** Any chunk-geometry builder with the shared mesher signature — the blocky
 *  VoxelMesher and the Surface-Nets SmoothMesher both fit. */
export type MesherFn = (world: VoxelWorld, light: LightGrid, chunk: Chunk) => THREE.BufferGeometry | null;

/** Receives per-column instanced-prop records when a column meshes, and the
 *  matching clear when it trims/unloads (see worldlab/Props.ts). */
export interface PropSink {
  setColumn(cx: number, cz: number, recs: PropRecord[]): void;
  clearColumn(cx: number, cz: number): void;
}

export const enum ColState {
  Generated = 0,
  Decorated = 1,
  Lit = 2,
  Meshed = 3,
}

export const COL_STATE_NAMES = ['generated', 'decorated', 'lit', 'meshed'] as const;

interface ColumnRec {
  cx: number;
  cz: number;
  state: ColState;
  meshes: THREE.Mesh[];
  /** Meshed with a stale mesher — rebuild, keeping the old mesh visible until
   *  its replacement exists (never show holes during a re-skin). */
  remesh: boolean;
}

interface Task {
  d: number; // Chebyshev distance from the centre column
  stage: ColState; // the state this task ADVANCES a column to (Generated = create)
  cx: number;
  cz: number;
}

export interface ManagerStats {
  /** Live column count per state (index = ColState). */
  byState: [number, number, number, number];
  chunksLoaded: number;
  meshesTracked: number;
  /** Tasks that were eligible but unfunded this frame (queue pressure). */
  queued: number;
  /** ms of world work actually spent this frame. */
  frameMs: number;
  /** EMA cost of one generate / one mesh task. */
  genMsAvg: number;
  litMsAvg: number;
  meshMsAvg: number;
  columnsDisposed: number;
}

export class ChunkManager {
  readonly world = new VoxelWorld();
  /** All chunk meshes live under this; add it to the scene once. */
  readonly group = new THREE.Group();
  /** Bumps whenever any column changes state or unloads — cheap change signal
   *  for overlays (borders HUD) that mirror manager state. */
  version = 0;

  private readonly columns = new Map<string, ColumnRec>();
  /** Never updated — all-zero static light. Stage 4 replaces this with the
   *  localized border-exchange flood. */
  private readonly light = new LightGrid(this.world);
  private meshRadius: number;
  private readonly stats: ManagerStats = {
    byState: [0, 0, 0, 0],
    chunksLoaded: 0,
    meshesTracked: 0,
    queued: 0,
    frameMs: 0,
    genMsAvg: 0,
    litMsAvg: 0,
    meshMsAvg: 0,
    columnsDisposed: 0,
  };

  private mesher: MesherFn = buildChunkGeometry;

  constructor(
    private readonly gen: ColumnGenerator,
    private readonly material: THREE.Material,
    meshRadius = 6,
    private readonly propSink?: PropSink,
  ) {
    this.meshRadius = meshRadius;
  }

  /** Baked light (0..1) at a world voxel — for stamping prop instances. */
  private lightAt(x: number, y: number, z: number): number {
    const c = this.world.getChunk(Math.floor(x / CS), Math.floor(y / CS), Math.floor(z / CS));
    if (!c) return 0;
    const m = (a: number): number => ((a % CS) + CS) % CS;
    return c.light[Chunk.index(m(x), m(y), m(z))] / 15;
  }

  /** Swap the geometry builder (blocky ↔ smooth). Every meshed column is
   *  flagged for an in-place rebuild through the normal budgeted queue; its
   *  old mesh stays in the scene until the replacement is built, so the world
   *  never shows holes mid-swap. (v1 demoted columns and only re-meshed ≤ R:
   *  everything in the hysteresis fringe lost its mesh permanently, and the
   *  blocky/smooth junction ring couldn't line up — John's "missing massive
   *  amounts of material" + seams.) */
  setMesher(fn: MesherFn): void {
    if (fn === this.mesher) return;
    this.mesher = fn;
    for (const col of this.columns.values()) {
      if (col.state === ColState.Meshed) col.remesh = true;
    }
    this.version++;
    log.info('mesher swapped — re-skinning loaded columns in place');
  }

  get radius(): number {
    return this.meshRadius;
  }

  setRadius(r: number): void {
    this.meshRadius = Math.max(2, Math.min(14, r));
    log.info(`mesh radius → ${this.meshRadius}`);
  }

  /** Advance the world around a world-space position, spending ≤ budgetMs. */
  update(wx: number, wz: number, budgetMs: number): ManagerStats {
    const t0 = performance.now();
    const ccx = Math.floor(wx / CS);
    const ccz = Math.floor(wz / CS);
    const R = this.meshRadius;
    const genR = R + 3;
    const unloadR = genR + 2;

    // --- Unload pass: hysteresis ring keeps border-walking from thrashing ---
    for (const col of this.columns.values()) {
      const d = Math.max(Math.abs(col.cx - ccx), Math.abs(col.cz - ccz));
      if (d > unloadR) {
        this.dispose(col);
      } else if (d > R + 2 && col.state === ColState.Meshed) {
        // Mesh-trim ring: the fog wall hides everything past ~R−1.5, so a
        // trailing mesh out here is pure waste (memory + cull iteration +
        // draws when it swings into the frustum). Drop geometry, keep voxel
        // data — re-entering R re-meshes instantly with no regeneration. The
        // 2-ring gap between trim (>R+2) and mesh (≤R) prevents thrash.
        for (const m of col.meshes) {
          this.group.remove(m);
          m.geometry.dispose();
        }
        col.meshes.length = 0;
        col.remesh = false;
        col.state = ColState.Lit;
        this.propSink?.clearColumn(col.cx, col.cz);
        this.version++;
      }
    }

    // --- Scan the window for eligible ladder steps, nearest-first ---
    // States only ever advance, so eligibility computed here stays valid for
    // every task we fund this frame; newly-unlocked steps wait one frame.
    const tasks: Task[] = [];
    for (let dz = -genR; dz <= genR; dz++) {
      for (let dx = -genR; dx <= genR; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dz));
        const cx = ccx + dx;
        const cz = ccz + dz;
        const col = this.columns.get(`${cx},${cz}`);
        if (!col) {
          tasks.push({ d, stage: ColState.Generated, cx, cz });
        } else if (col.state === ColState.Generated && d <= R + 2 && this.ring(cx, cz, ColState.Generated)) {
          tasks.push({ d, stage: ColState.Decorated, cx, cz });
        } else if (col.state === ColState.Decorated && d <= R + 1 && this.ring(cx, cz, ColState.Decorated)) {
          tasks.push({ d, stage: ColState.Lit, cx, cz });
        } else if (col.state === ColState.Lit && d <= R && this.ring(cx, cz, ColState.Lit)) {
          tasks.push({ d, stage: ColState.Meshed, cx, cz });
        } else if (col.state === ColState.Meshed && col.remesh && d <= genR) {
          // Stale-mesher rebuild. Voxel data for all 8 neighbours is loaded out
          // to genR (unload sits at genR+2), so a rebuild here is border-safe.
          tasks.push({ d, stage: ColState.Meshed, cx, cz });
        }
      }
    }
    tasks.sort((a, b) => a.d - b.d || b.stage - a.stage);

    // --- Drain under budget ---
    let i = 0;
    while (i < tasks.length && performance.now() - t0 < budgetMs) {
      this.run(tasks[i++]);
    }

    this.stats.queued = tasks.length - i;
    this.stats.frameMs = performance.now() - t0;
    this.refreshCounts();
    return this.stats;
  }

  /** All 8 neighbour columns exist and have reached at least `s`. */
  private ring(cx: number, cz: number, s: ColState): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = this.columns.get(`${cx + dx},${cz + dz}`);
        if (!n || n.state < s) return false;
      }
    }
    return true;
  }

  private run(t: Task): void {
    const t0 = performance.now();
    switch (t.stage) {
      case ColState.Generated: {
        this.gen.generateColumn(this.world, t.cx, t.cz);
        this.columns.set(`${t.cx},${t.cz}`, { cx: t.cx, cz: t.cz, state: ColState.Generated, meshes: [], remesh: false });
        this.stats.genMsAvg = ema(this.stats.genMsAvg, performance.now() - t0);
        break;
      }
      case ColState.Decorated: {
        this.gen.decorateColumn(this.world, t.cx, t.cz);
        this.columns.get(`${t.cx},${t.cz}`)!.state = ColState.Decorated;
        break;
      }
      case ColState.Lit: {
        // Localized flood: this column's emissive seeds, baked into
        // chunk.light. Overlapping neighbour floods max-combine, so ladder
        // order can't change the result (see LabLight.ts).
        lightColumn(this.world, t.cx, t.cz, this.gen.cyMin, this.gen.cyMax);
        this.columns.get(`${t.cx},${t.cz}`)!.state = ColState.Lit;
        this.stats.litMsAvg = ema(this.stats.litMsAvg, performance.now() - t0);
        break;
      }
      case ColState.Meshed: {
        const col = this.columns.get(`${t.cx},${t.cz}`)!;
        // Idempotent: drop any existing meshes first (remesh path), so this
        // column can never contribute two generations of geometry at once.
        for (const m of col.meshes) {
          this.group.remove(m);
          m.geometry.dispose();
        }
        col.meshes.length = 0;
        col.remesh = false;
        const geos: THREE.BufferGeometry[] = [];
        for (let cy = this.gen.cyMin; cy <= this.gen.cyMax; cy++) {
          const chunk = this.world.getChunk(t.cx, cy, t.cz);
          if (!chunk) continue;
          const geo = this.mesher(this.world, this.light, chunk);
          chunk.dirty = false;
          if (geo) geos.push(geo);
        }
        // ONE mesh per column, not per chunk — draw calls are the phone's
        // ceiling (≈700 meshes at R=8 before this), and all chunks share one
        // material anyway. Geometry is baked in world coords; never moves.
        if (geos.length) {
          const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
          if (geos.length > 1) for (const g of geos) g.dispose();
          const mesh = new THREE.Mesh(merged, this.material);
          mesh.matrixAutoUpdate = false;
          this.group.add(mesh);
          col.meshes.push(mesh);
        }
        if (this.propSink && this.gen.props) {
          const recs = this.gen.props(t.cx, t.cz);
          for (const r of recs) r.light = this.lightAt(Math.floor(r.x), Math.floor(r.y), Math.floor(r.z));
          this.propSink.setColumn(t.cx, t.cz, recs);
        }
        col.state = ColState.Meshed;
        this.stats.meshMsAvg = ema(this.stats.meshMsAvg, performance.now() - t0);
        break;
      }
    }
    this.version++;
  }

  private dispose(col: ColumnRec): void {
    for (const m of col.meshes) {
      this.group.remove(m);
      m.geometry.dispose(); // material is shared — never disposed here
    }
    col.meshes.length = 0;
    this.propSink?.clearColumn(col.cx, col.cz);
    // VoxelWorld keys chunks as "cx,cy,cz" (VoxelWorld.chunkKey).
    for (let cy = this.gen.cyMin; cy <= this.gen.cyMax; cy++) {
      this.world.chunks.delete(`${col.cx},${cy},${col.cz}`);
    }
    this.columns.delete(`${col.cx},${col.cz}`);
    this.stats.columnsDisposed++;
    this.version++;
  }

  private refreshCounts(): void {
    const by: [number, number, number, number] = [0, 0, 0, 0];
    let meshes = 0;
    for (const col of this.columns.values()) {
      by[col.state]++;
      meshes += col.meshes.length;
    }
    this.stats.byState = by;
    this.stats.chunksLoaded = this.world.chunks.size;
    this.stats.meshesTracked = meshes;
  }

  /** For overlays: iterate live columns (do not mutate). */
  forEachColumn(fn: (cx: number, cz: number, state: ColState) => void): void {
    for (const col of this.columns.values()) fn(col.cx, col.cz, col.state);
  }
}

const ema = (avg: number, sample: number): number => (avg === 0 ? sample : avg * 0.9 + sample * 0.1);
