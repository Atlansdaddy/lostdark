/**
 * CharacterEntity — base class for animated, damageable creatures.
 *
 * Owns: position, health, animation state, limb poses, direction facing.
 * Does NOT own: geometry (caller provides mesh). Does NOT network (single-player).
 */

import * as THREE from 'three';

export enum CharacterState {
  Idle = 'idle',
  Walk = 'walk',
  Run = 'run',
  Attack = 'attack',
  Dash = 'dash',
  Flinch = 'flinch',
  Death = 'death',
}

/** Per-limb articulation: rotation (radians) around local axes. */
export interface LimbPose {
  headPitch: number; // look up/down
  headYaw: number; // look left/right
  bodyRoll: number; // lean left/right at hip
  bodyPitch: number; // lean forward/back at hip
  bodyYaw: number; // rotate at hip (cardinal dirs)
  legLPitch: number; // left leg forward/back
  legLYaw: number; // left leg left/right
  legRPitch: number; // right leg forward/back
  legRYaw: number; // right leg left/right
  armLPitch: number; // left arm forward/back
  armLYaw: number; // left arm left/right (across body)
  armLRoll: number; // left arm twist
  armRPitch: number; // right arm forward/back
  armRYaw: number; // right arm left/right
  armRRoll: number; // right arm twist
  handLRotX?: number; // wrist flex (optional)
  handLRotY?: number; // wrist twist
  handRRotX?: number;
  handRRotY?: number;
}

/** Zero pose (neutral T-stance). */
export const ZERO_POSE: LimbPose = {
  headPitch: 0,
  headYaw: 0,
  bodyRoll: 0,
  bodyPitch: 0,
  bodyYaw: 0,
  legLPitch: 0,
  legLYaw: 0,
  legRPitch: 0,
  legRYaw: 0,
  armLPitch: 0,
  armLYaw: 0,
  armLRoll: 0,
  armRPitch: 0,
  armRYaw: 0,
  armRRoll: 0,
};

export class CharacterEntity {
  readonly group = new THREE.Group();
  state: CharacterState = CharacterState.Idle;
  pose: LimbPose = { ...ZERO_POSE };

  // Physics
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  facing = new THREE.Vector3(0, 0, -1); // forward direction (xz plane)
  yaw = 0; // radians, 0 = facing -z

  // Health & combat
  maxHealth: number;
  health: number;
  lastDamageTime = 0;
  lastDamageDir = new THREE.Vector3();

  // Animation time
  stateTime = 0;
  animSpeed = 1; // multiplier on dt

  // Weapons (just refs—owner populates)
  equippedWeapon: WeaponInstance | null = null;

  constructor(maxHealth: number = 100) {
    this.maxHealth = maxHealth;
    this.health = maxHealth;
  }

  takeDamage(amount: number, from: THREE.Vector3 | null = null): void {
    this.health = Math.max(0, this.health - amount);
    this.lastDamageTime = performance.now();
    if (from) {
      this.lastDamageDir.subVectors(this.pos, from).normalize();
    }
    if (this.health <= 0) {
      this.setState(CharacterState.Death);
    } else if (this.state !== CharacterState.Attack && this.state !== CharacterState.Dash) {
      this.setState(CharacterState.Flinch);
    }
  }

  setState(newState: CharacterState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.stateTime = 0;
  }

  isAlive(): boolean {
    return this.health > 0;
  }

  isDead(): boolean {
    return this.health <= 0;
  }

  /** Update position, animation. Called each frame. */
  update(dt: number): void {
    this.stateTime += dt * this.animSpeed;

    // Gravity (simple constant accel).
    this.vel.y -= 9.81 * dt;

    // Apply velocity.
    this.pos.addScaledVector(this.vel, dt);

    // Update group transform.
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }

  /** Set pose (limb articulation). Caller drives the animation logic. */
  setPose(pose: Partial<LimbPose>): void {
    this.pose = { ...this.pose, ...pose };
  }
}

/** A weapon the character can equip. */
export interface WeaponInstance {
  id: string;
  name: string;
  type: 'melee' | 'ranged';
  damage: number;
  equipped: boolean;
  mesh?: THREE.Object3D;
}
