/**
 * Smooth voxel surface — naive Surface Nets (the Enshrouded direction).
 *
 * The voxel DATA stays the source of truth (destructible, flood-fill-lit);
 * this extracts a SMOOTH skin over it instead of blocky quads:
 *
 *   1. density lattice: each lattice point averages the solidity of its 8
 *      surrounding voxels → a continuous 0..1 field from binary voxels
 *   2. one vertex per surface-crossing cell, placed at the mean of its edge
 *      crossings (the classic surface-nets vertex)
 *   3. a quad per sign-changing lattice edge, joining the 4 cells around it
 *   4. normals from the density gradient — smooth shading for free
 *
 * Chunk-safe: cells one layer beyond the chunk border get (deterministic)
 * duplicate vertices, so seams match exactly with no cross-chunk stitching.
 * Emits the same attributes as the blocky mesher (color/alight/aao) so the
 * light-driven material works unchanged. Toggle blocky↔smooth at runtime:
 * this IS the grain benchmark.
 */

import * as THREE from 'three';
import { World } from '../config';
import { Mat, MATERIALS, isSolid } from '../world/Materials';
import { VoxelWorld, Chunk } from '../world/VoxelWorld';
import { LightGrid } from '../lighting/LightGrid';

const CS = World.chunkSize;
const ISO = 0.5;

// Solidity lookup table — avoids a MATERIALS object walk per voxel.
const SOLID_LUT = new Uint8Array(32);
for (const m of Object.values(MATERIALS)) SOLID_LUT[m.id] = m.solid ? 1 : 0;

export function buildSmoothChunkGeometry(
  world: VoxelWorld,
  light: LightGrid,
  chunk: Chunk,
): THREE.BufferGeometry | null {
  const baseX = chunk.cx * CS;
  const baseY = chunk.cy * CS;
  const baseZ = chunk.cz * CS;

  // --- Solidity slab: local voxels [-2..CS] on each axis. Filled by direct
  // chunk-array copies (the per-voxel world.get() path was the startup stall:
  // millions of string-keyed Map lookups across all chunks). ---
  const S = CS + 3; // slab side
  const solid = new Uint8Array(S * S * S);
  const mats = new Uint8Array(S * S * S);
  const sIdx = (x: number, y: number, z: number) => ((y + 2) * S + (z + 2)) * S + (x + 2);

  const x0 = baseX - 2;
  const y0 = baseY - 2;
  const z0 = baseZ - 2;
  for (let ncy = Math.floor(y0 / CS); ncy * CS <= y0 + S - 1; ncy++) {
    for (let ncz = Math.floor(z0 / CS); ncz * CS <= z0 + S - 1; ncz++) {
      for (let ncx = Math.floor(x0 / CS); ncx * CS <= x0 + S - 1; ncx++) {
        const nc = world.getChunk(ncx, ncy, ncz);
        if (!nc) continue; // missing chunk = air = zeros (already)
        // Overlap of this chunk with the slab, in world coords.
        const wx0 = Math.max(x0, ncx * CS);
        const wx1 = Math.min(x0 + S, (ncx + 1) * CS);
        const wy0 = Math.max(y0, ncy * CS);
        const wy1 = Math.min(y0 + S, (ncy + 1) * CS);
        const wz0 = Math.max(z0, ncz * CS);
        const wz1 = Math.min(z0 + S, (ncz + 1) * CS);
        for (let wy = wy0; wy < wy1; wy++) {
          const ly = wy - ncy * CS;
          for (let wz = wz0; wz < wz1; wz++) {
            const lz = wz - ncz * CS;
            const rowBase = (ly * CS + lz) * CS;
            const slabBase = ((wy - y0) * S + (wz - z0)) * S;
            for (let wx = wx0; wx < wx1; wx++) {
              const m = nc.voxels[rowBase + (wx - ncx * CS)];
              const si = slabBase + (wx - x0);
              mats[si] = m;
              solid[si] = SOLID_LUT[m];
            }
          }
        }
      }
    }
  }

  // --- Density at lattice point p = avg solidity of the 8 voxels sharing it.
  // Lattice range needed: [-1..CS] per axis (corners of cells [-1..CS-1]).
  const L = CS + 2;
  const density = new Float32Array(L * L * L);
  const dIdx = (x: number, y: number, z: number) => ((y + 1) * L + (z + 1)) * L + (x + 1);
  for (let y = -1; y <= CS; y++) {
    for (let z = -1; z <= CS; z++) {
      for (let x = -1; x <= CS; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 0; dy++) {
          for (let dz = -1; dz <= 0; dz++) {
            for (let dx = -1; dx <= 0; dx++) {
              sum += solid[sIdx(x + dx, y + dy, z + dz)];
            }
          }
        }
        density[dIdx(x, y, z)] = sum / 8;
      }
    }
  }

  // --- Pass 1: a vertex for every surface cell in [-1..CS-1]³ ---
  const VW = CS + 1; // cell index window per axis (offset by +1)
  const cellVert = new Int32Array(VW * VW * VW).fill(-1);
  const cIdx = (x: number, y: number, z: number) => ((y + 1) * VW + (z + 1)) * VW + (x + 1);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const alight: number[] = [];
  const aao: number[] = [];
  const amat: number[] = []; // material id → per-material procedural texture
  const indices: number[] = [];
  let vcount = 0;

  const CORNERS: [number, number, number][] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  // Cell edges as corner-index pairs.
  const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // x-edges
    [0, 2], [1, 3], [4, 6], [5, 7], // y-edges
    [0, 4], [1, 5], [2, 6], [3, 7], // z-edges
  ];

  const d8 = new Float32Array(8);

  for (let cy = -1; cy < CS; cy++) {
    for (let cz = -1; cz < CS; cz++) {
      for (let cx = -1; cx < CS; cx++) {
        let inside = 0;
        for (let k = 0; k < 8; k++) {
          const c = CORNERS[k];
          d8[k] = density[dIdx(cx + c[0], cy + c[1], cz + c[2])];
          if (d8[k] >= ISO) inside++;
        }
        if (inside === 0 || inside === 8) continue;

        // Vertex = mean of edge crossings.
        let px = 0;
        let py = 0;
        let pz = 0;
        let crossings = 0;
        for (const [a, b] of EDGES) {
          const da = d8[a];
          const db = d8[b];
          if (da >= ISO === db >= ISO) continue;
          const t = (ISO - da) / (db - da);
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          px += ca[0] + (cb[0] - ca[0]) * t;
          py += ca[1] + (cb[1] - ca[1]) * t;
          pz += ca[2] + (cb[2] - ca[2]) * t;
          crossings++;
        }
        px /= crossings;
        py /= crossings;
        pz /= crossings;

        // Normal from the density gradient (toward less solid).
        let gx =
          d8[1] + d8[3] + d8[5] + d8[7] - (d8[0] + d8[2] + d8[4] + d8[6]);
        let gy =
          d8[2] + d8[3] + d8[6] + d8[7] - (d8[0] + d8[1] + d8[4] + d8[5]);
        let gz =
          d8[4] + d8[5] + d8[6] + d8[7] - (d8[0] + d8[1] + d8[2] + d8[3]);
        let glen = Math.hypot(gx, gy, gz);
        if (glen < 1e-6) {
          // Degenerate (symmetric) cell: a zero normal here becomes NaN in
          // the shader, and ONE NaN pixel blacks out the whole bloom chain.
          gx = 0;
          gy = 1;
          gz = 0;
          glen = 1;
        }

        // Material: this cell's voxel if solid, else its most-solid neighbour.
        let m = mats[sIdx(cx, cy, cz)] as Mat;
        if (!isSolid(m)) {
          const below = mats[sIdx(cx, cy - 1, cz)] as Mat;
          if (isSolid(below)) m = below;
          else {
            m = Mat.Stone;
            for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
              const nm = mats[sIdx(cx + ox, cy + oy, cz + oz)] as Mat;
              if (isSolid(nm)) {
                m = nm;
                break;
              }
            }
          }
        }
        const mat = MATERIALS[m] ?? MATERIALS[Mat.Stone];

        // Light: average flood-fill light over the open voxels around the cell.
        let lsum = 0;
        let lcount = 0;
        for (const [ox, oy, oz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
          if (!solid[sIdx(cx + ox, cy + oy, cz + oz)]) {
            lsum += light.sample(baseX + cx + ox, baseY + cy + oy, baseZ + cz + oz);
            lcount++;
          }
        }
        const l = lcount > 0 ? LightGrid.normalize(lsum / lcount) : 0;

        // AO from local packing: buried creases sit darker.
        let dsum = 0;
        for (let k = 0; k < 8; k++) dsum += d8[k];
        const ao = 1 - 0.4 * Math.min(1, dsum / 6);

        positions.push(baseX + cx + px, baseY + cy + py, baseZ + cz + pz);
        normals.push(-gx / glen, -gy / glen, -gz / glen);
        colors.push(mat.color[0], mat.color[1], mat.color[2]);
        alight.push(Math.max(l, LightGrid.normalize(mat.emission) * 0.72));
        aao.push(ao);
        amat.push(m);
        cellVert[cIdx(cx, cy, cz)] = vcount++;
      }
    }
  }

  if (vcount === 0) return null;

  // --- Pass 2: quads across sign-changing lattice edges owned by this chunk.
  // Edge at lattice point q along axis a joins cells (q-offsets ⊥ a).
  for (let qy = 0; qy < CS; qy++) {
    for (let qz = 0; qz < CS; qz++) {
      for (let qx = 0; qx < CS; qx++) {
        const d0 = density[dIdx(qx, qy, qz)];
        // +X edge
        emitEdge(d0, density[dIdx(qx + 1, qy, qz)], [
          cellVert[cIdx(qx, qy, qz)],
          cellVert[cIdx(qx, qy - 1, qz)],
          cellVert[cIdx(qx, qy - 1, qz - 1)],
          cellVert[cIdx(qx, qy, qz - 1)],
        ]);
        // +Y edge
        emitEdge(d0, density[dIdx(qx, qy + 1, qz)], [
          cellVert[cIdx(qx, qy, qz)],
          cellVert[cIdx(qx, qy, qz - 1)],
          cellVert[cIdx(qx - 1, qy, qz - 1)],
          cellVert[cIdx(qx - 1, qy, qz)],
        ]);
        // +Z edge
        emitEdge(d0, density[dIdx(qx, qy, qz + 1)], [
          cellVert[cIdx(qx, qy, qz)],
          cellVert[cIdx(qx - 1, qy, qz)],
          cellVert[cIdx(qx - 1, qy - 1, qz)],
          cellVert[cIdx(qx, qy - 1, qz)],
        ]);
      }
    }
  }

  function emitEdge(d0: number, d1: number, quad: number[]): void {
    const in0 = d0 >= ISO;
    const in1 = d1 >= ISO;
    if (in0 === in1) return;
    if (quad[0] < 0 || quad[1] < 0 || quad[2] < 0 || quad[3] < 0) return;
    // Winding: surface faces the AIR side.
    const [a, b, c, d] = in1 ? quad : [quad[3], quad[2], quad[1], quad[0]];
    indices.push(a, b, c, a, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('alight', new THREE.Float32BufferAttribute(alight, 1));
  geo.setAttribute('aao', new THREE.Float32BufferAttribute(aao, 1));
  geo.setAttribute('amat', new THREE.Float32BufferAttribute(amat, 1));
  geo.setIndex(indices);
  return geo;
}
