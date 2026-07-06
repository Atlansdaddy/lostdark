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
import { Mat } from '../world/Materials';
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
  /** World-Y of the floor top-face directly below the orb (bob-invariant, so
   *  the fog can sit ON the ground instead of riding the hover spring). Falls
   *  to orb.y − GROUND_PROBE when there's no floor within reach (over a drop). */
  floorY = 0;
  /** Set true for one frame when a wave-jump fires (drives the jump pulse FX). */
  jumped = false;

  // --- Dash: a dedicated blink-burst, on the ground or in the air. ---
  /** Remaining seconds of the active burst window (float, gravity-suppressed). */
  private dashTimer = 0;
  /** Remaining cooldown before another dash can fire. */
  private dashCooldown = 0;
  /** Air dashes spent since last grounded — refreshes on landing. */
  private airDashesUsed = 0;
  /** Unit horizontal direction the current burst travels. */
  private dashDir = new THREE.Vector3();
  /** True while a burst is active (drives the dash streak/FX). */
  dashing = false;
  /** Set true for one frame the moment a dash fires (FX trigger). */
  dashStarted = false;
  /** When inside a climbable vertical shaft (set by the scene), the wave-jump
   *  refreshes for free every frame — so any chimney you dropped down can be
   *  climbed back out by tapping up, while descending is just not jumping. */
  liftZone = false;

  // --- Water (testbed pool): buoyancy + drag + a surface to leap from. ---
  /** True while the orb rides in/on a water column. */
  inWater = false;
  /** World-Y of the water surface over the orb's column (−Infinity when dry). */
  waterSurfaceY = -Infinity;
  /** One-frame flag: the orb just crossed the surface hard (splash FX cue). */
  splashed = false;
  /** Camera pitch, fed by the scene each frame — swimming follows the LOOK:
   *  aim down and push forward to dive, aim up to climb back out. */
  lookPitch = 0;

  constructor(private world: VoxelWorld) {}

  spawn(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  /**
   * @param move   normalized horizontal intent in camera space
   * @param yaw    camera yaw so intent maps to world directions
   * @param jump   edge-triggered wave-jump this frame
   * @param sprint sprint HELD: glide at the old cruise speed, draining energy
   * @param dash   edge-triggered dash this frame: a blink-burst (ground or air)
   * @param jumpHeld jump button HELD: sustained hover-boost, energy-hungry
   */
  update(
    dt: number,
    move: { x: number; z: number },
    yaw: number,
    jump: boolean,
    sprint: boolean,
    dash: boolean,
    jumpHeld = false,
  ): void {
    // Camera-space intent → world direction.
    // Camera sits at azimuth `yaw` behind the orb, so its view axes are:
    //   forward = (-sin yaw, 0, -cos yaw)   right = (cos yaw, 0, -sin yaw)
    // W is move.z = -1 (forward), D is move.x = +1 (right).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const wx = move.x * cos + move.z * sin;
    const wz = -move.x * sin + move.z * cos;

    // --- Ground state first: dash and jump both read it. ---
    const floorDist = this.probeFloor();
    this.floorY = this.pos.y - floorDist; // real ground under the orb, no bob
    this.grounded = floorDist <= Move.hoverHeight + 0.6;
    if (this.grounded) {
      this.jumpsUsed = 0;
      this.airDashesUsed = 0; // landing refreshes the air dash
    }
    // In a climb shaft the chain refreshes every frame and jumps are free, so a
    // deep drop is never a trap — tap up to bounce out the chimney.
    if (this.liftZone) this.jumpsUsed = 0;

    // --- Water state: buoyancy makes the pool a floor you bob ON, and the jump
    // chain refreshes every frame in it, so water is never a pit trap — float
    // up, then leap out. Hysteresis (+0.45 vs the 0.35 float line) so the
    // surface hand-off doesn't flutter. ---
    this.waterSurfaceY = this.probeWater();
    const wasInWater = this.inWater;
    this.inWater = this.waterSurfaceY > -1e8 && this.pos.y < this.waterSurfaceY + 0.45;
    this.splashed = this.inWater !== wasInWater && Math.abs(this.vel.y) > 1.5;
    if (this.inWater) {
      this.jumpsUsed = 0;
      this.airDashesUsed = 0;
    }

    // --- Dash: a dedicated blink-burst. Fires on the ground or in the air
    //     (air dashes limited per airtime), separate from hold-to-sprint. ---
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.dashStarted = false;
    if (
      dash &&
      this.dashTimer <= 0 &&
      this.dashCooldown <= 0 &&
      this.energy >= Move.dash.cost &&
      (this.grounded || this.airDashesUsed < Move.dash.airMax)
    ) {
      // Direction: current move intent; if standing still, dash camera-forward.
      let dx = wx;
      let dz = wz;
      if (dx === 0 && dz === 0) {
        dx = -sin;
        dz = -cos;
      }
      const len = Math.hypot(dx, dz) || 1;
      this.dashDir.set(dx / len, 0, dz / len);
      this.energy -= Move.dash.cost;
      this.dashTimer = Move.dash.duration;
      this.dashCooldown = Move.dash.cooldown;
      if (!this.grounded) this.airDashesUsed++;
      this.dashStarted = true;
    }
    const dashing = this.dashTimer > 0;
    this.dashing = dashing;

    // Sprint (held): the old cruise speed, paid for in energy.
    const moving = wx !== 0 || wz !== 0;
    const sprinting = !dashing && sprint && moving && this.energy > 1;
    if (sprinting) this.energy = Math.max(0, this.energy - Move.sprintCostPerSec * dt);
    const speed = sprinting ? Move.sprintSpeed : Move.maxSpeed;

    // Horizontal: the dash overrides glide with an authoritative burst; the
    // residual velocity bleeds off into the normal drift when the window ends.
    if (dashing) {
      this.vel.x = this.dashDir.x * Move.dash.speed;
      this.vel.z = this.dashDir.z * Move.dash.speed;
    } else {
      // Chase target velocity (snappy), then drift (momentum).
      const targetX = wx * speed;
      const targetZ = wz * speed;
      this.vel.x += (targetX - this.vel.x) * Math.min(1, Move.accel * dt * 0.02);
      this.vel.z += (targetZ - this.vel.z) * Math.min(1, Move.accel * dt * 0.02);
      if (!moving) {
        const d = Math.max(0, 1 - Move.damping * dt);
        this.vel.x *= d;
        this.vel.z *= d;
      }
    }

    // --- Vertical: gravity + hover spring + wave-jump. Not flight. ---
    this.jumped = false;
    if (jump && this.jumpsUsed < Move.jumpChain && (this.liftZone || this.energy >= Move.jumpCost)) {
      // The wave-jump: a downward pulse that kicks the orb up. Each chained
      // jump is weaker — height is earned, never held (free while climbing out).
      if (!this.liftZone) this.energy -= Move.jumpCost;
      this.vel.y = Move.jumpSpeed * Math.pow(Move.jumpDecay, this.jumpsUsed);
      this.jumpsUsed++;
      this.jumped = true;
      this.dashTimer = 0; // a jump breaks the dash float — leap out of the blink
    }

    // Hover-boost: while the jump button is HELD (and there's energy) the orb
    // keeps lifting toward a ceiling, then hovers there — a sustained, costly
    // alternative to the skillful triple-jump chain. Overrides the hover spring.
    const boosting = jumpHeld && this.energy > 0 && this.dashTimer <= 0;
    if (boosting) this.energy = Math.max(0, this.energy - Move.hoverBoost.costPerSec * dt);

    if (this.dashTimer > 0) {
      // During the burst the orb floats: gravity and the hover spring are held
      // off so the dash reads as a clean horizontal blink, ground or air.
      this.vel.y *= Math.max(0, 1 - 12 * dt);
      this.dashTimer = Math.max(0, this.dashTimer - dt);
    } else if (this.inWater) {
      // SWIM, not just float. The vertical is driven by intent, in priority:
      //   1. Look-swim: aim the camera down and push forward to DIVE, aim up
      //      to climb — swimming follows the look, like any 3D swimmer.
      //   2. Hold jump: paddle straight up.
      //   3. No intent, submerged: gentle buoyant drift back toward the light.
      //   4. At the surface: bob on the float line (an underdamped spring).
      // A wave-jump (chain refreshed every frame in water) still leaps you out.
      const depth = this.waterSurfaceY - this.pos.y; // >0 = submerged
      const fwdIntent = -move.z; // W = +1
      const vertTarget = -fwdIntent * Math.sin(this.lookPitch) * speed * 0.6;
      if (Math.abs(vertTarget) > 0.4) {
        this.vel.y += (vertTarget - this.vel.y) * Math.min(1, 6 * dt);
      } else if (jumpHeld && this.energy > 0) {
        this.vel.y += 16 * dt; // paddle straight up
      } else if (depth > 0.9) {
        this.vel.y += (2.2 - this.vel.y) * 1.6 * dt; // idle: slow rise to the surface
      } else {
        const floatY = this.waterSurfaceY + 0.35;
        this.vel.y += ((floatY - this.pos.y) * 30 - this.vel.y * 7) * dt;
      }
      const drag = Math.max(0, 1 - 2.0 * dt);
      this.vel.x *= drag;
      this.vel.z *= drag;
    } else if (boosting) {
      const h = this.pos.y - this.floorY;
      if (h < Move.hoverBoost.ceiling) {
        // Climb — but don't cap a fresh wave-jump's ballistic pop; let gravity
        // bleed that down into hover range, then sustain the climb.
        if (this.vel.y < Move.hoverBoost.riseSpeed) {
          this.vel.y = Math.min(this.vel.y + Move.hoverBoost.accel * dt, Move.hoverBoost.riseSpeed);
        } else {
          this.vel.y -= Move.gravity * dt;
        }
      } else {
        // At the ceiling: settle into a hover, easing down if we overshot.
        this.vel.y += (0 - this.vel.y) * Math.min(1, 12 * dt);
        if (h > Move.hoverBoost.ceiling + 0.4) this.vel.y = Math.min(this.vel.y, -0.6);
      }
    } else {
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
    }

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

  /** World-Y of the water surface over the orb's column, or −Infinity when the
   *  orb isn't in/right above a water voxel. The visible surface plane sits
   *  0.6 into the top water voxel (see Testbeds), so the physics agree with
   *  what the player sees. */
  private probeWater(): number {
    const x = Math.floor(this.pos.x);
    const z = Math.floor(this.pos.z);
    let y = Math.floor(this.pos.y);
    if (this.world.get(x, y, z) !== Mat.Water) {
      // Riding just above the top water voxel still counts (surface bobbing).
      if (this.world.get(x, y - 1, z) === Mat.Water) y -= 1;
      else return -Infinity;
    }
    let top = y;
    while (this.world.get(x, top + 1, z) === Mat.Water) top++;
    return top + 0.6;
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
