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
  /** Water pool marker. NON-SOLID so the voxel mesher skips it (no ugly cubes) —
   *  the visible surface is a dedicated wave-shader mesh (render/WaterZone). Its
   *  faint emission feeds the flood-fill so a pool casts a soft luminescence onto
   *  its basin walls. The testbed water corner. */
  Water = 11,
  /** Dead charcoal — dark, solid, non-emissive. The bulk of the ember/coal
   *  hearth; it reads black until the fire's dynamic light licks over it. */
  Coal = 12,
  /** Live coal — solid + hot emissive. Scattered through the Coal bed so the
   *  hearth glows from within (bloom turns these into embers). */
  Ember = 13,
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
  [Mat.Water]: M({
    id: Mat.Water,
    name: 'Water',
    // A dark reflective paint (never literal black — see the light-paths rule):
    // the surface mesh carries the real look; this is just the voxel marker.
    color: [0.03, 0.09, 0.16],
    emission: 0, // DARK until a light is near (John's call) — no self-glow at all
    solid: false, // mesher skips it; the wave surface is a separate mesh
    density: 1.0,
    hardness: 0,
  }),
  [Mat.Coal]: M({
    id: Mat.Coal,
    name: 'Coal',
    color: [0.045, 0.038, 0.033], // charcoal — dark but non-zero so light reads
    emission: 0,
    density: 1.3,
    hardness: 3,
  }),
  [Mat.Ember]: M({
    id: Mat.Ember,
    name: 'Ember',
    color: [0.14, 0.06, 0.02],
    emission: 9, // hot coal — glows the hearth from within (blooms to embers)
    emissionColor: [1.0, 0.42, 0.12],
    density: 1.3,
    hardness: 2,
  }),
};

export const isSolid = (m: Mat): boolean => MATERIALS[m].solid;
