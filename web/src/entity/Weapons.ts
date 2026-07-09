/**
 * Weapons — the folk's Reek-grown arsenal. Everything is procedural geometry
 * with dark-game materials: near-black reflective albedo (never 0x000000 —
 * black albedo can't be lit) + a bioluminescent emissive accent, so a weapon
 * reads as a faint living glow in the dark and reveals its shape in the orb's
 * light. No imports, no extra Meshy credits.
 *
 *   glowcap_maul    — a glowcap head on a root handle; overhead slam (melee)
 *   sporespit_puffer— a puffball blunderbuss; lobbed spore-bolt (ranged)
 *   thornreed_lance — a long dark reed, lit thorn tip; coiled thrust (melee)
 *
 * Mounting: hand-bone local frames differ per rig, so a weapon is attached to
 * the hand bone but ORIENTED IN CHARACTER SPACE — its local rotation is the
 * inverse of the hand's rest-pose world rotation. The same mount works on any
 * skeleton Meshy exports; per-weapon grip offsets are then plain char-space
 * numbers that can be nudged live from the Animator UI / console.
 */

import * as THREE from 'three';
import type { SkeletonMap } from './SkeletonMap';

export type WeaponId = 'glowcap_maul' | 'sporespit_puffer' | 'thornreed_lance';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  kind: 'melee' | 'ranged';
  /** Attack clip in folkClips. */
  clip: string;
  /** FX + projectile tint. */
  color: number;
  /** Melee reach (units from the folk) / projectile pop range vs the orb. */
  reach: number;
  /** Char-space grip offset from the hand bone. */
  grip: THREE.Vector3;
  /** Char-space rest orientation (euler) of the weapon. */
  rot: THREE.Euler;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  glowcap_maul: {
    id: 'glowcap_maul',
    name: 'Glowcap Maul',
    kind: 'melee',
    clip: 'attack_maul',
    color: 0x34e8c8,
    reach: 2.3,
    grip: new THREE.Vector3(0, -0.04, 0),
    rot: new THREE.Euler(0, 0, 0),
  },
  sporespit_puffer: {
    id: 'sporespit_puffer',
    name: 'Sporespit Puffer',
    kind: 'ranged',
    clip: 'attack_puffer',
    color: 0xb28aff,
    reach: 26,
    grip: new THREE.Vector3(0, 0, 0.06),
    rot: new THREE.Euler(Math.PI / 2, 0, 0), // barrel forward (char +Z)
  },
  thornreed_lance: {
    id: 'thornreed_lance',
    name: 'Thornreed Lance',
    kind: 'melee',
    clip: 'attack_lance',
    color: 0x9dff5a,
    reach: 3.1,
    grip: new THREE.Vector3(0, -0.1, 0),
    rot: new THREE.Euler(Math.PI / 2, 0, 0), // shaft forward for the thrust
  },
};

/** Dark-game standard material: dim reflective base + optional self-glow. */
function mat(albedo: number, emissive = 0, intensity = 0): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: albedo,
    roughness: 0.88,
    metalness: 0,
    emissive: emissive,
    emissiveIntensity: intensity,
  });
  m.envMapIntensity = 0;
  return m;
}

function buildMaul(): THREE.Group {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.048, 0.52, 6), mat(0x241a12));
  handle.position.y = 0.26;
  // The glowcap head: squashed dome + pale gill ring beneath — the weapon IS
  // one of the world's glowcaps, torn up by the stem.
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 9), mat(0x11302c, 0x34e8c8, 0.85));
  cap.scale.set(1, 0.62, 1);
  cap.position.y = 0.56;
  const gills = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.145, 0.05, 10), mat(0x4a4438, 0xd8ffe8, 0.25));
  gills.position.y = 0.485;
  g.add(handle, cap, gills);
  return g;
}

function buildPuffer(): THREE.Group {
  const g = new THREE.Group();
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.055, 0.46, 6), mat(0x201626));
  stalk.position.y = 0.23;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 9), mat(0x1d1430, 0xb28aff, 0.7));
  ball.position.y = 0.5;
  // Muzzle: a puckered cone the bolts leave from (weapon-local +Y, rotated to
  // char +Z by the mount).
  const muzzle = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.12, 8), mat(0x2a2038, 0xd8c2ff, 0.4));
  muzzle.position.y = 0.66;
  g.add(stalk, ball, muzzle);
  g.userData.muzzleLocal = new THREE.Vector3(0, 0.7, 0); // bolt spawn point
  return g;
}

function buildLance(): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.1, 6), mat(0x141a10));
  shaft.position.y = 0.55;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.2, 7), mat(0x1c260f, 0x9dff5a, 0.9));
  tip.position.y = 1.18;
  g.add(shaft, tip);
  // A few thorns down the shaft, alternating sides.
  for (let i = 0; i < 4; i++) {
    const thorn = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.075, 5), mat(0x1c260f, 0x9dff5a, 0.35));
    const a = (i / 4) * Math.PI * 2 + 0.6;
    thorn.position.set(Math.cos(a) * 0.032, 0.35 + i * 0.18, Math.sin(a) * 0.032);
    thorn.rotation.z = -Math.cos(a) * 1.2;
    thorn.rotation.x = Math.sin(a) * 1.2;
    g.add(thorn);
  }
  g.userData.tipLocal = new THREE.Vector3(0, 1.25, 0); // strike-FX emission point
  return g;
}

const BUILDERS: Record<WeaponId, () => THREE.Group> = {
  glowcap_maul: buildMaul,
  sporespit_puffer: buildPuffer,
  thornreed_lance: buildLance,
};

const _q = new THREE.Quaternion();
const _qDesired = new THREE.Quaternion();

/**
 * Build a weapon and mount it on the RIGHT hand of a rigged folk.
 * Orientation math: hand.restWorld · local = desiredCharRot
 *              →  local = restWorld⁻¹ · desiredCharRot
 * so the weapon sits in a predictable character-space pose no matter what the
 * rig's hand axes look like. Returns null if the rig has no right hand.
 */
export function mountWeapon(skel: SkeletonMap, id: WeaponId): THREE.Group | null {
  const bind = skel.bind('handR');
  if (!bind) return null;
  const def = WEAPONS[id];
  const weapon = BUILDERS[id]();
  weapon.name = `weapon:${id}`;

  // Hand's rest world rotation (char space) = parentRestWorld · restLocal.
  _q.copy(bind.parentRestWorld).multiply(bind.restLocal).invert(); // char → hand-local
  _qDesired.setFromEuler(def.rot);
  weapon.quaternion.copy(_q).multiply(_qDesired);
  weapon.position.copy(def.grip).applyQuaternion(_q); // char-space offset → hand-local

  bind.bone.add(weapon);
  return weapon;
}

/** World position of a weapon's FX point (muzzle/tip), grip as fallback. */
export function weaponFxPoint(weapon: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  const local = (weapon.userData.muzzleLocal ?? weapon.userData.tipLocal ?? null) as THREE.Vector3 | null;
  out.copy(local ?? new THREE.Vector3(0, 0.5, 0));
  return weapon.localToWorld(out);
}
