/**
 * Rigging — create skeletal rigs and apply bone transforms from LimbPose data.
 *
 * Two modes:
 *   1. GLFT skeleton: load a rigged GLB, map bones to LimbPose keys
 *   2. Procedural rig: build a bone hierarchy from scratch (basic geometric shapes)
 */

import * as THREE from 'three';
import type { LimbPose } from './CharacterEntity';

/** Bone definition: name, local position, parent. */
export interface BoneSpec {
  name: string;
  parent: string | null;
  pos: [number, number, number]; // local offset from parent
  size?: [number, number, number]; // optional geometry size (for procedural rigs)
}

/** A rigged character: bones + skinned mesh (if loaded from GLTF). */
export interface RiggedCharacter {
  root: THREE.Bone;
  bones: Map<string, THREE.Bone>;
  skeleton: THREE.Skeleton;
  mesh?: THREE.SkinnedMesh; // loaded from GLTF; null if procedural
  group: THREE.Group; // root transform
}

/**
 * Default mushroom rig: head, body, 2 legs, 2 arms.
 * This is the PROCEDURAL blueprint; GLTF rigs override with their own skeleton.
 */
const MUSHROOM_RIG_SPEC: BoneSpec[] = [
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'body', parent: 'root', pos: [0, 0.3, 0], size: [0.3, 0.6, 0.3] },
  { name: 'head', parent: 'body', pos: [0, 0.4, 0], size: [0.25, 0.35, 0.25] },

  { name: 'leg_L', parent: 'body', pos: [-0.15, -0.3, 0], size: [0.15, 0.4, 0.15] },
  { name: 'leg_R', parent: 'body', pos: [0.15, -0.3, 0], size: [0.15, 0.4, 0.15] },

  { name: 'arm_L', parent: 'body', pos: [-0.25, 0.15, 0], size: [0.12, 0.5, 0.12] },
  { name: 'arm_R', parent: 'body', pos: [0.25, 0.15, 0], size: [0.12, 0.5, 0.12] },

  { name: 'hand_L', parent: 'arm_L', pos: [0, -0.25, 0], size: [0.1, 0.15, 0.1] },
  { name: 'hand_R', parent: 'arm_R', pos: [0, -0.25, 0], size: [0.1, 0.15, 0.1] },
];

export class RiggingEngine {
  /** Build a procedural rig from bone specs. */
  static buildProceduralRig(specs: BoneSpec[] = MUSHROOM_RIG_SPEC): RiggedCharacter {
    const bones = new Map<string, THREE.Bone>();
    const boneArray: THREE.Bone[] = [];

    // Create all bones first.
    for (const spec of specs) {
      const bone = new THREE.Bone();
      bone.name = spec.name;
      bone.position.fromArray(spec.pos);
      bones.set(spec.name, bone);
      boneArray.push(bone);
    }

    // Link parent-child.
    for (const spec of specs) {
      if (spec.parent) {
        const parent = bones.get(spec.parent);
        if (parent) {
          const child = bones.get(spec.name)!;
          parent.add(child);
        }
      }
    }

    const root = bones.get('root')!;
    const skeleton = new THREE.Skeleton(boneArray);

    // Optionally create a procedural mesh (simple boxes per bone).
    const group = new THREE.Group();
    for (const spec of specs) {
      if (spec.size) {
        const [w, h, d] = spec.size;
        const geo = new THREE.BoxGeometry(w, h, d);
        const mat = new THREE.MeshPhongMaterial({ color: 0xaa6644, wireframe: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = false;

        const bone = bones.get(spec.name)!;
        bone.add(mesh);
      }
    }

    group.add(root);
    return { root, bones, skeleton, group };
  }

  /**
   * Load a rigged character from a GLTF file.
   * Expects the GLTF to have an armature/skeleton already defined.
   */
  static async loadRiggedGLTF(
    url: string,
    loader: THREE.GLTFLoader,
  ): Promise<RiggedCharacter | null> {
    return new Promise((resolve) => {
      loader.load(
        url,
        (gltf) => {
          const root = gltf.scene;
          const bones = new Map<string, THREE.Bone>();

          // Traverse and collect bones.
          root.traverse((node) => {
            if (node instanceof THREE.Bone) {
              bones.set(node.name, node);
            }
          });

          // Find the skeleton from any skinned mesh.
          let skeleton: THREE.Skeleton | null = null;
          let mesh: THREE.SkinnedMesh | undefined;
          root.traverse((node) => {
            if (node instanceof THREE.SkinnedMesh && !skeleton) {
              mesh = node;
              skeleton = node.skeleton;
            }
          });

          if (!skeleton) {
            console.warn('no skeleton found in GLTF:', url);
            resolve(null);
            return;
          }

          // Find root bone (parent of the armature).
          let rootBone = bones.get('Armature') || bones.get('root');
          if (!rootBone && bones.size > 0) {
            rootBone = Array.from(bones.values())[0];
          }

          const group = new THREE.Group();
          if (rootBone) group.add(rootBone);
          if (mesh) group.add(mesh);

          resolve({
            root: rootBone || new THREE.Bone(),
            bones,
            skeleton,
            mesh,
            group,
          });
        },
        undefined,
        (err) => {
          console.error('failed to load rigged GLTF:', url, err);
          resolve(null);
        },
      );
    });
  }

  /**
   * Apply a LimbPose to a rigged character: rotate bones based on pose values.
   * This is the KEY function that drives animation.
   */
  static applyPose(rig: RiggedCharacter, pose: Partial<LimbPose>): void {
    // Map each pose field to bones + axes.
    const boneRotations: Record<string, { axis: 'x' | 'y' | 'z'; angle: number }[]> = {
      headPitch: [{ bone: 'head', axis: 'x', angle: pose.headPitch ?? 0 }],
      headYaw: [{ bone: 'head', axis: 'y', angle: pose.headYaw ?? 0 }],
      bodyPitch: [{ bone: 'body', axis: 'x', angle: pose.bodyPitch ?? 0 }],
      bodyRoll: [{ bone: 'body', axis: 'z', angle: pose.bodyRoll ?? 0 }],
      bodyYaw: [{ bone: 'body', axis: 'y', angle: pose.bodyYaw ?? 0 }],

      legLPitch: [{ bone: 'leg_L', axis: 'x', angle: pose.legLPitch ?? 0 }],
      legLYaw: [{ bone: 'leg_L', axis: 'y', angle: pose.legLYaw ?? 0 }],
      legRPitch: [{ bone: 'leg_R', axis: 'x', angle: pose.legRPitch ?? 0 }],
      legRYaw: [{ bone: 'leg_R', axis: 'y', angle: pose.legRYaw ?? 0 }],

      armLPitch: [{ bone: 'arm_L', axis: 'x', angle: pose.armLPitch ?? 0 }],
      armLYaw: [{ bone: 'arm_L', axis: 'y', angle: pose.armLYaw ?? 0 }],
      armLRoll: [{ bone: 'arm_L', axis: 'z', angle: pose.armLRoll ?? 0 }],
      armRPitch: [{ bone: 'arm_R', axis: 'x', angle: pose.armRPitch ?? 0 }],
      armRYaw: [{ bone: 'arm_R', axis: 'y', angle: pose.armRYaw ?? 0 }],
      armRRoll: [{ bone: 'arm_R', axis: 'z', angle: pose.armRRoll ?? 0 }],

      handLRotX: [{ bone: 'hand_L', axis: 'x', angle: pose.handLRotX ?? 0 }],
      handLRotY: [{ bone: 'hand_L', axis: 'y', angle: pose.handLRotY ?? 0 }],
      handRRotX: [{ bone: 'hand_R', axis: 'x', angle: pose.handRRotX ?? 0 }],
      handRRotY: [{ bone: 'hand_R', axis: 'y', angle: pose.handRRotY ?? 0 }],
    };

    // Apply each rotation.
    for (const [, rotations] of Object.entries(boneRotations)) {
      for (const { bone: boneName, axis, angle } of rotations) {
        const bone = rig.bones.get(boneName);
        if (!bone) continue;

        // Store quaternion-safe rotations per axis (apply accumulated).
        const q = bone.quaternion;
        const euler = new THREE.Euler().setFromQuaternion(q);
        if (axis === 'x') euler.x = angle;
        if (axis === 'y') euler.y = angle;
        if (axis === 'z') euler.z = angle;
        bone.quaternion.setFromEuler(euler);
      }
    }

    // Mark skeleton for update.
    rig.skeleton.bones.forEach((b) => b.updateMatrixWorld(true));
  }
}
