/**
 * MushroomFolk — one living mushroom person.
 *
 * Scene hierarchy (why three nested groups):
 *   group      entity transform — world position + facing yaw
 *   └ poseRoot root.* channels pivot here (origin at the FEET → death topples
 *              rotate around ground contact, root.y is the crumple drop)
 *     └ modelWrap  modelYaw (align the GLB's face with entity +Z) + scale
 *       └ gltf scene (SkeletonUtils-cloned, materials dark-game normalized)
 *
 * The folk are the Reek's own people: their bodies carry a faint fungal glow
 * (emissiveMap = albedo map), so they read as living lights in the dark —
 * same design language as the charged shrooms, without any fake ambient.
 *
 * Modes (John's toggle): STILL · WALK (in place) · MOVE (walk a slow circle
 * around the spawn anchor) · ATTACK (face the orb, loop the weapon attack).
 * Combat: hp, per-part hit multipliers off live bone positions, dash + force
 * wave damage with knockback, flinch overlay, direction-aware death topples,
 * corpse settle → sink → respawn.
 */

import * as THREE from 'three';
import { AnimPlayer } from './AnimPlayer';
import type { AnimClip } from './AnimClip';
import type { Pose } from './PoseRig';
import { PoseRig } from './PoseRig';
import { SkeletonMap } from './SkeletonMap';
import { FolkEffects, HealthBar, HitFlash } from './FolkEffects';
import { mountWeapon, WEAPONS, weaponFxPoint, type WeaponId } from './Weapons';

export type FolkMode = 'still' | 'walk' | 'move' | 'attack';
export const FOLK_MODES: FolkMode[] = ['still', 'walk', 'move', 'attack'];

export interface FolkDef {
  id: string;
  name: string;
  asset: string; // under web/public/
  /** Armature-only GLBs whose clips get merged in, renamed by the /walk|run/
   *  in their filename (Meshy ships walk/run as separate files). */
  animAssets: string[];
  /** World height (voxels) the model is scaled to. */
  height: number;
  hp: number;
  weapon: WeaponId;
  /** Body glow: emissive tint × intensity over the albedo map. */
  glow: number;
  glowIntensity: number;
  /** Rotate the GLB so its face points along entity +Z (flip if they moonwalk). */
  modelYaw: number;
  walkSpeed: number;
  /** 0..1 — how strongly the head tracks the orb. */
  headLook: number;
}

export const FOLK_DEFS: FolkDef[] = [
  {
    id: 'bluecap',
    name: 'Bluecap Bruiser',
    asset: 'assets/folk/bluecap.glb',
    animAssets: ['assets/folk/bluecap_walk.glb', 'assets/folk/bluecap_run.glb'],
    height: 1.9,
    hp: 90,
    weapon: 'glowcap_maul',
    glow: 0xbfe8ff,
    glowIntensity: 0.32,
    modelYaw: 0,
    walkSpeed: 1.4,
    headLook: 0.8,
  },
  {
    id: 'bluecap_lancer',
    name: 'Bluecap Lancer',
    asset: 'assets/folk/bluecap.glb',
    animAssets: ['assets/folk/bluecap_walk.glb', 'assets/folk/bluecap_run.glb'],
    height: 1.9,
    hp: 90,
    weapon: 'thornreed_lance',
    glow: 0xbfe8ff,
    glowIntensity: 0.32,
    modelYaw: 0,
    walkSpeed: 1.4,
    headLook: 0.8,
  },
  {
    id: 'sporeseer',
    name: 'Violet Sporeseer',
    asset: 'assets/folk/sporeseer.glb',
    animAssets: ['assets/folk/sporeseer_walk.glb', 'assets/folk/sporeseer_run.glb'],
    height: 2.7,
    hp: 60,
    weapon: 'sporespit_puffer',
    glow: 0xd8b8ff,
    glowIntensity: 0.38,
    modelYaw: 0,
    walkSpeed: 1.1,
    headLook: 0.9,
  },
];

/** Per-frame context the manager hands every folk. */
export interface FolkCtx {
  dt: number;
  orbPos: THREE.Vector3;
  camera: THREE.Camera;
  effects: FolkEffects;
  /** Walkable top Y for a column (feet land at this height). */
  groundY: (x: number, z: number) => number;
  /** The folk's attack connected with the orb (melee shove / bolt hit). */
  onOrbHit: (from: THREE.Vector3, power: number) => void;
  paused: boolean;
}

const CORPSE_HOLD = 6; // seconds a corpse lies before sinking
const SINK_TIME = 2.2;
const RESPAWN_AFTER = 3; // seconds after sink → back at the anchor
const ATTACK_REST = 0.55; // breather between attack loops

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

let nextFolkId = 1;

export class MushroomFolk {
  readonly def: FolkDef;
  readonly uid: number;
  readonly group = new THREE.Group();
  readonly poseRoot = new THREE.Group();
  readonly modelWrap = new THREE.Group();
  readonly skel: SkeletonMap;
  readonly rig: PoseRig;
  readonly player: AnimPlayer;
  readonly weapon: THREE.Group | null;
  private readonly bar = new HealthBar();
  private readonly flash: HitFlash;

  hp: number;
  state: 'alive' | 'dying' | 'dead' = 'alive';
  mode: FolkMode = 'still';
  /** Where this folk belongs — MOVE circles it, respawn returns to it. */
  readonly anchor = new THREE.Vector3();
  yaw = 0;

  private knock = new THREE.Vector3();
  private corpseT = 0;
  private attackCooldown = 0;
  private pathAngle = Math.random() * Math.PI * 2;
  private fadeMats: { m: THREE.Material; baseOpacity: number }[] = [];
  private headAdd: Pose = { 'head.yaw': 0, 'head.pitch': 0 };

  /** Animator-UI override: when set, this pose drives the rig directly and
   *  the mode machine / player stand down (scrubbing + slider posing). */
  editorPose: Pose | null = null;

  constructor(
    def: FolkDef,
    model: THREE.Object3D,
    animations: THREE.AnimationClip[],
    nativeHeight: number,
    clips: () => Record<string, AnimClip>,
  ) {
    this.def = def;
    this.uid = nextFolkId++;
    this.hp = def.hp;

    const s = def.height / Math.max(nativeHeight, 1e-4);
    this.modelWrap.scale.setScalar(s);
    this.modelWrap.rotation.y = def.modelYaw;
    this.modelWrap.add(model);
    this.poseRoot.add(this.modelWrap);
    this.group.add(this.poseRoot);
    this.group.name = `folk:${def.id}#${this.uid}`;

    this.skel = new SkeletonMap(model);
    this.rig = new PoseRig(this.skel, this.poseRoot);
    this.player = new AnimPlayer(this.rig, clips, model, animations);
    this.weapon = mountWeapon(this.skel, def.weapon);
    this.flash = new HitFlash(model);

    this.bar.group.position.y = def.height + 0.55;
    this.group.add(this.bar.group);

    // Collect materials once for the corpse fade.
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) this.fadeMats.push({ m, baseOpacity: m.opacity ?? 1 });
    });
    if (this.weapon) {
      this.weapon.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) this.fadeMats.push({ m: mesh.material as THREE.Material, baseOpacity: 1 });
      });
    }

    this.player.play('idle');
    this.player.onEnd((name) => {
      if (name.startsWith('death')) {
        this.state = 'dead';
        this.corpseT = 0;
      }
    });
  }

  /** Place at a world position (feet on the ground) and remember the anchor. */
  spawnAt(pos: THREE.Vector3, yaw: number): void {
    this.anchor.copy(pos);
    this.group.position.copy(pos);
    this.yaw = yaw;
    this.group.rotation.y = yaw;
  }

  /** Per-part damage multiplier for a world-space hit point: head shots ring
   *  the bell, limb grazes glance off. Falls back to body (1×). */
  hitMultiplier(point: THREE.Vector3): number {
    const head = this.skel.bind('head');
    if (head) {
      head.bone.getWorldPosition(_v);
      if (point.distanceToSquared(_v) < 0.35 * this.def.height * (0.35 * this.def.height)) return 2;
    }
    for (const slot of ['handL', 'handR', 'footL', 'footR'] as const) {
      const b = this.skel.bind(slot);
      if (b) {
        b.bone.getWorldPosition(_v);
        if (point.distanceToSquared(_v) < 0.09) return 0.75;
      }
    }
    return 1;
  }

  /** Crude body cylinder test — is a world point inside this folk? */
  contains(point: THREE.Vector3, pad = 0): boolean {
    if (this.state === 'dead') return false;
    const dx = point.x - this.group.position.x;
    const dz = point.z - this.group.position.z;
    const r = this.def.height * 0.28 + pad;
    if (dx * dx + dz * dz > r * r) return false;
    const dy = point.y - this.group.position.y;
    return dy > -0.2 && dy < this.def.height + pad;
  }

  /**
   * Take a hit. `from` = attacker position (knockback direction + which way
   * the body falls); `point` = impact point for part multipliers (optional).
   */
  damage(amount: number, from: THREE.Vector3 | null, effects: FolkEffects, point?: THREE.Vector3): void {
    if (this.state !== 'alive') return;
    const mult = point ? this.hitMultiplier(point) : 1;
    this.hp -= amount * mult;
    this.flash.flash();
    this.bar.show();

    // Spore puff out of the wound — folk bleed light.
    _v.copy(this.group.position);
    _v.y += this.def.height * 0.55;
    effects.burst(_v, this.def.glow, { count: mult > 1 ? 22 : 12, speed: 2.8, life: 0.7 });

    if (from) {
      _v2.copy(this.group.position).sub(from);
      _v2.y = 0;
      const len = _v2.length() || 1;
      const power = this.hp <= 0 ? 5.2 : 3.2;
      this.knock.add(_v2.multiplyScalar(power / len));
    }

    if (this.hp <= 0) {
      this.die(from);
    } else {
      this.player.playOverlay('flinch', Math.min(1.25, 0.6 + amount / 40));
    }
  }

  private die(from: THREE.Vector3 | null): void {
    this.state = 'dying';
    // Hit from the front → knocked onto the back; from behind → face-plant.
    let backward = true;
    if (from) {
      _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); // entity forward
      _v2.copy(this.group.position).sub(from).setY(0).normalize(); // hit → folk
      backward = _v.dot(_v2) < 0; // knocked against facing = falls back
    }
    this.player.play(backward ? 'death_back' : 'death_fwd', { fade: 0.07 });
  }

  /** Full reset back at the anchor (Animator UI's Revive + auto-respawn). */
  respawn(): void {
    this.hp = this.def.hp;
    this.state = 'alive';
    this.corpseT = 0;
    this.knock.set(0, 0, 0);
    this.group.position.copy(this.anchor);
    this.group.visible = true;
    for (const f of this.fadeMats) {
      f.m.opacity = f.baseOpacity;
      f.m.transparent = f.baseOpacity < 1;
    }
    this.player.play('idle', { restart: true });
  }

  /** True once the corpse has fully sunk — manager waits, then respawns. */
  readyToRespawn(): boolean {
    return this.state === 'dead' && this.corpseT > CORPSE_HOLD + SINK_TIME + RESPAWN_AFTER;
  }

  update(ctx: FolkCtx): void {
    const { dt } = ctx;

    // --- corpse: hold → sink into the mycelium → (manager respawns) ---
    if (this.state === 'dead') {
      this.corpseT += dt;
      if (this.corpseT > CORPSE_HOLD) {
        const u = Math.min(1, (this.corpseT - CORPSE_HOLD) / SINK_TIME);
        this.group.position.y = this.anchorGroundY(ctx) - u * 1.1;
        for (const f of this.fadeMats) {
          f.m.transparent = true;
          f.m.opacity = f.baseOpacity * (1 - u);
        }
        if (u >= 1) this.group.visible = false;
      }
      this.player.update(dt);
      return;
    }

    // --- dying: the death clip owns the body; just settle knockback ---
    if (this.state === 'dying') {
      this.integrateKnock(ctx);
      this.player.update(dt);
      this.bar.update(dt, Math.max(0, this.hp) / this.def.hp, ctx.camera);
      this.flash.update(dt);
      return;
    }

    // --- Animator UI has the body: pose it and stand everything else down ---
    if (this.editorPose) {
      const gy0 = this.anchorGroundY(ctx);
      this.group.position.y += (gy0 - this.group.position.y) * Math.min(1, dt * 10);
      this.rig.apply(this.editorPose);
      this.bar.update(dt, Math.max(0, this.hp) / this.def.hp, ctx.camera);
      this.flash.update(dt);
      return;
    }

    // --- alive: mode machine ---
    if (!ctx.paused) {
      switch (this.mode) {
        case 'still':
          this.player.play('idle');
          break;
        case 'walk':
          this.playWalk();
          break;
        case 'move': {
          this.playWalk();
          // A slow patrol circle around the anchor; yaw follows the tangent.
          const R = 2.6;
          const w = (this.def.walkSpeed / R) * dt;
          this.pathAngle += w;
          const tx = this.anchor.x + Math.cos(this.pathAngle) * R;
          const tz = this.anchor.z + Math.sin(this.pathAngle) * R;
          this.yaw = Math.atan2(tx - this.group.position.x, tz - this.group.position.z);
          this.group.position.x = tx;
          this.group.position.z = tz;
          break;
        }
        case 'attack': {
          // Square up to the orb, swing/fire on a loop with a breather.
          _v.copy(ctx.orbPos).sub(this.group.position);
          this.yaw = Math.atan2(_v.x, _v.z);
          this.attackCooldown -= dt;
          const clip = WEAPONS[this.def.weapon].clip;
          if (this.attackCooldown <= 0) {
            this.player.play(clip, { restart: true, fade: 0.12 });
            const c = this.player.duration();
            this.attackCooldown = c + ATTACK_REST;
          }
          break;
        }
      }
    }

    this.integrateKnock(ctx);

    // Ground snap: feet follow the column top (walkable surface).
    const gy = this.anchorGroundY(ctx);
    this.group.position.y += (gy - this.group.position.y) * Math.min(1, dt * 10);

    // Ease facing (no snap turns).
    const target = this.yaw;
    let d = target - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * Math.min(1, dt * 8);

    // Head-look: the folk WATCH the orb — life in the dark. Angles in entity
    // space; head.pitch is + forward/down, so looking UP at the orb is −.
    _v.copy(ctx.orbPos).sub(this.group.position);
    const horiz = Math.hypot(_v.x, _v.z);
    let dYaw = Math.atan2(_v.x, _v.z) - this.group.rotation.y;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const w = this.def.headLook * (horiz < 14 ? 1 : Math.max(0, 1 - (horiz - 14) / 8));
    this.headAdd['head.yaw'] = THREE.MathUtils.clamp(dYaw, -1.1, 1.1) * w;
    this.headAdd['head.pitch'] =
      THREE.MathUtils.clamp(-Math.atan2(_v.y - this.def.height * 0.8, horiz), -0.65, 0.65) * w;

    this.player.update(dt, this.headAdd);

    // Melee swing trail: motes stream off the weapon tip around the strike.
    this.updateSwingTrail(ctx);

    this.bar.update(dt, Math.max(0, this.hp) / this.def.hp, ctx.camera);
    this.flash.update(dt);
  }

  /** WALK prefers Meshy's baked gait when the rig shipped one. */
  private playWalk(): void {
    const baked = this.player.findGltf(/walk/i);
    if (!baked || !this.player.play(baked)) this.player.play('walk');
  }

  private integrateKnock(ctx: FolkCtx): void {
    if (this.knock.lengthSq() < 0.0004) return;
    this.group.position.x += this.knock.x * ctx.dt;
    this.group.position.z += this.knock.z * ctx.dt;
    this.knock.multiplyScalar(Math.max(0, 1 - ctx.dt * 4.5)); // ground drag
  }

  private anchorGroundY(ctx: FolkCtx): number {
    return ctx.groundY(this.group.position.x, this.group.position.z);
  }

  /** Strike/muzzle FX + orb contact. Wired by the manager (it owns effects). */
  bindCombat(ctx: () => FolkCtx): void {
    this.player.onEvent((type) => {
      const c = ctx();
      const def = WEAPONS[this.def.weapon];
      if (type === 'strike' && this.weapon) {
        weaponFxPoint(this.weapon, _v);
        c.effects.burst(_v, def.color, { count: 10, speed: 2.2, life: 0.5, grav: 2 });
        // Melee reach check against the orb.
        _v2.copy(c.orbPos).sub(this.group.position);
        if (_v2.length() < def.reach + 0.6) c.onOrbHit(this.group.position, 4.5);
      } else if (type === 'muzzle' && this.weapon) {
        weaponFxPoint(this.weapon, _v);
        // Lead the shot at the orb's chest height.
        _v2.copy(c.orbPos);
        c.effects.fireProjectile(_v, _v2, { color: def.color, speed: 13 });
      }
    });
  }

  private updateSwingTrail(ctx: FolkCtx): void {
    const def = WEAPONS[this.def.weapon];
    if (def.kind !== 'melee' || !this.weapon) return;
    const clip = this.player.currentName();
    if (clip !== def.clip) return;
    // Trail window: the 0.18s leading into the strike frame.
    const strikeT = def.clip === 'attack_maul' ? 0.42 : 0.4;
    const t = this.player.time();
    const inWindow = t > strikeT - 0.18 && t < strikeT + 0.05;
    if (inWindow) {
      weaponFxPoint(this.weapon, _v);
      ctx.effects.mote(_v, def.color, 0.35, 0.05);
    }
  }
}
