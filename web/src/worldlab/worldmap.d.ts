/** Typings for the verbatim-extracted worldmap.js (see its header). */
export interface WorldMapParams {
  seed: number;
  worldRadius: number;
  cellSize: number;
  oceanFraction: number;
  landmassCount: number;
  wedgeJitter: number;
  shelfWidth: number;
  seaBand: number;
  rimWidth: number;
  trenchHalf: number;
  badlandsInlandDepth: number;
  spawnLandShare: number;
}
export interface MapAnchor {
  x: number;
  y: number;
  type: 'cave' | 'tower';
  zone: string;
  difficulty: number;
}
export interface WorldMapData {
  params: WorldMapParams;
  seed: number;
  W: number;
  H: number;
  C: number;
  Rc: number;
  Rp: number;
  cellSize: number;
  land: Uint8Array;
  landmassId: Int16Array;
  depthClass: Uint8Array;
  coastDist: Int16Array;
  inlandDist: Int16Array;
  biome: Uint8Array;
  difficulty: Uint8Array;
  spawn: { x: number; y: number; i: number };
  anchors: MapAnchor[];
  names: { continents: string[]; ocean: string; seas: string[] };
  stats: { areas: Record<string, number>; landCells: number; playCells: number; oceanFraction: number; anchorCount: number; caves: number; towers: number };
  checksum: string;
  genMs: number;
}
export function generateWorldMap(params?: Partial<WorldMapParams>): WorldMapData;
export function runAcceptance(map: WorldMapData, opts?: { determinismRuns?: number }): { name: string; pass: boolean; detail: string }[] & { allPass: boolean };
export const BIOME: { NONE: 0; REEK: 1; BADLANDS: 2; BITE: 3; SEAR: 4; GLARE: 5; FADE: 6; DROWN: 7; NOTHING: 8 };
export const BIOME_NAME: string[];
export const DEPTH: { LAND: 0; SHELF: 1; SEA: 2; ABYSSAL: 3 };
export const DEFAULTS: WorldMapParams;
