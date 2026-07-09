/**
 * CAVE GENERATOR — pure data, zero THREE imports (John's spec, verbatim
 * pipeline). generateCave(params) → Cave. Deterministic (mulberry32 threaded
 * through every stage); internal re-roll (derived seed, ≤5) on connectivity
 * or dark-budget failure. Acceptance suite exported (runAcceptance) so the
 * lab page and the headless test print the SAME results.
 *
 * Layout-first: chambers scattered/separated → Delaunay → MST + loops →
 * SEMANTICS BEFORE CARVING (breach/Nest/veins/wardstones/dens) → wandering
 * A* tunnels with pinches & SQUEEZE → chasms with crossings & BRINK →
 * raster + BFS + LIGHT FIELD with the maxDarkRun survival budget → decor.
 */

// --- Cell / flag encodings ---------------------------------------------------

export const enum Cell {
  VOID = 0,
  FLOOR = 1,
  WALL = 2,
  CHASM = 3,
  CROSSING = 4,
}
export const FLAG_SQUEEZE = 1;
export const FLAG_BRINK = 2;

export interface CaveParams {
  seed: number;
  chamberCount: number;
  loopChance: number;
  tunnelWander: number;
  blobAmp: number;
  maxDarkRun: number;
  minLight: number;
  decorDensity: number;
  chasmCount: number;
}

export const CAVE_DEFAULTS: CaveParams = {
  seed: 1,
  chamberCount: 34,
  loopChance: 0.2,
  tunnelWander: 3.0,
  blobAmp: 0.35,
  maxDarkRun: 22,
  minLight: 0.08,
  decorDensity: 0.6,
  chasmCount: 3,
};

export interface Chamber {
  id: number;
  cx: number;
  cy: number;
  baseR: number;
  archetype: 'pocket' | 'gallery' | 'cavern';
  type: 'breach' | 'nest' | 'vein' | 'wardstone' | 'den' | 'open';
  depth: number; // graph hops from breach
  difficulty: number;
  darknessDensity: number;
  richness: number; // veins only
  tint: [number, number, number];
}

export interface Emitter {
  kind: 'crystal' | 'glowmoss' | 'wardstone' | 'vein';
  x: number;
  y: number;
  radius: number;
  intensity: number;
}

export interface Prop {
  kind: 'stalagmite' | 'stalactite' | 'crystal' | 'glowmoss' | 'sporesac' | 'pool' | 'vein' | 'wardstone';
  x: number;
  y: number;
  rot: number;
  scale: number;
}

export interface Spawn {
  x: number;
  y: number;
  tier: 'skitter' | 'snuffer' | 'breacher';
}

export interface CaveStats {
  chambers: number;
  edges: number;
  loops: number;
  criticalLength: number;
  floorTiles: number;
  veins: number;
  litFraction: number;
  longestDarkRun: number;
  mossInjections: number;
  rerolls: number;
  genMs: number;
}

export interface Cave {
  params: CaveParams;
  name: string;
  W: number;
  H: number;
  grid: Uint8Array; // Cell
  flags: Uint8Array; // FLAG_*
  ceiling: Uint8Array; // 1..4
  light: Float32Array; // 0..1
  bfs: Int16Array; // from breach, -1 non-floor
  chambers: Chamber[];
  edges: [number, number][]; // chamber id pairs (final graph)
  mstEdges: [number, number][];
  delaunayEdges: [number, number][];
  criticalPath: number[]; // tile indices breach→nest
  emitters: Emitter[];
  props: Prop[];
  spawns: Spawn[];
  stats: CaveStats;
}

// --- RNG + noise ---------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  float(a: number, b: number): number;
  int(a: number, b: number): number;
  pick<T>(arr: T[]): T;
  chance(p: number): boolean;
  gaussian(mu: number, sigma: number): number;
  raw(): number;
}

function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  return {
    raw: r,
    float: (a, b) => a + r() * (b - a),
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    gaussian: (mu, sigma) => {
      const u = Math.max(r(), 1e-9);
      const v = r();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

/** Seeded 2D value noise, ~[0,1]. */
function makeNoise2(seed: number): (x: number, y: number) => number {
  const h = (x: number, y: number): number => {
    let n = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const sm = (t: number): number => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = sm(x - xi);
    const fy = sm(y - yi);
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// --- Delaunay (Bowyer–Watson, small n) ------------------------------------------

function delaunay(pts: { x: number; y: number }[]): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];
  // Super-triangle
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const dm = Math.max(maxX - minX, maxY - minY) * 10 + 10;
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const P = pts.concat([
    { x: mx - dm, y: my - dm },
    { x: mx + dm, y: my - dm },
    { x: mx, y: my + dm },
  ]);
  interface Tri {
    a: number;
    b: number;
    c: number;
    x: number;
    y: number;
    r2: number;
  }
  const circum = (a: number, b: number, c: number): Tri => {
    const A = P[a];
    const B = P[b];
    const C = P[c];
    const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    const ux = ((A.x * A.x + A.y * A.y) * (B.y - C.y) + (B.x * B.x + B.y * B.y) * (C.y - A.y) + (C.x * C.x + C.y * C.y) * (A.y - B.y)) / d;
    const uy = ((A.x * A.x + A.y * A.y) * (C.x - B.x) + (B.x * B.x + B.y * B.y) * (A.x - C.x) + (C.x * C.x + C.y * C.y) * (B.x - A.x)) / d;
    return { a, b, c, x: ux, y: uy, r2: (A.x - ux) ** 2 + (A.y - uy) ** 2 };
  };
  let tris: Tri[] = [circum(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const bad: Tri[] = [];
    const good: Tri[] = [];
    for (const t of tris) {
      if ((P[i].x - t.x) ** 2 + (P[i].y - t.y) ** 2 < t.r2) bad.push(t);
      else good.push(t);
    }
    // boundary polygon of the bad region
    const edgeCount = new Map<string, [number, number]>();
    for (const t of bad) {
      for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (edgeCount.has(k)) edgeCount.delete(k);
        else edgeCount.set(k, [a, b]);
      }
    }
    tris = good;
    for (const [a, b] of edgeCount.values()) tris.push(circum(a, b, i));
  }
  const edges = new Set<string>();
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) {
      // keep only edges fully inside the real point set
      for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        if (a < n && b < n) edges.add(a < b ? `${a}_${b}` : `${b}_${a}`);
      }
      continue;
    }
    for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
      edges.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  }
  return [...edges].sort().map((k) => k.split('_').map(Number) as [number, number]);
}

// --- Name tables -----------------------------------------------------------------

const NAME_A = ['Weeping', 'Hollow', 'Sunken', 'Whispering', 'Breathless', 'Drowned', 'Silent', 'Gnawed', 'Pale', 'Shivering'];
const NAME_B = ['Throat', 'Maw', 'Gullet', 'Warren', 'Hollows', 'Depths', 'Gallery', 'Undercroft', 'Roots', 'Veins'];
const NAME_C = ['Ossuar', 'Merrow', 'Duskvane', 'Hollowreach', 'Grimsel', 'Vantre', 'Sorrowfen', 'Umbral', 'Cravven', 'Nyx'];

// --- Main -------------------------------------------------------------------------

/** Why the last attempt re-rolled (debug/stats visibility). */
export let lastFailReason = '';
/** Per-stage ms of the LAST successful generation — optimization ground truth. */
export const lastStageMs: Record<string, number> = {};

export function generateCave(params: Partial<CaveParams> = {}): Cave {
  const p: CaveParams = { ...CAVE_DEFAULTS, ...params };
  const t0 = performance.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const seed = attempt === 0 ? p.seed : (Math.imul(p.seed, 0x9e3779b1) + attempt) | 0;
    const cave = tryGenerate(p, seed, attempt);
    if (cave) {
      cave.stats.rerolls = attempt;
      cave.stats.genMs = performance.now() - t0;
      return cave;
    }
  }
  throw new Error(`cave seed ${p.seed}: 5 attempts failed connectivity/dark budget`);
}

function tryGenerate(p: CaveParams, seed: number, attempt: number): Cave | null {
  let tMark = performance.now();
  const mark = (name: string): void => {
    const now = performance.now();
    lastStageMs[name] = (lastStageMs[name] ?? 0) + (now - tMark);
    tMark = now;
  };
  if (attempt === 0) for (const k of Object.keys(lastStageMs)) delete lastStageMs[k];
  const rng = makeRng(seed);
  const noise = makeNoise2(seed ^ 0x51ab);

  // --- 1. Chamber scatter ---
  const spread = Math.sqrt(p.chamberCount) * 6.5;
  interface Cand {
    x: number;
    y: number;
    baseR: number;
    archetype: Chamber['archetype'];
    blobAmp: number;
    f: number;
    phase: number;
  }
  const cands: Cand[] = [];
  const nCand = Math.round(p.chamberCount * 1.4);
  for (let i = 0; i < nCand; i++) {
    const ang = rng.float(0, Math.PI * 2);
    const rr = Math.sqrt(rng.raw());
    const roll = rng.raw();
    const archetype: Chamber['archetype'] = roll < 0.4 ? 'pocket' : roll < 0.8 ? 'gallery' : 'cavern';
    const baseR = archetype === 'pocket' ? rng.float(4, 6) / 2 : archetype === 'gallery' ? rng.float(8, 13) / 2 : rng.float(15, 22) / 2;
    cands.push({
      x: Math.cos(ang) * rr * spread * 1.25,
      y: Math.sin(ang) * rr * spread,
      baseR,
      archetype,
      blobAmp: rng.float(0.25, 0.5),
      f: rng.float(1.2, 2.6),
      phase: rng.float(0, 100),
    });
  }
  // Force ≥2 caverns
  let caverns = cands.filter((c) => c.archetype === 'cavern').length;
  for (let i = 0; caverns < 2 && i < cands.length; i++) {
    if (cands[i].archetype !== 'cavern') {
      cands[i].archetype = 'cavern';
      cands[i].baseR = rng.float(15, 22) / 2;
      caverns++;
    }
  }

  mark('scatter');
  // --- 2. Separation (AABB push-apart over blob bounds, 3-cell padding) ---
  const pad = 3;
  // Flat arrays + precomputed radii — same pair order and math as before,
  // ~3× faster constants on mobile.
  const n = cands.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const rs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = cands[i].x;
    ys[i] = cands[i].y;
    rs[i] = cands[i].baseR * (1 + cands[i].blobAmp) + pad;
  }
  for (let iter = 0; iter < 300; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const rr = rs[i] + rs[j];
        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        const ox = rr - Math.abs(dx);
        if (ox <= 0) continue;
        const oy = rr - Math.abs(dy);
        if (oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const push = (ox / 2 + 0.1) * Math.sign(dx || 1);
          xs[i] -= push;
          xs[j] += push;
        } else {
          const push = (oy / 2 + 0.1) * Math.sign(dy || 1);
          ys[i] -= push;
          ys[j] += push;
        }
      }
    }
    if (!moved) break;
  }
  for (let i = 0; i < n; i++) {
    cands[i].x = xs[i];
    cands[i].y = ys[i];
  }
  for (const c of cands) {
    c.x = Math.round(c.x);
    c.y = Math.round(c.y);
  }
  // Cull smallest overflow down to chamberCount
  cands.sort((a, b) => b.baseR - a.baseR);
  const kept = cands.slice(0, p.chamberCount);

  mark('separation');
  // --- 3. Connectivity graph ---
  const dEdges = delaunay(kept);
  // Prim MST
  const dist = (e: [number, number]): number => Math.hypot(kept[e[0]].x - kept[e[1]].x, kept[e[0]].y - kept[e[1]].y);
  const inTree = new Set<number>([0]);
  const mst: [number, number][] = [];
  while (inTree.size < kept.length) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const e of dEdges) {
      const aIn = inTree.has(e[0]);
      const bIn = inTree.has(e[1]);
      if (aIn === bIn) continue;
      const d = dist(e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) { lastFailReason = 'delaunay'; return null; }
    mst.push(best);
    inTree.add(best[0]);
    inTree.add(best[1]);
  }
  const meanMst = mst.reduce((s, e) => s + dist(e), 0) / mst.length;
  const mstKeys = new Set(mst.map((e) => `${Math.min(...e)}_${Math.max(...e)}`));
  const edges: [number, number][] = [...mst];
  for (const e of dEdges) {
    const k = `${Math.min(...e)}_${Math.max(...e)}`;
    if (mstKeys.has(k)) continue;
    if (dist(e) > 2.2 * meanMst) continue;
    if (rng.chance(p.loopChance)) edges.push(e);
  }
  const loops = edges.length - kept.length + 1;

  mark('graph');
  // --- 4. Semantics before carving ---
  const adj: number[][] = kept.map(() => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const hop = (from: number): number[] => {
    const d = new Array(kept.length).fill(-1);
    d[from] = 0;
    const q = [from];
    let h = 0;
    while (h < q.length) {
      const c = q[h++];
      for (const nb of adj[c]) {
        if (d[nb] === -1) {
          d[nb] = d[c] + 1;
          q.push(nb);
        }
      }
    }
    return d;
  };
  // Nest = largest cavern
  let nest = 0;
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].archetype === 'cavern' && kept[i].baseR >= kept[nest].baseR) nest = i;
    else if (kept[nest].archetype !== 'cavern' && kept[i].archetype === 'cavern') nest = i;
  }
  const fromNest = hop(nest);
  // Breach = degree-1 chamber maximizing graph distance from Nest
  let breach = -1;
  for (let i = 0; i < kept.length; i++) {
    if (adj[i].length === 1 && i !== nest && (breach === -1 || fromNest[i] > fromNest[breach])) breach = i;
  }
  if (breach === -1) {
    // no leaf — take max-distance chamber
    breach = fromNest.indexOf(Math.max(...fromNest));
    if (breach === nest) { lastFailReason = 'breach'; return null; }
  }
  const depth = hop(breach);
  const maxDepth = Math.max(...depth, 1);

  const chambers: Chamber[] = kept.map((c, i) => ({
    id: i,
    cx: c.x,
    cy: c.y,
    baseR: c.baseR,
    archetype: c.archetype,
    type: 'open',
    depth: depth[i],
    difficulty: i === nest ? 1 : 0.15 + 0.85 * (depth[i] / maxDepth),
    darknessDensity: 0,
    richness: 0,
    tint: [0, 0, 0],
  }));
  chambers[nest].type = 'nest';
  chambers[breach].type = 'breach';
  // critical path (chamber hops breach→nest)
  const critChambers: number[] = [];
  {
    let cur = nest;
    critChambers.push(cur);
    while (cur !== breach) {
      let next = -1;
      for (const nb of adj[cur]) {
        if (depth[nb] === depth[cur] - 1) {
          next = nb;
          break;
        }
      }
      if (next === -1) { lastFailReason = 'critpath'; return null; }
      cur = next;
      critChambers.push(cur);
    }
    critChambers.reverse();
  }
  const onCrit = new Set(critChambers);
  // Veins = leaf chambers (cap 5)
  let veinsPlaced = 0;
  const leafByDepth = chambers
    .filter((c) => adj[c.id].length === 1 && c.type === 'open')
    .sort((a, b) => b.depth - a.depth);
  for (const c of leafByDepth) {
    if (veinsPlaced >= 5) break;
    c.type = 'vein';
    c.richness = 0.3 + 0.7 * (c.depth / maxDepth);
    veinsPlaced++;
  }
  // Wardstones 1-2 mid-depth off-path
  const wardCandidates = chambers.filter(
    (c) => c.type === 'open' && !onCrit.has(c.id) && c.depth / maxDepth > 0.3 && c.depth / maxDepth < 0.7,
  );
  const nWard = Math.min(wardCandidates.length, rng.int(1, 2));
  for (let i = 0; i < nWard; i++) {
    const c = wardCandidates[Math.floor(rng.raw() * wardCandidates.length)];
    if (c.type === 'open') c.type = 'wardstone';
  }
  // Snuffer dens 1-2 on critical path at 55–85% depth
  const denCands = critChambers.filter((id) => {
    const t = depth[id] / maxDepth;
    return t >= 0.55 && t <= 0.85 && chambers[id].type === 'open';
  });
  const nDen = Math.min(denCands.length, rng.int(1, 2));
  for (let i = 0; i < nDen; i++) {
    const id = denCands[Math.floor(rng.raw() * denCands.length)];
    if (chambers[id].type === 'open') chambers[id].type = 'den';
  }
  // tints — cool bioluminescent range
  for (const c of chambers) {
    const hue = rng.float(0.45, 0.78); // teal → violet
    const [r, g, b] = hsl(hue, 0.55, 0.5);
    c.tint = [r, g, b];
  }

  mark('semantics');
  // --- Grid extents ---
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of kept) {
    const R = c.baseR * (1 + c.blobAmp) + 4;
    minX = Math.min(minX, c.x - R);
    maxX = Math.max(maxX, c.x + R);
    minY = Math.min(minY, c.y - R);
    maxY = Math.max(maxY, c.y + R);
  }
  const OX = Math.floor(minX) - 4;
  const OY = Math.floor(minY) - 4;
  const W = Math.ceil(maxX) - OX + 5;
  const H = Math.ceil(maxY) - OY + 5;
  const grid = new Uint8Array(W * H); // VOID
  const flags = new Uint8Array(W * H);
  const chamberAt = new Int16Array(W * H).fill(-1);
  const gi = (x: number, y: number): number => y * W + x;
  // Per-chamber floor-cell index, built once at carve time — every later stage
  // reads this instead of rescanning the whole grid (the v1 perf sin).
  const chamberCells: number[][] = kept.map(() => []);

  mark('extents');
  // --- Carve chambers (radial blobs) ---
  const LUT_N = 128;
  const rLut = new Float32Array(LUT_N + 1);
  for (let ci = 0; ci < kept.length; ci++) {
    const c = kept[ci];
    // Angular radius LUT (128 samples + lerp): the per-cell atan2+noise pair
    // was 13% of generation; the blob silhouette is identical to the eye.
    for (let i = 0; i <= LUT_N; i++) {
      const th = (i / LUT_N) * Math.PI * 2 - Math.PI;
      rLut[i] = c.baseR * (1 + c.blobAmp * (noise((Math.cos(th) + 1) * c.f + c.phase, (Math.sin(th) + 1) * c.f) * 2 - 1));
    }
    const R = c.baseR * (1 + c.blobAmp) + 1;
    for (let y = Math.floor(c.y - R); y <= c.y + R; y++) {
      for (let x = Math.floor(c.x - R); x <= c.x + R; x++) {
        const dx = x - c.x;
        const dy = y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        let inside = d < 0.001;
        if (!inside) {
          const tf = ((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * LUT_N;
          const t0 = Math.floor(tf);
          const rTheta = rLut[t0] + (rLut[Math.min(t0 + 1, LUT_N)] - rLut[t0]) * (tf - t0);
          inside = d <= rTheta;
        }
        if (inside) {
          const ii = gi(x - OX, y - OY);
          if (grid[ii] === Cell.VOID) chamberCells[ci].push(ii);
          grid[ii] = Cell.FLOOR;
          chamberAt[ii] = ci;
        }
      }
    }
  }

  mark('carve-chambers');
  // --- 6. Tunnels: A* over wander cost field, width 1-3, pinches, SQUEEZE ---
  // Precomputed once — ~90 tunnels × per-node noise calls was the A* tax.
  const sFreq = 0.11;
  const costField = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      costField[y * W + x] = 1 + p.tunnelWander * noise((x + OX) * sFreq, (y + OY) * sFreq);
    }
  }
  const tunnelCells: number[][] = []; // per-edge path (tile indices)
  const mouthCells = new Set<number>();
  const critEdgeSet = new Set<string>();
  for (let i = 0; i < critChambers.length - 1; i++) {
    critEdgeSet.add(`${Math.min(critChambers[i], critChambers[i + 1])}_${Math.max(critChambers[i], critChambers[i + 1])}`);
  }
  for (const [aId, bId] of edges) {
    const A = kept[aId];
    const B = kept[bId];
    const pad = 16;
    const bx0 = Math.max(2, Math.min(A.x, B.x) - OX - pad);
    const bx1 = Math.min(W - 3, Math.max(A.x, B.x) - OX + pad);
    const by0 = Math.max(2, Math.min(A.y, B.y) - OY - pad);
    const by1 = Math.min(H - 3, Math.max(A.y, B.y) - OY + pad);
    const path = astar(A.x - OX, A.y - OY, B.x - OX, B.y - OY, W, H, costField, bx0, by0, bx1, by1);
    if (!path) { lastFailReason = 'astar'; return null; }
    const isCrit = critEdgeSet.has(`${Math.min(aId, bId)}_${Math.max(aId, bId)}`);
    // width profile with ≥1 pinch
    const widths: number[] = path.map((_, i) => {
      const t = i / Math.max(1, path.length - 1);
      const wNoise = noise(i * 0.15 + aId, bId * 3.1);
      let w = isCrit ? (wNoise > 0.45 ? 3 : 2) : wNoise > 0.66 ? 3 : wNoise > 0.25 ? 2 : 1;
      if (t < 0.12 || t > 0.88) w = Math.max(w, 2); // mouths never squeeze
      return w;
    });
    // enforce a pinch: width-1 run of 2-4 cells mid-path
    const pinchAt = Math.floor(path.length * rng.float(0.3, 0.7));
    const pinchLen = rng.int(2, 4);
    for (let i = pinchAt; i < Math.min(path.length, pinchAt + pinchLen); i++) widths[i] = 1;
    const cells: number[] = [];
    for (let i = 0; i < path.length; i++) {
      const [px, py] = path[i];
      const w = widths[i];
      const rad = (w - 1) / 2;
      for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++) {
        for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
          if (Math.hypot(dx, dy) > rad + 0.45) continue;
          const x = px + dx;
          const y = py + dy;
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          const idx = gi(x, y);
          if (grid[idx] === Cell.VOID) {
            grid[idx] = Cell.FLOOR;
            cells.push(idx);
          }
          if (w === 1 && dx === 0 && dy === 0 && chamberAt[idx] === -1) flags[idx] |= FLAG_SQUEEZE;
        }
      }
      // tunnel mouth = first/last cells that touch a chamber
      if (i < 3 || i > path.length - 4) mouthCells.add(gi(px, py));
    }
    tunnelCells.push(cells);
  }

  mark('tunnels');
  // --- 7. Chasms ---
  const chasmTargets: { cx: number; cy: number; r: number }[] = [];
  const cavernsArr = chambers.filter((c) => c.archetype === 'cavern' && c.type !== 'breach');
  for (let i = 0; i < Math.min(2, cavernsArr.length) && chasmTargets.length < p.chasmCount; i++) {
    const c = cavernsArr[Math.floor(rng.raw() * cavernsArr.length)];
    chasmTargets.push({ cx: c.cx - OX, cy: c.cy - OY, r: c.baseR });
  }
  while (chasmTargets.length < p.chasmCount && tunnelCells.length) {
    const t = tunnelCells[Math.floor(rng.raw() * tunnelCells.length)];
    if (!t.length) break;
    const mid = t[Math.floor(t.length / 2)];
    chasmTargets.push({ cx: mid % W, cy: Math.floor(mid / W), r: 4 });
  }
  let chasmsPlaced = 0;
  for (const tgt of chasmTargets) {
    // Try a few orientations/offsets — v1 gave up on first severance and some
    // seeds shipped with zero BRINK terrain.
    for (let attemptC = 0; attemptC < 4; attemptC++) {
      const wSpan = rng.int(2, 4);
      const horizontal = rng.chance(0.5);
      const offA = rng.int(-2, 2);
      const span = Math.ceil(tgt.r * 2.4);
      const marked: number[] = [];
      for (let along = -span; along <= span; along++) {
        for (let across = 0; across < wSpan; across++) {
          const x = tgt.cx + (horizontal ? along : across - Math.floor(wSpan / 2) + offA);
          const y = tgt.cy + (horizontal ? across - Math.floor(wSpan / 2) + offA : along);
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          const idx = gi(x, y);
          if (grid[idx] === Cell.FLOOR && !(flags[idx] & FLAG_SQUEEZE) && !mouthCells.has(idx)) marked.push(idx);
        }
      }
      if (marked.length < 4) continue;
      for (const idx of marked) grid[idx] = Cell.CHASM;
      // crossings from the middle third of the span, so bridges bridge
      const mid = marked.slice(Math.floor(marked.length / 3), Math.ceil((marked.length * 2) / 3));
      const nCross = rng.int(1, 2);
      for (let i = 0; i < nCross; i++) {
        const idx = mid[Math.floor(rng.raw() * mid.length)] ?? marked[Math.floor(marked.length / 2)];
        grid[idx] = Cell.CROSSING;
      }
      if (fullyConnected(grid, W, H, kept[breach].x - OX, kept[breach].y - OY)) {
        chasmsPlaced++;
        break;
      }
      for (const idx of marked) grid[idx] = Cell.FLOOR; // revert, try next orientation
    }
  }
  if (chasmsPlaced === 0 && p.chasmCount > 0) { lastFailReason = 'chasm'; return null; }

  // BRINK flags
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = gi(x, y);
      if (grid[idx] !== Cell.FLOOR && grid[idx] !== Cell.CROSSING) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (grid[gi(x + dx, y + dy)] === Cell.CHASM) {
          flags[idx] |= FLAG_BRINK;
          break;
        }
      }
    }
  }

  mark('chasms');
  // --- Connectivity (hard gate) ---
  if (!fullyConnected(grid, W, H, kept[breach].x - OX, kept[breach].y - OY)) { lastFailReason = 'connectivity'; return null; }

  mark('connectivity');
  // --- 8. Rasterize walls, ceilings, BFS ---
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = gi(x, y);
      if (grid[idx] !== Cell.VOID) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const g = grid[gi(nx, ny)];
          if (g === Cell.FLOOR || g === Cell.CHASM || g === Cell.CROSSING) {
            touch = true;
            break;
          }
        }
      }
      if (touch) grid[idx] = Cell.WALL;
    }
  }
  const ceiling = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = gi(x, y);
      if (grid[idx] === Cell.VOID || grid[idx] === Cell.WALL) continue;
      if (flags[idx] & FLAG_SQUEEZE) {
        ceiling[idx] = 1;
        continue;
      }
      const ch = chamberAt[idx];
      const base = ch >= 0 && chambers[ch].archetype === 'cavern' ? 3.5 : ch >= 0 ? 2.5 : 2;
      ceiling[idx] = Math.max(1, Math.min(4, Math.round(base + (noise(x * 0.2, y * 0.2) - 0.5) * 1.6)));
    }
  }
  const bfs = bfsField(grid, W, H, kept[breach].x - OX, kept[breach].y - OY);

  // Critical path as tiles: greedy descent breach→nest over per-tile BFS from nest.
  const bfsNest = bfsField(grid, W, H, kept[nest].x - OX, kept[nest].y - OY);
  const critPath: number[] = [];
  {
    let cx = kept[breach].x - OX;
    let cy = kept[breach].y - OY;
    let guard = W * H;
    while (guard-- > 0) {
      critPath.push(gi(cx, cy));
      if (bfsNest[gi(cx, cy)] === 0) break;
      let bx = cx;
      let by = cy;
      let best = bfsNest[gi(cx, cy)];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const v = bfsNest[gi(cx + dx, cy + dy)];
        if (v >= 0 && v < best) {
          best = v;
          bx = cx + dx;
          by = cy + dy;
        }
      }
      if (bx === cx && by === cy) break;
      cx = bx;
      cy = by;
    }
  }

  mark('raster');
  // --- 9. Light field + dark-budget enforcement ---
  const emitters: Emitter[] = [];
  const props: Prop[] = [];
  const propOccupied = new Set<number>();
  const place = (kind: Prop['kind'], x: number, y: number, scale = 1): boolean => {
    const idx = gi(x, y);
    const g = grid[idx];
    if (g !== Cell.FLOOR || propOccupied.has(idx) || mouthCells.has(idx) || flags[idx] & FLAG_SQUEEZE) return false;
    props.push({ kind, x, y, rot: rng.float(0, Math.PI * 2), scale });
    propOccupied.add(idx);
    return true;
  };

  // Emissive decor per chamber (crystals, moss, veins, wardstones)
  for (const c of chambers) {
    const cellsOf = chamberCells[c.id].filter((i) => grid[i] === Cell.FLOOR);
    if (!cellsOf.length) continue;
    const pickCell = (): [number, number] => {
      const idx = cellsOf[Math.floor(rng.raw() * cellsOf.length)];
      return [idx % W, Math.floor(idx / W)];
    };
    if (c.type === 'wardstone') {
      const [x, y] = pickCell();
      if (place('wardstone', x, y, 1.4)) emitters.push({ kind: 'wardstone', x, y, radius: 7, intensity: 0.25 });
    }
    if (c.type === 'vein') {
      const nVein = 2 + Math.round(3 * c.richness);
      for (let i = 0; i < nVein; i++) {
        const [x, y] = pickCell();
        if (place('vein', x, y, 0.8 + c.richness)) emitters.push({ kind: 'vein', x, y, radius: 4, intensity: 0.5 });
      }
    }
    // crystals — brighter pockets, more in caverns
    const nCrystal = Math.round((c.archetype === 'cavern' ? 2 : rng.chance(0.4) ? 1 : 0) * p.decorDensity * 1.6);
    for (let i = 0; i < nCrystal; i++) {
      const [x, y] = pickCell();
      if (place('crystal', x, y, rng.float(0.7, 1.5))) emitters.push({ kind: 'crystal', x, y, radius: 9, intensity: 1 });
    }
    // glowmoss — dim herd anchors
    const nMoss = Math.round(rng.int(0, 2) * p.decorDensity);
    for (let i = 0; i < nMoss; i++) {
      const [x, y] = pickCell();
      if (place('glowmoss', x, y, rng.float(0.8, 1.3))) emitters.push({ kind: 'glowmoss', x, y, radius: 5.5, intensity: 0.45 });
    }
  }

  const light = new Float32Array(W * H);
  const applyLight = (): void => {
    light.fill(0);
    for (const e of emitters) {
      const R = Math.ceil(e.radius);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = e.x + dx;
          const y = e.y + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const d = Math.hypot(dx, dy);
          const v = Math.max(0, 1 - d / e.radius);
          light[gi(x, y)] = Math.min(1, light[gi(x, y)] + v * v * e.intensity);
        }
      }
    }
  };
  applyLight();

  // Dark-run budget along the critical path
  let mossInjections = 0;
  let longestDark = 0;
  for (let guard = 0; guard < 12; guard++) {
    longestDark = 0;
    let runStart = -1;
    let worstStart = -1;
    let worstLen = 0;
    for (let i = 0; i < critPath.length; i++) {
      const dark = light[critPath[i]] < p.minLight;
      if (dark && runStart === -1) runStart = i;
      if ((!dark || i === critPath.length - 1) && runStart !== -1) {
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
    if (mossInjections >= 3 * Math.ceil(critPath.length / Math.max(1, p.maxDarkRun))) { lastFailReason = 'moss-cap'; return null; }
    // inject glowmoss at the midpoint of the offending run
    const midIdx = critPath[worstStart + Math.floor(worstLen / 2)];
    const mx = midIdx % W;
    const my = Math.floor(midIdx / W);
    let placed = false;
    for (let r = 0; r <= 2 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          if (place('glowmoss', mx + dx, my + dy, 1.1)) {
            emitters.push({ kind: 'glowmoss', x: mx + dx, y: my + dy, radius: 6, intensity: 0.5 });
            placed = true;
          }
        }
      }
    }
    if (!placed) {
      // squeeze/mouth cell — emit anyway without a prop footprint
      emitters.push({ kind: 'glowmoss', x: mx, y: my, radius: 6, intensity: 0.5 });
    }
    mossInjections++;
    applyLight();
  }
  if (longestDark > p.maxDarkRun) { lastFailReason = 'darkbudget'; return null; }

  // darknessDensity per chamber (mean 1−light over its floor)
  for (const c of chambers) {
    let sum = 0;
    let n = 0;
    for (const i of chamberCells[c.id]) {
      if (grid[i] === Cell.FLOOR) {
        sum += 1 - light[i];
        n++;
      }
    }
    c.darknessDensity = n ? sum / n : 0;
  }

  mark('light');
  // --- Non-emissive decoration ---
  for (const c of chambers) {
    if (c.type === 'breach') continue;
    const cellsOf = chamberCells[c.id].filter((i) => grid[i] === Cell.FLOOR);
    const area = cellsOf.length;
    if (!area) continue;
    const interior = cellsOf.filter((idx) => {
      const x = idx % W;
      const y = Math.floor(idx / W);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const g = grid[gi(x + dx, y + dy)];
          if (g !== Cell.FLOOR && g !== Cell.CROSSING && g !== Cell.CHASM) return false;
        }
      }
      for (const m of mouthCells) if (Math.abs((m % W) - x) + Math.abs(Math.floor(m / W) - y) < 2) return false;
      return true;
    });
    const nStag = Math.round((c.archetype === 'cavern' ? 4 : 1.4) * p.decorDensity);
    for (let i = 0; i < nStag && interior.length; i++) {
      const idx = interior[Math.floor(rng.raw() * interior.length)];
      place('stalagmite', idx % W, Math.floor(idx / W), rng.float(0.7, 1.7));
    }
    for (const idx of cellsOf) {
      if (ceiling[idx] >= 3 && rng.chance(0.05 * p.decorDensity)) {
        const x = idx % W;
        const y = Math.floor(idx / W);
        if (!propOccupied.has(idx)) props.push({ kind: 'stalactite', x, y, rot: rng.float(0, 6.28), scale: rng.float(0.7, 1.5) });
      }
    }
    if (rng.chance(0.3 * p.decorDensity)) {
      const idx = cellsOf[Math.floor(rng.raw() * cellsOf.length)];
      place('pool', idx % W, Math.floor(idx / W), rng.float(1, 2));
    }
    if (rng.chance(0.35 * p.decorDensity)) {
      const idx = cellsOf[Math.floor(rng.raw() * cellsOf.length)];
      place('sporesac', idx % W, Math.floor(idx / W), rng.float(0.7, 1.2));
    }
  }

  mark('decor');
  // --- Spawns ---
  const spawns: Spawn[] = [];
  for (const c of chambers) {
    if (c.type === 'breach' || c.type === 'wardstone') continue;
    const cellsOf = chamberCells[c.id].filter((i) => grid[i] === Cell.FLOOR && !propOccupied.has(i) && !mouthCells.has(i));
    const n = Math.round((cellsOf.length / 16) * (0.4 + 0.6 * c.difficulty) * (0.5 + c.darknessDensity));
    for (let i = 0; i < n && cellsOf.length; i++) {
      const idx = cellsOf.splice(Math.floor(rng.raw() * cellsOf.length), 1)[0];
      const tier: Spawn['tier'] =
        c.type === 'nest' && rng.chance(0.5) ? 'breacher' : (c.type === 'den' || (c.archetype === 'cavern' && c.depth / maxDepth > 0.5)) && rng.chance(0.5) ? 'snuffer' : 'skitter';
      spawns.push({ x: idx % W, y: Math.floor(idx / W), tier });
    }
  }

  mark('spawns');
  // --- Stats + name ---
  let floorTiles = 0;
  let litTiles = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === Cell.FLOOR || grid[i] === Cell.CROSSING) {
      floorTiles++;
      if (light[i] >= p.minLight) litTiles++;
    }
  }
  const nameRng = makeRng(seed ^ 0xbead);
  const name = `The ${NAME_A[Math.floor(nameRng.raw() * NAME_A.length)]} ${NAME_B[Math.floor(nameRng.raw() * NAME_B.length)]} of ${NAME_C[Math.floor(nameRng.raw() * NAME_C.length)]}`;

  return {
    params: p,
    name,
    W,
    H,
    grid,
    flags,
    ceiling,
    light,
    bfs,
    chambers,
    edges,
    mstEdges: mst,
    delaunayEdges: dEdges,
    criticalPath: critPath,
    emitters,
    props,
    spawns,
    stats: {
      chambers: chambers.length,
      edges: edges.length,
      loops,
      criticalLength: critPath.length,
      floorTiles,
      veins: props.filter((pr) => pr.kind === 'vein').length,
      litFraction: floorTiles ? litTiles / floorTiles : 0,
      longestDarkRun: longestDark,
      mossInjections,
      rerolls: attempt,
      genMs: 0,
    },
  };
}

// A* scratch (module-level, versioned — see astar)
let asG = new Float64Array(0);
let asFrom = new Int32Array(0);
let asStamp = new Int32Array(0);
let asGen = 0;

// --- Helpers ---------------------------------------------------------------------

function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

let fcSeen = new Int32Array(0);
let fcQueue = new Int32Array(0);
let fcGen = 0;

function fullyConnected(grid: Uint8Array, W: number, H: number, sx: number, sy: number): boolean {
  const pass = (g: number): boolean => g === Cell.FLOOR || g === Cell.CROSSING;
  if (fcSeen.length < grid.length) {
    fcSeen = new Int32Array(grid.length);
    fcQueue = new Int32Array(grid.length);
  }
  fcGen++;
  let total = 0;
  for (let i = 0; i < grid.length; i++) if (pass(grid[i])) total++;
  if (!pass(grid[sy * W + sx])) {
    // nudge to a nearby floor
    let found = false;
    for (let r = 1; r <= 4 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (pass(grid[(sy + dy) * W + sx + dx])) {
            sx += dx;
            sy += dy;
            found = true;
          }
        }
      }
    }
    if (!found) return false;
  }
  fcQueue[0] = sy * W + sx;
  fcSeen[fcQueue[0]] = fcGen;
  let head = 0;
  let tail = 1;
  let count = 1;
  while (head < tail) {
    const idx = fcQueue[head++];
    const x = idx % W;
    const y = (idx / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (fcSeen[ni] !== fcGen && pass(grid[ni])) {
        fcSeen[ni] = fcGen;
        count++;
        fcQueue[tail++] = ni;
      }
    }
  }
  return count === total;
}

function bfsField(grid: Uint8Array, W: number, H: number, sx: number, sy: number): Int16Array {
  const pass = (g: number): boolean => g === Cell.FLOOR || g === Cell.CROSSING;
  const out = new Int16Array(grid.length).fill(-1);
  // snap
  outer: for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (pass(grid[(sy + dy) * W + sx + dx])) {
          sx += dx;
          sy += dy;
          break outer;
        }
      }
    }
  }
  const start = sy * W + sx;
  if (!pass(grid[start])) return out;
  out[start] = 0;
  const q = [start];
  let head = 0;
  while (head < q.length) {
    const idx = q[head++];
    const x = idx % W;
    const y = (idx / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (out[ni] === -1 && pass(grid[ni])) {
        out[ni] = out[idx] + 1;
        q.push(ni);
      }
    }
  }
  return out;
}

/** A* over an open field (before walls exist) with a wander cost.
 *  Binary heap + typed arrays — the naive open-list scan was O(n²) and blew
 *  the 50ms generation budget. */
function astar(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  W: number,
  H: number,
  costField: Float32Array,
  bx0 = 2,
  by0 = 2,
  bx1 = 1e9,
  by1 = 1e9,
): [number, number][] | null {
  // Scratch reuse: ~45 tunnels/gen were each allocating W*H arrays (GC churn
  // was a third of generation time on the phone). Version stamps make stale
  // entries invisible without refilling.
  if (asG.length < W * H) {
    asG = new Float64Array(W * H);
    asFrom = new Int32Array(W * H);
    asStamp = new Int32Array(W * H);
  }
  asGen++;
  const g = asG;
  const from = asFrom;
  const stamp = asStamp;
  const gen = asGen;
  const heapIdx: number[] = [];
  const heapF: number[] = [];
  const push = (idx: number, f: number): void => {
    heapIdx.push(idx);
    heapF.push(f);
    let i = heapIdx.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heapF[par] <= heapF[i]) break;
      [heapF[par], heapF[i]] = [heapF[i], heapF[par]];
      [heapIdx[par], heapIdx[i]] = [heapIdx[i], heapIdx[par]];
      i = par;
    }
  };
  const pop = (): number => {
    const top = heapIdx[0];
    const lastI = heapIdx.pop()!;
    const lastF = heapF.pop()!;
    if (heapIdx.length) {
      heapIdx[0] = lastI;
      heapF[0] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        [heapIdx[m], heapIdx[i]] = [heapIdx[i], heapIdx[m]];
        i = m;
      }
    }
    return top;
  };
  const start = sy * W + sx;
  g[start] = 0;
  stamp[start] = gen;
  from[start] = -1;
  push(start, 0);
  while (heapIdx.length) {
    const cur = pop();
    const cx = cur % W;
    const cy = (cur / W) | 0;
    if (Math.abs(cx - tx) + Math.abs(cy - ty) <= 1) {
      const path: [number, number][] = [[cx, cy]];
      let k = cur;
      while (from[k] !== -1) {
        k = from[k];
        path.push([k % W, (k / W) | 0]);
      }
      path.reverse();
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < bx0 || ny < by0 || nx > Math.min(bx1, W - 3) || ny > Math.min(by1, H - 3)) continue;
      const nk = ny * W + nx;
      const ng = g[cur] + costField[nk];
      if (stamp[nk] !== gen || ng < g[nk]) {
        stamp[nk] = gen;
        g[nk] = ng;
        from[nk] = cur;
        push(nk, ng + Math.hypot(tx - nx, ty - ny));
      }
    }
  }
  return null;
}

// --- Acceptance suite (shared by lab page + headless test) ------------------------

export interface AcceptResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** fast=true skips the determinism re-generation check (2 extra full gens) —
 *  use for the per-regen HUD; run the full suite from the VERIFY button. */
export function runAcceptance(cave: Cave, fast = false): AcceptResult[] {
  const r: AcceptResult[] = [];
  const { W, grid, flags, bfs, chambers, stats, params } = cave;
  const pass = (g: number): boolean => g === Cell.FLOOR || g === Cell.CROSSING;

  // 1. reachability
  let floorTotal = 0;
  let reached = 0;
  for (let i = 0; i < grid.length; i++) {
    if (pass(grid[i])) {
      floorTotal++;
      if (bfs[i] >= 0) reached++;
    }
  }
  r.push({ name: 'reachability', pass: reached === floorTotal, detail: `${reached}/${floorTotal} floor cells` });

  // 2. determinism (3 runs, checksum) — skipped in fast mode (2 extra gens)
  if (!fast) {
    const sum = (g: Uint8Array): number => {
      let h = 2166136261;
      for (let i = 0; i < g.length; i++) h = Math.imul(h ^ g[i], 16777619);
      return h >>> 0;
    };
    const c1 = sum(generateCave(params).grid);
    const c2 = sum(generateCave(params).grid);
    const c3 = sum(cave.grid);
    r.push({ name: 'determinism', pass: c1 === c2 && c2 === c3, detail: `checksums ${c1.toString(16)}/${c2.toString(16)}/${c3.toString(16)}` });
  }

  // 3. nest depth / breach degree
  const nest = chambers.find((c) => c.type === 'nest')!;
  const breach = chambers.find((c) => c.type === 'breach')!;
  const maxD = Math.max(...chambers.map((c) => c.depth));
  const deg = cave.edges.filter((e) => e.includes(breach.id)).length;
  const nestAdj = cave.edges.some((e) => (e[0] === breach.id && e[1] === nest.id) || (e[1] === breach.id && e[0] === nest.id));
  r.push({
    name: 'nest/breach',
    pass: nest.depth >= 0.6 * maxD && deg === 1 && !nestAdj,
    detail: `nest depth ${nest.depth}/${maxD}, breach degree ${deg}, adjacent ${nestAdj}`,
  });

  // 4. dark budget
  r.push({
    name: 'dark budget',
    pass: stats.longestDarkRun <= params.maxDarkRun,
    detail: `longest ${stats.longestDarkRun} ≤ ${params.maxDarkRun} (${stats.mossInjections} injections)`,
  });

  // 5. squeeze curve on veins
  const veins = chambers.filter((c) => c.type === 'vein');
  const third = maxD / 3;
  const deepR = veins.filter((v) => v.depth > 2 * third).map((v) => v.richness);
  const shallowR = veins.filter((v) => v.depth <= third).map((v) => v.richness);
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const squeezeOk = deepR.length === 0 || shallowR.length === 0 || mean(deepR) > mean(shallowR);
  r.push({
    name: 'squeeze curve',
    pass: squeezeOk,
    detail: `deep ${mean(deepR).toFixed(2)} vs shallow ${mean(shallowR).toFixed(2)} (${veins.length} veins)`,
  });

  // 6. pinches/squeeze/brink exist
  let squeezeCells = 0;
  let brinkCells = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] & FLAG_SQUEEZE) squeezeCells++;
    if (flags[i] & FLAG_BRINK) brinkCells++;
  }
  r.push({ name: 'squeeze+brink', pass: squeezeCells >= 1 && brinkCells >= 1, detail: `squeeze ${squeezeCells}, brink ${brinkCells}` });

  // 7. loops
  r.push({ name: 'loops', pass: stats.loops >= 1, detail: `cyclomatic ${stats.loops}` });

  // 8. prop/spawn placement legality + light budget
  let badPlace = 0;
  for (const pr of cave.props) {
    const g = grid[pr.y * W + pr.x];
    if (g !== Cell.FLOOR) badPlace++;
  }
  for (const sp of cave.spawns) {
    const g = grid[sp.y * W + sp.x];
    if (g !== Cell.FLOOR) badPlace++;
  }
  r.push({ name: 'placement', pass: badPlace === 0, detail: `${badPlace} illegal placements; ${cave.emitters.length} emitters` });

  // 9. perf
  r.push({ name: 'perf', pass: stats.genMs < 50 || params.chamberCount < 60, detail: `${stats.genMs.toFixed(1)}ms @ ${stats.chambers} chambers` });

  // context stat line
  r.push({
    name: 'stats',
    pass: true,
    detail: `lit ${(stats.litFraction * 100).toFixed(0)}%, crit ${stats.criticalLength}, floor ${stats.floorTiles}, rerolls ${stats.rerolls}`,
  });
  return r;
}
