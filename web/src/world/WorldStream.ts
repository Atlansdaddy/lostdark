/**
 * WorldStream — the game-side streaming ladder (Phase-5 bridge).
 *
 * The worldlab's ChunkManager owns meshes; the GAME already has a mesh
 * pipeline (remeshDirtyChunks + chunkMeshes + its culling loop), so this class
 * runs only the DATA half of the ring ladder over the map-driven WorldGen:
 *
 *   GENERATED (≤R+2) → DECORATED (≤R+1) → LIT (≤R)
 *
 * and the game's mesher is gated by canMesh(): a chunk may only mesh once its
 * column is Lit — the same seam-proof ordering the lab proved, expressed
 * through main.ts's existing machinery instead of a parallel one.
 *
 * Unloading returns the dropped chunks so the caller can dispose their meshes.
 */

import { World } from '../config';
import { Chunk, VoxelWorld } from './VoxelWorld';
import { lightColumn } from '../worldlab/LabLight';
import type { WorldGen } from '../worldlab/WorldGen';

const CS = World.chunkSize;

const enum St {
  Generated = 0,
  Decorated = 1,
  Lit = 2,
}

export class WorldStream {
  private readonly cols = new Map<string, St>();

  constructor(
    private readonly world: VoxelWorld,
    private readonly gen: WorldGen,
    public radius = 5,
    /** Game-side extra decoration (the demo's Reek POIs/flora hooks). */
    private readonly extraDecorate?: (cx: number, cz: number) => void,
  ) {}

  /** The game's remesh loop asks per chunk: is this column's data final? */
  canMesh(cx: number, cz: number): boolean {
    return this.cols.get(`${cx},${cz}`) === St.Lit;
  }

  /** Advance the ladder around a world position, spending ≤ budgetMs. */
  update(wx: number, wz: number, budgetMs: number): number {
    const t0 = performance.now();
    const ccx = Math.floor(wx / CS);
    const ccz = Math.floor(wz / CS);
    const R = this.radius;
    const genR = R + 2;
    interface Task {
      d: number;
      stage: St;
      cx: number;
      cz: number;
    }
    const tasks: Task[] = [];
    for (let dz = -genR; dz <= genR; dz++) {
      for (let dx = -genR; dx <= genR; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dz));
        const cx = ccx + dx;
        const cz = ccz + dz;
        const st = this.cols.get(`${cx},${cz}`);
        if (st === undefined) tasks.push({ d, stage: St.Generated, cx, cz });
        else if (st === St.Generated && d <= R + 1 && this.ring(cx, cz, St.Generated)) tasks.push({ d, stage: St.Decorated, cx, cz });
        else if (st === St.Decorated && d <= R && this.ring(cx, cz, St.Decorated)) tasks.push({ d, stage: St.Lit, cx, cz });
      }
    }
    tasks.sort((a, b) => a.d - b.d || b.stage - a.stage);
    let done = 0;
    for (const t of tasks) {
      if (performance.now() - t0 >= budgetMs) break;
      if (t.stage === St.Generated) {
        this.gen.generateColumn(this.world, t.cx, t.cz);
        this.cols.set(`${t.cx},${t.cz}`, St.Generated);
      } else if (t.stage === St.Decorated) {
        this.gen.decorateColumn(this.world, t.cx, t.cz);
        this.extraDecorate?.(t.cx, t.cz);
        this.cols.set(`${t.cx},${t.cz}`, St.Decorated);
      } else {
        lightColumn(this.world, t.cx, t.cz, this.gen.cyMin, this.gen.cyMax);
        // lightColumn leaves the touched chunks light-clean; the game meshes
        // them via its own dirty flags, which generation already set.
        this.cols.set(`${t.cx},${t.cz}`, St.Lit);
        for (let cy = this.gen.cyMin; cy <= this.gen.cyMax; cy++) {
          const c = this.world.getChunk(t.cx, cy, t.cz);
          if (c) c.lightDirty = false;
        }
      }
      done++;
    }
    return done;
  }

  /** True while the near ladder still has pending work (boot convergence). */
  busy(wx: number, wz: number): boolean {
    const ccx = Math.floor(wx / CS);
    const ccz = Math.floor(wz / CS);
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        if (this.cols.get(`${ccx + dx},${ccz + dz}`) !== St.Lit) return true;
      }
    }
    return false;
  }

  /** Drop columns beyond the hysteresis ring; returns their chunks so the
   *  caller can remove + dispose the meshes it built for them. */
  unload(wx: number, wz: number): Chunk[] {
    const ccx = Math.floor(wx / CS);
    const ccz = Math.floor(wz / CS);
    const limit = this.radius + 5;
    const dropped: Chunk[] = [];
    for (const key of [...this.cols.keys()]) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) <= limit) continue;
      this.cols.delete(key);
      for (let cy = this.gen.cyMin; cy <= this.gen.cyMax; cy++) {
        const chunkKey = `${cx},${cy},${cz}`;
        const c = this.world.chunks.get(chunkKey);
        if (c) {
          dropped.push(c);
          this.world.chunks.delete(chunkKey);
        }
      }
    }
    return dropped;
  }

  private ring(cx: number, cz: number, s: St): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = this.cols.get(`${cx + dx},${cz + dz}`);
        if (n === undefined || n < s) return false;
      }
    }
    return true;
  }
}
