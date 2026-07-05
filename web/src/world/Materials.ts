/**
 * The material table.
 *
 * v1 material elements per SPEC §1 (~7): stone, metal, wood, glass, sand,
 * dirt, ice, crystal — plus the biome-native glowcap that lights The Reek.
 * Materials carry the live properties the reaction engine will read later
 * (density, hardness, emission…). For the See-&-Move slice we only need
 * colour + emission; the rest is stubbed so the engine bolts on without churn.
 */

export const enum Mat {
  Air = 0,
  Stone = 1,
  Dirt = 2,
  Sand = 3,
  Wood = 4,
  Metal = 5,
  Glass = 6,
  Ice = 7,
  Crystal = 8,
  Glowcap = 9, // The Reek's bioluminescence — an emissive world light source
  /** Invisible, non-solid light emitter: lets SMOOTH (non-voxel) flora feed
   *  the flood-fill grid. The hybrid art rule's glue: life is mesh, its light
   *  is still voxel-true. */
  GlowAir = 10,
}

export interface Material {
  id: Mat;
  name: string;
  /** Base albedo, linear-ish RGB in 0..1. */
  color: [number, number, number];
  /** Emitted light level 0..15 (0 = not a light source). */
  emission: number;
  /** Emissive tint (only meaningful when emission > 0). */
  emissionColor: [number, number, number];
  solid: boolean;
  /** Stubs for the reaction engine — real constants live in wave_destruction_2d. */
  density: number;
  hardness: number;
}

const M = (m: Partial<Material> & { id: Mat; name: string; color: [number, number, number] }): Material => ({
  emission: 0,
  emissionColor: [1, 1, 1],
  solid: true,
  density: 1,
  hardness: 1,
  ...m,
});

export const MATERIALS: Record<Mat, Material> = {
  [Mat.Air]: M({ id: Mat.Air, name: 'Air', color: [0, 0, 0], solid: false, density: 0, hardness: 0 }),
  [Mat.Stone]: M({ id: Mat.Stone, name: 'Stone', color: [0.32, 0.33, 0.38], density: 2.6, hardness: 6 }),
  [Mat.Dirt]: M({ id: Mat.Dirt, name: 'Dirt', color: [0.29, 0.21, 0.15], density: 1.4, hardness: 2 }),
  [Mat.Sand]: M({ id: Mat.Sand, name: 'Sand', color: [0.62, 0.54, 0.36], density: 1.5, hardness: 1 }),
  [Mat.Wood]: M({ id: Mat.Wood, name: 'Wood', color: [0.36, 0.25, 0.14], density: 0.7, hardness: 3 }),
  [Mat.Metal]: M({ id: Mat.Metal, name: 'Metal', color: [0.5, 0.52, 0.57], density: 7.8, hardness: 9 }),
  [Mat.Glass]: M({ id: Mat.Glass, name: 'Glass', color: [0.6, 0.75, 0.82], density: 2.5, hardness: 4 }),
  [Mat.Ice]: M({ id: Mat.Ice, name: 'Ice', color: [0.55, 0.72, 0.85], density: 0.9, hardness: 2 }),
  [Mat.Crystal]: M({
    id: Mat.Crystal,
    name: 'Crystal',
    color: [0.5, 0.4, 0.7],
    emission: 6,
    emissionColor: [0.55, 0.4, 0.95],
    density: 2.6,
    hardness: 7,
  }),
  [Mat.Glowcap]: M({
    id: Mat.Glowcap,
    name: 'Glowcap',
    color: [0.35, 0.9, 0.7],
    emission: 10, // tight pools — the dark between them must stay a pressure
    emissionColor: [0.35, 1.0, 0.75],
    density: 0.3,
    hardness: 1,
  }),
  [Mat.GlowAir]: M({
    id: Mat.GlowAir,
    name: 'GlowAir',
    color: [0, 0, 0],
    emission: 5, // uncharged groves are DIM pools; charge brings the light
    emissionColor: [0.35, 1.0, 0.75],
    solid: false,
    density: 0,
    hardness: 0,
  }),
};

export const isSolid = (m: Mat): boolean => MATERIALS[m].solid;
