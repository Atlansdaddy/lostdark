/**
 * SkeletonMap — resolves an auto-rigged (Meshy/Mixamo-style) skeleton into
 * semantic slots (head, spine chain, arms, hands, digits, legs) and owns the
 * rest-pose data every higher layer (PoseRig, the Animator UI) builds on.
 *
 * WHY "character space": every auto-rigger ships different bone-LOCAL axis
 * conventions, so "rotate the head +0.3 about X" means something different on
 * every export. Instead we specify rotations in the CHARACTER's rest frame
 * ("+pitch = nod toward facing") and conjugate them into each bone's local
 * frame:   local' = P⁻¹ · R · P · rest,   where P is the parent's rest-pose
 * world rotation (in character space). The rig's own axis conventions cancel
 * out, so the same clip data drives any skeleton Meshy hands us.
 *
 * Slots resolve by bone-NAME patterns first (Meshy rigs use Mixamo-style
 * names); anything unresolved is visible in the Animator UI, where a slot can
 * be remapped to any bone by hand. Unmapped bones are still fully drivable
 * through raw `bone:<Name>.<axis>` channels (see PoseRig).
 */

import * as THREE from 'three';

/** Semantic skeleton slots. L/R suffixes are the CHARACTER's left/right. */
export type SlotName =
  | 'hips'
  | 'spine'
  | 'spine1'
  | 'spine2'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'armL'
  | 'forearmL'
  | 'handL'
  | 'shoulderR'
  | 'armR'
  | 'forearmR'
  | 'handR'
  | 'upLegL'
  | 'legL'
  | 'footL'
  | 'upLegR'
  | 'legR'
  | 'footR';

/** Rest-pose bind data for one bone (all quats in character space). */
export interface BoneBind {
  bone: THREE.Bone;
  /** Bone's local rotation in the bind (rest) pose. */
  restLocal: THREE.Quaternion;
  /** Parent's accumulated rest rotation relative to the character root. */
  parentRestWorld: THREE.Quaternion;
  /** Cached inverse of parentRestWorld. */
  invParentRestWorld: THREE.Quaternion;
}

/** Normalize a bone name for matching: lowercase, strip rig prefixes/joiners. */
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/mixamorig/g, '')
    .replace(/armature/g, '')
    .replace(/[\s_\-.:|]/g, '');
}

/** Slot → list of normalized-name candidates, most specific first. */
const SLOT_PATTERNS: Record<SlotName, string[]> = {
  hips: ['hips', 'pelvis', 'hip'],
  spine: ['spine'],
  spine1: ['spine1', 'chest'],
  spine2: ['spine2', 'upperchest', 'chestupper'],
  neck: ['neck'],
  head: ['head'],
  shoulderL: ['leftshoulder', 'shoulderl', 'lshoulder', 'leftclavicle', 'claviclel'],
  armL: ['leftarm', 'arml', 'larm', 'leftupperarm', 'upperarml'],
  forearmL: ['leftforearm', 'forearml', 'lforearm', 'leftlowerarm', 'lowerarml'],
  handL: ['lefthand', 'handl', 'lhand'],
  shoulderR: ['rightshoulder', 'shoulderr', 'rshoulder', 'rightclavicle', 'clavicler'],
  armR: ['rightarm', 'armr', 'rarm', 'rightupperarm', 'upperarmr'],
  forearmR: ['rightforearm', 'forearmr', 'rforearm', 'rightlowerarm', 'lowerarmr'],
  handR: ['righthand', 'handr', 'rhand'],
  upLegL: ['leftupleg', 'uplegl', 'lupleg', 'leftupperleg', 'upperlegl', 'leftthigh', 'thighl'],
  legL: ['leftleg', 'legl', 'lleg', 'leftlowerleg', 'lowerlegl', 'leftshin', 'shinl', 'leftcalf'],
  footL: ['leftfoot', 'footl', 'lfoot'],
  upLegR: ['rightupleg', 'uplegr', 'rupleg', 'rightupperleg', 'upperlegr', 'rightthigh', 'thighr'],
  legR: ['rightleg', 'legr', 'rleg', 'rightlowerleg', 'lowerlegr', 'rightshin', 'shinr', 'rightcalf'],
  footR: ['rightfoot', 'footr', 'rfoot'],
};

export class SkeletonMap {
  /** Slot → bone name (only resolved slots present). */
  readonly slots = new Map<SlotName, string>();
  /** Bone name → bind data, for EVERY bone found under the root. */
  readonly binds = new Map<string, BoneBind>();
  /** Finger chains per hand: arrays of bone names, knuckle→tip order. */
  digitsL: string[][] = [];
  digitsR: string[][] = [];
  /** Every bone name, discovery order — the Animator UI's raw bone tree. */
  readonly boneNames: string[] = [];

  /**
   * @param root The character-space root: the loaded gltf.scene (BEFORE any
   *   game-side yaw/scale wrappers). Rest quats accumulate relative to it, so
   *   "character space" == this node's local frame.
   */
  constructor(root: THREE.Object3D) {
    // Capture rest data. The model must still be in bind pose (fresh load).
    const restWorld = new Map<THREE.Object3D, THREE.Quaternion>();
    const walk = (node: THREE.Object3D, parentQ: THREE.Quaternion): void => {
      const q = parentQ.clone().multiply(node.quaternion);
      restWorld.set(node, q);
      if ((node as THREE.Bone).isBone) {
        const name = node.name || `bone_${this.boneNames.length}`;
        if (!this.binds.has(name)) {
          this.binds.set(name, {
            bone: node as THREE.Bone,
            restLocal: node.quaternion.clone(),
            parentRestWorld: parentQ.clone(),
            invParentRestWorld: parentQ.clone().invert(),
          });
          this.boneNames.push(name);
        }
      }
      for (const child of node.children) walk(child, q);
    };
    walk(root, new THREE.Quaternion());

    this.resolve();
  }

  /** Name-pattern pass: fill every slot whose bone we can recognize. */
  private resolve(): void {
    const byNorm = new Map<string, string>();
    for (const name of this.boneNames) byNorm.set(norm(name), name);

    for (const slot of Object.keys(SLOT_PATTERNS) as SlotName[]) {
      for (const pat of SLOT_PATTERNS[slot]) {
        const hit = byNorm.get(pat);
        if (hit) {
          this.slots.set(slot, hit);
          break;
        }
      }
    }

    // Spine chain: order STRUCTURALLY (nearest the hips first). Names lie —
    // Mixamo calls the lowest bone "Spine" (…Spine1, Spine2 upward) while
    // Meshy calls the lowest "Spine02" (…Spine01, Spine upward). Hierarchy
    // depth is the truth on both.
    const spines = this.boneNames.filter((n) => /spine/i.test(n));
    if (spines.length) {
      const depthOf = (n: string): number => {
        let d = 0;
        let node: THREE.Object3D | null = this.binds.get(n)?.bone ?? null;
        while (node?.parent && (node.parent as THREE.Bone).isBone) {
          d++;
          node = node.parent;
        }
        return d;
      };
      spines.sort((a, b) => depthOf(a) - depthOf(b));
      const chain: SlotName[] = ['spine', 'spine1', 'spine2'];
      spines.slice(0, 3).forEach((n, i) => this.slots.set(chain[i], n));
    }

    // Digits: every bone chain hanging under each hand. Group by direct child
    // of the hand (one chain per finger), ordered knuckle→tip.
    this.digitsL = this.collectDigits('handL');
    this.digitsR = this.collectDigits('handR');
  }

  private collectDigits(hand: 'handL' | 'handR'): string[][] {
    const handName = this.slots.get(hand);
    if (!handName) return [];
    const handBone = this.binds.get(handName)?.bone;
    if (!handBone) return [];
    const chains: string[][] = [];
    for (const child of handBone.children) {
      if (!(child as THREE.Bone).isBone) continue;
      const chain: string[] = [];
      let node: THREE.Object3D | null = child;
      while (node && (node as THREE.Bone).isBone) {
        chain.push(node.name);
        // Follow the first bone child (fingers are simple chains).
        node = node.children.find((c) => (c as THREE.Bone).isBone) ?? null;
      }
      if (chain.length) chains.push(chain);
    }
    return chains;
  }

  /** Reassign a slot to a different bone (Animator UI's mapping panel). */
  remap(slot: SlotName, boneName: string): void {
    if (this.binds.has(boneName)) {
      this.slots.set(slot, boneName);
      if (slot === 'handL') this.digitsL = this.collectDigits('handL');
      if (slot === 'handR') this.digitsR = this.collectDigits('handR');
    }
  }

  /** Bind data for a slot, or null if the slot didn't resolve on this rig. */
  bind(slot: SlotName): BoneBind | null {
    const name = this.slots.get(slot);
    return name ? (this.binds.get(name) ?? null) : null;
  }

  /** Bind data by raw bone name (drives `bone:<Name>.<axis>` channels). */
  bindByName(name: string): BoneBind | null {
    return this.binds.get(name) ?? null;
  }

  /** Restore the given bones to their rest-pose local rotation. */
  resetToRest(names: Iterable<string>): void {
    for (const n of names) {
      const b = this.binds.get(n);
      if (b) b.bone.quaternion.copy(b.restLocal);
    }
  }

  /** Slots that failed to resolve — surfaced in the Animator UI. */
  unresolved(): SlotName[] {
    return (Object.keys(SLOT_PATTERNS) as SlotName[]).filter((s) => !this.slots.has(s));
  }
}
