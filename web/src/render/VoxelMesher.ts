/**
 * Voxel mesher — face-culling with SMOOTH LIGHTING + AMBIENT OCCLUSION.
 *
 * Flat per-face light reads as programmer-art. Instead, each face vertex
 * samples the flood-fill light of the 4 cells that touch that corner and
 * averages them (Minecraft-style smooth lighting), and bakes a corner AO term
 * from neighbouring solidity. Light then *gradients* across faces and creases
 * go soft and dark — the single biggest step from "greybox" to "place".
 *
 * Attributes emitted per vertex:
 *   color   — material albedo
 *   alight  — smoothed static light 0..1
 *   aao     — ambient occlusion 0..1 (also applied to dynamic light in-shader)
 */

import * as THREE from 'three';
import { World } from '../config';
import { Mat, MATERIALS, isSolid } from '../world/Materials';
import { VoxelWorld, Chunk } from '../world/VoxelWorld';
import { LightGrid } from '../lighting/LightGrid';
import { logger } from '../core/log';

const meshLog = logger('mesher');

const CS = World.chunkSize;
const VS = World.voxelSize;

// Solidity lookup table — avoids a MATERIALS object walk per sample.
const SOLID_LUT = new Uint8Array(32);
for (const m of Object.values(MATERIALS)) SOLID_LUT[m.id] = m.solid ? 1 : 0;

// Reusable slabs: local copies of materials + baked light covering [-1..CS]
// on each axis. Every neighbour/AO/light sample below reads these flat arrays
// instead of going through world.get()/light.sample() — each of those is a
// string-keyed Map lookup, and a chunk mesh makes ~10⁵ of them (this was
// ~80% of mesh time; the SmoothMesher learned the same lesson first).
const SLAB = CS + 2;
const slabMats = new Uint8Array(SLAB * SLAB * SLAB);
const slabLight = new Uint8Array(SLAB * SLAB * SLAB);
const sIdx = (x: number, y: number, z: number): number => ((y + 1) * SLAB + (z + 1)) * SLAB + (x + 1);

/** Copy the chunk + a 1-voxel border of its neighbours into the slabs. */
function fillSlabs(world: VoxelWorld, chunk: Chunk): void {
  slabMats.fill(0);
  slabLight.fill(0);
  const x0 = chunk.cx * CS - 1;
  const y0 = chunk.cy * CS - 1;
  const z0 = chunk.cz * CS - 1;
  for (let ncy = Math.floor(y0 / CS); ncy * CS <= y0 + SLAB - 1; ncy++) {
    for (let ncz = Math.floor(z0 / CS); ncz * CS <= z0 + SLAB - 1; ncz++) {
      for (let ncx = Math.floor(x0 / CS); ncx * CS <= x0 + SLAB - 1; ncx++) {
        const nc = world.getChunk(ncx, ncy, ncz);
        if (!nc) continue; // missing chunk = air + dark (zeros already)
        const wx0 = Math.max(x0, ncx * CS);
        const wx1 = Math.min(x0 + SLAB, (ncx + 1) * CS);
        const wy0 = Math.max(y0, ncy * CS);
        const wy1 = Math.min(y0 + SLAB, (ncy + 1) * CS);
        const wz0 = Math.max(z0, ncz * CS);
        const wz1 = Math.min(z0 + SLAB, (ncz + 1) * CS);
        for (let wy = wy0; wy < wy1; wy++) {
          const ly = wy - ncy * CS;
          for (let wz = wz0; wz < wz1; wz++) {
            const rowBase = (ly * CS + (wz - ncz * CS)) * CS;
            const slabBase = ((wy - y0) * SLAB + (wz - z0)) * SLAB;
            for (let wx = wx0; wx < wx1; wx++) {
              const i = rowBase + (wx - ncx * CS);
              const si = slabBase + (wx - x0);
              slabMats[si] = nc.voxels[i];
              slabLight[si] = nc.light[i];
            }
          }
        }
      }
    }
  }
}

interface Face {
  n: [number, number, number];
  corners: [number, number, number][];
}
const FACES: Face[] = [
  { n: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] }, // +X
  { n: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] }, // -X
  { n: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] }, // +Y
  { n: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y
  { n: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] }, // +Z
  { n: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] }, // -Z
];

// AO curve per open-neighbour count (0 = fully occluded corner).
const AO_CURVE = [0.42, 0.62, 0.82, 1.0];

export function buildChunkGeometry(
  world: VoxelWorld,
  light: LightGrid,
  chunk: Chunk,
): THREE.BufferGeometry | null {
  // Light values are read from the same chunk.light arrays the LightGrid
  // samples — via the slab copy below, not per-sample calls.
  void light;
  fillSlabs(world, chunk);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const alight: number[] = [];
  const aao: number[] = [];
  const amat: number[] = []; // material id → per-material procedural texture
  const indices: number[] = [];
  let vcount = 0;

  const baseX = chunk.cx * CS;
  const baseY = chunk.cy * CS;
  const baseZ = chunk.cz * CS;

  for (let ly = 0; ly < CS; ly++) {
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const m = chunk.voxels[Chunk.index(lx, ly, lz)] as Mat;
        if (!isSolid(m)) continue;
        const mat = MATERIALS[m];
        const emissive = mat.emission > 0;
        const wx = baseX + lx;
        const wy = baseY + ly;
        const wz = baseZ + lz;

        for (const f of FACES) {
          // Air cell this face looks into (slab-local coordinates).
          const ax = lx + f.n[0];
          const ay = ly + f.n[1];
          const az = lz + f.n[2];
          const nm = slabMats[sIdx(ax, ay, az)] as Mat;
          if (isSolid(nm) && !(nm === Mat.Glass && m !== Mat.Glass)) continue;

          // Tangent axes of this face (the two axes that aren't the normal).
          const na = f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2;
          const ta = na === 0 ? 1 : 0;
          const tb = na === 2 ? 1 : 2;

          const cornerLight: number[] = [];
          const cornerAO: number[] = [];

          for (const c of f.corners) {
            if (emissive) {
              // Light sources render bright and unshadowed — but not searing;
              // the glow they CAST matters more than the face itself.
              cornerLight.push(LightGrid.normalize(mat.emission) * 0.72);
              cornerAO.push(1);
              continue;
            }
            // Direction this corner leans, along each tangent axis.
            const sa = c[ta] === 1 ? 1 : -1;
            const sb = c[tb] === 1 ? 1 : -1;
            const o1 = [0, 0, 0];
            const o2 = [0, 0, 0];
            o1[ta] = sa;
            o2[tb] = sb;

            const i1 = sIdx(ax + o1[0], ay + o1[1], az + o1[2]);
            const i2 = sIdx(ax + o2[0], ay + o2[1], az + o2[2]);
            const ic = sIdx(ax + o1[0] + o2[0], ay + o1[1] + o2[1], az + o1[2] + o2[2]);
            const s1 = SOLID_LUT[slabMats[i1]] === 1;
            const s2 = SOLID_LUT[slabMats[i2]] === 1;
            const sc = SOLID_LUT[slabMats[ic]] === 1;

            // Smooth light: average the 4 cells meeting at this corner.
            const l0 = slabLight[sIdx(ax, ay, az)];
            cornerLight.push(LightGrid.normalize((l0 + slabLight[i1] + slabLight[i2] + slabLight[ic]) / 4));

            // AO from corner solidity (fully closed corner = darkest).
            const open = s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (sc ? 1 : 0));
            cornerAO.push(AO_CURVE[open]);
          }

          for (let i = 0; i < 4; i++) {
            const c = f.corners[i];
            positions.push((wx + c[0]) * VS, (wy + c[1]) * VS, (wz + c[2]) * VS);
            normals.push(f.n[0], f.n[1], f.n[2]);
            colors.push(mat.color[0], mat.color[1], mat.color[2]);
            alight.push(cornerLight[i]);
            aao.push(cornerAO[i]);
            amat.push(m);
          }

          // Flip the quad diagonal so AO interpolates without banding.
          const w00 = cornerAO[0] + cornerLight[0];
          const w11 = cornerAO[2] + cornerLight[2];
          const w01 = cornerAO[1] + cornerLight[1];
          const w10 = cornerAO[3] + cornerLight[3];
          if (w00 + w11 >= w01 + w10) {
            indices.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
          } else {
            indices.push(vcount + 1, vcount + 2, vcount + 3, vcount + 1, vcount + 3, vcount);
          }
          vcount += 4;
        }
      }
    }
  }

  if (vcount === 0) return null;

  if (import.meta.env.DEV) {
    for (let i = 0; i < positions.length; i++) {
      if (Number.isNaN(positions[i])) {
        meshLog.once('nan-pos', 'warn', `NaN position in chunk ${chunk.cx},${chunk.cy},${chunk.cz} at ${i}`);
        break;
      }
    }
    for (let i = 0; i < alight.length; i++) {
      if (Number.isNaN(alight[i]) || Number.isNaN(aao[i])) {
        meshLog.once('nan-light', 'warn', `NaN light/ao in chunk ${chunk.cx},${chunk.cy},${chunk.cz} at ${i}`);
        break;
      }
    }
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
