/**
 * WorldGen — THE INTEGRATION. The maplab macro-skeleton becomes the streaming
 * engine's ground truth: the world map generates ONCE at boot (~100ms), then
 * every chunk column asks it "what am I?" — Reek swamp, Badlands mesa, Bite
 * ice, ocean shelf, abyssal deep, or the Nothing rim — and builds terrain,
 * materials, props, and dungeon-anchor beacons to match.
 *
 * Geometry contract: 1 map cell = 32 m = exactly one chunk column (designed
 * for this). Column (cx, cz) ↔ map cell (spawn.x + cx, spawn.y + cz), so the
 * lab/world origin is the Reek heart, exactly where the orb wakes.
 *
 * Heights come from a PRE-SMOOTHED per-cell field (bilinear-sampled per voxel
 * column + local fbm detail), so 32 m cells never read as terraces and coast-
 * lines slope into the sea instead of stepping.
 */

import { World } from '../config';
import { fbm2 } from '../world/ReekGen';
import { Mat } from '../world/Materials';
import { Chunk, VoxelWorld } from '../world/VoxelWorld';
import { PropRecord, PropType } from './Props';
import { ColumnGenerator } from './HeightfieldGen';
import { generateWorldMap, BIOME, BIOME_NAME, DEPTH, WorldMapData } from './worldmap.js';

const CS = World.chunkSize;
export const SEA_LEVEL = 6; // must match the lab's water plane (WATER_Y)

/** Uniform hash (same recipe as everywhere else in the gen stack). */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Per-biome surface palette + height character.
const BASE_LIFT: Record<number, number> = {
  [BIOME.REEK]: 0, // low wet heart
  [BIOME.BADLANDS]: 10, // raised dry interior
  [BIOME.BITE]: 8,
  [BIOME.SEAR]: 6,
  [BIOME.GLARE]: 2,
  [BIOME.FADE]: 4,
  [BIOME.NOTHING]: -2,
};

export class WorldGen implements ColumnGenerator {
  readonly cyMin = -1; // y ≥ −32 (abyssal floor ≈ −16)
  readonly cyMax = 2; //  y < 96 (inland highlands ≈ 60)

  readonly map: WorldMapData;
  /** The GAME's Reek pipeline supplies demo-grade trees/groves — it turns
   *  these lab-grade voxel trees + shroom markers off to avoid doubles. */
  labReekFlora = true;
  /** Smoothed per-cell height field (same layout as map grids). */
  private readonly cellH: Float32Array;
  /** Anchor beacon lookup: map cell index → anchor type. */
  private readonly anchorAt = new Map<number, 'cave' | 'tower'>();

  constructor(
    private readonly seed: number,
    worldRadius = 6000,
  ) {
    this.map = generateWorldMap({ seed, worldRadius });
    const m = this.map;

    // --- Raw per-cell height from map semantics ---
    const raw = new Float32Array(m.W * m.H);
    for (let i = 0; i < raw.length; i++) {
      const b = m.biome[i];
      if (b === BIOME.NONE) {
        raw[i] = -22; // outside the disc: deep void floor
        continue;
      }
      if (m.land[i]) {
        const inland = Math.min(m.inlandDist[i] < 0 ? 0 : m.inlandDist[i], 30);
        raw[i] = SEA_LEVEL + 4 + inland * 1.5 + (BASE_LIFT[b] ?? 0);
      } else {
        // water: shelf shallows → open sea → abyssal deeps
        const d = m.depthClass[i];
        raw[i] = d === DEPTH.SHELF ? SEA_LEVEL - 3 : d === DEPTH.SEA ? SEA_LEVEL - 9 : SEA_LEVEL - 22;
      }
    }
    // --- Two 3×3 blur passes: coasts slope, cells stop being terraces ---
    const tmp = new Float32Array(raw.length);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? raw : tmp;
      const dst = pass === 0 ? tmp : raw;
      for (let y = 0; y < m.H; y++) {
        for (let x = 0; x < m.W; x++) {
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H) continue;
              sum += src[ny * m.W + nx];
              n++;
            }
          }
          dst[y * m.W + x] = sum / n;
        }
      }
    }
    this.cellH = raw;

    for (const a of m.anchors) this.anchorAt.set(a.y * m.W + a.x, a.type);
  }

  // --- Map addressing: column/world coords ↔ cell coords -----------------------

  /** Map cell index for a WORLD voxel coordinate (fractional ok), or -1. */
  private cellIndex(x: number, z: number): number {
    const m = this.map;
    const cx = m.spawn.x + Math.floor(x / CS);
    const cy = m.spawn.y + Math.floor(z / CS);
    if (cx < 0 || cy < 0 || cx >= m.W || cy >= m.H) return -1;
    return cy * m.W + cx;
  }

  biomeId(x: number, z: number): number {
    const i = this.cellIndex(x, z);
    return i < 0 ? BIOME.NONE : this.map.biome[i];
  }

  /** Lab HUD hook — same signature as HeightfieldGen's. */
  biomeAt(x: number, z: number): string {
    return BIOME_NAME[this.biomeId(x, z)];
  }

  /** Bilinear sample of the smoothed cell-height field at world coords. */
  private fieldH(x: number, z: number): number {
    const m = this.map;
    const fx = m.spawn.x + x / CS - 0.5;
    const fy = m.spawn.y + z / CS - 0.5;
    const x0 = Math.max(0, Math.min(m.W - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(m.H - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const i00 = y0 * m.W + x0;
    const a = this.cellH[i00] + (this.cellH[i00 + 1] - this.cellH[i00]) * tx;
    const b = this.cellH[i00 + m.W] + (this.cellH[i00 + m.W + 1] - this.cellH[i00 + m.W]) * tx;
    return a + (b - a) * ty;
  }

  /** Surface height — smoothed macro field + biome-flavored local detail. */
  height(x: number, z: number): number {
    const b = this.biomeId(x, z);
    let h = this.fieldH(x, z);
    const detail = fbm2(x * 0.03, z * 0.03, this.seed + 601) * 4 - 2;
    if (b === BIOME.BADLANDS) {
      // mesa country: quantize into terraces, keep canyon-ish relief
      h = Math.round((h + detail * 2.2) / 5) * 5 + fbm2(x * 0.08, z * 0.08, this.seed + 607) * 2;
    } else if (b === BIOME.DROWN || !this.landAt(x, z)) {
      h += detail * 0.6; // gentle seabed
    } else {
      h += detail;
    }
    return Math.max(-24, Math.min(92, Math.floor(h)));
  }

  private landAt(x: number, z: number): boolean {
    const i = this.cellIndex(x, z);
    return i >= 0 && this.map.land[i] === 1;
  }

  // --- Column generation ---------------------------------------------------------

  generateColumn(world: VoxelWorld, ccx: number, ccz: number): void {
    const chunks: (Chunk | undefined)[] = new Array(this.cyMax - this.cyMin + 1);
    const chunkAt = (cy: number): Chunk => (chunks[cy - this.cyMin] ??= world.getChunk(ccx, cy, ccz, true)!);
    const BEDROCK = -26;

    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = ccx * CS + lx;
        const z = ccz * CS + lz;
        const b = this.biomeId(x, z);
        if (b === BIOME.NONE) continue; // outside the world disc: void
        const h = this.height(x, z);

        // Surface material by biome (underwater floors are sand everywhere).
        let top: Mat;
        let topDepth = 2;
        if (h < SEA_LEVEL + 1 && !this.landAt(x, z)) {
          top = Mat.Sand;
          topDepth = 3;
        } else {
          switch (b) {
            case BIOME.REEK:
              top = Mat.Dirt;
              break;
            case BIOME.BADLANDS:
              top = Mat.Sand;
              topDepth = 3;
              break;
            case BIOME.BITE:
              top = Mat.Ice;
              break;
            case BIOME.SEAR:
            case BIOME.FADE:
            case BIOME.NOTHING:
              top = Mat.Stone;
              break;
            case BIOME.GLARE:
              top = Mat.Sand;
              break;
            default:
              top = Mat.Dirt;
          }
        }

        // Biome sparkle in the top voxel: Reek glow-moss, Sear embers,
        // Glare crystal glints, Fade metal traces. All emissives feed the
        // baked light automatically via the Lit rung.
        const roll = hash2(x, z, this.seed + 71);
        let topMat: Mat = top;
        if (h >= SEA_LEVEL) {
          // NO Reek ground sparkle — the demo Reek floor is DARK and that's
          // the reference (John). The old 4.5% Glowcap top-voxels flood-lit
          // the whole surface once the light volume exposed streamed light.
          // Reek light comes from glowcap props/GlowAir pools only. Sear/Glare
          // keep strong emitters at pool-rarity so the dark stays a pressure.
          if (b === BIOME.SEAR && roll < 0.004) topMat = Mat.Ember;
          else if (b === BIOME.GLARE && roll < 0.006) topMat = Mat.Crystal;
          else if (b === BIOME.FADE && roll < 0.02) topMat = Mat.Metal;
        }

        let cur: Chunk | null = null;
        let curCy = 1e9;
        for (let y = BEDROCK; y <= h; y++) {
          const cy = Math.floor(y / CS);
          if (cy !== curCy) {
            curCy = cy;
            cur = chunkAt(cy);
          }
          cur!.voxels[Chunk.index(lx, y - cy * CS, lz)] =
            y === h ? topMat : y > h - topDepth ? top : Mat.Stone;
        }
      }
    }
    for (const chunk of chunks) {
      if (!chunk) continue;
      chunk.dirty = true;
      chunk.lightDirty = true;
    }
  }

  // --- Decoration: Reek trees + anchor beacons ------------------------------------

  decorateColumn(world: VoxelWorld, ccx: number, ccz: number): void {
    // Dungeon-anchor beacon: a crystal spire + GlowAir crown at the cell's
    // heart — a visible promise in the dark ("something is HERE") until the
    // cave/tower generators stamp their real content at these cells.
    const m = this.map;
    const cellX = m.spawn.x + ccx;
    const cellY = m.spawn.y + ccz;
    if (cellX >= 0 && cellY >= 0 && cellX < m.W && cellY < m.H) {
      const anchor = this.anchorAt.get(cellY * m.W + cellX);
      if (anchor) {
        const ax = ccx * CS + CS / 2;
        const az = ccz * CS + CS / 2;
        const ah = this.height(ax, az);
        if (ah > SEA_LEVEL - 2) {
          const spire = anchor === 'tower' ? 5 : 3;
          for (let y = ah + 1; y <= ah + spire; y++) world.set(ax, y, az, Mat.Crystal);
          world.set(ax, ah + spire + 1, az, Mat.GlowAir);
        }
      }
    }

    if (!this.labReekFlora) return;
    // Glowshroom light markers (the registration lesson: the light must land
    // where the prop stands — marker height computed at the MARKER's column).
    for (const pr of this.props(ccx, ccz)) {
      if (pr.t !== PropType.Glowshroom) continue;
      const mx = Math.round(pr.x);
      const mz = Math.round(pr.z);
      const my = this.height(mx, mz) + 1;
      if (world.get(mx, my, mz) === Mat.Air) world.set(mx, my, mz, Mat.GlowAir);
      else if (world.get(mx, my + 1, mz) === Mat.Air) world.set(mx, my + 1, mz, Mat.GlowAir);
    }

    // Reek spore-trees (the proto-forest, from HeightfieldGen's recipe).
    const STEP = 7;
    for (let gz = 0; gz < CS; gz += STEP) {
      for (let gx = 0; gx < CS; gx += STEP) {
        const x = ccx * CS + gx + Math.floor(hash2(ccx * CS + gx, ccz * CS + gz, this.seed + 3001) * (STEP - 1));
        const z = ccz * CS + gz + Math.floor(hash2(ccz * CS + gz, ccx * CS + gx, this.seed + 3011) * (STEP - 1));
        if (this.biomeId(x, z) !== BIOME.REEK) continue;
        if (hash2(x, z, this.seed + 3023) > 0.3) continue;
        const h = this.height(x, z);
        if (h <= SEA_LEVEL) continue;
        const trunk = 4 + Math.floor(hash2(x + 5, z, this.seed + 3037) * 4);
        for (let y = h + 1; y <= h + trunk; y++) world.set(x, y, z, Mat.Wood);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz2 = -2; dz2 <= 2; dz2++) {
            for (let dx2 = -2; dx2 <= 2; dx2++) {
              if (Math.abs(dx2) + Math.abs(dz2) + Math.abs(dy) > 3) continue;
              if (world.get(x + dx2, h + trunk + dy, z + dz2) === Mat.Air) {
                world.set(x + dx2, h + trunk + dy, z + dz2, Mat.Glowcap);
              }
            }
          }
        }
      }
    }
  }

  // --- Instanced props by biome ----------------------------------------------------

  props(ccx: number, ccz: number): PropRecord[] {
    const out: PropRecord[] = [];
    const STEP = 4;
    for (let gz = 0; gz < CS; gz += STEP) {
      for (let gx = 0; gx < CS; gx += STEP) {
        const wx = ccx * CS + gx;
        const wz = ccz * CS + gz;
        const x = wx + hash2(wx, wz, this.seed + 4001) * (STEP - 1);
        const z = wz + hash2(wz, wx, this.seed + 4013) * (STEP - 1);
        const ix = Math.floor(x);
        const iz = Math.floor(z);
        const b = this.biomeId(ix, iz);
        const h = this.height(ix, iz);
        const roll = hash2(ix, iz, this.seed + 4027);

        // spore-motes drift over the Reek (land or swamp shallows)
        if (b === BIOME.REEK) {
          const mroll = hash2(ix + 7, iz - 13, this.seed + 5201);
          if (mroll < 0.14) {
            out.push({
              t: PropType.Mote,
              x,
              y: Math.max(h, SEA_LEVEL) + 1.6 + (mroll / 0.14) * 3,
              z,
              s: 0.6 + hash2(ix, iz + 31, this.seed + 5211) * 0.9,
              r: 0,
              light: 0,
            });
          }
        }
        if (h <= SEA_LEVEL) continue;

        let t: PropType | -1 = -1;
        if (b === BIOME.REEK) t = roll > 0.55 ? PropType.Grass : roll < 0.07 ? PropType.Glowshroom : -1;
        else if (b === BIOME.BADLANDS) t = roll < 0.08 ? PropType.Rock : -1;
        else if (b === BIOME.BITE || b === BIOME.SEAR) t = roll < 0.06 ? PropType.Rock : -1;
        else if (b === BIOME.GLARE || b === BIOME.FADE) t = roll < 0.05 ? PropType.Rock : -1;
        if (t === -1) continue;
        out.push({
          t,
          x,
          y: h + 1,
          z,
          s: 0.7 + hash2(ix + 11, iz, this.seed + 4051) * 0.8,
          r: hash2(iz, ix + 29, this.seed + 4061) * Math.PI * 2,
          light: 0,
        });
      }
    }
    return out;
  }
}
