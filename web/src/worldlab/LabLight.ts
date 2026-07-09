/**
 * WORLDLAB stage-4 lighting — incremental per-column flood fill.
 *
 * The research-verified recipe (docs/RESEARCH_voxel_streaming.md §Lighting):
 * BFS over a FIFO queue, seeded from a column's own emissive voxels, spreading
 * 6-way with level−1 per hop, terminating where the world is already as
 * bright — so work is proportional to the light-affected volume, never the
 * world. Light is baked into the same chunk.light arrays the meshers sample.
 *
 * CROSS-BORDER RULE (the one-chunk-off killer): the BFS walks WORLD
 * coordinates and resolves the owning chunk per write. There is no per-chunk
 * local coordinate space anywhere in this file — the class of bug where a
 * flood writes through the wrong chunk's coordinate space (John's "orb light
 * on the next floor over") cannot be expressed here.
 *
 * ORDER-INDEPENDENCE: floods combine by max(). Each column's rung floods its
 * own seeds; overlapping floods from neighbouring columns relax the same
 * cells toward the same fixpoint, so ladder scheduling order cannot change
 * the result (asserted by the headless lighting test).
 *
 * The ladder guarantees correctness: a column is Lit before any neighbour
 * meshes, and max emission (15) < chunk size (32), so a flood only ever
 * touches the 8 ring-1 neighbours — all Decorated-or-better by then.
 */

import { World } from '../config';
import { Mat, MATERIALS } from '../world/Materials';
import { Chunk, VoxelWorld } from '../world/VoxelWorld';

const CS = World.chunkSize;

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const mod = (a: number, b: number): number => ((a % b) + b) % b;

// Solidity/opacity LUT — light passes air, Glass, and non-solids (water,
// GlowAir), exactly matching the game LightGrid's spread rule.
const BLOCKS_LIGHT = new Uint8Array(32);
for (const m of Object.values(MATERIALS)) {
  BLOCKS_LIGHT[m.id] = m.solid && m.id !== Mat.Glass ? 1 : 0;
}

/** Flood one column's emissive seeds into the world's baked light. */
export function lightColumn(
  world: VoxelWorld,
  cx: number,
  cz: number,
  cyMin: number,
  cyMax: number,
): void {
  // Flat-array FIFO (x,y,z packed alongside level) — no object churn.
  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  const ql: number[] = [];

  // --- Seeds: this column's own emissive voxels, at max(existing, emission).
  for (let cy = cyMin; cy <= cyMax; cy++) {
    const c = world.getChunk(cx, cy, cz);
    if (!c) continue;
    for (let i = 0; i < c.voxels.length; i++) {
      const em = MATERIALS[c.voxels[i] as Mat].emission;
      if (em > 0 && em > c.light[i]) {
        c.light[i] = em;
        // Unpack flat index → local → world (Chunk.index is (ly*CS+lz)*CS+lx).
        const lx = i % CS;
        const lz = floorDiv(i, CS) % CS;
        const ly = floorDiv(i, CS * CS);
        qx.push(cx * CS + lx);
        qy.push(cy * CS + ly);
        qz.push(cz * CS + lz);
        ql.push(em);
      }
    }
  }

  // --- BFS relax, world coordinates only. Memoize the last chunk touched —
  // floods are spatially coherent, so this kills most map lookups.
  let mcx = NaN;
  let mcy = NaN;
  let mcz = NaN;
  let mc: Chunk | undefined;
  const spread = (x: number, y: number, z: number, level: number): void => {
    const gx = floorDiv(x, CS);
    const gy = floorDiv(y, CS);
    const gz = floorDiv(z, CS);
    if (gx !== mcx || gy !== mcy || gz !== mcz) {
      mc = world.getChunk(gx, gy, gz);
      mcx = gx;
      mcy = gy;
      mcz = gz;
    }
    if (!mc) return;
    const i = Chunk.index(mod(x, CS), mod(y, CS), mod(z, CS));
    if (BLOCKS_LIGHT[mc.voxels[i]]) return; // opaque solids stop light
    if (mc.light[i] >= level) return; // already as bright — flood dies here
    mc.light[i] = level;
    qx.push(x);
    qy.push(y);
    qz.push(z);
    ql.push(level);
  };

  let head = 0;
  while (head < qx.length) {
    const x = qx[head];
    const y = qy[head];
    const z = qz[head];
    const l = ql[head++];
    if (l <= 1) continue;
    const n = l - 1;
    spread(x + 1, y, z, n);
    spread(x - 1, y, z, n);
    spread(x, y + 1, z, n);
    spread(x, y - 1, z, n);
    spread(x, y, z + 1, n);
    spread(x, y, z - 1, n);
  }
}
