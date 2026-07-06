/**
 * Elemental testbeds — three iteration corners carved into the real map.
 *
 * John's ask: seed the world's corners with live testbeds so the new elemental
 * systems (water, fire, force-wave/build) can be tuned in-game. These are carved
 * straight into the generated 256² tile at three of its corners, each on a flat
 * stone stage with cleared headroom so the procedural cave terrain never buries
 * them:
 *
 *   WATER  (NW, ~-84,-90): a natural noise-shored lake (~58×28, 6-deep bowl)
 *                          with a solid dirt lakebed, wave surface + fish.
 *   FORGE  (NE, ~+90,-90): a stone hearth of coal + live embers (the fire zone).
 *   SANDBOX(SW, ~-90,+90): a flat build deck + a starter tower to force-wave.
 *
 * carveTestbeds() only writes VOXELS (geometry + emissive markers). The visual
 * systems (WaterZone, FireZone, BuildSandbox) consume the returned metadata to
 * build their meshes/particles. Call it AFTER generateReek() but BEFORE
 * lightGrid.update()+remesh so the new emissives light and mesh with everything.
 */

import * as THREE from 'three';
import { Mat } from './Materials';
import type { VoxelWorld } from './VoxelWorld';

/** A single water body: an organically-shaped lake inside a bounding rect. */
export interface Pool {
  cx: number;
  cz: number;
  /** Bounding half-extent along X (the surface plane spans the full rect). */
  halfX: number;
  /** Bounding half-extent along Z. */
  halfZ: number;
  /** World Y the water surface plane sits at. */
  surfaceY: number;
  /** World Y of the DEEPEST lakebed top face (center of the bowl). */
  floorY: number;
  /** Per-column water depth over the bbox, row-major [iz*depthW+ix],
   *  0 = land, 255 = maxDepth. The shader reads it for shore foam + depth
   *  tint; gameplay can read it to know where the water actually is. */
  depth: Uint8Array<ArrayBuffer>;
  depthW: number;
  depthD: number;
  /** Deepest water column, in voxels. */
  maxDepth: number;
}

/** An axis-aligned voxel rect + its top surface Y. */
export interface Slab {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  topY: number;
}

export interface Testbeds {
  water: { center: THREE.Vector3; teleport: THREE.Vector3; pools: Pool[] };
  forge: { center: THREE.Vector3; teleport: THREE.Vector3; bed: Slab; hearths: THREE.Vector3[] };
  sandbox: { center: THREE.Vector3; teleport: THREE.Vector3; deck: Slab };
  /** Every flattened stage footprint — worldgen decorations placed BEFORE the
   *  carve (grass, etc.) float over these and must be re-seated onto the real
   *  column top (main.ts does this after carving). */
  stages: Slab[];
}

// Flat stage geometry, shared by every zone.
const FLOOR_TOP = 4; // world Y of each stage's walkable stone surface
const BASE_DEPTH = 10; // solid stone below the surface
const HEADROOM = 16; // air cleared above the surface (top y=20 = light-volume ceiling)
const ZONE_HALF = 18; // half-width of a zone footprint (→ 36×36 stages)

/** Deterministic 0..1 hash so ember scatter is stable across reloads. */
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function carveTestbeds(world: VoxelWorld): Testbeds {
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, m: Mat): void => {
    for (let ix = x; ix < x + w; ix++)
      for (let iy = y; iy < y + h; iy++)
        for (let iz = z; iz < z + d; iz++) world.set(ix, iy, iz, m);
  };

  /** Lay a flat stone stage over a rect: solid base + cleared headroom. */
  const stages: Slab[] = [];
  const stageRect = (x0: number, z0: number, x1: number, z1: number): void => {
    // Solid stone base up to (and including) FLOOR_TOP.
    box(x0, FLOOR_TOP - BASE_DEPTH, z0, x1 - x0, BASE_DEPTH + 1, z1 - z0, Mat.Stone);
    // Clear the air above so cave terrain never roofs the stage.
    box(x0, FLOOR_TOP + 1, z0, x1 - x0, HEADROOM, z1 - z0, Mat.Air);
    stages.push({ x0, z0, x1, z1, topY: FLOOR_TOP });
  };
  /** Square stage centered on (cx,cz). */
  const stage = (cx: number, cz: number): void =>
    stageRect(cx - ZONE_HALF, cz - ZONE_HALF, cx + ZONE_HALF, cz + ZONE_HALF);

  // === WATER (NW corner): a natural LAKE ===
  // John's call: not a rectangle. The shoreline is a radius modulated by
  // angular noise (deterministic phases), and the bottom is a BOWL — a shallow
  // shelf at the shore falling to a deep center. Every wet column gets a DIRT
  // lakebed voxel under it: a real, solid floor (its own hitbox) that grass,
  // wards and the orb can seat on / collide with.
  const wcx = -84; // center pulled in so the stage stays inside the -128 edge
  const wcz = -90;
  const LAKE_HX = 32; // bounding half-extents — the lake fills ~80% of this
  const LAKE_HZ = 17;
  const LAKE_DEPTH = 6; // voxels of water at the deepest point
  stageRect(wcx - LAKE_HX - 6, wcz - LAKE_HZ - 6, wcx + LAKE_HX + 6, wcz + LAKE_HZ + 6);
  const depthW = LAKE_HX * 2;
  const depthD = LAKE_HZ * 2;
  const depth = new Uint8Array(depthW * depthD);
  // Shoreline wobble phases — hashed, so the shape is stable across reloads.
  const ph1 = hash3(1, 7, 3) * Math.PI * 2;
  const ph2 = hash3(4, 2, 9) * Math.PI * 2;
  const ph3 = hash3(8, 5, 1) * Math.PI * 2;
  for (let iz = 0; iz < depthD; iz++) {
    for (let ix = 0; ix < depthW; ix++) {
      const x = wcx - LAKE_HX + ix;
      const z = wcz - LAKE_HZ + iz;
      const nx = (x - wcx + 0.5) / LAKE_HX;
      const nz = (z - wcz + 0.5) / LAKE_HZ;
      const r = Math.hypot(nx, nz);
      const th = Math.atan2(nz, nx);
      // Noisy shore radius: 0.6 … 1.0 of the bounding ellipse.
      const tau =
        0.8 + 0.1 * Math.sin(2 * th + ph1) + 0.06 * Math.sin(3 * th + ph2) + 0.04 * Math.sin(5 * th + ph3);
      if (r >= tau) continue; // land
      // Bowl profile: shallow shelf at the rim, LAKE_DEPTH at the center.
      const u = r / tau;
      const d = Math.max(1, Math.round(LAKE_DEPTH * Math.pow(1 - u * u, 0.7)));
      depth[iz * depthW + ix] = Math.round((d / LAKE_DEPTH) * 255);
      for (let y = FLOOR_TOP - d + 1; y <= FLOOR_TOP; y++) world.set(x, y, z, Mat.Water);
      world.set(x, FLOOR_TOP - d, z, Mat.Dirt); // the lakebed — solid, attachable
    }
  }
  const pools: Pool[] = [
    {
      cx: wcx,
      cz: wcz,
      halfX: LAKE_HX,
      halfZ: LAKE_HZ,
      surfaceY: FLOOR_TOP + 0.6, // surface sits just under the shore lip
      floorY: FLOOR_TOP - LAKE_DEPTH + 1, // deepest bed top face
      depth,
      depthW,
      depthD,
      maxDepth: LAKE_DEPTH,
    },
  ];

  // === FORGE (NE corner): coal hearth with scattered live embers ===
  const fcx = 90;
  const fcz = -90;
  stage(fcx, fcz);
  const hearthHalf = 9;
  const bedTop = FLOOR_TOP + 3;
  // Stone hearth ring (2 tall) so the coal sits in a basin.
  box(fcx - hearthHalf - 1, FLOOR_TOP + 1, fcz - hearthHalf - 1, (hearthHalf + 1) * 2, 2, (hearthHalf + 1) * 2, Mat.Stone);
  box(fcx - hearthHalf, FLOOR_TOP + 1, fcz - hearthHalf, hearthHalf * 2, 2, hearthHalf * 2, Mat.Air);
  // Coal bed (3 tall). The top layer keeps a sparse Ember speckle purely to feed
  // the flood-fill (the hearth lights its surroundings); visually it's hidden
  // under FireZone's glowing-crack coal overlay.
  for (let x = fcx - hearthHalf; x < fcx + hearthHalf; x++) {
    for (let z = fcz - hearthHalf; z < fcz + hearthHalf; z++) {
      for (let y = FLOOR_TOP + 1; y <= bedTop; y++) {
        const hot = y === bedTop && hash3(x, y, z) > 0.62; // ~38% of the top face
        world.set(x, y, z, hot ? Mat.Ember : Mat.Coal);
      }
    }
  }
  const hearths: THREE.Vector3[] = [
    new THREE.Vector3(fcx, bedTop + 1, fcz),
    new THREE.Vector3(fcx - 4.5, bedTop + 1, fcz - 3),
    new THREE.Vector3(fcx + 4.5, bedTop + 1, fcz + 3),
    new THREE.Vector3(fcx + 3, bedTop + 1, fcz - 4.5),
  ];

  // === SANDBOX (SW corner): flat build deck + a starter tower ===
  const scx = -90;
  const scz = 90;
  stage(scx, scz);
  const deck: Slab = { x0: scx - ZONE_HALF, z0: scz - ZONE_HALF, x1: scx + ZONE_HALF, z1: scz + ZONE_HALF, topY: FLOOR_TOP };
  // A hollow stone tower with glass windows + a wood roof — something to smash
  // with the force wave on day one. (Player-built voxels are what the force wave
  // actually scatters; this seeds one so the zone isn't empty.)
  const tx = scx + 6;
  const tz = scz + 6;
  const th = 12;
  box(tx - 3, FLOOR_TOP + 1, tz - 3, 6, th, 6, Mat.Stone);
  box(tx - 2, FLOOR_TOP + 1, tz - 2, 4, th - 2, 4, Mat.Air); // hollow
  for (const wy of [FLOOR_TOP + 4, FLOOR_TOP + 8]) {
    box(tx - 3, wy, tz - 1, 1, 2, 2, Mat.Glass);
    box(tx + 2, wy, tz - 1, 1, 2, 2, Mat.Glass);
  }
  box(tx - 3, FLOOR_TOP + th, tz - 3, 6, 1, 6, Mat.Wood); // roof cap

  return {
    water: {
      center: new THREE.Vector3(wcx, FLOOR_TOP, wcz),
      // Land on the shore beside the lake, not over open water.
      teleport: new THREE.Vector3(wcx, FLOOR_TOP + 3, wcz + LAKE_HZ + 3),
      pools,
    },
    forge: {
      center: new THREE.Vector3(fcx, bedTop, fcz),
      teleport: new THREE.Vector3(fcx, bedTop + 4, fcz + 12),
      bed: { x0: fcx - hearthHalf, z0: fcz - hearthHalf, x1: fcx + hearthHalf, z1: fcz + hearthHalf, topY: bedTop },
      hearths,
    },
    sandbox: {
      center: new THREE.Vector3(scx, FLOOR_TOP, scz),
      teleport: new THREE.Vector3(scx - 6, FLOOR_TOP + 3, scz - 6),
      deck,
    },
    stages,
  };
}
