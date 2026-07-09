/**
 * Voxel flood-fill light propagation (GDD §5j Phase-1).
 *
 * Minecraft-style block-light BFS: emissive voxels seed a level, light spreads
 * one step per cell through open space, attenuating by 1 each hop. This is the
 * cheap, destructible-safe GI workhorse — "built light holds back the dark."
 * We re-flood only when a chunk's contents changed (lightDirty).
 *
 * The orb's carried bubble and the echolocation pulse are *dynamic* and handled
 * in the shader instead — this grid is the static, cached layer.
 */

import { World, Light } from '../config';
import { Mat, MATERIALS, isSolid } from '../world/Materials';
import { VoxelWorld, Chunk } from '../world/VoxelWorld';

const CS = World.chunkSize;
const MAXL = Light.max;

type QItem = { x: number; y: number; z: number; l: number };

export class LightGrid {
  /** Cached static emissive-voxel seeds for reflood() (invalidated on update). */
  private staticSeeds: QItem[] | null = null;

  constructor(private world: VoxelWorld) {}

  /** True if any chunk needed re-flooding (renderer then knows to remesh). */
  update(): boolean {
    let anyDirty = false;
    for (const c of this.world.chunks.values()) {
      if (c.lightDirty) {
        anyDirty = true;
        break;
      }
    }
    if (!anyDirty) return false;

    this.staticSeeds = null; // world changed — reflood()'s static cache is stale

    // Global re-flood. For the sandbox this is a handful of chunks; the
    // streaming version will scope this to the dirty region + a bleed margin.
    const queue: QItem[] = [];
    for (const c of this.world.chunks.values()) {
      c.light.fill(0);
      this.seedChunk(c, queue);
      c.lightDirty = false;
    }
    this.propagate(queue);
    for (const c of this.world.chunks.values()) c.dirty = true;
    return true;
  }

  /**
   * Re-flood from static emissive voxels PLUS dynamic point emitters (charged
   * flora), to drive the sampled light volume so the world light responds to
   * charge. Does NOT dirty or re-mesh chunks — it only refreshes chunk.light for
   * the volume to read. Cheap: the dark bounds the BFS, and the static seeds are
   * collected once and cached (update() invalidates them when the world changes).
   */
  reflood(emitters: readonly { x: number; y: number; z: number; level: number }[]): void {
    if (!this.staticSeeds) {
      const seeds: QItem[] = [];
      for (const c of this.world.chunks.values()) {
        for (let ly = 0; ly < CS; ly++) {
          for (let lz = 0; lz < CS; lz++) {
            for (let lx = 0; lx < CS; lx++) {
              const em = MATERIALS[c.voxels[Chunk.index(lx, ly, lz)] as Mat].emission;
              if (em > 0) {
                seeds.push({ x: c.cx * CS + lx, y: c.cy * CS + ly, z: c.cz * CS + lz, l: em });
              }
            }
          }
        }
      }
      this.staticSeeds = seeds;
    }

    const queue: QItem[] = [];
    for (const c of this.world.chunks.values()) c.light.fill(0);
    for (const s of this.staticSeeds) this.seedAt(s.x, s.y, s.z, s.l, queue);
    for (const e of emitters) {
      if (e.level > 0) this.seedAt(e.x, e.y, e.z, Math.min(MAXL, Math.round(e.level)), queue);
    }
    this.propagate(queue);
  }

  /**
   * ADDITIVE local flood for newly-placed emissive voxels (ward placement).
   * Exact when the edit only adds light — replaced voxels stay opaque, so
   * max-combine relaxation reaches the same fixpoint as a global reflood
   * while touching ~6 chunks instead of every chunk in the world (placing a
   * ward was re-lighting and re-meshing the entire map: ~5s on the phone).
   * Touched chunks are marked dirty (remesh) and light-clean.
   */
  addLight(cells: readonly { x: number; y: number; z: number }[]): void {
    this.staticSeeds = null; // new static emitters — reflood()'s cache is stale
    const queue: QItem[] = [];
    const touched = new Set<Chunk>();
    for (const c of cells) {
      const em = MATERIALS[this.world.get(c.x, c.y, c.z)].emission;
      if (em > 0) this.seedAt(c.x, c.y, c.z, em, queue, touched);
    }
    this.propagate(queue, touched);
    for (const c of touched) {
      c.dirty = true;
      c.lightDirty = false;
    }
  }

  /** Force a light level at a world voxel and queue it for propagation. */
  private seedAt(x: number, y: number, z: number, level: number, queue: QItem[], touched?: Set<Chunk>): void {
    const c = this.world.getChunk(Math.floor(x / CS), Math.floor(y / CS), Math.floor(z / CS));
    if (!c) return;
    const lx = ((x % CS) + CS) % CS;
    const ly = ((y % CS) + CS) % CS;
    const lz = ((z % CS) + CS) % CS;
    const i = Chunk.index(lx, ly, lz);
    if (level > c.light[i]) {
      c.light[i] = level;
      touched?.add(c);
      queue.push({ x, y, z, l: level });
    }
  }

  private seedChunk(c: Chunk, queue: QItem[]): void {
    for (let ly = 0; ly < CS; ly++) {
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const m = c.voxels[Chunk.index(lx, ly, lz)] as Mat;
          const emission = MATERIALS[m].emission;
          if (emission > 0) {
            const i = Chunk.index(lx, ly, lz);
            if (emission > c.light[i]) {
              c.light[i] = emission;
              queue.push({ x: c.cx * CS + lx, y: c.cy * CS + ly, z: c.cz * CS + lz, l: emission });
            }
          }
        }
      }
    }
  }

  private propagate(queue: QItem[], touched?: Set<Chunk>): void {
    let head = 0;
    while (head < queue.length) {
      const { x, y, z, l } = queue[head++];
      if (l <= 1) continue;
      const next = l - 1;
      this.spread(x + 1, y, z, next, queue, touched);
      this.spread(x - 1, y, z, next, queue, touched);
      this.spread(x, y + 1, z, next, queue, touched);
      this.spread(x, y - 1, z, next, queue, touched);
      this.spread(x, y, z + 1, next, queue, touched);
      this.spread(x, y, z - 1, next, queue, touched);
    }
  }

  private spread(x: number, y: number, z: number, level: number, queue: QItem[], touched?: Set<Chunk>): void {
    // Light only travels through open (non-opaque) space. Opaque solids stop it,
    // but their air-facing neighbours are what the mesher samples, so faces of a
    // wall next to a lit cell still read as lit.
    const m = this.world.get(x, y, z);
    if (isSolid(m) && m !== Mat.Glass) return;
    const c = this.world.getChunk(
      Math.floor(x / CS),
      Math.floor(y / CS),
      Math.floor(z / CS),
    );
    if (!c) return;
    const lx = ((x % CS) + CS) % CS;
    const ly = ((y % CS) + CS) % CS;
    const lz = ((z % CS) + CS) % CS;
    const i = Chunk.index(lx, ly, lz);
    if (c.light[i] >= level) return;
    c.light[i] = level;
    touched?.add(c);
    queue.push({ x, y, z, l: level });
  }

  /** Light level (0..MAX) at a cell — used by meshers and flora baking.
   *  Accepts fractional coords (flora sits on fractional surface heights). */
  sample(x: number, y: number, z: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const c = this.world.getChunk(
      Math.floor(x / CS),
      Math.floor(y / CS),
      Math.floor(z / CS),
    );
    if (!c) return 0;
    const lx = ((x % CS) + CS) % CS;
    const ly = ((y % CS) + CS) % CS;
    const lz = ((z % CS) + CS) % CS;
    return c.light[Chunk.index(lx, ly, lz)];
  }

  private fastChunk: Chunk | null = null;
  private fastGX = NaN;
  private fastGY = NaN;
  private fastGZ = NaN;

  /** Like sample() but caches the last chunk — fast for the spatially-coherent
   *  sweep that repacks the light volume (avoids a map lookup per texel). */
  sampleFast(x: number, y: number, z: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    const gx = Math.floor(x / CS);
    const gy = Math.floor(y / CS);
    const gz = Math.floor(z / CS);
    if (gx !== this.fastGX || gy !== this.fastGY || gz !== this.fastGZ) {
      this.fastChunk = this.world.getChunk(gx, gy, gz) ?? null;
      this.fastGX = gx;
      this.fastGY = gy;
      this.fastGZ = gz;
    }
    const c = this.fastChunk;
    if (!c) return 0;
    const lx = ((x % CS) + CS) % CS;
    const ly = ((y % CS) + CS) % CS;
    const lz = ((z % CS) + CS) % CS;
    return c.light[Chunk.index(lx, ly, lz)];
  }

  static normalize(level: number): number {
    return level / MAXL;
  }
}
