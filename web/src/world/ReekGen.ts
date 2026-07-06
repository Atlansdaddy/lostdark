/**
 * The Reek — procedural biome generator (GDD §5e: fixed skeleton, procedural
 * flesh, hand-authored highlights).
 *
 * STRUCTURE (deep-caves revision):
 *   sky       open night above — no ceiling; the SkyDome renders it
 *   surface   rolling fungal ground, groves/trees/grass, ringed by rim-cliffs
 *   entrances crater shafts sinking from the surface down into the dark below
 *   caves     a TRUE 3D network carved through the rock from just under the
 *             crust down to bedrock: worm passages & crawl-tunnels of varying
 *             width weaving between big CAVERN ROOMS, linked by vertical shafts.
 *             Deeper = taller rooms, darker, richer (shelf fungi, hanging
 *             mycelium, crystals). The dark is the point; light is earned.
 *
 * Everything is SEEDED and POSITION-DETERMINISTIC: every value derives from
 * (x, y, z, seed) hashes, never iteration order — the contract that lets this
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

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 15), 668265263);
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

// Trilinear 3D value noise, normalised to ~[0,1] (mean ≈ 0.5) so the cavern
// threshold and the centred tunnel test below are symmetric and tunable.
function vnoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const fz = smooth(z - zi);
  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

function fbm3(x: number, y: number, z: number, seed: number, octaves = 2): number {
  let v = 0;
  let amp = 0.55;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += vnoise3(x * f, y * f, z * f, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v / norm; // ~0..1, mean ≈ 0.5
}

// --- Field functions: the world as pure functions of (x, y, z) ---

function floorHeight(x: number, z: number, seed: number): number {
  return Math.round(fbm2(x * 0.022, z * 0.022, seed) * 5 - 1.5);
}

// The cave layer runs from just under the surface crust down to bedrock — a
// deep, walkable band (was a ~10-voxel sheet; now ~35 tall).
const BEDROCK = -40;
const CRUST = 3; // solid cap kept between the local surface and the first cave
const CAVE_FLOOR = BEDROCK + 1; // lowest y that can be cave air

/** The highest y a cave may open at this column (leaves the surface crust). */
function caveTop(x: number, z: number, seed: number): number {
  return floorHeight(x, z, seed) - CRUST;
}

/** Cave-country mask: a low-frequency 2D field. Caves only exist where it's
 *  high, so they CLUSTER into systems separated by big solid rock — this is
 *  both the variety ("some areas riddled, some solid") and the perf discipline
 *  (far less exposed cave-wall surface for the mesher than uniform Swiss cheese). */
function caveRegion(x: number, z: number, seed: number): number {
  return fbm2(x * 0.013 + 301, z * 0.013 + 709, seed + 91, 3);
}

/**
 * The 3D cave field: TRUE volumetric carving, evaluated per voxel.
 *   • Caverns  — rounded rooms from a blob field; a little bigger/commoner in a
 *                region's core and with depth ("worth going deep").
 *   • Tunnels  — the intersection of two zero-sets forms a wandering tube; its
 *                radius breathes from a crawl-space to a broad passage.
 * Both share the same (x,y,z) space, so tunnels naturally bore INTO caverns and
 * wander vertically into shafts — one function yields the whole network, but
 * only inside cave-country (the region mask), never everywhere.
 */
function caveAir(x: number, y: number, z: number, seed: number): boolean {
  const top = caveTop(x, z, seed);
  if (y > top || y <= CAVE_FLOOR) return false;
  const region = caveRegion(x, z, seed);
  if (region < 0.52) return false; // solid rock outside cave-country
  const rgn = Math.min(1, (region - 0.52) / 0.18); // 0 at the edge → 1 in the core

  const span = top - CAVE_FLOOR;
  const depth = span > 0 ? (top - y) / span : 0; // 0 at the crust → 1 at bedrock

  // Caverns: rooms where the blob field peaks. Higher y-frequency keeps them
  // from running arbitrarily tall; threshold eases with depth and region core.
  const cav = fbm3(x * 0.032, y * 0.09, z * 0.032, seed + 29, 2);
  if (cav > 0.80 - depth * 0.10 - rgn * 0.06) return true;

  // Tunnels / passages: a circular tube where two noises both cross their mid.
  // Radius breathes from crawl-space to passage, and thins toward the region
  // edge so systems taper into the rock instead of ending in a wall.
  const rad = (0.045 + fbm3(x * 0.02, y * 0.03, z * 0.02, seed + 71, 2) * 0.06) * (0.5 + 0.5 * rgn);
  const a = fbm3(x * 0.05, y * 0.08, z * 0.05, seed + 13, 2) - 0.5;
  const b = fbm3(x * 0.05 + 21.7, y * 0.08 + 9.1, z * 0.05 + 3.3, seed + 41, 2) - 0.5;
  if (a * a + b * b < rad * rad) return true;

  return false;
}

interface Span {
  cf: number; // cave floor (lowest air voxel)
  cc: number; // cave ceiling (highest air voxel)
}

/** All open air spans in a column, top-to-bottom — a column may pierce several
 *  stacked levels now, so POIs are placed per span, not per column. */
function columnSpans(x: number, z: number, seed: number): Span[] {
  const spans: Span[] = [];
  const top = caveTop(x, z, seed);
  let inAir = false;
  let cc = 0;
  for (let y = top; y > CAVE_FLOOR; y--) {
    const air = caveAir(x, y, z, seed);
    if (air && !inAir) {
      inAir = true;
      cc = y; // first air from the top of this run = its ceiling
    } else if (!air && inAir) {
      inAir = false;
      spans.push({ cf: y + 1, cc });
    }
  }
  if (inAir) spans.push({ cf: CAVE_FLOOR + 1, cc });
  return spans;
}

interface Entrance {
  x: number;
  z: number;
  by: number; // the y the funnel bottoms out at (opens into the cave)
}

export function generateReek(
  world: VoxelWorld,
  seed: number,
  half: number,
  hooks: ReekHooks,
): ReekResult {
  // --- Entrances: crater shafts where the surface gives into the caves ---
  const ents: Entrance[] = [];
  for (let gx = -half + 20; gx < half - 20 && ents.length < 5; gx += 22) {
    for (let gz = -half + 20; gz < half - 20 && ents.length < 5; gz += 22) {
      if (hash2(gx / 22, gz / 22, seed + 401) <= 0.78) continue;
      const jx = gx + Math.floor((hash2(gx, gz, seed + 409) - 0.5) * 8);
      const jz = gz + Math.floor((hash2(gz, gx, seed + 419) - 0.5) * 8);
      const fh = floorHeight(jx, jz, seed);
      // The shaft only opens where a cave rises fairly near the surface, and
      // only onto a genuine room (so you drop into a space, not a crack).
      const spans = columnSpans(jx, jz, seed);
      let mouth: Span | null = null;
      for (const s of spans) {
        if (s.cc >= fh - 12 && s.cc - s.cf >= 4) {
          mouth = s;
          break;
        }
      }
      if (mouth) ents.push({ x: jx, z: jz, by: mouth.cf });
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

      // Entrance shafts: a funnel opening from the surface down into the cave.
      let cutY = fh + 1; // nothing cut by default
      for (const e of ents) {
        const d = Math.hypot(x - e.x, z - e.z);
        if (d < ENTRANCE_R) {
          const t = d / ENTRANCE_R;
          const c = e.by + 1 + Math.pow(t, 1.5) * (fh - e.by);
          cutY = Math.min(cutY, Math.floor(c));
        }
      }

      for (let y = BEDROCK; y <= fh; y++) {
        if (y >= cutY) continue; // entrance funnel
        if (caveAir(x, y, z, seed)) continue; // cave void
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
      for (const e of ents) {
        if (Math.hypot(jx - e.x, jz - e.z) < ENTRANCE_R + 3) inCrater = true;
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

  // --- CAVE POIs: the underdark furnished, level by level ---
  // A coarse grid; each cell scans its column's spans and dresses each open
  // space by size. Caverns get the full ecosystem, passages a sparse whisper,
  // and everything grows richer (denser, more crystals) the deeper it sits.
  const CSTEP = 10;
  const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let gx = -half + CSTEP; gx < half - CSTEP; gx += CSTEP) {
    for (let gz = -half + CSTEP; gz < half - CSTEP; gz += CSTEP) {
      const jx = gx + Math.floor((hash2(gx, gz, seed + 211) - 0.5) * 7);
      const jz = gz + Math.floor((hash2(gz, gx, seed + 223) - 0.5) * 7);
      const top = caveTop(jx, jz, seed);
      const spanRange = top - CAVE_FLOOR;

      for (const span of columnSpans(jx, jz, seed)) {
        const h = span.cc - span.cf;
        if (h < 2) continue;
        const midY = (span.cf + span.cc) * 0.5;
        const depth = spanRange > 0 ? (top - midY) / spanRange : 0; // 0 top → 1 deep
        const r = hash2(jx, jz + span.cf * 131, seed + 227);
        const cavern = h >= 6;

        if (cavern) {
          // Cave grove — larger, stranger glowcaps. Deeper rooms hold more.
          if (r < 0.6) {
            const count = 1 + Math.floor(hash2(jx, jz, seed + 229) * (2 + depth * 2));
            for (let m = 0; m < count; m++) {
              const mx = jx + Math.floor((hash2(jx + m, jz, seed + 233) - 0.5) * 6);
              const mz = jz + Math.floor((hash2(jz + m, jx, seed + 239) - 0.5) * 6);
              if (!caveAir(mx, span.cf + 1, mz, seed)) continue;
              const gh = 3 + hash2(mx, mz, seed + 241) * (2.5 + depth * 2);
              hooks.grove(mx, span.cf + 1, mz, Math.min(gh, h - 1.5));
              // A sparse few glow from the start — most stay dark until charged.
              if (hash2(mx, mz, seed + 245) > 0.62) {
                world.set(mx, Math.min(Math.round(span.cf + 1 + gh + 1), span.cc), mz, Mat.GlowAir);
              }
            }
            if (hash2(jz, jx, seed + 251) > 0.5) hooks.pickup(jx + 1, span.cf + 2.4, jz);
          }

          // Hanging mycelium from the room ceiling.
          const strands = 2 + Math.floor(hash2(jx, jz, seed + 257) * 3);
          for (let s = 0; s < strands; s++) {
            const sx = jx + Math.floor((hash2(jx + s, jz, seed + 263) - 0.5) * 9);
            const sz = jz + Math.floor((hash2(jz + s, jx, seed + 269) - 0.5) * 9);
            if (!caveAir(sx, span.cc, sz, seed)) continue;
            const maxLen = h - 1.2;
            if (maxLen < 1) continue;
            hooks.strand(sx, span.cc + 0.9, sz, Math.min(1.5 + hash2(sx, sz, seed + 271) * 2.5, maxLen));
          }

          // Shelf mycelium: probe outward at a mid height for the first wall.
          for (const [dx, dz] of DIRS) {
            if (hash2(jx + dx * 3, jz + dz * 3, seed + 277) < 0.45) continue;
            const wy = Math.round(span.cf + 1.5 + hash2(jx, jz + dx + dz, seed + 281) * (h - 2.5));
            for (let step = 1; step <= 7; step++) {
              const wx = jx + dx * step;
              const wz = jz + dz * step;
              if (!caveAir(wx, wy, wz, seed)) {
                const ox = jx + dx * (step - 1);
                const oz = jz + dz * (step - 1);
                if (step > 1 && caveAir(ox, wy, oz, seed)) {
                  hooks.shelf(ox + dx * 0.5, wy, oz + dz * 0.5, -dx, -dz);
                }
                break;
              }
            }
          }

          // Crystals give the deep rooms their cold light — more likely deeper.
          if (r > 0.72 - depth * 0.2) {
            world.set(jx + 2, span.cf + 1, jz + 2, Mat.Crystal);
            world.set(jx + 2, span.cf + 2, jz + 2, Mat.Crystal);
            hooks.crystalLight(jx + 2, span.cf + 2, jz + 2);
          }
        } else {
          // Passages / crawl-tunnels: sparse life so the dark stays a pressure.
          if (r > 0.86) {
            world.set(jx, span.cf + 1, jz, Mat.Crystal);
            hooks.crystalLight(jx, span.cf + 1, jz);
          } else if (r < 0.14) {
            hooks.buttons(jx, span.cf + 1, jz);
          } else if (r > 0.5 && r < 0.6 && h >= 3) {
            // An occasional shelf clinging to a passage wall.
            for (const [dx, dz] of DIRS) {
              const wy = span.cf + 1;
              if (!caveAir(jx + dx, wy, jz + dz, seed) && caveAir(jx, wy, jz, seed)) {
                hooks.shelf(jx + dx * 0.5, wy + 0.5, jz + dz * 0.5, -dx, -dz);
                break;
              }
            }
          }
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

  return { spawn, beacons, entrances: ents.map((e) => [e.x, e.z] as [number, number]) };
}
