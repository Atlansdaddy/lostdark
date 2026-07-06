/**
 * CharacterManager — spawn, update, render mushroom people.
 *
 * Owns the character pool, animation updates, and integration with the world.
 */

import * as THREE from 'three';
import { CharacterEntity, CharacterState } from './CharacterEntity';
import { CharacterAnimationManager } from './AnimationEngine';
import { RiggingEngine, type RiggedCharacter } from './Rigging';
import { CombatSystem, BiomeTheme, type WeaponDef } from './CombatSystem';

export interface CharacterSpawnConfig {
  pos: THREE.Vector3;
  maxHealth?: number;
  biome?: BiomeTheme;
  weapon?: string;
  meshColor?: number;
}

export class CharacterManager {
  private characters: CharacterEntity[] = [];
  private riggedChars = new Map<CharacterEntity, RiggedCharacter>();
  private animManager = new CharacterAnimationManager();
  private combatSystem = new CombatSystem();
  private scene: THREE.Scene;

  private glftLoader: THREE.GLTFLoader;
  private riggingEngine = RiggingEngine;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.glftLoader = new THREE.GLTFLoader();
  }

  /** Spawn a mushroom character into the world. */
  spawn(config: CharacterSpawnConfig): CharacterEntity {
    const char = new CharacterEntity(config.maxHealth ?? 100);
    char.pos.copy(config.pos);

    // Create a rigged character (procedural for now).
    const rig = this.riggingEngine.buildProceduralRig();
    this.riggedChars.set(char, rig);
    this.scene.add(char.group);
    char.group.add(rig.group);

    // Equip a weapon.
    if (config.weapon) {
      const biome = config.biome ?? BiomeTheme.Reek;
      const weaponDef = CombatSystem.getWeapon(biome, config.weapon);
      if (weaponDef) {
        char.equippedWeapon = {
          id: weaponDef.id,
          name: weaponDef.name,
          type: weaponDef.type,
          damage: weaponDef.damage,
          equipped: true,
        };
      }
    }

    this.characters.push(char);
    return char;
  }

  /** Spawn multiple mushroom people in a cluster. */
  spawnCluster(center: THREE.Vector3, count: number, config: CharacterSpawnConfig): CharacterEntity[] {
    const spawned: CharacterEntity[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = 3 + Math.random() * 2;
      const pos = new THREE.Vector3(
        center.x + Math.cos(angle) * radius,
        center.y,
        center.z + Math.sin(angle) * radius,
      );
      spawned.push(this.spawn({ ...config, pos }));
    }
    return spawned;
  }

  /** Update all characters (animation, state, physics). */
  update(dt: number): void {
    for (const char of this.characters) {
      if (!char.isAlive()) continue;

      // Update character (physics, state time).
      char.update(dt);

      // Update animation.
      this.animManager.update(char, dt);

      // Apply the pose to the rig.
      const rig = this.riggedChars.get(char);
      if (rig) {
        this.riggingEngine.applyPose(rig, char.pose);
      }

      // Handle state transitions.
      this.updateCharacterState(char);
    }

    // Update projectiles.
    this.combatSystem.updateProjectiles(dt, this.characters);
  }

  /** Update character state machine logic. */
  private updateCharacterState(char: CharacterEntity): void {
    const speed = char.vel.length();

    // Flinch → return to idle after duration.
    if (char.state === CharacterState.Flinch && char.stateTime > 0.3) {
      char.setState(CharacterState.Idle);
    }

    // Attack/Dash → idle when finished.
    if (
      (char.state === CharacterState.Attack || char.state === CharacterState.Dash) &&
      char.stateTime > 0.8
    ) {
      char.setState(CharacterState.Idle);
    }

    // Auto-transition based on speed (if not in a specific action).
    if (char.state === CharacterState.Idle && speed > 0.5) {
      char.setState(speed > 3 ? CharacterState.Run : CharacterState.Walk);
    } else if (char.state === CharacterState.Walk && speed < 0.1) {
      char.setState(CharacterState.Idle);
    } else if (char.state === CharacterState.Walk && speed > 3) {
      char.setState(CharacterState.Run);
    } else if (char.state === CharacterState.Run && speed < 1.5) {
      char.setState(CharacterState.Walk);
    }
  }

  /** Make a character attack the nearest target. */
  attackTarget(attacker: CharacterEntity): void {
    if (!attacker.isAlive() || attacker.state === CharacterState.Attack) return;

    const targets = this.characters.filter((c) => c !== attacker && c.isAlive());
    if (targets.length === 0) return;

    const nearest = targets.reduce((a, b) =>
      a.pos.distanceTo(attacker.pos) < b.pos.distanceTo(attacker.pos) ? a : b,
    );

    if (attacker.equippedWeapon?.type === 'melee') {
      const weaponDef = CombatSystem.getWeapon(BiomeTheme.Reek, attacker.equippedWeapon.id);
      if (weaponDef) {
        this.combatSystem.meleeAttack(attacker, weaponDef, [nearest]);
      }
      attacker.setState(CharacterState.Attack);
    } else if (attacker.equippedWeapon?.type === 'ranged') {
      const weaponDef = CombatSystem.getWeapon(BiomeTheme.Reek, attacker.equippedWeapon.id);
      if (weaponDef) {
        const proj = this.combatSystem.fireProjectile(attacker, weaponDef, nearest.pos);
        if (proj.mesh) this.scene.add(proj.mesh);
      }
      attacker.setState(CharacterState.Attack);
    }
  }

  /** Dash in a direction (knockback/move effect). */
  dash(char: CharacterEntity, direction: THREE.Vector3, speed: number): void {
    if (!char.isAlive() || char.state === CharacterState.Dash) return;
    char.vel.copy(direction).multiplyScalar(speed);
    char.setState(CharacterState.Dash);
  }

  /** Damage a character by name or instance. */
  damageCharacter(target: CharacterEntity, damage: number, from: THREE.Vector3 | null = null): void {
    target.takeDamage(damage, from);
  }

  /** Get all active characters. */
  getCharacters(): CharacterEntity[] {
    return this.characters;
  }

  /** Get alive characters only. */
  getAliveCharacters(): CharacterEntity[] {
    return this.characters.filter((c) => c.isAlive());
  }

  /** Remove a character from the world. */
  removeCharacter(char: CharacterEntity): void {
    const idx = this.characters.indexOf(char);
    if (idx >= 0) {
      this.characters.splice(idx, 1);
      const rig = this.riggedChars.get(char);
      if (rig) {
        rig.group.removeFromParent();
        this.riggedChars.delete(char);
      }
      char.group.removeFromParent();
    }
  }

  /** Clear all characters. */
  clear(): void {
    for (const char of this.characters) {
      const rig = this.riggedChars.get(char);
      if (rig) rig.group.removeFromParent();
      char.group.removeFromParent();
    }
    this.characters = [];
    this.riggedChars.clear();
    this.combatSystem.clear();
  }

  /** Get projectiles for rendering. */
  getProjectiles() {
    return this.combatSystem.getProjectiles();
  }
}
