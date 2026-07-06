/**
 * AnimationEngine — procedural animation playback for character limbs.
 *
 * Drives pose keyframes per state (idle, walk, run, attack, etc).
 * Can blend between animations, layer effects (head-look, body-sway).
 */

import { CharacterEntity, CharacterState, type LimbPose, ZERO_POSE } from './CharacterEntity';

/** One keyframe: a time offset and the pose at that moment. */
export interface PoseKeyframe {
  t: number;
  pose: Partial<LimbPose>;
}

/** A sequence of keyframes that loops. */
export interface Animation {
  name: string;
  duration: number; // seconds
  keyframes: PoseKeyframe[];
  loop: boolean;
}

/** Lerp between two partial poses. */
function lerpPose(a: Partial<LimbPose>, b: Partial<LimbPose>, t: number): Partial<LimbPose> {
  const result: Partial<LimbPose> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LimbPose>;
  for (const key of keys) {
    const va = (a[key] ?? 0) as number;
    const vb = (b[key] ?? 0) as number;
    result[key] = va + (vb - va) * t;
  }
  return result;
}

/** Interpolate keyframes at time t (in [0, duration)). */
function sampleAnimation(anim: Animation, t: number): Partial<LimbPose> {
  if (anim.keyframes.length === 0) return {};
  if (anim.keyframes.length === 1) return anim.keyframes[0].pose;

  const kf = anim.keyframes;
  for (let i = 0; i < kf.length - 1; i++) {
    if (t >= kf[i].t && t < kf[i + 1].t) {
      const localT = (t - kf[i].t) / (kf[i + 1].t - kf[i].t);
      return lerpPose(kf[i].pose, kf[i + 1].pose, localT);
    }
  }
  return kf[kf.length - 1].pose; // past end
}

export class AnimationEngine {
  private animations = new Map<string, Animation>();
  private currentAnim: Animation | null = null;
  private layerPoses: Partial<LimbPose>[] = []; // facial/head layers stacked on base

  constructor() {
    this._buildDefaultAnimations();
  }

  private _buildDefaultAnimations(): void {
    // --- IDLE: gentle sway + head idle ---
    this.addAnimation({
      name: 'idle',
      duration: 2,
      loop: true,
      keyframes: [
        { t: 0, pose: { bodyPitch: 0, bodyRoll: 0, headPitch: -0.1 } },
        { t: 1, pose: { bodyPitch: 0.05, bodyRoll: 0.02, headPitch: 0 } },
        { t: 2, pose: { bodyPitch: 0, bodyRoll: 0, headPitch: -0.1 } },
      ],
    });

    // --- WALK: stepping gait (legs alternate pitch, slight body sway) ---
    this.addAnimation({
      name: 'walk',
      duration: 1.2,
      loop: true,
      keyframes: [
        { t: 0, pose: { legLPitch: 0.3, legRPitch: -0.3, bodyRoll: -0.05, bodyPitch: 0.1 } },
        { t: 0.3, pose: { legLPitch: 0, legRPitch: 0, bodyRoll: 0, bodyPitch: 0.05 } },
        { t: 0.6, pose: { legLPitch: -0.3, legRPitch: 0.3, bodyRoll: 0.05, bodyPitch: 0.1 } },
        { t: 1, pose: { legLPitch: 0, legRPitch: 0, bodyRoll: 0, bodyPitch: 0.05 } },
        { t: 1.2, pose: { legLPitch: 0.3, legRPitch: -0.3, bodyRoll: -0.05, bodyPitch: 0.1 } },
      ],
    });

    // --- RUN: faster gait, higher energy ---
    this.addAnimation({
      name: 'run',
      duration: 0.6,
      loop: true,
      keyframes: [
        { t: 0, pose: { legLPitch: 0.6, legRPitch: -0.6, bodyPitch: 0.2, armLPitch: -0.4, armRPitch: 0.4 } },
        { t: 0.15, pose: { legLPitch: 0.1, legRPitch: 0.1, bodyPitch: 0.15, armLPitch: 0.4, armRPitch: -0.4 } },
        { t: 0.3, pose: { legLPitch: -0.6, legRPitch: 0.6, bodyPitch: 0.2, armLPitch: -0.4, armRPitch: 0.4 } },
        { t: 0.45, pose: { legLPitch: 0.1, legRPitch: 0.1, bodyPitch: 0.15, armLPitch: 0.4, armRPitch: -0.4 } },
        { t: 0.6, pose: { legLPitch: 0.6, legRPitch: -0.6, bodyPitch: 0.2, armLPitch: -0.4, armRPitch: 0.4 } },
      ],
    });

    // --- ATTACK: swing pose (arms extend, body twists) ---
    this.addAnimation({
      name: 'attack',
      duration: 0.8,
      loop: false,
      keyframes: [
        { t: 0, pose: { armRPitch: -0.2, armRYaw: -0.3, bodyYaw: 0.2 } },
        { t: 0.3, pose: { armRPitch: -1.2, armRYaw: -0.8, bodyYaw: 0.4 } }, // wind-up
        { t: 0.5, pose: { armRPitch: 0.4, armRYaw: 0.6, bodyYaw: -0.3 } }, // swing
        { t: 0.8, pose: { armRPitch: 0, armRYaw: 0, bodyYaw: 0 } }, // return
      ],
    });

    // --- DASH: explosive pose (lean forward, arms back) ---
    this.addAnimation({
      name: 'dash',
      duration: 0.4,
      loop: false,
      keyframes: [
        { t: 0, pose: { bodyPitch: -0.3, armLPitch: 0.3, armRPitch: 0.3 } },
        { t: 0.2, pose: { bodyPitch: -0.5, armLPitch: 0.5, armRPitch: 0.5 } },
        { t: 0.4, pose: { bodyPitch: 0, armLPitch: 0, armRPitch: 0 } },
      ],
    });

    // --- FLINCH: recoil from damage ---
    this.addAnimation({
      name: 'flinch',
      duration: 0.3,
      loop: false,
      keyframes: [
        { t: 0, pose: { bodyPitch: -0.2, bodyRoll: 0.1 } },
        { t: 0.15, pose: { bodyPitch: 0.1, bodyRoll: -0.15 } },
        { t: 0.3, pose: { bodyPitch: 0, bodyRoll: 0 } },
      ],
    });

    // --- DEATH: topple pose ---
    this.addAnimation({
      name: 'death',
      duration: 1,
      loop: false,
      keyframes: [
        { t: 0, pose: { bodyPitch: 0 } },
        { t: 0.5, pose: { bodyPitch: 1.57 } }, // 90° forward fall
        { t: 1, pose: { bodyPitch: 1.57 } },
      ],
    });
  }

  addAnimation(anim: Animation): void {
    this.animations.set(anim.name, anim);
  }

  /** Play an animation by name. */
  play(name: string, resetTime = true): void {
    const anim = this.animations.get(name);
    if (!anim) {
      console.warn(`animation not found: ${name}`);
      return;
    }
    if (resetTime || this.currentAnim !== anim) {
      this.currentAnim = anim;
    }
  }

  /** Update the current animation and apply to character. */
  update(character: CharacterEntity, dt: number): void {
    if (!this.currentAnim) return;

    const t = character.stateTime % this.currentAnim.duration;
    const basePose = sampleAnimation(this.currentAnim, t);
    let finalPose: Partial<LimbPose> = { ...basePose };

    // Layer procedural effects (head-look, body-sway).
    for (const layer of this.layerPoses) {
      finalPose = { ...finalPose, ...layer };
    }

    character.setPose(finalPose);
  }

  /** Add a procedural layer (face direction, sway). */
  addLayer(pose: Partial<LimbPose>): void {
    this.layerPoses.push(pose);
  }

  /** Clear all procedural layers. */
  clearLayers(): void {
    this.layerPoses = [];
  }

  /** Procedural head-look: head rotates toward a target direction. */
  headLookAt(targetDir: THREE.Vector3, character: CharacterEntity, strength = 1): void {
    const rel = new THREE.Vector3().subVectors(targetDir, character.pos).normalize();
    const localRel = new THREE.Vector3(rel.x, rel.y, rel.z);
    localRel.applyAxisAngle(new THREE.Vector3(0, 1, 0), -character.yaw);

    this.addLayer({
      headYaw: localRel.x * strength * 0.5,
      headPitch: -localRel.y * strength * 0.5,
    });
  }

  /** Procedural body sway (gentle oscillation). */
  bodySway(amount = 0.05, time: number): void {
    this.addLayer({
      bodyRoll: Math.sin(time * 3) * amount,
    });
  }
}

/** Manager that ties animation engine to state machine. */
export class CharacterAnimationManager {
  private engine: AnimationEngine;

  constructor() {
    this.engine = new AnimationEngine();
  }

  update(character: CharacterEntity, dt: number): void {
    // Switch animation based on state.
    let targetAnim = 'idle';
    switch (character.state) {
      case CharacterState.Idle:
        targetAnim = 'idle';
        break;
      case CharacterState.Walk:
        targetAnim = 'walk';
        break;
      case CharacterState.Run:
        targetAnim = 'run';
        break;
      case CharacterState.Attack:
        targetAnim = 'attack';
        break;
      case CharacterState.Dash:
        targetAnim = 'dash';
        break;
      case CharacterState.Flinch:
        targetAnim = 'flinch';
        break;
      case CharacterState.Death:
        targetAnim = 'death';
        break;
    }

    this.engine.play(targetAnim, this.engine['currentAnim']?.name !== targetAnim);
    this.engine.update(character, dt);

    // Procedural layers: head look-ahead + gentle sway when idle.
    this.engine.clearLayers();
    if (character.state === CharacterState.Idle) {
      this.engine.bodySway(0.03, performance.now() * 0.001);
    }
    const lookAhead = new THREE.Vector3().copy(character.facing).multiplyScalar(2).add(character.pos);
    this.engine.headLookAt(lookAhead, character, 0.3);
  }

  addCustomAnimation(anim: Animation): void {
    this.engine.addAnimation(anim);
  }
}
