/**
 * The orb — the player, and the emotional anchor (GDD §5h).
 *
 * Locomotion is HOVER-glide, not flight: gravity pulls, and a slightly
 * underdamped spring holds the orb ~hoverHeight above the nearest floor so it
 * bobs like something alive holding itself up. Horizontal glide chases a
 * target velocity (snappy) and decays into drift (momentum). Vertical gain is
 * earned: the WAVE-JUMP is a downward pulse that launches the orb, chainable
 * mid-air up to 3 with diminishing power, energy-gated — never free flight.
 *
 * Carries the two survival stats — Lumen (life) and Energy (the pulse economy) —
 * and a resting "breath" so the light reads as alive rather than as an asset.
 */

import * as THREE from 'three';
import { Move, Survival, Light } from '../config';
import { VoxelWorld } from '../world/VoxelWorld';

const RADIUS = 0.45; // orb collision radius in voxels
const GROUND_PROBE = 6; // how far below we look for the hover floor

export class Orb {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();

  /** Extra collision test (flora hitboxes etc.), injected by the scene. */
  extraCollide: ((p: THREE.Vector3, radius: number) => boolean) | null = null;

  lumen: number = Survival.lumenMax;
  energy: number = Survival.energyMax;

  /** Irregular breathing phase — drives a subtle brightness/scale pulse. */
  private breath = 0;
  breathGlow = 1;
  /** Breath tempo, driven by mood arousal (calm = slow deep, alarmed = fast). */
  pulseRate = 1.6;

  private jumpsUsed = 0;
  grounded = false;
  /** Set true for one frame when a wave-jump fires (drives the jump pulse FX). */
  jumped = false;

  constructor(private world: VoxelWorld) {}

  spawn(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  /**
   * @param move   normalized horizontal intent in camera space
   * @param yaw    camera yaw so intent maps to world directions
   * @param jump   edge-triggered wave-jump this frame
   * @param sprint dash HELD: glide at the old cruise speed, draining energy
   */
  update(dt: number, move: { x: number; z: number }, yaw: number, jump: boolean, sprint: boolean): void {
    // Camera-space intent → world direction.
    // Camera sits at azimuth `yaw` behind the orb, so its view axes are:
    //   forward = (-sin yaw, 0, -cos yaw)   right = (cos yaw, 0, -sin yaw)
    // W is move.z = -1 (forward), D is move.x = +1 (right).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const wx = move.x * cos + move.z * sin;
    const wz = -move.x * sin + move.z * cos;

    // Sprint (dash held): the old cruise speed, paid for in energy.
    const moving = wx !== 0 || wz !== 0;
    const sprinting = sprint && moving && this.energy > 1;
    if (sprinting) this.energy = Math.max(0, this.energy - Move.sprintCostPerSec * dt);
    const speed = sprinting ? Move.sprintSpeed : Move.maxSpeed;

    // Horizontal glide: chase target velocity (snappy), then drift (momentum).
    const targetX = wx * speed;
    const targetZ = wz * speed;
    this.vel.x += (targetX - this.vel.x) * Math.min(1, Move.accel * dt * 0.02);
    this.vel.z += (targetZ - this.vel.z) * Math.min(1, Move.accel * dt * 0.02);
    if (!moving) {
      const d = Math.max(0, 1 - Move.damping * dt);
      this.vel.x *= d;
      this.vel.z *= d;
    }

    // --- Vertical: gravity + hover spring + wave-jump. Not flight. ---
    const floorDist = this.probeFloor();
    this.grounded = floorDist <= Move.hoverHeight + 0.6;
    if (this.grounded) this.jumpsUsed = 0;

    this.jumped = false;
    if (jump && this.jumpsUsed < Move.jumpChain && this.energy >= Move.jumpCost) {
      // The wave-jump: a downward pulse that kicks the orb up. Each chained
      // jump is weaker — height is earned, never held.
      this.energy -= Move.jumpCost;
      this.vel.y = Move.jumpSpeed * Math.pow(Move.jumpDecay, this.jumpsUsed);
      this.jumpsUsed++;
      this.jumped = true;
    }

    this.vel.y -= Move.gravity * dt;
    // Hover spring engages near the floor — but never fights an active jump
    // (a fast upward velocity is ballistic; the spring only catches the fall).
    if (floorDist < GROUND_PROBE && this.vel.y < 4) {
      const stretch = Move.hoverHeight - floorDist;
      if (stretch > -0.5) {
        // Gravity-compensated so it settles at exactly hoverHeight, bobbing.
        this.vel.y +=
          (stretch * Move.hoverStiffness + Move.gravity - this.vel.y * Move.hoverDamping) * dt;
      }
    }
    // The orb is light itself — it drifts down, it never plummets.
    if (this.vel.y < -Move.fallGlide) this.vel.y = -Move.fallGlide;

    // Integrate with per-axis collision so we slide along walls.
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('y', this.vel.y * dt);
    this.moveAxis('z', this.vel.z * dt);

    // Safety: if we're somehow overlapping a solid (world edits under the orb,
    // spawn edge cases), rise gently until free — never wedge the player.
    if (this.collides(this.pos)) {
      this.pos.y += Math.max(4 * dt, 0.02);
      this.vel.y = Math.max(this.vel.y, 0);
    }

    // Energy regen (when lit — approximated as "always" for the slice).
    this.energy = Math.min(Survival.energyMax, this.energy + Survival.energyRegenPerSec * dt);

    // Resting breath — irregular so it reads as alive, never a clean sine.
    // Tempo follows mood arousal; depth is fuller when the breath is slow.
    this.breath += dt * this.pulseRate * (1 + 0.25 * Math.sin(this.breath * 0.7));
    const depth = 0.09 + 0.07 / Math.max(this.pulseRate, 0.8);
    this.breathGlow = 1 + depth * Math.sin(this.breath) + 0.05 * Math.sin(this.breath * 2.3);
  }

  /** Distance from the orb's center to the first solid voxel straight below. */
  private probeFloor(): number {
    const x = Math.floor(this.pos.x);
    const z = Math.floor(this.pos.z);
    for (let d = 0; d < GROUND_PROBE; d++) {
      const y = Math.floor(this.pos.y) - d;
      if (this.world.solid(x, y, z)) {
        return this.pos.y - (y + 1); // top face of that voxel
      }
    }
    return GROUND_PROBE;
  }

  private moveAxis(axis: 'x' | 'y' | 'z', delta: number): void {
    if (delta === 0) return;
    const next = this.pos.clone();
    next[axis] += delta;
    if (this.collides(next)) {
      this.vel[axis] = 0;
      return;
    }
    this.pos.copy(next);
  }

  private collides(p: THREE.Vector3): boolean {
    if (this.extraCollide && this.extraCollide(p, RADIUS)) return true;
    // Sample the voxel cells the orb sphere overlaps (cheap AABB approximation).
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const vx = Math.floor(p.x + dx * RADIUS);
          const vy = Math.floor(p.y + dy * RADIUS);
          const vz = Math.floor(p.z + dz * RADIUS);
          if (this.world.solid(vx, vy, vz)) {
            // Only block if the sphere actually reaches this cell.
            const cx = Math.max(vx, Math.min(p.x, vx + 1));
            const cy = Math.max(vy, Math.min(p.y, vy + 1));
            const cz = Math.max(vz, Math.min(p.z, vz + 1));
            if (
              (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2 <
              RADIUS * RADIUS
            ) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  canPulse(): boolean {
    return this.energy >= Light.pulse.energyCost;
  }

  spendPulse(): void {
    this.energy = Math.max(0, this.energy - Light.pulse.energyCost);
  }
}
