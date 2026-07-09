/**
 * WORLDLAB stage-1.5 generator — infinite heightfield with SIMPLE BIOME REGIONS.
 *
 * Two very-low-frequency fields drive everything (the classic recipe):
 *   elevation  — basins (water) ← plains → mountains (+snow caps)
 *   moisture   — desert ← plains → forest (with voxel trees)
 *
 * Height is one CONTINUOUS function blended by smoothsteps over elevation —
 * never a hard per-biome switch — so region borders can't tear the terrain.
 * Everything remains a pure function of (x, z, seed): chunk borders can't
 * disagree, and a disposed column regenerates bit-identically.
 *
 * Trees are DECORATION: their canopies intentionally spill across chunk
 * borders — the first real exercise of the ladder's decorate ring.
 *
 * Implements the ColumnGenerator contract the ChunkManager streams through;
 * stage 2 swaps a per-chunk ReekGen behind this same interface.
 */

import { World } from '../config';
import { fbm2, fbm3 } from '../world/ReekGen';
import { Mat } from '../world/Materials';
import { Chunk, VoxelWorld } from '../world/VoxelWorld';
import { PropRecord, PropType } from './Props';

const CS = World.chunkSize;

/** What the ChunkManager needs from any world generator. */
export interface ColumnGenerator {
  /** Vertical chunk range every column occupies (inclusive). */
  readonly cyMin: number;
  readonly cyMax: number;
  /** Fill one column of chunks (cx, cz) with raw voxels. Must be a pure
   *  function of world position + seed — no reads of neighbouring columns. */
  generateColumn(world: VoxelWorld, cx: number, cz: number): void;
  /** Cross-border decoration (POIs, trees). Runs one ring inside generation,
   *  so writes into 8-neighbours are guaranteed to land in existing chunks. */
  decorateColumn(world: VoxelWorld, cx: number, cz: number): void;
  /** Deterministic instanced-prop records for a column (light left 0 —
   *  the ChunkManager samples baked light at mesh time). */
  props?(cx: number, cz: number): PropRecord[];
}

const BEDROCK = -12; // lowest solid y (deep zones return via dungeon anchors, not globally)
export const WATER_Y = 6; // sea level; the lab draws one water plane here
const SNOW_Y = 60; // mountain tops above this wear ice

// --- The underground (stage 2): ReekGen's TRUE 3D cave network, ported as
// pure per-position fields — worm tunnels + cavern rooms clustered into
// cave-country, entered via crater shafts. See world/ReekGen.ts for the
// original commentary; constants match it.
const CRUST = 3; // solid cap kept between the local surface and the first cave
const CAVE_FLOOR = BEDROCK + 1; // lowest y that can be cave air
const ENTRANCE_CELL = 22; // entrance-candidate grid pitch (voxels)
const ENTRANCE_R = 9; // crater funnel radius

/** Uniform hash in [0,1) — ReekGen's recipe. fbm2 is NOT a random roll (it's
 *  bell-curved around ~0.48): using it against tail thresholds made shrooms
 *  near-impossible and grass near-certain. Rolls use THIS; fields use fbm2. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smoothstep = (a: number, b: number, t: number): number => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

export type BiomeName = 'water' | 'desert' | 'forest' | 'plains' | 'mountain';

interface Span {
  cf: number; // cave floor (lowest air voxel)
  cc: number; // cave ceiling (highest air voxel)
}

export interface Entrance {
  x: number;
  z: number;
  by: number; // funnel bottom — opens into the cave mouth
}

export class HeightfieldGen implements ColumnGenerator {
  readonly cyMin = -1; // y −32.. (deep bands come back per-zone with dungeons)
  readonly cyMax = 2; //  y up to 95 (peaks reach ~90)

  /** Entrance candidates are pure per cell but pricey (span scan) — memoized. */
  private readonly entCache = new Map<string, Entrance | null>();

  constructor(private readonly seed: number) {}

  // --- Cave fields (ReekGen port — see its commentary for the design) -------

  /** Cave-country mask — PARKED (returns 0: no natural noise-caves at all).
   *  John's design: the Reek/swamp is the EASY starter zone; caves & dungeons
   *  belong to the badlands (canyon biome, borders the Drown) and arrive via
   *  the procedural DUNGEON BUILDER (zones + guaranteed count/spacing), which
   *  will reuse the cave fields below for organic cavern skins. A possible
   *  underwater hollow beneath the swamps is a parked deliberation, not gen. */
  private caveRegion(_x: number, _z: number): number {
    return 0;
  }

  /** Volumetric cave test with the column's top/region precomputed (the hot
   *  path — generateColumn calls this per below-surface voxel). */
  private caveAirCore(x: number, y: number, z: number, top: number, region: number): boolean {
    if (y > top || y <= CAVE_FLOOR) return false;
    if (region < 0.52) return false; // solid rock outside cave-country
    const rgn = Math.min(1, (region - 0.52) / 0.18);
    const span = top - CAVE_FLOOR;
    const depth = span > 0 ? (top - y) / span : 0;
    // Caverns: rooms where the blob field peaks; bigger/commoner deep + in core.
    const cav = fbm3(x * 0.032, y * 0.09, z * 0.032, this.seed + 29, 2);
    if (cav > 0.8 - depth * 0.1 - rgn * 0.06) return true;
    // Tunnels: a wandering tube where two noises both cross their midline.
    // Radius floor raised from ReekGen's 0.045 — passages read as passages.
    const rad = (0.058 + fbm3(x * 0.02, y * 0.03, z * 0.02, this.seed + 71, 2) * 0.06) * (0.5 + 0.5 * rgn);
    const a = fbm3(x * 0.05, y * 0.08, z * 0.05, this.seed + 13, 2) - 0.5;
    const b = fbm3(x * 0.05 + 21.7, y * 0.08 + 9.1, z * 0.05 + 3.3, this.seed + 41, 2) - 0.5;
    return a * a + b * b < rad * rad;
  }

  /**
   * Cave-air mask for a whole column, index i ↔ y = CAVE_FLOOR+1+i, DILATED
   * two voxels upward: everything the generator carves keeps ≥3 voxels of
   * headroom, so orb travel + the camera boom always fit (John's guarantee —
   * "crawl-space" stays flavor, never a blocker). Same noise cost as the old
   * per-voxel test: the raw samples are computed once and reused.
   */
  private caveMask(x: number, z: number, top: number, region: number): Uint8Array | null {
    if (region < 0.52 || top <= CAVE_FLOOR) return null;
    const n = top - CAVE_FLOOR;
    const raw = new Uint8Array(n);
    let any = 0;
    for (let i = 0; i < n; i++) {
      raw[i] = this.caveAirCore(x, CAVE_FLOOR + 1 + i, z, top, region) ? 1 : 0;
      any |= raw[i];
    }
    if (!any) return null;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      mask[i] = raw[i] | (i >= 1 ? raw[i - 1] : 0) | (i >= 2 ? raw[i - 2] : 0);
    }
    return mask;
  }

  /** Standalone cave test (decorators, tests) — dilated, same as carving. */
  caveAir(x: number, y: number, z: number): boolean {
    const top = this.height(x, z) - CRUST;
    const mask = this.caveMask(x, z, top, this.caveRegion(x, z));
    if (!mask) return false;
    const i = y - CAVE_FLOOR - 1;
    return i >= 0 && i < mask.length && mask[i] === 1;
  }

  /** All open cave spans in a column, top-to-bottom (dilated mask — spans
   *  match exactly what generateColumn carves). */
  private columnSpans(x: number, z: number): Span[] {
    const top = this.height(x, z) - CRUST;
    const mask = this.caveMask(x, z, top, this.caveRegion(x, z));
    const spans: Span[] = [];
    if (!mask) return spans;
    let inAir = false;
    let cc = 0;
    for (let i = mask.length - 1; i >= 0; i--) {
      const y = CAVE_FLOOR + 1 + i;
      if (mask[i] && !inAir) {
        inAir = true;
        cc = y;
      } else if (!mask[i] && inAir) {
        inAir = false;
        spans.push({ cf: y + 1, cc });
      }
    }
    if (inAir) spans.push({ cf: CAVE_FLOOR + 1, cc });
    return spans;
  }

  /** Entrance candidate for one grid cell (pure, memoized): a crater shaft
   *  where the surface gives into a genuine room fairly near the top. */
  entrance(cellX: number, cellZ: number): Entrance | null {
    const key = `${cellX},${cellZ}`;
    const hit = this.entCache.get(key);
    if (hit !== undefined) return hit;
    let e: Entrance | null = null;
    if (hash2(cellX, cellZ, this.seed + 401) > 0.68) {
      const bx = cellX * ENTRANCE_CELL + 11;
      const bz = cellZ * ENTRANCE_CELL + 11;
      const jx = bx + Math.floor((hash2(bx, bz, this.seed + 409) - 0.5) * 8);
      const jz = bz + Math.floor((hash2(bz, bx, this.seed + 419) - 0.5) * 8);
      const fh = this.height(jx, jz);
      if (fh > WATER_Y + 1) {
        // Only onto a real room (drop into a space, not a crack).
        for (const s of this.columnSpans(jx, jz)) {
          if (s.cc >= fh - 16 && s.cc - s.cf >= 4) {
            e = { x: jx, z: jz, by: s.cf };
            break;
          }
        }
      }
    }
    this.entCache.set(key, e);
    return e;
  }

  /** Funnel carve height at a column (Infinity = untouched). */
  private entranceCutY(x: number, z: number, fh: number): number {
    let cut = Infinity;
    const c0x = Math.floor(x / ENTRANCE_CELL);
    const c0z = Math.floor(z / ENTRANCE_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const e = this.entrance(c0x + dx, c0z + dz);
        if (!e) continue;
        const d = Math.hypot(x - e.x, z - e.z);
        if (d < ENTRANCE_R) {
          cut = Math.min(cut, Math.floor(e.by + 1 + Math.pow(d / ENTRANCE_R, 1.5) * (fh - e.by)));
        }
      }
    }
    return cut;
  }

  /** The two region fields, ~0..1 each. Frequencies are LOW on purpose:
   *  regions should span many chunks (~600-voxel features). */
  private fields(x: number, z: number): { elev: number; moist: number } {
    return {
      elev: fbm2(x * 0.0016, z * 0.0016, this.seed + 1013),
      moist: fbm2(x * 0.0016 + 413.7, z * 0.0016 + 89.2, this.seed + 2027),
    };
  }

  /** Swamp factor 0..1 — wet lowland forest pocked with shallow pools (the
   *  proto-Reek's water, John's call: swamps, not just elevation basins). */
  private swampAt(x: number, z: number, elev: number, moist: number): number {
    const gate = smoothstep(0.58, 0.68, moist) * (1 - smoothstep(0.5, 0.6, elev));
    if (gate <= 0) return 0;
    const pool = smoothstep(0.52, 0.68, fbm2(x * 0.035 + 91.3, z * 0.035 + 17.9, this.seed + 5003));
    return gate * pool;
  }

  /** Surface height — one continuous blend, never a per-biome switch. */
  height(x: number, z: number): number {
    const { elev, moist } = this.fields(x, z);
    const rolling =
      fbm2(x * 0.01, z * 0.01, this.seed) * 10 + fbm2(x * 0.045, z * 0.045, this.seed + 501) * 3;
    const mtn = smoothstep(0.56, 0.78, elev); // 0 plains → 1 peaks
    // "Mountains felt like hills" (John) — peaks now reach ~90 with ridge
    // detail, and the massif shoulders load more mass under them.
    const mtnH = mtn * (46 + fbm2(x * 0.008, z * 0.008, this.seed + 701) * 38 + fbm2(x * 0.03, z * 0.03, this.seed + 907) * 8);
    const basin = smoothstep(0.42, 0.3, elev); // 0 land → 1 deep water
    const basinDip = basin * (9 + fbm2(x * 0.02, z * 0.02, this.seed + 803) * 4);
    let h = 8 + rolling * (1 - basin * 0.75) + mtnH - basinDip;
    // Swamp pools: pull wet-forest lowlands to just under the waterline.
    const sw = this.swampAt(x, z, elev, moist);
    if (sw > 0) h += (WATER_Y - 1.4 - h) * sw;
    return Math.max(BEDROCK + 2, Math.min(92, Math.floor(h)));
  }

  biomeAt(x: number, z: number): BiomeName {
    const { elev, moist } = this.fields(x, z);
    if (this.height(x, z) <= WATER_Y) return 'water';
    if (smoothstep(0.56, 0.78, elev) > 0.45) return 'mountain';
    if (moist < 0.36) return 'desert';
    if (moist > 0.58) return 'forest';
    return 'plains';
  }

  generateColumn(world: VoxelWorld, cx: number, cz: number): void {
    // Write straight into chunk arrays — world.set()'s per-voxel key hashing
    // and dirty-neighbour bookkeeping is wasted work during bulk generation.
    // Chunks are created LAZILY on first voxel write: pure-air chunks (above
    // low terrain) never exist at all — missing chunk = air to every reader.
    const chunks: (Chunk | undefined)[] = new Array(this.cyMax - this.cyMin + 1);
    const chunkAt = (cy: number): Chunk =>
      (chunks[cy - this.cyMin] ??= world.getChunk(cx, cy, cz, true)!);
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = cx * CS + lx;
        const z = cz * CS + lz;
        const { elev, moist } = this.fields(x, z);
        const h = this.height(x, z);
        const mtn = smoothstep(0.56, 0.78, elev);
        // Surface material by region (heights already blend; tops just paint):
        //   shore/underwater → sand · mountains → stone with ice caps above
        //   the snow line · dry → sand (desert) · otherwise dirt.
        let top: Mat;
        if (h <= WATER_Y + 1) top = Mat.Sand;
        else if (mtn > 0.45) top = h >= SNOW_Y ? Mat.Ice : Mat.Stone;
        else if (moist < 0.36) top = Mat.Sand;
        else top = Mat.Dirt;
        const topDepth = top === Mat.Sand ? 3 : 2;

        // Glow-moss (proto-Reek: "the ground should glow") — emissive Glowcap
        // ground patches in wet forest, denser along swamp-pool banks. Being
        // emissive voxels, the Lit rung seeds them automatically.
        const forestish = moist > 0.58 && mtn <= 0.45;
        const moss =
          forestish &&
          h > WATER_Y &&
          hash2(x, z, this.seed + 5101) < (h <= WATER_Y + 2 ? 0.12 : 0.035);

        // Underground: cave carving (dilated mask — ≥3 voxels of headroom
        // everywhere, John's travel/camera guarantee) + entrance funnels.
        const caveTop = h - CRUST;
        const mask = this.caveMask(x, z, caveTop, this.caveRegion(x, z));
        const cut = this.entranceCutY(x, z, h);

        let cur: Chunk | null = null;
        let curCy = 1e9;
        for (let y = BEDROCK; y <= h; y++) {
          if (y >= cut) continue; // entrance funnel
          if (mask) {
            const mi = y - CAVE_FLOOR - 1;
            if (mi >= 0 && mi < mask.length && mask[mi]) continue; // cave void
          }
          const cy = Math.floor(y / CS);
          if (cy !== curCy) {
            curCy = cy;
            cur = chunkAt(cy);
          }
          cur!.voxels[Chunk.index(lx, y - cy * CS, lz)] =
            y === h && moss ? Mat.Glowcap : y > h - topDepth ? top : Mat.Stone;
        }
      }
    }
    for (const chunk of chunks) {
      if (!chunk) continue;
      chunk.dirty = true;
      chunk.lightDirty = true;
    }
  }

  /** Instanced ground props on a jittered grid — glowshrooms (which also cast
   *  baked light via a GlowAir marker stamped in decorateColumn), rocks, and
   *  grass tufts, all biome-gated. Pure function of (cx, cz, seed). */
  props(cx: number, cz: number): PropRecord[] {
    const out: PropRecord[] = [];
    const STEP = 4;
    for (let gz = 0; gz < CS; gz += STEP) {
      for (let gx = 0; gx < CS; gx += STEP) {
        const wx = cx * CS + gx;
        const wz = cz * CS + gz;
        const x = wx + hash2(wx, wz, this.seed + 4001) * (STEP - 1);
        const z = wz + hash2(wz, wx, this.seed + 4013) * (STEP - 1);
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        const h = this.height(ix, iz);

        // Spore-motes: glowing AIR (John) — omnidirectional emitter points
        // drifting over wet forest, including above the swamp pools.
        const { elev, moist } = this.fields(ix, iz);
        const forestish = moist > 0.58 && smoothstep(0.56, 0.78, elev) <= 0.45;
        const mroll = hash2(ix + 7, iz - 13, this.seed + 5201);
        if (forestish && mroll < 0.16) {
          out.push({
            t: PropType.Mote,
            x,
            y: Math.max(h, WATER_Y) + 1.6 + (mroll / 0.16) * 3.2,
            z,
            s: 0.6 + hash2(ix, iz + 31, this.seed + 5211) * 0.9,
            r: 0,
            light: 0,
          });
        }

        if (h <= WATER_Y) continue;
        const roll = hash2(ix, iz, this.seed + 4027);
        const biome = this.biomeAt(ix, iz);
        let t: PropType | -1 = -1;
        // Forest = the proto-Reek (John): swampy fungal zone — shrooms live here.
        if (biome === 'forest') t = roll > 0.55 ? PropType.Grass : roll < 0.06 ? PropType.Glowshroom : -1;
        else if (biome === 'plains') t = roll > 0.75 ? PropType.Grass : roll < 0.015 ? PropType.Glowshroom : roll < 0.05 ? PropType.Rock : -1;
        else if (biome === 'desert') t = roll < 0.07 ? PropType.Rock : -1;
        else if (biome === 'mountain') t = roll < 0.09 ? PropType.Rock : -1;
        if (t === -1) continue;
        out.push({
          t,
          x,
          y: h + 1, // ground plane sits atop the surface voxel
          z,
          s: 0.7 + hash2(ix + 11, iz, this.seed + 4051) * 0.8,
          r: hash2(iz, ix + 29, this.seed + 4061) * Math.PI * 2,
          light: 0,
        });
      }
    }
    return out;
  }

  /** Forest trees on a jittered grid. Canopies write across chunk borders via
   *  world.set — legal here BECAUSE the ladder guarantees all 8 neighbours are
   *  already Generated and not yet Meshed. */
  decorateColumn(world: VoxelWorld, cx: number, cz: number): void {
    // Glowshroom light markers: an invisible GlowAir voxel at each cap, so the
    // Lit rung bakes a soft pool onto the ground around every shroom.
    // REGISTRATION RULE: marker height is recomputed at the marker's OWN
    // column — using the prop column's height put markers inside solid ground
    // whenever the rounded position crossed into a neighbouring column, and
    // the Air guard then silently dropped the light (John's dark-based shroom).
    for (const p of this.props(cx, cz)) {
      if (p.t !== PropType.Glowshroom) continue;
      const mx = Math.round(p.x);
      const mz = Math.round(p.z);
      const my = this.height(mx, mz) + 1;
      if (world.get(mx, my, mz) === Mat.Air) world.set(mx, my, mz, Mat.GlowAir);
      else if (world.get(mx, my + 1, mz) === Mat.Air) world.set(mx, my + 1, mz, Mat.GlowAir);
    }

    // Cave crystals (ReekGen §cave-POIs, trimmed): probe a coarse grid, dress
    // each open span — caverns get crystal clusters (more likely deeper),
    // passages a rare lone crystal. The dark is the point; light is earned.
    for (let gz = 5; gz < CS; gz += 10) {
      for (let gx = 5; gx < CS; gx += 10) {
        const jx = cx * CS + gx + Math.floor((hash2(cx * CS + gx, cz * CS + gz, this.seed + 211) - 0.5) * 6);
        const jz = cz * CS + gz + Math.floor((hash2(cz * CS + gz, cx * CS + gx, this.seed + 223) - 0.5) * 6);
        const top = this.height(jx, jz) - CRUST;
        const spanRange = top - CAVE_FLOOR;
        for (const span of this.columnSpans(jx, jz)) {
          const sh = span.cc - span.cf;
          if (sh < 2) continue;
          const depth = spanRange > 0 ? (top - (span.cf + span.cc) * 0.5) / spanRange : 0;
          const r = hash2(jx, jz + span.cf * 131, this.seed + 227);
          if (sh >= 6) {
            if (r > 0.72 - depth * 0.2) {
              world.set(jx, span.cf + 1, jz, Mat.Crystal);
              world.set(jx, span.cf + 2, jz, Mat.Crystal);
              if (hash2(jx, span.cf, this.seed + 229) > 0.5) world.set(jx + 1, span.cf + 1, jz, Mat.Crystal);
            }
          } else if (r > 0.86) {
            world.set(jx, span.cf + 1, jz, Mat.Crystal);
          }
        }
      }
    }
    const STEP = 6;
    for (let gz = 0; gz < CS; gz += STEP) {
      for (let gx = 0; gx < CS; gx += STEP) {
        const x = cx * CS + gx + Math.floor(fbm2(cx * CS + gx + 0.31, cz * CS + gz, this.seed + 3001) * (STEP - 1));
        const z = cz * CS + gz + Math.floor(fbm2(cz * CS + gz + 0.77, cx * CS + gx, this.seed + 3011) * (STEP - 1));
        if (this.biomeAt(x, z) !== 'forest') continue;
        if (fbm2(x * 0.9, z * 0.9, this.seed + 3023) < 0.55) continue;

        const h = this.height(x, z);
        const trunk = 4 + Math.floor(fbm2(x * 0.7 + 5.1, z * 0.7, this.seed + 3037) * 4);
        for (let y = h + 1; y <= h + trunk; y++) world.set(x, y, z, Mat.Wood);
        // Canopy blob — glowcaps read as bright foliage in the fullbright lab.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz2 = -2; dz2 <= 2; dz2++) {
            for (let dx2 = -2; dx2 <= 2; dx2++) {
              if (Math.abs(dx2) + Math.abs(dz2) + Math.abs(dy) > 3) continue;
              const ty = h + trunk + dy;
              if (world.get(x + dx2, ty, z + dz2) === Mat.Air) {
                world.set(x + dx2, ty, z + dz2, Mat.Glowcap);
              }
            }
          }
        }
      }
    }
  }
}
