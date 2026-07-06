/**
 * CombatSystem — damage, hitboxes, knockback, weapons, projectiles.
 */

import * as THREE from 'three';
import type { CharacterEntity } from './CharacterEntity';

export enum BiomeTheme {
  Reek = 'reek', // dark/fungal
  Forge = 'forge', // fire/ember
  Water = 'water', // aquatic
  Sandbox = 'sandbox', // construct
}

/** Weapon definition: stats + visual/audio hints. */
export interface WeaponDef {
  id: string;
  name: string;
  type: 'melee' | 'ranged';
  biome: BiomeTheme;
  damage: number;
  range: number; // melee: strike radius; ranged: projectile range
  attackSpeed: number; // attacks per second
  knockback: number; // velocity imparted on hit
  effect?: {
    color: number;
    particleCount?: number;
    sound?: string;
  };
}

/** Projectile in flight. */
export interface Projectile {
  id: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number; // seconds remaining
  maxLife: number;
  owner: CharacterEntity;
  damage: number;
  mesh?: THREE.Mesh;
  color: number;
}

/** Hitbox for collision/damage. */
export interface Hitbox {
  bone: string; // 'head', 'body', 'leg_L', 'arm_R', etc.
  offset: THREE.Vector3; // local offset from bone
  radius: number; // sphere radius
  damageMultiplier: number; // headshots = 2x, limbs = 0.75x
}

/** Static weapon defs per biome. */
const WEAPONS_BY_BIOME: Record<BiomeTheme, WeaponDef[]> = {
  [BiomeTheme.Reek]: [
    {
      id: 'spore_staff',
      name: 'Spore Staff',
      type: 'ranged',
      biome: BiomeTheme.Reek,
      damage: 8,
      range: 30,
      attackSpeed: 1.5,
      knockback: 3,
      effect: { color: 0x9d4edd, particleCount: 6 },
    },
    {
      id: 'fungal_blade',
      name: 'Fungal Blade',
      type: 'melee',
      biome: BiomeTheme.Reek,
      damage: 15,
      range: 2,
      attackSpeed: 1,
      knockback: 5,
      effect: { color: 0x7b2d7b },
    },
  ],
  [BiomeTheme.Forge]: [
    {
      id: 'ember_lance',
      name: 'Ember Lance',
      type: 'melee',
      biome: BiomeTheme.Forge,
      damage: 18,
      range: 2.5,
      attackSpeed: 0.8,
      knockback: 6,
      effect: { color: 0xff6b35, particleCount: 8 },
    },
    {
      id: 'coal_shot',
      name: 'Coal Shot',
      type: 'ranged',
      biome: BiomeTheme.Forge,
      damage: 12,
      range: 25,
      attackSpeed: 2,
      knockback: 4,
      effect: { color: 0x333333 },
    },
  ],
  [BiomeTheme.Water]: [
    {
      id: 'wave_hammer',
      name: 'Wave Hammer',
      type: 'melee',
      biome: BiomeTheme.Water,
      damage: 12,
      range: 2,
      attackSpeed: 0.6,
      knockback: 7,
      effect: { color: 0x00d9ff },
    },
    {
      id: 'torrent_burst',
      name: 'Torrent Burst',
      type: 'ranged',
      biome: BiomeTheme.Water,
      damage: 10,
      range: 20,
      attackSpeed: 2.5,
      knockback: 2,
      effect: { color: 0x0099ff, particleCount: 10 },
    },
  ],
  [BiomeTheme.Sandbox]: [
    {
      id: 'construct_fist',
      name: 'Construct Fist',
      type: 'melee',
      biome: BiomeTheme.Sandbox,
      damage: 16,
      range: 2,
      attackSpeed: 1.2,
      knockback: 8,
      effect: { color: 0xd4a373 },
    },
    {
      id: 'stone_shot',
      name: 'Stone Shot',
      type: 'ranged',
      biome: BiomeTheme.Sandbox,
      damage: 9,
      range: 35,
      attackSpeed: 1.8,
      knockback: 3,
      effect: { color: 0xaaaa88 },
    },
  ],
};

/** Hitbox definitions per bone. */
const HITBOXES: Hitbox[] = [
  { bone: 'head', offset: new THREE.Vector3(0, 0, 0), radius: 0.2, damageMultiplier: 2 },
  { bone: 'body', offset: new THREE.Vector3(0, 0, 0), radius: 0.35, damageMultiplier: 1 },
  { bone: 'leg_L', offset: new THREE.Vector3(0, 0, 0), radius: 0.15, damageMultiplier: 0.75 },
  { bone: 'leg_R', offset: new THREE.Vector3(0, 0, 0), radius: 0.15, damageMultiplier: 0.75 },
  { bone: 'arm_L', offset: new THREE.Vector3(0, 0, 0), radius: 0.12, damageMultiplier: 0.75 },
  { bone: 'arm_R', offset: new THREE.Vector3(0, 0, 0), radius: 0.12, damageMultiplier: 0.75 },
];

export class CombatSystem {
  private projectiles: Projectile[] = [];
  private nextProjectileId = 0;
  private hitboxes = HITBOXES;

  /** Get weapon definition by biome + weapon id. */
  static getWeapon(biome: BiomeTheme, weaponId: string): WeaponDef | null {
    const biomeWeapons = WEAPONS_BY_BIOME[biome];
    return biomeWeapons.find((w) => w.id === weaponId) || null;
  }

  /** Get all weapons for a biome. */
  static getWeaponsByBiome(biome: BiomeTheme): WeaponDef[] {
    return WEAPONS_BY_BIOME[biome] || [];
  }

  /** Fire a ranged weapon: spawn projectile. */
  fireProjectile(
    owner: CharacterEntity,
    weapon: WeaponDef,
    targetPos: THREE.Vector3,
  ): Projectile {
    const direction = new THREE.Vector3().subVectors(targetPos, owner.pos).normalize();
    const projectile: Projectile = {
      id: `proj_${this.nextProjectileId++}`,
      pos: new THREE.Vector3().copy(owner.pos).addScaledVector(direction, 1),
      vel: new THREE.Vector3().copy(direction).multiplyScalar(20),
      life: weapon.range / 20,
      maxLife: weapon.range / 20,
      owner,
      damage: weapon.damage,
      color: weapon.effect?.color ?? 0xffffff,
    };

    // Create a simple mesh for the projectile.
    const geo = new THREE.SphereGeometry(0.15, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: projectile.color });
    projectile.mesh = new THREE.Mesh(geo, mat);
    projectile.mesh.position.copy(projectile.pos);

    this.projectiles.push(projectile);
    return projectile;
  }

  /** Hitscan melee attack: check characters in range + apply damage. */
  meleeAttack(
    attacker: CharacterEntity,
    weapon: WeaponDef,
    targets: CharacterEntity[],
  ): CharacterEntity[] {
    const hit: CharacterEntity[] = [];
    const strikePos = new THREE.Vector3().copy(attacker.pos).addScaledVector(attacker.facing, weapon.range);

    for (const target of targets) {
      if (target === attacker || !target.isAlive()) continue;

      const dist = target.pos.distanceTo(strikePos);
      if (dist <= weapon.range) {
        const damage = weapon.damage * (Math.random() * 0.2 + 0.9); // ±10% variance
        const knockdir = new THREE.Vector3().subVectors(target.pos, attacker.pos).normalize();
        target.vel.addScaledVector(knockdir, weapon.knockback);
        target.takeDamage(damage, attacker.pos);
        hit.push(target);
      }
    }

    return hit;
  }

  /** Update projectiles: move, age, check collisions. */
  updateProjectiles(dt: number, targets: CharacterEntity[]): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      proj.life -= dt;

      if (proj.life <= 0) {
        this.projectiles.splice(i, 1);
        if (proj.mesh) proj.mesh.removeFromParent();
        continue;
      }

      proj.pos.addScaledVector(proj.vel, dt);
      proj.vel.y -= 9.81 * dt; // gravity
      if (proj.mesh) proj.mesh.position.copy(proj.pos);

      // Check collisions.
      for (const target of targets) {
        if (target === proj.owner || !target.isAlive()) continue;

        const dist = target.pos.distanceTo(proj.pos);
        if (dist <= 0.5) {
          // Hit!
          const knockdir = new THREE.Vector3().subVectors(target.pos, proj.owner.pos).normalize();
          target.vel.addScaledVector(knockdir, proj.owner.equippedWeapon?.damage ?? 10);

          const weapon = proj.owner.equippedWeapon;
          const damageMultiplier = Math.random() < 0.2 ? 2 : 1; // 20% headshot chance
          target.takeDamage(proj.damage * damageMultiplier, proj.owner.pos);

          this.projectiles.splice(i, 1);
          if (proj.mesh) proj.mesh.removeFromParent();
          break;
        }
      }
    }
  }

  /** Get hitboxes for a character (in world space). */
  getHitboxes(character: CharacterEntity): Hitbox[] {
    return this.hitboxes;
  }

  getProjectiles(): readonly Projectile[] {
    return this.projectiles;
  }

  clear(): void {
    for (const proj of this.projectiles) {
      if (proj.mesh) proj.mesh.removeFromParent();
    }
    this.projectiles = [];
  }
}
