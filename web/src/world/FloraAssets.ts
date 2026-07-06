/**
 * FloraAssets — GLTF flora prop library.
 *
 * Loads CC0 nature models (trees, mushrooms, rocks, bushes, ferns, grass) as
 * .glb files from /assets/flora/ and hands out normalized clones ready to seat
 * on the ground. All source models are public-domain (CC0) by Quaternius via
 * poly.pizza — see public/assets/flora/CREDITS.txt.
 *
 * The loader is deliberately dumb about the game: it only loads geometry and
 * normalizes scale/pivot. Lighting integration (the echolocation pulse-reveal
 * patch, the dark-game albedo pass, culling, colliders) lives in the caller,
 * so imported props flow through the SAME systems as the procedural flora.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { logger } from '../core/log';

const log = logger('flora-assets');

/** Every flora prop we ship, keyed by a stable name. Files live in public/. */
export const FLORA_MANIFEST = {
  tree_01: 'tree_01.glb', // stylized leafy tree
  tree_02: 'tree_02.glb', // dead/bare tree — reads well in The Reek
  mushroom_01: 'mushroom_01.glb',
  mushroom_02: 'mushroom_02.glb', // Laetiporus shelf fungus
  bigshroom_01: 'bigshroom_01.glb', // large toadstool
  bigshroom_02: 'bigshroom_02.glb',
  bigshroom_03: 'bigshroom_03.glb',
  meshy_glowshroom: 'meshy_glowshroom.glb', // Meshy-generated giant glowing toadstool
  meshy_glowshroom_02: 'meshy_glowshroom_02.glb', // cluster of small blue glowcaps
  meshy_glowshroom_03: 'meshy_glowshroom_03.glb', // tall violet amanita
  meshy_flatshroom: 'meshy_flatshroom.glb', // broad flat parasol cap
  rock_01: 'rock_01.glb', // round pebble
  rock_02: 'rock_02.glb', // square pebble
  bush_01: 'bush_01.glb',
  fern_01: 'fern_01.glb',
  grass_01: 'grass_01.glb', // tall grass tuft
} as const;

export type FloraName = keyof typeof FLORA_MANIFEST;

/** Public base path (Vite serves public/ at the web root). */
const ASSET_BASE = 'assets/flora/';

/** A placed clone plus the measurements a caller needs to seat + collide it. */
export interface FloraInstance {
  /** Fresh Object3D — feet at y=0, centered on x/z, scaled to `height`. */
  group: THREE.Group;
  /** World height after scaling (units). */
  height: number;
  /** Rough horizontal radius after scaling (units) — for collider/spacing. */
  radius: number;
}

/** Deepest luminance a lit imported flora surface may reflect. The source atlas
 *  albedos are bright/pastel; in a dark game a bright albedo blows out the
 *  instant any light touches it. Clamped so a lit surface is a soft reveal, not
 *  a glare (matches the native-flora dark-game pass). */
const ALBEDO_MAX_LUM = 0.5;

/**
 * Rework one imported material so it lights like native flora instead of the
 * "whitish glowy silhouette" the raw poly.pizza export produces:
 *   • metalness → 0. The export ships 0.4 metalness; with no env map a partly
 *     metallic surface reads as a flat dark blob that ignores the point light.
 *     Organic props are dielectric — force a matte diffuse that catches lights.
 *   • strip emissive + IBL — nothing self-glows or floats half-lit in the dark.
 *   • alpha-blended leaf cards → alpha CUTOUT. The translucent bright cards ARE
 *     the glowy halo; a depth-written cutout reads as solid, lit foliage.
 *   • deepen bright albedo so a lit surface is a reveal, not a blowout.
 * Returns a fresh clone so the shared source model is never mutated.
 */
function normalizeMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const m = src.clone();
  m.metalness = 0;
  m.roughness = Math.max(m.roughness ?? 1, 0.85);
  m.envMapIntensity = 0;
  if (m.emissive) m.emissive.setRGB(0, 0, 0);
  m.emissiveIntensity = 0;
  m.toneMapped = true;
  if (m.transparent && m.map) {
    m.transparent = false;
    m.alphaTest = 0.5;
    m.depthWrite = true;
    m.side = THREE.DoubleSide; // leaf cards visible edge-on from both faces
  }
  if (m.color) {
    const lum = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
    if (lum > ALBEDO_MAX_LUM) m.color.multiplyScalar(ALBEDO_MAX_LUM / lum);
  }
  return m;
}

/** Sensible default world heights per prop (units), so a mixed scatter reads
 *  in proportion regardless of each source model's native scale. */
const DEFAULT_HEIGHT: Record<FloraName, number> = {
  tree_01: 9,
  tree_02: 8,
  mushroom_01: 1.4,
  mushroom_02: 1.1,
  bigshroom_01: 3.6,
  bigshroom_02: 3.0,
  bigshroom_03: 2.6,
  meshy_glowshroom: 4.2, // giant — the generated hero toadstool
  meshy_glowshroom_02: 1.8, // low cluster
  meshy_glowshroom_03: 3.4, // tall amanita
  meshy_flatshroom: 3.2, // broad flat parasol
  rock_01: 1.1,
  rock_02: 1.3,
  bush_01: 1.6,
  fern_01: 1.2,
  grass_01: 0.9,
};

/** Shrink an oversized texture in place: swap its image for a downscaled canvas.
 *  Keeps the SAME texture object, so flipY / colorSpace / wrap / UV mapping are
 *  all preserved (no re-orientation or colour shift). The Meshy exports ship 2K+
 *  maps — overkill for this game — so cap the longest side at `size`. */
function downscaleTexture(tex: THREE.Texture, size: number): void {
  const img = tex.image as { width?: number; height?: number } | undefined;
  if (!img || typeof img.width !== 'number' || typeof img.height !== 'number') return;
  const w = img.width;
  const h = img.height;
  if (Math.max(w, h) <= size) return;
  const s = size / Math.max(w, h);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * s));
  cv.height = Math.max(1, Math.round(h * s));
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  try {
    ctx.drawImage(img as CanvasImageSource, 0, 0, cv.width, cv.height);
  } catch {
    return; // undrawable / tainted → leave original
  }
  tex.image = cv;
  tex.needsUpdate = true;
}

export class FloraLibrary {
  private roots = new Map<FloraName, THREE.Object3D>();
  private loaded = false;

  /** Shrink every texture on a loaded asset (done once per asset, before it's
   *  cloned across the world) so hundreds of instances don't hold 2K maps. */
  private optimize(root: THREE.Object3D): void {
    const seen = new Set<THREE.Texture>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        for (const t of [std.map, std.normalMap, std.roughnessMap, std.metalnessMap, std.aoMap, std.emissiveMap]) {
          if (t && !seen.has(t)) {
            seen.add(t);
            downscaleTexture(t, 512);
          }
        }
      }
    });
  }

  /** Load every manifest entry in parallel. Missing files warn (and are simply
   *  skipped) rather than throwing — one bad asset shouldn't blank the world. */
  async preload(): Promise<void> {
    if (this.loaded) return;
    const loader = new GLTFLoader();
    const names = Object.keys(FLORA_MANIFEST) as FloraName[];
    const t0 = performance.now();
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            loader.load(
              ASSET_BASE + FLORA_MANIFEST[name],
              (gltf) => {
                this.optimize(gltf.scene); // shrink textures once, before cloning
                this.roots.set(name, gltf.scene);
                resolve();
              },
              undefined,
              (err) => {
                log.warn(`failed to load ${name}:`, err);
                resolve(); // keep going without it
              },
            );
          }),
      ),
    );
    this.loaded = true;
    log.info(
      `loaded ${this.roots.size}/${names.length} flora props in ${Math.round(performance.now() - t0)}ms`,
    );
  }

  /** True once a given prop is available to instance. */
  has(name: FloraName): boolean {
    return this.roots.has(name);
  }

  /**
   * Clone a loaded prop, normalized so its feet sit at y=0, it's centered on
   * x/z, and it stands `height` units tall (defaults per prop). The returned
   * group can be positioned with `.position.set(x, groundY, z)` directly.
   *
   * Materials are cloned so the caller can patch them (pulse-reveal, dark-game
   * albedo) without touching the shared source model.
   */
  make(name: FloraName, height = DEFAULT_HEIGHT[name], sizeMul = 1): FloraInstance | null {
    height *= sizeMul; // per-instance size variation (a grove is never uniform)
    const root = this.roots.get(name);
    if (!root) {
      log.warn(`make(${name}) — not loaded`);
      return null;
    }

    const src = root.clone(true);
    // Rework materials so imported props light like native flora (see
    // normalizeMaterial). Cloned inside, so the shared source is never touched.
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => normalizeMaterial(m as THREE.MeshStandardMaterial))
        : normalizeMaterial(mesh.material as THREE.MeshStandardMaterial);
    });

    // Measure native bounds, then scale to the target height and drop the pivot
    // to the model's feet, centered horizontally.
    const box = new THREE.Box3().setFromObject(src);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const nativeH = Math.max(size.y, 1e-4);
    const scale = height / nativeH;

    const group = new THREE.Group();
    src.scale.setScalar(scale);
    // After scaling: shift so min.y → 0 and (x,z) center → 0.
    src.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    group.add(src);
    group.name = `flora:${name}`;

    const radius = (Math.max(size.x, size.z) * scale) / 2;
    return { group, height, radius };
  }
}
