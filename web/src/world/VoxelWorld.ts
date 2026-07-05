/**
 * Chunked voxel storage.
 *
 * The world is effectively infinite (SPEC §3) — stored as a sparse map of
 * fixed-size chunks keyed by chunk coordinate. For the sandbox slice only a
 * handful of chunks exist, but the interface is already the streaming one:
 * everything addresses voxels by absolute (x,y,z) and chunks materialise on
 * demand. Meshing/lighting mark chunks dirty; nothing else needs to know how
 * storage is partitioned.
 */

import { World } from '../config';
import { Mat, isSolid } from './Materials';

const CS = World.chunkSize;

const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

// Floored integer division / modulo that behave correctly for negatives.
const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const mod = (a: number, b: number): number => ((a % b) + b) % b;

export class Chunk {
  readonly voxels: Uint8Array;
  /** Baked light level per voxel (0..15), produced by the LightGrid. */
  readonly light: Uint8Array;
  dirty = true; // needs remesh
  lightDirty = true; // needs re-flood

  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
  ) {
    this.voxels = new Uint8Array(CS * CS * CS);
    this.light = new Uint8Array(CS * CS * CS);
  }

  static index(lx: number, ly: number, lz: number): number {
    return (ly * CS + lz) * CS + lx;
  }
}

export class VoxelWorld {
  readonly chunks = new Map<string, Chunk>();

  /** Bounds actually touched so far (in voxels), for camera framing/debug. */
  min: [number, number, number] = [Infinity, Infinity, Infinity];
  max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  getChunk(cx: number, cy: number, cz: number, create = false): Chunk | undefined {
    const key = chunkKey(cx, cy, cz);
    let c = this.chunks.get(key);
    if (!c && create) {
      c = new Chunk(cx, cy, cz);
      this.chunks.set(key, c);
    }
    return c;
  }

  get(x: number, y: number, z: number): Mat {
    const c = this.getChunk(floorDiv(x, CS), floorDiv(y, CS), floorDiv(z, CS));
    if (!c) return Mat.Air;
    return c.voxels[Chunk.index(mod(x, CS), mod(y, CS), mod(z, CS))] as Mat;
  }

  set(x: number, y: number, z: number, m: Mat): void {
    const cx = floorDiv(x, CS);
    const cy = floorDiv(y, CS);
    const cz = floorDiv(z, CS);
    const c = this.getChunk(cx, cy, cz, true)!;
    const i = Chunk.index(mod(x, CS), mod(y, CS), mod(z, CS));
    if (c.voxels[i] === m) return;
    c.voxels[i] = m;
    this.markDirty(cx, cy, cz);
    // Neighbours sharing this face may need remeshing too.
    if (mod(x, CS) === 0) this.markDirty(cx - 1, cy, cz);
    if (mod(x, CS) === CS - 1) this.markDirty(cx + 1, cy, cz);
    if (mod(y, CS) === 0) this.markDirty(cx, cy - 1, cz);
    if (mod(y, CS) === CS - 1) this.markDirty(cx, cy + 1, cz);
    if (mod(z, CS) === 0) this.markDirty(cx, cy, cz - 1);
    if (mod(z, CS) === CS - 1) this.markDirty(cx, cy, cz + 1);
    if (m !== Mat.Air) {
      this.min = [Math.min(this.min[0], x), Math.min(this.min[1], y), Math.min(this.min[2], z)];
      this.max = [Math.max(this.max[0], x), Math.max(this.max[1], y), Math.max(this.max[2], z)];
    }
  }

  solid(x: number, y: number, z: number): boolean {
    return isSolid(this.get(x, y, z));
  }

  private markDirty(cx: number, cy: number, cz: number): void {
    const c = this.getChunk(cx, cy, cz);
    if (c) {
      c.dirty = true;
      c.lightDirty = true;
    }
  }
}
