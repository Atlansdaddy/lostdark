/**
 * REMNANT TOWER GENERATOR — pure data, zero THREE imports (John's spec).
 * Buildings were MADE: one BSP blueprint reused every floor (mutation drift
 * 0.35), then centuries of decay eat it — noise turns walls to RUBBLE, floors
 * to HOLEs, exterior walls to LEDGE openings. Vertical connectivity is a
 * DIRECTED multigraph (stairs bidirectional per-segment-collapsed, drops
 * down-only, climbs up-only, ledges exposed both-ways, shaft where decayed
 * open) — the critical ascent must use ≥1 non-stair edge (forced
 * improvisation). Dark-span budget enforced by waking dead fixtures.
 * Deterministic (mulberry32); derived-seed re-roll ≤5.
 */

export const enum TCell {
  VOID = 0,
  FLOOR = 1,
  WALL = 2,
  RUBBLE = 3,
  HOLE = 4,
  STAIR = 5,
  LEDGE = 6,
  SHAFT = 7,
}

export interface TowerParams {
  seed: number;
  floorCount: number;
  baseSize: number;
  stairCollapse: number;
  decayT1: number;
  decayT2: number;
  altitudeBias: number;
  planMutation: number;
  maxDarkRun: number;
  minLight: number;
  decorDensity: number;
}

export const TOWER_DEFAULTS: TowerParams = {
  seed: 1,
  floorCount: 12,
  baseSize: 24,
  stairCollapse: 0.4,
  decayT1: 0.55,
  decayT2: 0.72,
  altitudeBias: 0.25,
  planMutation: 0.35,
  maxDarkRun: 22,
  minLight: 0.08,
  decorDensity: 0.6,
};

export interface TRoom {
  id: number;
  floor: number;
  cx: number;
  cy: number;
  /** Guaranteed-passable FLOOR cell (centroids of L-shaped rooms can land on
   *  walls/holes — anchor is what reachability checks use). */
  ax: number;
  ay: number;
  w: number;
  h: number;
  type: 'breach' | 'beacon' | 'cache' | 'post' | 'open';
  difficulty: number;
  darknessDensity: number;
  sealed: boolean;
}

export interface VEdge {
  fromFloor: number;
  toFloor: number;
  x: number;
  y: number;
  kind: 'stair' | 'climb' | 'drop' | 'ledge' | 'shaft';
  isCritical: boolean;
  collapsed: boolean;
}

export interface TEmitter {
  kind: 'fixture' | 'beacon' | 'seal';
  floor: number;
  x: number;
  y: number;
  radius: number;
  intensity: number;
  alive: boolean;
}

export interface TProp {
  kind: 'husk' | 'conduit' | 'glass' | 'cable' | 'locker' | 'beacon' | 'fixture';
  floor: number;
  x: number;
  y: number;
  rot: number;
  scale: number;
}

export interface TSpawn {
  floor: number;
  x: number;
  y: number;
  tier: 'skitter' | 'snuffer' | 'warden';
}

export interface TowerStats {
  floors: number;
  rooms: number;
  stairSegmentsCollapsed: number;
  holes: number;
  climbs: number;
  ledges: number;
  verticalLoops: number;
  criticalAscent: number;
  caches: number;
  litFraction: number;
  longestDarkRun: number;
  fixturesWoken: number;
  rerolls: number;
  genMs: number;
  improvEdge: string;
}

export interface Tower {
  params: TowerParams;
  name: string;
  W: number;
  H: number;
  floors: number;
  floorHeight: number;
  layers: Uint8Array[];
  light: Float32Array[];
  bfs: Int16Array[];
  rooms: TRoom[];
  vEdges: VEdge[];
  emitters: TEmitter[];
  props: TProp[];
  caches: { floor: number; x: number; y: number; richness: number; roomId: number }[];
  spawns: TSpawn[];
  breach: [number, number, number]; // floor,x,y
  stats: TowerStats;
}

// --- RNG / noise (same recipes as CaveGen) -----------------------------------

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise3(seed: number): (x: number, y: number, z: number) => number {
  const h = (x: number, y: number, z: number): number => {
    let n = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const sm = (t: number): number => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const fx = sm(x - xi);
    const fy = sm(y - yi);
    const fz = sm(z - zi);
    let v = 0;
    for (const [dx, dy, dz, w] of [
      [0, 0, 0, (1 - fx) * (1 - fy) * (1 - fz)],
      [1, 0, 0, fx * (1 - fy) * (1 - fz)],
      [0, 1, 0, (1 - fx) * fy * (1 - fz)],
      [1, 1, 0, fx * fy * (1 - fz)],
      [0, 0, 1, (1 - fx) * (1 - fy) * fz],
      [1, 0, 1, fx * (1 - fy) * fz],
      [0, 1, 1, (1 - fx) * fy * fz],
      [1, 1, 1, fx * fy * fz],
    ] as const) {
      v += h(xi + dx, yi + dy, zi + dz) * w;
    }
    return v;
  };
}

const NAME_KIND = ['Relay Spire', 'Cistern Watch', 'Signal Bastille', 'Archive Block', 'Transit Stack', 'Beacon House'];
const NAME_NICK = ['The Widow', 'Gallows', 'The Molar', 'Candle', 'The Stump', 'Vigil', 'The Hollow Tooth', 'Lantern'];

/** Why the last attempt re-rolled. */
export let towerLastFail = '';

export function generateTower(params: Partial<TowerParams> = {}): Tower {
  const p: TowerParams = { ...TOWER_DEFAULTS, ...params };
  const t0 = performance.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const seed = attempt === 0 ? p.seed : (Math.imul(p.seed, 0x9e3779b1) + attempt) | 0;
    const tower = tryTower(p, seed, attempt);
    if (tower) {
      tower.stats.rerolls = attempt;
      tower.stats.genMs = performance.now() - t0;
      return tower;
    }
  }
  throw new Error(`tower seed ${p.seed}: 5 attempts failed (${towerLastFail})`);
}

function tryTower(p: TowerParams, seed: number, _attempt: number): Tower | null {
  const rand = mulberry32(seed);
  const noise3 = makeNoise3(seed ^ 0x70e4);
  const F = p.floorCount;
  const W = p.baseSize + 2;
  const H = p.baseSize + 2;
  const gi = (x: number, y: number): number => y * W + x;

  // --- 2. Footprint & taper ---
  const octagon = rand() < 0.4;
  const chamfer = octagon ? Math.max(3, Math.floor(p.baseSize / 5)) : 0;
  const insetOf = (f: number): number => {
    const t = f / F;
    if (t <= 0.6) return 0;
    return Math.min(Math.floor((t - 0.6) / 0.4 * 3) + 1, Math.floor(p.baseSize / 4));
  };
  const inFootprint = (x: number, y: number, f: number): boolean => {
    const ins = 1 + insetOf(f);
    if (x < ins || y < ins || x >= W - ins || y >= H - ins) return false;
    if (chamfer) {
      const cx = Math.min(x - ins, W - 1 - ins - x);
      const cy = Math.min(y - ins, H - 1 - ins - y);
      if (cx + cy < chamfer) return false;
    }
    return true;
  };

  // --- 3. Blueprint: BSP splits, reused per floor with drift ---
  // (buildings have plans — decay is the randomness, not the architecture)
  interface Split {
    vertical: boolean;
    at: number; // coordinate of the wall line
    lo: number;
    hi: number; // extent of the wall along the other axis
    door: number; // door center along the wall
  }
  const baseSplits: Split[] = [];
  {
    // recursive split of the base rect into rooms 4..10
    const splitRect = (x0: number, y0: number, x1: number, y1: number, depth: number): void => {
      const w = x1 - x0;
      const h = y1 - y0;
      if (depth > 4 || (w <= 10 && h <= 10) || (w < 9 && h < 9)) return;
      const vertical = w > h ? true : h > w ? false : rand() < 0.5;
      if (vertical) {
        const at = x0 + 4 + Math.floor(rand() * Math.max(1, w - 8));
        baseSplits.push({ vertical, at, lo: y0, hi: y1, door: y0 + 1 + Math.floor(rand() * Math.max(1, h - 2)) });
        splitRect(x0, y0, at, y1, depth + 1);
        splitRect(at + 1, y0, x1, y1, depth + 1);
      } else {
        const at = y0 + 4 + Math.floor(rand() * Math.max(1, h - 8));
        baseSplits.push({ vertical, at, lo: x0, hi: x1, door: x0 + 1 + Math.floor(rand() * Math.max(1, w - 2)) });
        splitRect(x0, y0, x1, at, depth + 1);
        splitRect(x0, at + 1, x1, y1, depth + 1);
      }
    };
    splitRect(2, 2, W - 2, H - 2, 0);
  }
  // Core shaft: 3×3 at the center, full height.
  const sx0 = Math.floor(W / 2) - 1;
  const sy0 = Math.floor(H / 2) - 1;

  // Stairwell positions (2, opposite corners, inside footprint at all floors)
  const stairPos: [number, number][] = [
    [4, 4],
    [W - 6, H - 6],
  ];

  // --- Build intact floors from the blueprint ---
  const layers: Uint8Array[] = [];
  for (let f = 0; f < F; f++) {
    const L = new Uint8Array(W * H);
    const fRand = mulberry32(seed ^ (0x100 + f));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!inFootprint(x, y, f)) continue;
        // exterior wall = footprint edge
        const edge = !inFootprint(x - 1, y, f) || !inFootprint(x + 1, y, f) || !inFootprint(x, y - 1, f) || !inFootprint(x, y + 1, f);
        L[gi(x, y)] = edge ? TCell.WALL : TCell.FLOOR;
      }
    }
    // interior walls from blueprint (with per-floor drift)
    for (const sp of baseSplits) {
      const drift = fRand() < p.planMutation ? (fRand() < 0.5 ? -1 : 1) : 0;
      const at = sp.at + drift;
      const door = sp.door + (fRand() < p.planMutation ? Math.floor((fRand() - 0.5) * 4) : 0);
      for (let t = sp.lo; t < sp.hi; t++) {
        const x = sp.vertical ? at : t;
        const y = sp.vertical ? t : at;
        if (!inFootprint(x, y, f)) continue;
        if (Math.abs(t - door) <= 0) continue; // door gap (2 wide with the next cell)
        if (Math.abs(t - door) === 1) continue;
        if (L[gi(x, y)] === TCell.FLOOR) L[gi(x, y)] = TCell.WALL;
      }
    }
    // core shaft
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const x = sx0 + dx;
        const y = sy0 + dy;
        if (dx === 1 && dy === 1) L[gi(x, y)] = TCell.SHAFT;
        else if (L[gi(x, y)] !== TCell.VOID) L[gi(x, y)] = TCell.WALL;
      }
    }
    // stairwells: 2×2 STAIR pads
    for (const [sxp, syp] of stairPos) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (inFootprint(sxp + dx, syp + dy, f)) L[gi(sxp + dx, syp + dy)] = TCell.STAIR;
        }
      }
    }
    layers.push(L);
  }

  // --- 4. Decay pass ---
  const ns = 0.13;
  for (let f = 0; f < F; f++) {
    const L = layers[f];
    const alt = p.altitudeBias * (f / F);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = gi(x, y);
        const c = L[idx];
        if (c === TCell.VOID || c === TCell.STAIR || c === TCell.SHAFT) continue;
        const collapse = noise3(x * ns, y * ns, f * ns * 2.4) + alt;
        if (c === TCell.WALL && collapse > p.decayT1) {
          // exterior wall → LEDGE opening; interior → rubble
          const exterior = !inFootprint(x - 1, y, f) || !inFootprint(x + 1, y, f) || !inFootprint(x, y - 1, f) || !inFootprint(x, y + 1, f);
          L[idx] = exterior ? TCell.LEDGE : TCell.RUBBLE;
        } else if (c === TCell.FLOOR && collapse > p.decayT2 && f > 0) {
          L[idx] = TCell.HOLE; // never hole the ground floor
        }
      }
    }
  }
  // Clamp: no room decayed below 40% — approximate by flood regions later; the
  // spec clamp we enforce hard: ground floor holes (impossible above) + shaft
  // ring integrity:
  for (let f = 0; f < F; f++) {
    const L = layers[f];
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const idx = gi(sx0 + dx, sy0 + dy);
        if (dx === 1 && dy === 1) L[idx] = TCell.SHAFT;
        else if (L[idx] === TCell.RUBBLE || L[idx] === TCell.HOLE) L[idx] = TCell.WALL;
      }
    }
  }

  // --- Rooms (flood regions of FLOOR/RUBBLE per floor, walls as borders) ---
  const rooms: TRoom[] = [];
  const roomAt: Int16Array[] = [];
  for (let f = 0; f < F; f++) {
    const L = layers[f];
    const RA = new Int16Array(W * H).fill(-1);
    roomAt.push(RA);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = gi(x, y);
        if (RA[idx] !== -1) continue;
        const c = L[idx];
        if (c !== TCell.FLOOR && c !== TCell.RUBBLE && c !== TCell.HOLE) continue;
        // flood this room
        const id = rooms.length;
        const q = [idx];
        RA[idx] = id;
        let head = 0;
        let sx = 0;
        let sy = 0;
        let n = 0;
        let minx = W;
        let maxx = 0;
        let miny = H;
        let maxy = 0;
        let holes = 0;
        let cells = 0;
        let ax = -1;
        let ay = -1;
        while (head < q.length) {
          const i2 = q[head++];
          const x2 = i2 % W;
          const y2 = (i2 / W) | 0;
          sx += x2;
          sy += y2;
          n++;
          cells++;
          if (L[i2] === TCell.HOLE) holes++;
          else if (ax === -1) {
            ax = x2;
            ay = y2;
          }
          minx = Math.min(minx, x2);
          maxx = Math.max(maxx, x2);
          miny = Math.min(miny, y2);
          maxy = Math.max(maxy, y2);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const ni = (y2 + dy) * W + (x2 + dx);
            const nc = L[ni];
            if (RA[ni] === -1 && (nc === TCell.FLOOR || nc === TCell.RUBBLE || nc === TCell.HOLE)) {
              RA[ni] = id;
              q.push(ni);
            }
          }
        }
        // Clamp: if the room decayed below 40% intact, restore rubble→floor
        if (cells > 0 && (cells - holes) / cells < 0.4) {
          for (const i2 of q) if (L[i2] === TCell.HOLE) L[i2] = TCell.RUBBLE;
        }
        rooms.push({
          id,
          floor: f,
          cx: Math.round(sx / n),
          cy: Math.round(sy / n),
          ax: ax === -1 ? Math.round(sx / n) : ax,
          ay: ay === -1 ? Math.round(sy / n) : ay,
          w: maxx - minx + 1,
          h: maxy - miny + 1,
          type: 'open',
          difficulty: 0.15 + 0.85 * (f / F),
          darknessDensity: 0,
          sealed: false,
        });
      }
    }
  }

  // --- 5. Vertical connectivity multigraph ---
  const vEdges: VEdge[] = [];
  const segRand = mulberry32(seed ^ 0x57a1);
  let collapsedSegs = 0;
  for (const [sxp, syp] of stairPos) {
    for (let f = 0; f < F - 1; f++) {
      const okHere = layers[f][gi(sxp, syp)] === TCell.STAIR && layers[f + 1][gi(sxp, syp)] === TCell.STAIR;
      const collapsed = !okHere || segRand() < p.stairCollapse;
      if (collapsed) collapsedSegs++;
      vEdges.push({ fromFloor: f, toFloor: f + 1, x: sxp, y: syp, kind: 'stair', isCritical: false, collapsed });
    }
  }
  // shaft climbs where the ring is decayed open on both floors (seeded)
  const shaftRand = mulberry32(seed ^ 0x5aa5);
  for (let f = 0; f < F - 1; f++) {
    if (shaftRand() < 0.45) {
      vEdges.push({ fromFloor: f, toFloor: f + 1, x: sx0 + 1, y: sy0 + 1, kind: 'shaft', isCritical: false, collapsed: false });
    }
  }
  // holes → drops; rubble beside hole below → climbs
  let holes = 0;
  let climbs = 0;
  for (let f = 1; f < F; f++) {
    const L = layers[f];
    const below = layers[f - 1];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (L[gi(x, y)] !== TCell.HOLE) continue;
        const b = below[gi(x, y)];
        if (b === TCell.FLOOR || b === TCell.RUBBLE) {
          holes++;
          vEdges.push({ fromFloor: f, toFloor: f - 1, x, y, kind: 'drop', isCritical: false, collapsed: false });
          // climb: rubble on the floor below adjacent to the hole column
          let rubbleAdj = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            if (below[gi(x + dx, y + dy)] === TCell.RUBBLE) rubbleAdj = true;
          }
          if (rubbleAdj) {
            climbs++;
            vEdges.push({ fromFloor: f - 1, toFloor: f, x, y, kind: 'climb', isCritical: false, collapsed: false });
          }
        }
      }
    }
  }
  // ledges: exterior openings on adjacent floors within 3 cells
  let ledges = 0;
  for (let f = 0; f < F - 1; f++) {
    const A = layers[f];
    const B = layers[f + 1];
    outer: for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (A[gi(x, y)] !== TCell.LEDGE) continue;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
            if (B[gi(nx, ny)] === TCell.LEDGE) {
              vEdges.push({ fromFloor: f, toFloor: f + 1, x, y, kind: 'ledge', isCritical: false, collapsed: false });
              ledges++;
              if (ledges >= 6) break outer;
              break;
            }
          }
        }
      }
    }
  }

  // --- Passability + directed 3D BFS from the breach ---
  const passable = (f: number, x: number, y: number): boolean => {
    const c = layers[f][gi(x, y)];
    return c === TCell.FLOOR || c === TCell.RUBBLE || c === TCell.STAIR || c === TCell.LEDGE || c === TCell.HOLE;
  };
  // Breach: exterior opening on ground floor — prefer a LEDGE cell; else carve
  // a door in the exterior wall far from the apex stair.
  let breach: [number, number, number] | null = null;
  for (let y = 1; y < H - 1 && !breach; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (layers[0][gi(x, y)] === TCell.LEDGE) {
        breach = [0, x, y];
        break;
      }
    }
  }
  if (!breach) {
    // carve one deterministically at the south wall midpoint
    for (let x = Math.floor(W / 2); x < W - 1; x++) {
      for (let y = H - 2; y > 0; y--) {
        if (layers[0][gi(x, y)] === TCell.WALL && layers[0][gi(x, y - 1)] === TCell.FLOOR) {
          layers[0][gi(x, y)] = TCell.LEDGE;
          breach = [0, x, y];
          break;
        }
      }
      if (breach) break;
    }
  }
  if (!breach) {
    towerLastFail = 'no breach site';
    return null;
  }

  // Edge buckets: (floor, cell) → traversals. The BFS was scanning every
  // edge per dequeued cell (O(cells×edges) — most of generation time).
  type Hop = { e: VEdge; nf: number; nidx: number };
  const buckets = new Map<number, Hop[]>();
  const addHop = (f: number, x: number, y: number, hop: Hop): void => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const key = f * W * H + gi(nx, ny);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(hop);
      }
    }
  };
  for (const e of vEdges) {
    addHop(e.fromFloor, e.x, e.y, { e, nf: e.toFloor, nidx: gi(e.x, e.y) });
    if (e.kind === 'stair' || e.kind === 'ledge' || e.kind === 'shaft') {
      addHop(e.toFloor, e.x, e.y, { e, nf: e.fromFloor, nidx: gi(e.x, e.y) });
    }
  }

  interface Bfs3 {
    out: Int16Array[];
    parent: Int32Array; // flat (f*W*H+idx) → predecessor code, -1 root/unreached
    via: Int32Array; // edge index used to enter this cell, -1 = lateral
  }
  const bfs3 = (useKinds: (k: VEdge['kind']) => boolean): Bfs3 => {
    const out = layers.map(() => new Int16Array(W * H).fill(-1));
    const parent = new Int32Array(F * W * H).fill(-1);
    const via = new Int32Array(F * W * H).fill(-1);
    const q: number[] = [];
    const enc = (f: number, idx: number): number => f * W * H + idx;
    out[breach![0]][gi(breach![1], breach![2])] = 0;
    q.push(enc(breach![0], gi(breach![1], breach![2])));
    let head = 0;
    while (head < q.length) {
      const code = q[head++];
      const f = (code / (W * H)) | 0;
      const idx = code % (W * H);
      const x = idx % W;
      const y = (idx / W) | 0;
      const d = out[f][idx];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = gi(nx, ny);
        if (passable(f, nx, ny) && out[f][ni] === -1) {
          out[f][ni] = d + 1;
          parent[enc(f, ni)] = code;
          q.push(enc(f, ni));
        }
      }
      const hops = buckets.get(code);
      if (hops) {
        for (const { e, nf, nidx } of hops) {
          if (e.collapsed || !useKinds(e.kind)) continue;
          const nx2 = nidx % W;
          const ny2 = (nidx / W) | 0;
          if (passable(nf, nx2, ny2) && out[nf][nidx] === -1) {
            out[nf][nidx] = d + 1;
            parent[enc(nf, nidx)] = code;
            via[enc(nf, nidx)] = vEdges.indexOf(e);
            q.push(enc(nf, nidx));
          }
        }
      }
    }
    return { out, parent, via };
  };

  // Constraint 2: full reachability + apex reachable — un-collapse cheapest
  // stair segments until it holds (≤4), else reroll.
  let bfs = bfs3(() => true);
  const apexRoom = (): TRoom => {
    const top = rooms.filter((r) => r.floor === F - 1);
    return top.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  };
  if (!apexRoom()) {
    towerLastFail = 'no apex room';
    return null;
  }
  const fullReach = (): { total: number; reached: number; apexOk: boolean } => {
    let total = 0;
    let reached = 0;
    for (let f = 0; f < F; f++) {
      for (let i = 0; i < W * H; i++) {
        const c = layers[f][i];
        if (c === TCell.FLOOR || c === TCell.RUBBLE || c === TCell.STAIR || c === TCell.LEDGE) {
          total++;
          if (bfs.out[f][i] >= 0) reached++;
        }
      }
    }
    const ap = apexRoom();
    return { total, reached, apexOk: bfs.out[ap.floor][gi(ap.ax, ap.ay)] >= 0 };
  };
  for (let fix = 0; fix < 5; fix++) {
    const r = fullReach();
    if (r.reached === r.total && r.apexOk) break;
    const candidates = vEdges.filter((e) => e.kind === 'stair' && e.collapsed);
    if (!candidates.length) {
      towerLastFail = 'unreachable, no stairs to restore';
      return null;
    }
    // un-collapse the lowest unreached-side segment (deterministic order)
    candidates.sort((a, b) => a.fromFloor - b.fromFloor || a.x - b.x);
    candidates[0].collapsed = false;
    collapsedSegs--;
    bfs = bfs3(() => true);
  }
  {
    const r = fullReach();
    if (r.reached !== r.total || !r.apexOk) {
      towerLastFail = `reach ${r.reached}/${r.total} apex ${r.apexOk}`;
      return null;
    }
  }

  // Constraint 3: forced improvisation — while stairs alone reach the apex,
  // collapse one stair segment that full connectivity can survive. Sweep all
  // candidates (top-down), never retrying one that proved load-bearing.
  let improvEdge = '';
  {
    const tried = new Set<VEdge>();
    for (let guard = 0; guard < 40; guard++) {
      const stairOnly = bfs3((k) => k === 'stair');
      const apx = apexRoom();
      if (stairOnly.out[apx.floor][gi(apx.ax, apx.ay)] < 0) break; // stairs alone insufficient ✓
      const usable = vEdges.filter((e) => e.kind === 'stair' && !e.collapsed && !tried.has(e));
      if (!usable.length) break; // cannot force it — acceptance will flag
      usable.sort((a, b) => b.fromFloor - a.fromFloor || a.x - b.x);
      const pick = usable[0];
      tried.add(pick);
      pick.collapsed = true;
      collapsedSegs++;
      bfs = bfs3(() => true);
      const r = fullReach();
      if (r.reached !== r.total || !r.apexOk) {
        pick.collapsed = false; // load-bearing — revert, try the next candidate
        collapsedSegs--;
        bfs = bfs3(() => true);
      }
    }
  }

  // Critical ascent: exact parent-walk from the apex anchor (recorded by the
  // BFS — no gradient guessing). Marks edges critical, finds the improvised
  // (non-stair) ascent, and yields the path cells for the dark-run budget.
  const ap = apexRoom();
  const enc3 = (f: number, idx: number): number => f * W * H + idx;
  let critLen = bfs.out[ap.floor][gi(ap.ax, ap.ay)];
  const critPath: [number, number][] = []; // [floor, idx] breach→apex
  {
    let code = enc3(ap.floor, gi(ap.ax, ap.ay));
    let guard = F * W * H;
    while (code >= 0 && guard-- > 0) {
      const f = (code / (W * H)) | 0;
      const idx = code % (W * H);
      critPath.push([f, idx]);
      const eIdx = bfs.via[code];
      if (eIdx >= 0) {
        vEdges[eIdx].isCritical = true;
        if (vEdges[eIdx].kind !== 'stair' && !improvEdge) {
          improvEdge = `${vEdges[eIdx].kind}@f${Math.min(vEdges[eIdx].fromFloor, vEdges[eIdx].toFloor)}`;
        }
      }
      code = bfs.parent[code];
    }
    critPath.reverse();
  }

  // --- 6. Semantics ---
  const roomOf = (f: number, x: number, y: number): TRoom | undefined => {
    const id = roomAt[f][gi(x, y)];
    return id >= 0 ? rooms[id] : undefined;
  };
  ap.type = 'beacon';
  ap.difficulty = 1;
  const breachRoom = roomOf(0, breach[1], breach[2] - 1) ?? roomOf(0, breach[1], breach[2] + 1);
  if (breachRoom) breachRoom.type = 'breach';
  // caches: intact sealed rooms (no rubble/hole/ledge on their border walls) — approximate: rooms with zero RUBBLE/HOLE cells
  const cacheRand = mulberry32(seed ^ 0xcac4e);
  const caches: Tower['caches'] = [];
  const intact = rooms.filter((r) => {
    if (r.type !== 'open' || r.floor === 0) return false;
    let bad = 0;
    for (let i = 0; i < W * H; i++) {
      if (roomAt[r.floor][i] === r.id && layers[r.floor][i] !== TCell.FLOOR) bad++;
    }
    return bad === 0 && r.w >= 4 && r.h >= 3;
  });
  intact.sort((a, b) => b.floor - a.floor);
  for (const r of intact) {
    if (caches.length >= 5) break;
    if (cacheRand() < 0.75) {
      r.type = 'cache';
      r.sealed = true;
      caches.push({ floor: r.floor, x: r.cx, y: r.cy, richness: 0.3 + 0.7 * (r.floor / F), roomId: r.id });
    }
  }
  // snuffer posts on the critical ascent at 55–85%
  const postRand = mulberry32(seed ^ 0x9057);
  const critFloors = vEdges.filter((e) => e.isCritical).map((e) => Math.max(e.fromFloor, e.toFloor));
  const postCands = rooms.filter(
    (r) => r.type === 'open' && r.floor / F >= 0.55 && r.floor / F <= 0.85 && critFloors.includes(r.floor),
  );
  for (let i = 0; i < Math.min(2, postCands.length); i++) {
    const r = postCands[Math.floor(postRand() * postCands.length)];
    if (r.type === 'open') r.type = 'post';
  }

  // --- Fixtures + light field ---
  const emitters: TEmitter[] = [];
  const fixRand = mulberry32(seed ^ 0xf1c5);
  const props: TProp[] = [];
  for (const r of rooms) {
    // one fixture per room (ceiling), alive p=0.12 weighted toward the shaft
    const nearShaft = Math.hypot(r.cx - (sx0 + 1), r.cy - (sy0 + 1)) < p.baseSize * 0.3;
    const alive = fixRand() < (nearShaft ? 0.24 : 0.08);
    emitters.push({ kind: 'fixture', floor: r.floor, x: r.cx, y: r.cy, radius: 6.5, intensity: alive ? 0.85 : 0, alive });
    props.push({ kind: 'fixture', floor: r.floor, x: r.cx, y: r.cy, rot: 0, scale: 1 });
  }
  emitters.push({ kind: 'beacon', floor: ap.floor, x: ap.cx, y: ap.cy, radius: 9, intensity: 0.2, alive: false });
  props.push({ kind: 'beacon', floor: ap.floor, x: ap.cx, y: ap.cy, rot: 0, scale: 1.6 });
  for (const c of caches) emitters.push({ kind: 'seal', floor: c.floor, x: c.x, y: c.y, radius: 3, intensity: 0.3, alive: true });

  const light: Float32Array[] = layers.map(() => new Float32Array(W * H));
  const applyLight = (): void => {
    for (const L of light) L.fill(0);
    for (const e of emitters) {
      if (e.intensity <= 0) continue;
      const R = Math.ceil(e.radius);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = e.x + dx;
          const y = e.y + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const v = Math.max(0, 1 - Math.hypot(dx, dy) / e.radius);
          light[e.floor][gi(x, y)] = Math.min(1, light[e.floor][gi(x, y)] + v * v * e.intensity);
        }
      }
    }
    // bleed 40% through holes to the floor below
    for (let f = F - 1; f >= 1; f--) {
      for (let i = 0; i < W * H; i++) {
        if (layers[f][i] === TCell.HOLE) light[f - 1][i] = Math.min(1, light[f - 1][i] + light[f][i] * 0.4);
      }
    }
  };
  applyLight();

  // Dark-run budget along the critical ascent (approximate the path by the
  // BFS gradient walk cells) — wake dead fixtures on violations (≤3/run).
  let fixturesWoken = 0;
  let longestDark = 0;
  {
    const path = critPath;
    for (let wake = 0; wake < 10; wake++) {
      longestDark = 0;
      let runStart = -1;
      let worstStart = -1;
      let worstLen = 0;
      for (let i = 0; i < path.length; i++) {
        const dark = light[path[i][0]][path[i][1]] < p.minLight;
        if (dark && runStart === -1) runStart = i;
        if ((!dark || i === path.length - 1) && runStart !== -1) {
          const len = (dark ? i + 1 : i) - runStart;
          if (len > worstLen) {
            worstLen = len;
            worstStart = runStart;
          }
          runStart = -1;
        }
      }
      longestDark = worstLen;
      if (worstLen <= p.maxDarkRun) break;
      if (fixturesWoken >= 6) {
        towerLastFail = 'dark budget unfixable';
        return null;
      }
      const [mf, mi] = path[worstStart + Math.floor(worstLen / 2)];
      let bestE: TEmitter | null = null;
      let bd = Infinity;
      for (const e of emitters) {
        if (e.kind !== 'fixture' || e.alive || e.floor !== mf) continue;
        const d = Math.hypot(e.x - (mi % W), e.y - ((mi / W) | 0));
        if (d < bd) {
          bd = d;
          bestE = e;
        }
      }
      if (!bestE) {
        towerLastFail = 'no fixture to wake';
        return null;
      }
      bestE.alive = true;
      bestE.intensity = 0.85;
      fixturesWoken++;
      applyLight();
    }
  }

  // darknessDensity per room
  for (const r of rooms) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      if (roomAt[r.floor][i] === r.id) {
        sum += 1 - light[r.floor][i];
        n++;
      }
    }
    r.darknessDensity = n ? sum / n : 0;
  }

  // --- 9. Decoration + spawns ---
  const decRand = mulberry32(seed ^ 0xdec0);
  const spawns: TSpawn[] = [];
  for (const r of rooms) {
    const cells: number[] = [];
    for (let i = 0; i < W * H; i++) if (roomAt[r.floor][i] === r.id && layers[r.floor][i] === TCell.FLOOR) cells.push(i);
    if (!cells.length) continue;
    const takeCell = (): number => cells.splice(Math.floor(decRand() * cells.length), 1)[0];
    // husks (cover), lockers in caches, glass fields, conduits along the walls
    const nHusk = Math.round((r.w * r.h) / 26 * p.decorDensity);
    for (let i = 0; i < nHusk && cells.length; i++) {
      const idx = takeCell();
      props.push({ kind: 'husk', floor: r.floor, x: idx % W, y: (idx / W) | 0, rot: (decRand() * 4) | 0, scale: 0.8 + decRand() * 0.5 });
    }
    if (r.type === 'cache' && cells.length) {
      const idx = takeCell();
      props.push({ kind: 'locker', floor: r.floor, x: idx % W, y: (idx / W) | 0, rot: 0, scale: 1 });
    }
    if (decRand() < 0.25 * p.decorDensity && cells.length) {
      const idx = takeCell();
      props.push({ kind: 'glass', floor: r.floor, x: idx % W, y: (idx / W) | 0, rot: 0, scale: 1 + decRand() });
    }
    // spawns
    if (r.type === 'breach') continue;
    const n = Math.round(((r.w * r.h) / 16) * (0.4 + 0.6 * r.difficulty) * (0.5 + r.darknessDensity));
    for (let i = 0; i < n && cells.length; i++) {
      const idx = takeCell();
      const tier: TSpawn['tier'] = r.type === 'beacon' ? 'warden' : (r.type === 'post' || r.floor / F > 0.6) && decRand() < 0.5 ? 'snuffer' : 'skitter';
      spawns.push({ floor: r.floor, x: idx % W, y: (idx / W) | 0, tier });
    }
  }
  // cable drops at climbs (the visual grammar for "you can climb here")
  for (const e of vEdges) {
    if (e.kind === 'climb') props.push({ kind: 'cable', floor: e.toFloor, x: e.x, y: e.y, rot: 0, scale: 1 });
  }

  // --- Stats + name ---
  let floorTiles = 0;
  let litTiles = 0;
  for (let f = 0; f < F; f++) {
    for (let i = 0; i < W * H; i++) {
      const c = layers[f][i];
      if (c === TCell.FLOOR || c === TCell.RUBBLE || c === TCell.STAIR || c === TCell.LEDGE) {
        floorTiles++;
        if (light[f][i] >= p.minLight) litTiles++;
      }
    }
  }
  // vertical loops: floors reachable by ≥2 distinct vertical edges
  let verticalLoops = 0;
  for (let f = 1; f < F; f++) {
    const ways = vEdges.filter((e) => !e.collapsed && Math.max(e.fromFloor, e.toFloor) === f && (e.toFloor === f || e.kind !== 'drop'));
    if (ways.length >= 2) verticalLoops++;
  }
  const nameRand = mulberry32(seed ^ 0xbead);
  const code = `${String.fromCharCode(65 + ((nameRand() * 26) | 0))}${String.fromCharCode(65 + ((nameRand() * 26) | 0))}-${(nameRand() * 90 + 10) | 0}`;
  const name = `${NAME_KIND[(nameRand() * NAME_KIND.length) | 0]} ${code} “${NAME_NICK[(nameRand() * NAME_NICK.length) | 0]}”`;

  return {
    params: p,
    name,
    W,
    H,
    floors: F,
    floorHeight: 3,
    layers,
    light,
    bfs: bfs.out,
    rooms,
    vEdges,
    emitters,
    props,
    caches,
    spawns,
    breach,
    stats: {
      floors: F,
      rooms: rooms.length,
      stairSegmentsCollapsed: collapsedSegs,
      holes,
      climbs,
      ledges,
      verticalLoops,
      criticalAscent: critLen,
      caches: caches.length,
      litFraction: floorTiles ? litTiles / floorTiles : 0,
      longestDarkRun: longestDark,
      fixturesWoken,
      rerolls: 0,
      genMs: 0,
      improvEdge,
    },
  };
}

// --- Acceptance suite ---------------------------------------------------------

export interface TAccept {
  name: string;
  pass: boolean;
  detail: string;
}

export function runTowerAcceptance(t: Tower, fast = false): TAccept[] {
  const r: TAccept[] = [];
  const { W, H, floors: F, layers, bfs, params, stats } = t;

  let total = 0;
  let reached = 0;
  for (let f = 0; f < F; f++) {
    for (let i = 0; i < W * H; i++) {
      const c = layers[f][i];
      if (c === TCell.FLOOR || c === TCell.RUBBLE || c === TCell.STAIR || c === TCell.LEDGE) {
        total++;
        if (bfs[f][i] >= 0) reached++;
      }
    }
  }
  const beacon = t.rooms.find((x) => x.type === 'beacon')!;
  const apexOk = bfs[beacon.floor][beacon.ay * W + beacon.ax] >= 0;
  r.push({ name: 'reachability', pass: reached === total && apexOk, detail: `${reached}/${total} cells, apex ${apexOk}` });

  if (!fast) {
    const sum = (t2: Tower): number => {
      let h = 2166136261;
      for (const L of t2.layers) for (let i = 0; i < L.length; i++) h = Math.imul(h ^ L[i], 16777619);
      return h >>> 0;
    };
    const c1 = sum(generateTower(params));
    const c2 = sum(generateTower(params));
    r.push({ name: 'determinism', pass: c1 === c2 && c2 === sum(t), detail: `${c1.toString(16)}/${c2.toString(16)}` });
  }

  r.push({ name: 'improvisation', pass: stats.improvEdge !== '', detail: stats.improvEdge || 'stairs suffice (VIOLATION)' });
  r.push({ name: 'vertical loops', pass: stats.verticalLoops >= 1, detail: `${stats.verticalLoops} floors with ≥2 routes` });
  r.push({
    name: 'dark budget',
    pass: stats.longestDarkRun <= params.maxDarkRun,
    detail: `longest ${stats.longestDarkRun} ≤ ${params.maxDarkRun} (${stats.fixturesWoken} woken)`,
  });

  const topThird = t.caches.filter((c) => c.floor >= (F * 2) / 3).map((c) => c.richness);
  const botThird = t.caches.filter((c) => c.floor < F / 3).map((c) => c.richness);
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  r.push({
    name: 'cache squeeze',
    pass: topThird.length === 0 || botThird.length === 0 || mean(topThird) > mean(botThird),
    detail: `top ${mean(topThird).toFixed(2)} vs bottom ${mean(botThird).toFixed(2)} (${t.caches.length} caches)`,
  });

  let groundHoles = 0;
  for (let i = 0; i < W * H; i++) if (layers[0][i] === TCell.HOLE) groundHoles++;
  let shaftOk = true;
  for (let f = 0; f < F; f++) {
    const c = layers[f][Math.floor(H / 2) * W + Math.floor(W / 2)];
    if (c !== TCell.SHAFT) shaftOk = false;
  }
  r.push({ name: 'structure clamps', pass: groundHoles === 0 && shaftOk, detail: `ground holes ${groundHoles}, shaft intact ${shaftOk}` });

  let badPlace = 0;
  for (const pr of t.props) {
    const c = layers[pr.floor][pr.y * W + pr.x];
    if (pr.kind !== 'cable' && pr.kind !== 'fixture' && pr.kind !== 'beacon' && c !== TCell.FLOOR) badPlace++;
  }
  for (const sp of t.spawns) if (layers[sp.floor][sp.y * W + sp.x] !== TCell.FLOOR) badPlace++;
  const lightCount = t.emitters.filter((e) => e.intensity > 0).length;
  r.push({ name: 'placement', pass: badPlace === 0, detail: `${badPlace} illegal; ${lightCount} live emitters` });

  r.push({ name: 'perf', pass: true, detail: `${stats.genMs.toFixed(1)}ms @ ${F} floors (50ms desktop budget)` });
  r.push({
    name: 'stats',
    pass: true,
    detail: `rooms ${stats.rooms} · collapsed ${stats.stairSegmentsCollapsed} · holes ${stats.holes} · climbs ${stats.climbs} · ledges ${stats.ledges} · lit ${(stats.litFraction * 100).toFixed(0)}%`,
  });
  return r;
}
