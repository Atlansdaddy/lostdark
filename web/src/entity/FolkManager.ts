/**
 * FolkManager — loads the Meshy folk rigs, spawns the mushroom people, and
 * runs their per-frame world: animation, combat, projectiles, respawns.
 *
 * Damage sources (the player's verbs, wired from main.ts):
 *   • DASH — the orb's blink-burst hurts any folk it passes through. One hit
 *     per folk per dash (the set clears when a new dash fires).
 *   • FORCE WAVE — radial damage + shove, falling off with distance.
 * Folk fight back only in ATTACK mode, and the orb never dies — their strikes
 * shove it and flash the aura (main.ts decides what a hit "costs").
 *
 * The clip registry is the ONE source of animation truth: baked-in clips from
 * folkClips.ts with localStorage overrides layered on top — so animations
 * John edits in the Animator UI survive reloads and drive the live game the
 * moment they're saved.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { logger } from '../core/log';
import type { AnimClip } from './AnimClip';
import { builtinClips } from './folkClips';
import { FolkEffects } from './FolkEffects';
import { FOLK_DEFS, MushroomFolk, type FolkCtx, type FolkDef, type FolkMode } from './MushroomFolk';

const log = logger('folk');

const CLIPS_LS_KEY = 'waiver.folk.clips.v1';

/** Deepest luminance a lit folk surface may reflect (same rule as flora). */
const ALBEDO_MAX_LUM = 0.5;

interface FolkSource {
  def: FolkDef;
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  nativeHeight: number;
}

export interface FolkDeps {
  scene: THREE.Scene;
  solid: (x: number, y: number, z: number) => boolean;
  moteTexture: THREE.Texture;
  getOrbPos: () => THREE.Vector3;
  /** A folk attack connected — shove the orb, flash the aura, etc. */
  onOrbHit: (from: THREE.Vector3, power: number) => void;
}

export class FolkManager {
  readonly folk: MushroomFolk[] = [];
  readonly effects: FolkEffects;
  /** Global mode — the STILL/WALK/MOVE/ATTACK toggle. */
  mode: FolkMode = 'still';
  /** Fallen folk regrow at their anchor (great for iterating on deaths). */
  respawnEnabled = true;

  private deps: FolkDeps;
  private sources = new Map<string, FolkSource>();
  private clipOverrides: Record<string, AnimClip> = {};
  private clipRegistry: Record<string, AnimClip>;
  private hitThisDash = new Set<number>();
  private ctx: FolkCtx;

  constructor(deps: FolkDeps) {
    this.deps = deps;
    this.effects = new FolkEffects(deps.scene, deps.moteTexture);

    // Baked clips + saved Animator-UI edits on top.
    this.clipRegistry = builtinClips();
    try {
      const raw = localStorage.getItem(CLIPS_LS_KEY);
      if (raw) {
        this.clipOverrides = JSON.parse(raw) as Record<string, AnimClip>;
        Object.assign(this.clipRegistry, this.clipOverrides);
        log.info(`loaded ${Object.keys(this.clipOverrides).length} clip override(s) from localStorage`);
      }
    } catch (err) {
      log.warn('bad saved clips, ignoring', err);
    }

    this.ctx = {
      dt: 0,
      orbPos: new THREE.Vector3(),
      camera: null as unknown as THREE.Camera, // set every frame in update()
      effects: this.effects,
      groundY: (x, z) => this.groundY(x, z),
      onOrbHit: deps.onOrbHit,
      paused: false,
    };
  }

  // --- clip registry (the Animator UI talks to these) -----------------------

  clips(): Record<string, AnimClip> {
    return this.clipRegistry;
  }

  /** Add/replace a clip and persist it as an override. */
  saveClip(clip: AnimClip): void {
    this.clipRegistry[clip.name] = clip;
    this.clipOverrides[clip.name] = clip;
    try {
      localStorage.setItem(CLIPS_LS_KEY, JSON.stringify(this.clipOverrides));
    } catch (err) {
      log.warn('failed to persist clips', err);
    }
  }

  /** Drop an override (built-in of the same name comes back). */
  resetClip(name: string): void {
    delete this.clipOverrides[name];
    this.clipRegistry = { ...builtinClips(), ...this.clipOverrides };
    try {
      localStorage.setItem(CLIPS_LS_KEY, JSON.stringify(this.clipOverrides));
    } catch {
      /* full disk etc — nothing useful to do */
    }
  }

  hasOverride(name: string): boolean {
    return name in this.clipOverrides;
  }

  // --- loading + spawning ----------------------------------------------------

  /** Load every folk GLB. Missing files log + skip (world keeps booting). */
  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const t0 = performance.now();
    const byAsset = new Map<string, FolkDef[]>();
    for (const def of FOLK_DEFS) {
      const list = byAsset.get(def.asset) ?? [];
      list.push(def);
      byAsset.set(def.asset, list);
    }
    const loadOne = (url: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] } | null> =>
      new Promise((resolve) => {
        loader.load(
          url,
          (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
          undefined,
          (err) => {
            log.warn(`failed to load ${url}`, err);
            resolve(null);
          },
        );
      });

    await Promise.all(
      [...byAsset.entries()].map(async ([asset, defs]) => {
        const main = await loadOne(asset);
        if (!main) return;
        const box = new THREE.Box3().setFromObject(main.scene);
        const size = new THREE.Vector3();
        box.getSize(size);

        // Meshy ships walk/run as separate armature GLBs over the SAME
        // skeleton — pull their clips in and give them honest names. The main
        // GLB's own stub clip (a ~0.3s bind pose) is dropped.
        const animations = main.animations.filter((a) => a.duration > 0.4);
        for (const animUrl of defs[0].animAssets) {
          const animGltf = await loadOne(animUrl);
          if (!animGltf) continue;
          const nice = /run/i.test(animUrl) ? 'Running' : /walk/i.test(animUrl) ? 'Walking' : animUrl;
          for (const clip of animGltf.animations) {
            clip.name = animGltf.animations.length > 1 ? `${nice}:${clip.name}` : nice;
            animations.push(clip);
          }
        }

        for (const def of defs) {
          this.normalizeMaterials(main.scene, def);
          this.sources.set(def.id, {
            def,
            scene: main.scene,
            animations,
            nativeHeight: Math.max(size.y, 1e-4),
          });
        }
        log.info(
          `loaded ${asset} (${size.y.toFixed(2)}u tall, clips: ${animations.map((a) => a.name).join(', ') || 'none'})`,
        );
      }),
    );
    log.info(`folk sources ready in ${Math.round(performance.now() - t0)}ms`);
  }

  /**
   * Dark-game surface pass (same rules as flora) + the folk's own life-light:
   * albedo clamped so the orb's beam reveals rather than blows out, and the
   * albedo map REUSED as an emissive map so the body carries a faint fungal
   * glow — bright texels (the pale flesh, the cap spots) glow hardest, which
   * is exactly the screenshot look.
   */
  private normalizeMaterials(root: THREE.Object3D, def: FolkDef): void {
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // skinned bounds lie once animated
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const raw of mats) {
        const m = raw as THREE.MeshStandardMaterial;
        if (seen.has(m)) continue;
        seen.add(m);
        m.metalness = 0;
        m.roughness = Math.max(m.roughness ?? 1, 0.8);
        m.envMapIntensity = 0;
        if (m.color) {
          const lum = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
          if (lum > ALBEDO_MAX_LUM) m.color.multiplyScalar(ALBEDO_MAX_LUM / lum);
        }
        if (m.map) {
          m.emissiveMap = m.map;
          m.emissive = new THREE.Color(def.glow);
          m.emissiveIntensity = def.glowIntensity;
        }
      }
    });
  }

  /** One folk of each def in a shallow arc at `center`, all facing `face`. */
  spawnAll(center: THREE.Vector3, face: THREE.Vector3): void {
    const loaded = FOLK_DEFS.filter((d) => this.sources.has(d.id));
    if (!loaded.length) {
      log.warn('no folk sources loaded — nothing to spawn');
      return;
    }
    const spread = Math.PI * 0.55;
    loaded.forEach((def, i) => {
      const a = loaded.length === 1 ? 0 : -spread / 2 + (i / (loaded.length - 1)) * spread;
      const dist = 3.4;
      const pos = new THREE.Vector3(
        center.x + Math.sin(a) * dist,
        center.y,
        center.z + Math.cos(a) * dist,
      );
      pos.y = this.groundY(pos.x, pos.z);
      const yaw = Math.atan2(face.x - pos.x, face.z - pos.z);
      this.spawn(def.id, pos, yaw);
    });
    log.info(`spawned ${this.folk.length} mushroom folk by spawn`);
  }

  spawn(defId: string, pos: THREE.Vector3, yaw = 0): MushroomFolk | null {
    const src = this.sources.get(defId);
    if (!src) return null;
    // SkeletonUtils.clone — a plain .clone() breaks SkinnedMesh bone bindings.
    const model = SkeletonUtils.clone(src.scene);
    const folk = new MushroomFolk(src.def, model, src.animations, src.nativeHeight, () => this.clipRegistry);
    folk.spawnAt(pos, yaw);
    folk.mode = this.mode;
    folk.bindCombat(() => this.ctx);
    this.deps.scene.add(folk.group);
    this.folk.push(folk);
    return folk;
  }

  /** Column-top probe (same convention as the grass re-seat in main.ts):
   *  walkable surface = top solid voxel + 1. */
  private groundY(x: number, z: number): number {
    const vx = Math.floor(x);
    const vz = Math.floor(z);
    for (let y = 22; y > -12; y--) {
      if (this.deps.solid(vx, y, vz)) return y + 1;
    }
    return 4; // stage floor fallback — never strand anyone at -12
  }

  // --- the toggle ------------------------------------------------------------

  setMode(mode: FolkMode): void {
    this.mode = mode;
    for (const f of this.folk) f.mode = mode;
    log.info(`folk mode → ${mode.toUpperCase()}`);
  }

  cycleMode(): FolkMode {
    const order: FolkMode[] = ['still', 'walk', 'move', 'attack'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
    return this.mode;
  }

  // --- damage hooks (main.ts wires the player's verbs here) ------------------

  /** Call when orb.dashStarted — a fresh dash can hit everyone once. */
  beginDash(): void {
    this.hitThisDash.clear();
  }

  /** Call every frame while orb.dashing. */
  dashSweep(orbPos: THREE.Vector3): void {
    for (const f of this.folk) {
      if (f.state !== 'alive' || this.hitThisDash.has(f.uid)) continue;
      if (f.contains(orbPos, 0.55)) {
        this.hitThisDash.add(f.uid);
        f.damage(34, orbPos, this.effects, orbPos);
      }
    }
  }

  /** The sandbox force wave: radial shove + falloff damage. */
  applyForceWave(origin: THREE.Vector3): void {
    for (const f of this.folk) {
      if (f.state !== 'alive') continue;
      const d = f.group.position.distanceTo(origin);
      if (d > 14) continue;
      const dmg = THREE.MathUtils.lerp(42, 10, Math.min(1, d / 14));
      f.damage(dmg, origin, this.effects);
    }
  }

  // --- frame -----------------------------------------------------------------

  update(
    dt: number,
    camera: THREE.Camera,
    opts: { paused: boolean; dashing: boolean; dashStarted: boolean },
  ): void {
    const orbPos = this.deps.getOrbPos();
    this.ctx.dt = dt;
    this.ctx.orbPos.copy(orbPos);
    this.ctx.camera = camera;
    this.ctx.paused = opts.paused;

    if (opts.dashStarted) this.beginDash();
    if (opts.dashing && !opts.paused) this.dashSweep(orbPos);

    for (const f of this.folk) {
      f.update(this.ctx);
      if (this.respawnEnabled && f.readyToRespawn()) f.respawn();
    }

    this.effects.update(dt, this.deps.solid, orbPos, (p) => {
      // A spore-bolt reached the orb — shove it along the bolt's flight.
      this.deps.onOrbHit(p.pos, 2.5);
    });
  }
}
