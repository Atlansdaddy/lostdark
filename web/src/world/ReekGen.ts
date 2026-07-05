/**
 * The Reek — procedural biome generator (GDD §5e: fixed skeleton, procedural
 * flesh, hand-authored highlights).
 *
 * STRUCTURE (open-sky revision):
 *   sky       open night above — no ceiling; the SkyDome renders it
 *   surface   rolling fungal ground, groves/trees/grass, ringed by rim-cliffs
 *   entrances crater funnels sinking from the surface into the dark below
 *   caves     a carved network under the ground: passages of varying height
 *             opening into large CAVERN ROOMS with hanging mycelium, shelf
 *             fungi, cave groves and crystals — deeper = darker = richer
 *
 * Everything is SEEDED and POSITION-DETERMINISTIC: every value derives from
 * (x, z, seed) hashes, never iteration order — the contract that lets this
 * generate one chunk at a time for the streamed 150–225 km² world later.
 */

import { Mat } from './Materials';
import { VoxelWorld } from './VoxelWorld';

export interface ReekHooks {
  /** A smooth glowcap mushroom: base position, stalk height. */
  grove(x: number, y: number, z: number, height: number): void;
  /** A crystal cluster's light, for the fog registry. */
  crystalLight(x: number, y: number, z: number): void;
  /** A glowspore pickup. */
  pickup(x: number, y: number, z: number): void;
  /** A blade-tuft of reek-grass (instanced by the caller). */
  grass(x: number, y: number, z: number): void;
  /** A spore-tree: base position, trunk height. */
  tree(x: number, y: number, z: number, height: number): void;
  /** A clump of tiny button-caps hugging the ground. */
  buttons(x: number, y: number, z: number): void;
  /** A mycelium strand hanging from an overhead anchor, glow-tipped. */
  strand(x: number, anchorY: number, z: number, length: number): void;
  /** Shelf mycelium jutting from a cave wall; (dx,dz) = out-of-wall normal. */
  shelf(x: number, y: number, z: number, dx: number, dz: number): void;
}

export interface ReekResult {
  spawn: [number, number, number];
  beacons: [number, number, number][];
  entrances: [number, number][];
}

// --- Deterministic hash / noise (position + seed → value, no state) ---

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function vnoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm2(x: number, y: number, seed: number, octaves = 3): number {
  let v = 0;
  let amp = 0.55;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += vnoise2(x * f, y * f, seed + i * 101) * amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v;
}

// --- Field functions: the world as pure functions of (x, z) ---

function floorHeight(x: number, z: number, seed: number): number {
  return Math.round(fbm2(x * 0.022, z * 0.022, seed) * 5 - 1.5);
}

const BEDROCK = -12;

interface CaveSpan {
  carved: boolean;
  cf: number; // cave floor (last solid y below the void)
  cc: number; // cave ceiling (last open y; solid resumes above)
  room: boolean;
}

/** The cave network as a pure column function. */
function caveSpan(x: number, z: number, seed: number): CaveSpan {
  const caveN = fbm2(x * 0.032 + 503, z * 0.032 + 211, seed + 13);
  if (caveN <= 0.52) return { carved: false, cf: 0, cc: 0, room: false };
  const cf = -9 + Math.floor(fbm2(x * 0.05 + 777, z * 0.05 + 333, seed + 37) * 2.99);
  // Passages breathe: 2–5 tall, always shifting.
  let cc = cf + 2 + Math.floor(fbm2(x * 0.06 + 111, z * 0.06 + 222, seed + 41) * 3.99);
  // Large cavern rooms where the room-field peaks: up to ~8–10 tall.
  const roomN = fbm2(x * 0.018 + 901, z * 0.018 + 877, seed + 29);
  const room = roomN > 0.58;
  if (room) {
    cc = Math.max(cc, cf + 7 + Math.floor((roomN - 0.58) * 30));
  }
  cc = Math.min(cc, -2); // rooms vault high but never breach the surface
  return { carved: cc > cf, cf, cc, room };
}

export function generateReek(
  world: VoxelWorld,
  seed: number,
  half: number,
  hooks: ReekHooks,
): ReekResult {
  // --- Entrances: crater funnels where the surface gives into cave rooms ---
  const entrances: [number, number][] = [];
  for (let gx = -half + 20; gx < half - 20 && entrances.length < 4; gx += 24) {
    for (let gz = -half + 20; gz < half - 20 && entrances.length < 4; gz += 24) {
      if (hash2(gx / 24, gz / 24, seed + 401) > 0.8) {
        const jx = gx + Math.floor((hash2(gx, gz, seed + 409) - 0.5) * 8);
        const jz = gz + Math.floor((hash2(gz, gx, seed + 419) - 0.5) * 8);
        const span = caveSpan(jx, jz, seed);
        if (span.carved && span.room) entrances.push([jx, jz]);
      }
    }
  }

  const ENTRANCE_R = 9;

  // --- Terrain columns ---
  for (let x = -half; x < half; x++) {
    for (let z = -half; z < half; z++) {
      const fh = floorHeight(x, z, seed);
      const border = x <= -half + 2 || x >= half - 3 || z <= -half + 2 || z >= half - 3;

      if (border) {
        // Rim cliffs: the valley's edge rises instead of a roof closing in.
        const rim = fh + 10 + Math.floor(fbm2(x * 0.07, z * 0.07, seed + 51) * 8);
        for (let y = BEDROCK; y <= rim; y++) world.set(x, y, z, Mat.Stone);
        continue;
      }

      const span = caveSpan(x, z, seed);

      // Entrance craters: an open funnel from the surface into the cave.
      let cutY = fh + 1; // nothing cut by default
      for (const [ex, ez] of entrances) {
        const d = Math.hypot(x - ex, z - ez);
        if (d < ENTRANCE_R && span.carved) {
          const t = d / ENTRANCE_R;
          const c = span.cf + 1 + Math.pow(t, 1.35) * (fh - span.cf);
          cutY = Math.min(cutY, Math.floor(c));
        }
      }

      for (let y = BEDROCK; y <= fh; y++) {
        if (span.carved && y > span.cf && y <= span.cc) continue; // cave void
        if (y >= cutY) continue; // entrance funnel
        const dirtTop = y >= fh - 1 && fbm2(x * 0.06, z * 0.06, seed + 23) > 0.45;
        world.set(x, y, z, dirtTop ? Mat.Dirt : Mat.Stone);
      }

      // Reek-grass on intact surface only.
      if (cutY > fh && hash2(x, z, seed + 131) > 0.74) {
        hooks.grass(x, fh + 1, z);
      }
    }
  }

  // --- SURFACE POIs on a coarse grid ---
  const groves: [number, number, number][] = [];
  const beacons: [number, number, number][] = [];
  const STEP = 16;

  for (let gx = -half + STEP; gx < half - STEP; gx += STEP) {
    for (let gz = -half + STEP; gz < half - STEP; gz += STEP) {
      const r = hash2(gx / STEP, gz / STEP, seed + 47);
      const jx = gx + Math.floor((hash2(gx, gz, seed + 53) - 0.5) * 10);
      const jz = gz + Math.floor((hash2(gz, gx, seed + 59) - 0.5) * 10);
      const fy = floorHeight(jx, jz, seed) + 1;
      // Skip POIs that fall into an entrance crater.
      let inCrater = false;
      for (const [ex, ez] of entrances) {
        if (Math.hypot(jx - ex, jz - ez) < ENTRANCE_R + 3) inCrater = true;
      }
      if (inCrater) continue;

      if (r < 0.42) {
        // Glowcap grove: 2–4 mushrooms + GlowAir seeds + a pickup or two.
        groves.push([jx, fy, jz]);
        const count = 2 + Math.floor(hash2(jx, jz, seed + 61) * 3);
        for (let m = 0; m < count; m++) {
          const mx = jx + Math.floor((hash2(jx + m, jz, seed + 67) - 0.5) * 7);
          const mz = jz + Math.floor((hash2(jz + m, jx, seed + 71) - 0.5) * 7);
          const my = floorHeight(mx, mz, seed) + 1;
          const h = 2.5 + hash2(mx, mz, seed + 73) * 3;
          hooks.grove(mx, my, mz, h);
          world.set(mx, Math.round(my + h + 1), mz, Mat.GlowAir);
        }
        if (hash2(jx, jz, seed + 79) > 0.35) hooks.pickup(jx + 1, fy + 1.4, jz - 1);
        if (hash2(jz, jx, seed + 83) > 0.6) hooks.pickup(jx - 2, fy + 1.6, jz + 2);
        for (let b = 0; b < 2; b++) {
          if (hash2(jx + b * 7, jz - b * 5, seed + 157) > 0.4) {
            const bx = jx + Math.floor((hash2(jx, b, seed + 163) - 0.5) * 12);
            const bz = jz + Math.floor((hash2(jz, b, seed + 167) - 0.5) * 12);
            hooks.buttons(bx, floorHeight(bx, bz, seed) + 1, bz);
          }
        }
      } else if (r < 0.56) {
        // Crystal node.
        for (let c = 0; c < 5; c++) {
          const cx = jx + (c % 3) - 1;
          const cz = jz + Math.floor(hash2(c, jx, seed + 89) * 3) - 1;
          const chh = 1 + Math.floor(hash2(cx, cz, seed + 97) * 3);
          const cy = floorHeight(cx, cz, seed) + 1;
          for (let y = cy; y < cy + chh; y++) world.set(cx, y, cz, Mat.Crystal);
        }
        hooks.crystalLight(jx, fy + 2, jz);
      } else if (r < 0.68) {
        // Undergrowth clearings: button clumps between the groves.
        hooks.buttons(jx, fy, jz);
        if (hash2(jz, jx, seed + 171) > 0.5) {
          hooks.buttons(jx + 5, floorHeight(jx + 5, jz - 3, seed) + 1, jz - 3);
        }
      } else if (r >= 0.72 && r < 0.9) {
        // Spore-tree stand: 1–2 tall trees under the open sky.
        const count = 1 + Math.floor(hash2(jx, jz, seed + 137) * 2);
        for (let t = 0; t < count; t++) {
          const tx = jx + Math.floor((hash2(jx + t, jz, seed + 139) - 0.5) * 8);
          const tz = jz + Math.floor((hash2(jz + t, jx, seed + 149) - 0.5) * 8);
          const ty = floorHeight(tx, tz, seed) + 1;
          const th = 7 + hash2(tx, tz, seed + 151) * 4;
          hooks.tree(tx, ty, tz, th);
          world.set(tx, Math.round(ty + th + 1), tz, Mat.GlowAir);
        }
      } else if (r > 0.93) {
        // PREBAKED SET-PIECE: a dead Keeper beacon — worldbuilding whisper.
        beacons.push([jx, fy, jz]);
        for (let y = fy; y < fy + 7; y++) world.set(jx, y, jz, Mat.Metal);
        world.set(jx, fy + 7, jz, Mat.Glass);
        world.set(jx + 1, fy + 5, jz, Mat.Metal);
        world.set(jx - 1, fy + 5, jz, Mat.Metal);
        for (let a = 0; a < 8; a++) {
          const rx = jx + Math.round(Math.cos(a * 0.785) * 3);
          const rz = jz + Math.round(Math.sin(a * 0.785) * 3);
          if (hash2(rx, rz, seed + 103) > 0.5) {
            world.set(rx, floorHeight(rx, rz, seed) + 1, rz, Mat.Stone);
          }
        }
      }
    }
  }

  // --- CAVE POIs: the underdark furnished (rooms get the full ecosystem) ---
  const CSTEP = 12;
  for (let gx = -half + CSTEP; gx < half - CSTEP; gx += CSTEP) {
    for (let gz = -half + CSTEP; gz < half - CSTEP; gz += CSTEP) {
      const jx = gx + Math.floor((hash2(gx, gz, seed + 211) - 0.5) * 8);
      const jz = gz + Math.floor((hash2(gz, gx, seed + 223) - 0.5) * 8);
      const span = caveSpan(jx, jz, seed);
      if (!span.carved) continue;
      const r = hash2(jx, jz, seed + 227);

      if (span.room) {
        // Cave grove — larger, stranger mushrooms in the big dark rooms.
        if (r < 0.55) {
          const count = 1 + Math.floor(hash2(jx, jz, seed + 229) * 3);
          for (let m = 0; m < count; m++) {
            const mx = jx + Math.floor((hash2(jx + m, jz, seed + 233) - 0.5) * 6);
            const mz = jz + Math.floor((hash2(jz + m, jx, seed + 239) - 0.5) * 6);
            const ms = caveSpan(mx, mz, seed);
            if (!ms.carved) continue;
            const h = 3 + hash2(mx, mz, seed + 241) * 3.5;
            hooks.grove(mx, ms.cf + 1, mz, Math.min(h, ms.cc - ms.cf - 1.5));
            world.set(mx, Math.min(Math.round(ms.cf + 1 + h + 1), ms.cc), mz, Mat.GlowAir);
          }
          if (hash2(jz, jx, seed + 251) > 0.5) hooks.pickup(jx + 1, span.cf + 2.4, jz);
        }
        // Hanging mycelium from the room ceiling.
        const strands = 2 + Math.floor(hash2(jx, jz, seed + 257) * 3);
        for (let s = 0; s < strands; s++) {
          const sx = jx + Math.floor((hash2(jx + s, jz, seed + 263) - 0.5) * 9);
          const sz = jz + Math.floor((hash2(jz + s, jx, seed + 269) - 0.5) * 9);
          const ss = caveSpan(sx, sz, seed);
          if (!ss.carved) continue;
          const maxLen = ss.cc - ss.cf - 1.2;
          if (maxLen < 1) continue;
          hooks.strand(sx, ss.cc + 0.9, sz, Math.min(1.5 + hash2(sx, sz, seed + 271) * 2.5, maxLen));
        }
        // Shelf mycelium on the room's walls: probe outward for solid columns.
        const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dz] of DIRS) {
          if (hash2(jx + dx * 3, jz + dz * 3, seed + 277) < 0.45) continue;
          for (let step = 2; step <= 7; step++) {
            const wx = jx + dx * step;
            const wz = jz + dz * step;
            if (!caveSpan(wx, wz, seed).carved) {
              // Wall found: shelf sits on the last open column, facing back in.
              const ox = jx + dx * (step - 1);
              const oz = jz + dz * (step - 1);
              const os = caveSpan(ox, oz, seed);
              if (os.carved && os.cc - os.cf > 2) {
                const sy = os.cf + 2 + hash2(ox, oz, seed + 281) * (os.cc - os.cf - 2);
                hooks.shelf(ox + dx * 0.5, sy, oz + dz * 0.5, -dx, -dz);
              }
              break;
            }
          }
        }
        // Crystals give the deep rooms their cold light.
        if (r > 0.72) {
          world.set(jx + 2, span.cf + 1, jz + 2, Mat.Crystal);
          world.set(jx + 2, span.cf + 2, jz + 2, Mat.Crystal);
          hooks.crystalLight(jx + 2, span.cf + 2, jz + 2);
        }
      } else {
        // Passages: sparse life — a rare crystal, a rare clump of buttons.
        if (r > 0.82) {
          world.set(jx, span.cf + 1, jz, Mat.Crystal);
          hooks.crystalLight(jx, span.cf + 1, jz);
        } else if (r < 0.12) {
          hooks.buttons(jx, span.cf + 1, jz);
        }
      }
    }
  }

  // Spawn at the surface grove nearest the origin (a warm hollow to wake in).
  let spawn: [number, number, number] = [0, 4, 0];
  let best = Infinity;
  for (const [gx, gy, gz] of groves) {
    const d = gx * gx + gz * gz;
    if (d < best) {
      best = d;
      spawn = [gx + 2, gy + 2.5, gz + 2];
    }
  }

  return { spawn, beacons, entrances };
}
