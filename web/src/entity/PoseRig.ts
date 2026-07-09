/**
 * PoseRig — channel-based articulation on top of SkeletonMap.
 *
 * A "pose" is a flat Record<channel, number>. Channels are SEMANTIC — they
 * describe anatomy, not bone axes — so the same clip drives any rig Meshy
 * exports:
 *
 *   head.pitch / head.yaw / head.roll        nod · shake · tilt (neck+head)
 *   body.pitch / body.roll / body.yaw        bend at the hip: fore/back ·
 *                                            side/side · twist (spine chain)
 *   legL.pitch / spread / twist / knee / foot   (+ legR.*, mirrored signs so
 *                                            + always means the SAME anatomical
 *                                            move on both sides)
 *   armL.pitch / raise / twist / elbow       shoulder swing · lift · roll · bend
 *   armL.wrist.pitch / armL.wrist.yaw        wrist flex · wave
 *   armL.digits                              finger curl 0..~1.2 (+ armR.*)
 *   root.y / root.pitch / root.roll / root.yaw   whole-body offset/topple —
 *                                            pivots at the FEET (death falls)
 *   bone:<Name>.x|y|z                        raw local-euler channel on ANY
 *                                            bone (cap wobble, accessories) —
 *                                            this is how "extra rig points"
 *                                            from the Animator UI stay
 *                                            keyframeable like everything else.
 *
 * Circular patterns (head rolls, hip circles, arm windmills) are just two
 * channels driven 90° out of phase — see makeCircle() in AnimClip.ts.
 *
 * Rotations are specified in CHARACTER space and conjugated into each bone's
 * local frame via the rest pose (see SkeletonMap header), so bone-local axis
 * conventions cancel out. Digits are the one exception: fingers ride an arm
 * that itself moves, so curls apply in bone-LOCAL space (constant flex axis).
 */

import * as THREE from 'three';
import { SkeletonMap, type SlotName } from './SkeletonMap';

export type Pose = Record<string, number>;

interface ChannelTarget {
  slot: SlotName;
  w: number; // weight (chain distribution)
  axis: 'x' | 'y' | 'z';
  s: number; // sign (L/R anatomical mirroring)
}

/** Which bones a semantic channel drives, with what weight/axis/sign.
 *  Chain weights are renormalized at bind time over the slots that actually
 *  resolved, so a rig without (say) spine2 still bends the full amount. */
const CHANNEL_DEFS: Record<string, ChannelTarget[]> = {
  'head.pitch': [
    { slot: 'neck', w: 0.35, axis: 'x', s: 1 },
    { slot: 'head', w: 0.65, axis: 'x', s: 1 },
  ],
  'head.yaw': [
    { slot: 'neck', w: 0.3, axis: 'y', s: 1 },
    { slot: 'head', w: 0.7, axis: 'y', s: 1 },
  ],
  'head.roll': [
    { slot: 'neck', w: 0.3, axis: 'z', s: 1 },
    { slot: 'head', w: 0.7, axis: 'z', s: 1 },
  ],
  'body.pitch': [
    { slot: 'spine', w: 0.45, axis: 'x', s: 1 },
    { slot: 'spine1', w: 0.35, axis: 'x', s: 1 },
    { slot: 'spine2', w: 0.2, axis: 'x', s: 1 },
  ],
  'body.roll': [
    { slot: 'spine', w: 0.45, axis: 'z', s: 1 },
    { slot: 'spine1', w: 0.35, axis: 'z', s: 1 },
    { slot: 'spine2', w: 0.2, axis: 'z', s: 1 },
  ],
  'body.yaw': [
    { slot: 'spine', w: 0.45, axis: 'y', s: 1 },
    { slot: 'spine1', w: 0.35, axis: 'y', s: 1 },
    { slot: 'spine2', w: 0.2, axis: 'y', s: 1 },
  ],
  // Arms. T-pose: left arm along +X, right along -X (character space).
  // pitch + = swing forward · raise + = lift up · twist + = roll forward edge up
  'armL.pitch': [{ slot: 'armL', w: 1, axis: 'y', s: -1 }],
  'armR.pitch': [{ slot: 'armR', w: 1, axis: 'y', s: 1 }],
  'armL.raise': [{ slot: 'armL', w: 1, axis: 'z', s: 1 }],
  'armR.raise': [{ slot: 'armR', w: 1, axis: 'z', s: -1 }],
  'armL.twist': [{ slot: 'armL', w: 1, axis: 'x', s: 1 }],
  'armR.twist': [{ slot: 'armR', w: 1, axis: 'x', s: -1 }],
  'armL.elbow': [{ slot: 'forearmL', w: 1, axis: 'y', s: -1 }],
  'armR.elbow': [{ slot: 'forearmR', w: 1, axis: 'y', s: 1 }],
  'armL.wrist.pitch': [{ slot: 'handL', w: 1, axis: 'z', s: -1 }],
  'armR.wrist.pitch': [{ slot: 'handR', w: 1, axis: 'z', s: 1 }],
  'armL.wrist.yaw': [{ slot: 'handL', w: 1, axis: 'y', s: -1 }],
  'armR.wrist.yaw': [{ slot: 'handR', w: 1, axis: 'y', s: 1 }],
  // Legs. pitch + = swing forward · spread + = out to the side · knee + = bend
  'legL.pitch': [{ slot: 'upLegL', w: 1, axis: 'x', s: -1 }],
  'legR.pitch': [{ slot: 'upLegR', w: 1, axis: 'x', s: -1 }],
  'legL.spread': [{ slot: 'upLegL', w: 1, axis: 'z', s: 1 }],
  'legR.spread': [{ slot: 'upLegR', w: 1, axis: 'z', s: -1 }],
  'legL.twist': [{ slot: 'upLegL', w: 1, axis: 'y', s: 1 }],
  'legR.twist': [{ slot: 'upLegR', w: 1, axis: 'y', s: -1 }],
  'legL.knee': [{ slot: 'legL', w: 1, axis: 'x', s: 1 }],
  'legR.knee': [{ slot: 'legR', w: 1, axis: 'x', s: 1 }],
  'legL.foot': [{ slot: 'footL', w: 1, axis: 'x', s: -1 }],
  'legR.foot': [{ slot: 'footR', w: 1, axis: 'x', s: -1 }],
};

/** Finger-curl falloff by joint depth (knuckle, mid, tip). */
const DIGIT_FALLOFF = [1, 0.85, 0.7];
/** Fingers flex about this LOCAL axis on Meshy/Mixamo-style rigs. If a rig
 *  disagrees, flip these two — they're the only digit convention knobs. */
const DIGIT_AXIS: 'x' | 'y' | 'z' = 'x';
const DIGIT_SIGN_L = 1;
const DIGIT_SIGN_R = 1;

/** Channel groups + ranges — drives the Animator UI's slider panels. */
export const CHANNEL_GROUPS: { label: string; channels: { id: string; min: number; max: number }[] }[] = [
  {
    label: 'Head',
    channels: [
      { id: 'head.pitch', min: -1.1, max: 1.1 },
      { id: 'head.yaw', min: -1.3, max: 1.3 },
      { id: 'head.roll', min: -0.9, max: 0.9 },
    ],
  },
  {
    label: 'Body (hip)',
    channels: [
      { id: 'body.pitch', min: -1.2, max: 1.2 },
      { id: 'body.roll', min: -0.9, max: 0.9 },
      { id: 'body.yaw', min: -1.2, max: 1.2 },
    ],
  },
  {
    label: 'Leg L',
    channels: [
      { id: 'legL.pitch', min: -1.4, max: 1.4 },
      { id: 'legL.spread', min: -0.9, max: 0.9 },
      { id: 'legL.twist', min: -0.9, max: 0.9 },
      { id: 'legL.knee', min: 0, max: 2.0 },
      { id: 'legL.foot', min: -0.8, max: 0.8 },
    ],
  },
  {
    label: 'Leg R',
    channels: [
      { id: 'legR.pitch', min: -1.4, max: 1.4 },
      { id: 'legR.spread', min: -0.9, max: 0.9 },
      { id: 'legR.twist', min: -0.9, max: 0.9 },
      { id: 'legR.knee', min: 0, max: 2.0 },
      { id: 'legR.foot', min: -0.8, max: 0.8 },
    ],
  },
  {
    label: 'Arm L',
    channels: [
      { id: 'armL.pitch', min: -1.6, max: 1.6 },
      { id: 'armL.raise', min: -1.4, max: 1.4 },
      { id: 'armL.twist', min: -1.2, max: 1.2 },
      { id: 'armL.elbow', min: 0, max: 2.4 },
      { id: 'armL.wrist.pitch', min: -1.0, max: 1.0 },
      { id: 'armL.wrist.yaw', min: -1.0, max: 1.0 },
      { id: 'armL.digits', min: 0, max: 1.2 },
    ],
  },
  {
    label: 'Arm R',
    channels: [
      { id: 'armR.pitch', min: -1.6, max: 1.6 },
      { id: 'armR.raise', min: -1.4, max: 1.4 },
      { id: 'armR.twist', min: -1.2, max: 1.2 },
      { id: 'armR.elbow', min: 0, max: 2.4 },
      { id: 'armR.wrist.pitch', min: -1.0, max: 1.0 },
      { id: 'armR.wrist.yaw', min: -1.0, max: 1.0 },
      { id: 'armR.digits', min: 0, max: 1.2 },
    ],
  },
  {
    label: 'Root (whole body)',
    channels: [
      { id: 'root.y', min: -1.5, max: 0.6 },
      { id: 'root.pitch', min: -1.8, max: 1.8 },
      { id: 'root.roll', min: -1.8, max: 1.8 },
      { id: 'root.yaw', min: -3.2, max: 3.2 },
    ],
  },
];

/** Snapshot of every bone's local rotation + root state, for crossfading
 *  between animation systems (procedural pose ↔ Meshy's baked GLTF clips). */
export interface RigSnapshot {
  quats: Map<string, THREE.Quaternion>;
  rootY: number;
  rootEuler: THREE.Euler;
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class PoseRig {
  readonly skel: SkeletonMap;
  /** Wrapper group the root.* channels drive; its origin sits at the FEET so
   *  root.pitch/roll topple the body around ground contact (death falls). */
  readonly poseRoot: THREE.Object3D;

  /** Per-channel resolved targets (weights renormalized over present slots). */
  private defs = new Map<string, { bind: string; w: number; axis: 'x' | 'y' | 'z'; s: number }[]>();
  /** Per-frame euler accumulators, char space, keyed by bone name. */
  private accum = new Map<string, { x: number; y: number; z: number }>();
  /** Raw bone-local accumulators (bone:<Name>.<axis> channels + digits). */
  private accumLocal = new Map<string, { x: number; y: number; z: number }>();
  private touched = new Set<string>();
  private touchedLast = new Set<string>();

  constructor(skel: SkeletonMap, poseRoot: THREE.Object3D) {
    this.skel = skel;
    this.poseRoot = poseRoot;
    this.rebind();
  }

  /** (Re)resolve channel targets against the skeleton — call after remap(). */
  rebind(): void {
    this.defs.clear();
    for (const [ch, targets] of Object.entries(CHANNEL_DEFS)) {
      const present = targets.filter((t) => this.skel.slots.has(t.slot));
      if (!present.length) continue;
      const wSum = present.reduce((a, t) => a + t.w, 0);
      this.defs.set(
        ch,
        present.map((t) => ({
          bind: this.skel.slots.get(t.slot)!,
          w: t.w / wSum, // renormalize: missing chain links don't shrink the bend
          axis: t.axis,
          s: t.s,
        })),
      );
    }
  }

  private addAccum(map: Map<string, { x: number; y: number; z: number }>, bone: string, axis: 'x' | 'y' | 'z', v: number): void {
    let a = map.get(bone);
    if (!a) {
      a = { x: 0, y: 0, z: 0 };
      map.set(bone, a);
    }
    a[axis] += v;
  }

  /**
   * Apply a pose. Resets every bone touched this frame OR last frame to rest
   * first (so releasing a channel returns the bone home), then writes the
   * accumulated rotations. Root channels write the poseRoot wrapper.
   */
  apply(pose: Pose): void {
    this.accum.clear();
    this.accumLocal.clear();
    this.touched.clear();

    let rootY = 0;
    let rootPitch = 0;
    let rootRoll = 0;
    let rootYaw = 0;

    for (const [ch, v] of Object.entries(pose)) {
      if (v === 0 || !Number.isFinite(v)) continue;
      // Root channels → wrapper transform.
      if (ch === 'root.y') { rootY = v; continue; }
      if (ch === 'root.pitch') { rootPitch = v; continue; }
      if (ch === 'root.roll') { rootRoll = v; continue; }
      if (ch === 'root.yaw') { rootYaw = v; continue; }
      // Digit curls → local-space chain rotations.
      if (ch === 'armL.digits' || ch === 'armR.digits') {
        const chains = ch === 'armL.digits' ? this.skel.digitsL : this.skel.digitsR;
        const sign = ch === 'armL.digits' ? DIGIT_SIGN_L : DIGIT_SIGN_R;
        for (const chain of chains) {
          for (let i = 0; i < chain.length; i++) {
            const f = DIGIT_FALLOFF[Math.min(i, DIGIT_FALLOFF.length - 1)];
            this.addAccum(this.accumLocal, chain[i], DIGIT_AXIS, v * f * sign);
            this.touched.add(chain[i]);
          }
        }
        continue;
      }
      // Raw bone channels: "bone:<Name>.<axis>" — local space.
      if (ch.startsWith('bone:')) {
        const dot = ch.lastIndexOf('.');
        const name = ch.slice(5, dot);
        const axis = ch.slice(dot + 1) as 'x' | 'y' | 'z';
        if ((axis === 'x' || axis === 'y' || axis === 'z') && this.skel.binds.has(name)) {
          this.addAccum(this.accumLocal, name, axis, v);
          this.touched.add(name);
        }
        continue;
      }
      // Semantic channels → char-space accumulators.
      const targets = this.defs.get(ch);
      if (!targets) continue;
      for (const t of targets) {
        this.addAccum(this.accum, t.bind, t.axis, v * t.w * t.s);
        this.touched.add(t.bind);
      }
    }

    // Home anything we let go of, then everything we're about to write.
    for (const n of this.touchedLast) if (!this.touched.has(n)) this.skel.resetToRest([n]);
    this.skel.resetToRest(this.touched);

    // Char-space rotations: local' = P⁻¹ · R · P · rest.
    for (const [name, e] of this.accum) {
      const b = this.skel.binds.get(name);
      if (!b) continue;
      _q.setFromEuler(_e.set(e.x, e.y, e.z, 'YXZ'));
      b.bone.quaternion
        .copy(b.invParentRestWorld)
        .multiply(_q)
        .multiply(b.parentRestWorld)
        .multiply(b.restLocal);
    }
    // Bone-local rotations compose AFTER whatever the bone already has.
    for (const [name, e] of this.accumLocal) {
      const b = this.skel.binds.get(name);
      if (!b) continue;
      _q2.setFromEuler(_e.set(e.x, e.y, e.z, 'XYZ'));
      b.bone.quaternion.multiply(_q2);
    }

    // Root wrapper: feet-pivot topple + vertical offset.
    this.poseRoot.position.y = rootY;
    this.poseRoot.rotation.set(rootPitch, rootYaw, rootRoll, 'YXZ');

    // Swap touched sets (reuse objects, no per-frame allocation).
    const tmp = this.touchedLast;
    this.touchedLast = this.touched;
    this.touched = tmp;
  }

  /** Capture the current bone rotations + root state (system crossfades). */
  snapshot(): RigSnapshot {
    const quats = new Map<string, THREE.Quaternion>();
    for (const [name, b] of this.skel.binds) quats.set(name, b.bone.quaternion.clone());
    return {
      quats,
      rootY: this.poseRoot.position.y,
      rootEuler: this.poseRoot.rotation.clone(),
    };
  }

  /** Blend every bone from a snapshot toward its CURRENT rotation.
   *  alpha 0 = snapshot, 1 = current. Call AFTER apply()/mixer update. */
  blendFromSnapshot(snap: RigSnapshot, alpha: number): void {
    if (alpha >= 1) return;
    for (const [name, q] of snap.quats) {
      const b = this.skel.binds.get(name);
      if (!b) continue;
      _q.copy(b.bone.quaternion);
      b.bone.quaternion.copy(q).slerp(_q, alpha);
    }
    this.poseRoot.position.y = THREE.MathUtils.lerp(snap.rootY, this.poseRoot.position.y, alpha);
    this.poseRoot.rotation.x = THREE.MathUtils.lerp(snap.rootEuler.x, this.poseRoot.rotation.x, alpha);
    this.poseRoot.rotation.y = THREE.MathUtils.lerp(snap.rootEuler.y, this.poseRoot.rotation.y, alpha);
    this.poseRoot.rotation.z = THREE.MathUtils.lerp(snap.rootEuler.z, this.poseRoot.rotation.z, alpha);
  }

  /** Every channel the UI can drive on this rig (semantic set; raw bone:*
   *  channels are minted on demand by the Animator UI's bone panel). */
  availableChannels(): string[] {
    const out: string[] = [];
    for (const g of CHANNEL_GROUPS) for (const c of g.channels) out.push(c.id);
    return out;
  }
}
