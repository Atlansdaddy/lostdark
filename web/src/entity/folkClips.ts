/**
 * folkClips — the authored animation library for the mushroom folk.
 *
 * These are first-pass keyframes, deliberately editable: the Animator UI (K)
 * loads any of these as a working copy, John tweaks sliders/keys live, exports
 * JSON, and the export gets baked back into this file. Nothing here is sacred.
 *
 * Conventions (see PoseRig.ts):
 *   • radians everywhere; digits 0..~1.2; root.y in world units
 *   • the folk rest pose is a T-POSE, so every grounded clip starts by
 *     lowering the arms (armX.raise ≈ -1.1 keeps them at the sides)
 *   • + pitch = swing/lean forward · + raise = arm up · + knee = bend
 *   • root.pitch pivots at the FEET: +1.5 ≈ face-plant, -1.5 ≈ fall on back
 */

import { type AnimClip, k, makeCircle, type Key } from './AnimClip';

/** Arms-at-sides constant — a single key = a constant track. */
const ARMS_DOWN_L: Key[] = k(0, -1.12);
const ARMS_DOWN_R: Key[] = k(0, -1.12);

const idle: AnimClip = {
  name: 'idle',
  duration: 3.6,
  loop: true,
  tracks: {
    'armL.raise': k(0, -1.12, 1.8, -1.06, 3.6, -1.12),
    'armR.raise': k(0, -1.12, 1.8, -1.18, 3.6, -1.12),
    'armL.elbow': k(0, 0.12),
    'armR.elbow': k(0, 0.12),
    'armL.digits': k(0, 0.15, 1.8, 0.32, 3.6, 0.15),
    'armR.digits': k(0, 0.2, 2.1, 0.35, 3.6, 0.2),
    // Breathing: chest lifts, whole body rises a hair.
    'body.pitch': k(0, 0.02, 0.9, 0.05, 1.8, 0.02, 2.7, 0.05, 3.6, 0.02),
    'root.y': k(0, 0, 0.9, 0.012, 1.8, 0, 2.7, 0.012, 3.6, 0),
    'body.roll': k(0, 0.015, 1.8, -0.015, 3.6, 0.015),
    // A slow scan of the dark — the folk feel awake, not parked.
    'head.yaw': k(0, 0, 0.8, 0, 1.3, 0.35, 2.0, 0.35, 2.5, -0.28, 3.1, -0.28, 3.6, 0),
    'head.pitch': k(0, 0.03, 1.3, -0.06, 2.5, 0.06, 3.6, 0.03),
  },
};

const walk: AnimClip = {
  name: 'walk',
  duration: 0.95,
  loop: true,
  tracks: {
    // Gait: legs counter-phase; knee bends through the swing phase.
    'legL.pitch': k(0, 0.5, 0.2375, 0.05, 0.475, -0.45, 0.7125, -0.02, 0.95, 0.5),
    'legR.pitch': k(0, -0.45, 0.2375, -0.02, 0.475, 0.5, 0.7125, 0.05, 0.95, -0.45),
    'legL.knee': k(0, 0.1, 0.45, 0.12, 0.62, 0.72, 0.8, 0.32, 0.95, 0.1),
    'legR.knee': k(0, 0.12, 0.14, 0.72, 0.32, 0.32, 0.475, 0.1, 0.95, 0.12),
    'legL.foot': k(0, -0.2, 0.3, 0.25, 0.55, 0.1, 0.95, -0.2),
    'legR.foot': k(0, 0.1, 0.475, -0.2, 0.78, 0.25, 0.95, 0.1),
    // Arms swing opposite their leg, close to the body.
    'armL.pitch': k(0, -0.38, 0.475, 0.38, 0.95, -0.38),
    'armR.pitch': k(0, 0.38, 0.475, -0.38, 0.95, 0.38),
    'armL.raise': ARMS_DOWN_L,
    'armR.raise': ARMS_DOWN_R,
    'armL.elbow': k(0, 0.15, 0.475, 0.3, 0.95, 0.15),
    'armR.elbow': k(0, 0.3, 0.475, 0.15, 0.95, 0.3),
    'armL.digits': k(0, 0.2),
    'armR.digits': k(0, 0.2),
    // Torso: weight shifts over the planted foot + counter-twist. The pair of
    // phased roll/yaw tracks is a shallow hip CIRCLE per stride.
    'body.roll': k(0, 0.055, 0.2375, 0, 0.475, -0.055, 0.7125, 0, 0.95, 0.055),
    'body.yaw': k(0, -0.09, 0.475, 0.09, 0.95, -0.09),
    'body.pitch': k(0, 0.07),
    // Two bobs per cycle — one per footfall.
    'root.y': k(0, 0.008, 0.12, 0.035, 0.2375, 0.008, 0.35, 0.035, 0.475, 0.008, 0.59, 0.035, 0.7125, 0.008, 0.83, 0.035, 0.95, 0.008),
    'head.pitch': k(0, 0.02),
  },
  events: [
    { t: 0.03, type: 'footstep' },
    { t: 0.5, type: 'footstep' },
  ],
};

/** Our own run — Meshy's baked Running clip usually wins, but this keeps the
 *  state machine complete when a rig arrives without one. */
const run: AnimClip = {
  name: 'run',
  duration: 0.55,
  loop: true,
  tracks: {
    'legL.pitch': k(0, 0.85, 0.1375, 0.1, 0.275, -0.7, 0.4125, 0, 0.55, 0.85),
    'legR.pitch': k(0, -0.7, 0.1375, 0, 0.275, 0.85, 0.4125, 0.1, 0.55, -0.7),
    'legL.knee': k(0, 0.15, 0.33, 0.35, 0.42, 1.1, 0.5, 0.5, 0.55, 0.15),
    'legR.knee': k(0, 0.35, 0.14, 1.1, 0.22, 0.5, 0.275, 0.15, 0.55, 0.35),
    'armL.pitch': k(0, -0.7, 0.275, 0.7, 0.55, -0.7),
    'armR.pitch': k(0, 0.7, 0.275, -0.7, 0.55, 0.7),
    'armL.raise': k(0, -1.0),
    'armR.raise': k(0, -1.0),
    'armL.elbow': k(0, 0.9),
    'armR.elbow': k(0, 0.9),
    'armL.digits': k(0, 0.6),
    'armR.digits': k(0, 0.6),
    'body.pitch': k(0, 0.28),
    'body.roll': k(0, 0.05, 0.275, -0.05, 0.55, 0.05),
    'body.yaw': k(0, -0.12, 0.275, 0.12, 0.55, -0.12),
    'root.y': k(0, 0.01, 0.07, 0.06, 0.1375, 0.01, 0.2, 0.01, 0.345, 0.06, 0.4125, 0.01, 0.55, 0.01),
  },
  events: [
    { t: 0.02, type: 'footstep' },
    { t: 0.29, type: 'footstep' },
  ],
};

/** Overhead maul slam. 'strike' = the hit frame (damage + trail + impact FX). */
const attack_maul: AnimClip = {
  name: 'attack_maul',
  duration: 0.85,
  loop: false,
  tracks: {
    'armR.raise': k(0, -1.1, 0.18, 0.35, 0.32, 0.65, 0.5, -0.6, 0.65, -0.9, 0.85, -1.1),
    'armR.pitch': k(0, 0.1, 0.3, -0.5, 0.42, 0.95, 0.6, 0.6, 0.85, 0.1),
    'armR.elbow': k(0, 0.2, 0.3, 0.95, 0.45, 0.12, 0.85, 0.2),
    'armR.wrist.pitch': k(0, 0, 0.3, -0.45, 0.45, 0.5, 0.62, 0.15, 0.85, 0),
    'armR.digits': k(0, 0.95),
    'armL.raise': k(0, -1.1, 0.3, -0.55, 0.5, -0.85, 0.85, -1.1),
    'armL.pitch': k(0, 0, 0.3, -0.35, 0.5, 0.25, 0.85, 0),
    'armL.digits': k(0, 0.5),
    'body.yaw': k(0, 0, 0.3, -0.45, 0.5, 0.4, 0.85, 0),
    'body.pitch': k(0, 0, 0.3, -0.18, 0.5, 0.38, 0.7, 0.15, 0.85, 0),
    'legL.pitch': k(0, 0, 0.3, 0.18, 0.5, 0.3, 0.85, 0),
    'legL.knee': k(0, 0.05, 0.5, 0.25, 0.85, 0.05),
    'legR.pitch': k(0, 0, 0.3, -0.12, 0.5, -0.25, 0.85, 0),
    'legR.knee': k(0, 0.05, 0.5, 0.3, 0.85, 0.05),
    'root.y': k(0, 0, 0.42, 0, 0.52, -0.06, 0.7, -0.02, 0.85, 0),
    'head.pitch': k(0, 0, 0.3, -0.15, 0.5, 0.2, 0.85, 0),
  },
  events: [{ t: 0.42, type: 'strike' }],
};

/** Two-hand spore-gun volley. 'muzzle' = projectile leaves the puffball. */
const attack_puffer: AnimClip = {
  name: 'attack_puffer',
  duration: 0.9,
  loop: false,
  tracks: {
    'armR.pitch': k(0, 0.1, 0.25, 1.25, 0.5, 1.3, 0.58, 1.02, 0.72, 1.2, 0.9, 0.1),
    'armR.raise': k(0, -1.1, 0.25, -0.18, 0.5, -0.12, 0.9, -1.1),
    'armR.elbow': k(0, 0.2, 0.3, 0.38, 0.5, 0.3, 0.9, 0.2),
    'armR.digits': k(0, 0.65),
    'armL.pitch': k(0, 0.1, 0.3, 1.0, 0.5, 1.05, 0.6, 0.85, 0.9, 0.1),
    'armL.raise': k(0, -1.1, 0.3, -0.38, 0.9, -1.1),
    'armL.elbow': k(0, 0.2, 0.3, 0.55, 0.9, 0.2),
    'armL.digits': k(0, 0.65),
    'body.pitch': k(0, 0, 0.35, -0.08, 0.55, 0.18, 0.75, 0.05, 0.9, 0),
    'body.yaw': k(0, 0, 0.3, -0.18, 0.9, 0),
    'head.pitch': k(0, 0, 0.35, -0.06, 0.9, 0),
    'root.y': k(0, 0, 0.5, 0, 0.58, 0.02, 0.7, 0, 0.9, 0),
  },
  events: [{ t: 0.5, type: 'muzzle' }],
};

/** Coiled lance thrust. */
const attack_lance: AnimClip = {
  name: 'attack_lance',
  duration: 0.75,
  loop: false,
  tracks: {
    'armR.pitch': k(0, 0.1, 0.22, -0.65, 0.4, 1.35, 0.55, 1.1, 0.75, 0.1),
    'armR.raise': k(0, -1.1, 0.22, -0.55, 0.4, -0.18, 0.75, -1.1),
    'armR.elbow': k(0, 0.2, 0.22, 1.0, 0.4, 0.05, 0.6, 0.3, 0.75, 0.2),
    'armR.digits': k(0, 1.0),
    'armL.pitch': k(0, 0, 0.22, 0.45, 0.42, -0.3, 0.75, 0),
    'armL.raise': k(0, -1.1, 0.22, -0.8, 0.75, -1.1),
    'body.yaw': k(0, 0, 0.22, 0.5, 0.42, -0.35, 0.75, 0),
    'body.pitch': k(0, 0, 0.22, -0.1, 0.42, 0.3, 0.6, 0.1, 0.75, 0),
    'legL.pitch': k(0, 0, 0.22, 0.1, 0.42, 0.35, 0.75, 0),
    'legL.knee': k(0, 0.05, 0.42, 0.3, 0.75, 0.05),
    'legR.pitch': k(0, 0, 0.42, -0.3, 0.75, 0),
    'root.y': k(0, 0, 0.45, -0.04, 0.65, -0.01, 0.75, 0),
    'head.pitch': k(0, 0, 0.42, 0.08, 0.75, 0),
  },
  events: [{ t: 0.4, type: 'strike' }],
};

/** Damage flinch — played as an ADDITIVE overlay on whatever else runs. */
const flinch: AnimClip = {
  name: 'flinch',
  duration: 0.35,
  loop: false,
  tracks: {
    'body.pitch': k(0, 0, 0.08, -0.24, 0.2, 0.07, 0.35, 0),
    'head.pitch': k(0, 0, 0.08, -0.32, 0.22, 0.06, 0.35, 0),
    'armL.raise': k(0, 0, 0.08, 0.18, 0.25, 0, 0.35, 0),
    'armR.raise': k(0, 0, 0.08, 0.18, 0.25, 0, 0.35, 0),
    'root.y': k(0, 0, 0.08, -0.025, 0.22, 0, 0.35, 0),
  },
};

/** Knocked onto the back: stagger → topple around the heels → bounce → still.
 *  root.pitch is NEGATIVE (feet-pivot, so the head arcs backward to ground). */
const death_back: AnimClip = {
  name: 'death_back',
  duration: 1.5,
  loop: false,
  tracks: {
    'root.pitch': [
      { t: 0, v: 0 },
      { t: 0.25, v: -0.12 },
      { t: 0.8, v: -1.5, e: 'in' },
      { t: 0.95, v: -1.62 },
      { t: 1.1, v: -1.5 },
      { t: 1.5, v: -1.55 },
    ],
    'body.pitch': k(0, 0, 0.15, -0.3, 0.8, -0.1, 1.1, 0.22, 1.5, 0.12),
    'head.pitch': k(0, 0, 0.15, -0.35, 0.9, 0.3, 1.2, -0.1, 1.5, 0),
    'armL.raise': k(0, -1.1, 0.2, 0.45, 0.7, 0.6, 1.1, 0.35, 1.5, 0.3),
    'armR.raise': k(0, -1.1, 0.25, 0.3, 0.7, 0.55, 1.1, 0.4, 1.5, 0.35),
    'armL.pitch': k(0, 0, 0.2, 0.35, 0.8, -0.15, 1.5, -0.1),
    'armR.pitch': k(0, 0, 0.2, -0.3, 0.8, 0.2, 1.5, 0.1),
    'armL.digits': k(0, 0.7, 1.2, 0.12, 1.5, 0.1),
    'armR.digits': k(0, 0.7, 1.2, 0.12, 1.5, 0.1),
    'legL.knee': k(0, 0.05, 0.25, 0.3, 0.8, 0.9, 1.5, 0.85),
    'legR.knee': k(0, 0.05, 0.3, 0.35, 0.8, 0.8, 1.5, 0.8),
    'legL.pitch': k(0, 0, 0.8, 0.25, 1.5, 0.2),
    'legR.pitch': k(0, 0, 0.8, 0.15, 1.5, 0.15),
  },
};

/** Forward crumple: knees give first, drop, then face-plant over the knees. */
const death_fwd: AnimClip = {
  name: 'death_fwd',
  duration: 1.4,
  loop: false,
  tracks: {
    'legL.knee': k(0, 0.05, 0.3, 1.3, 1.4, 1.2),
    'legR.knee': k(0, 0.1, 0.35, 1.35, 1.4, 1.25),
    'root.y': k(0, 0, 0.3, -0.35, 0.6, -0.42, 1.4, -0.45),
    'root.pitch': [
      { t: 0, v: 0 },
      { t: 0.35, v: 0.05 },
      { t: 0.9, v: 1.5, e: 'in' },
      { t: 1.05, v: 1.58 },
      { t: 1.4, v: 1.55 },
    ],
    'body.pitch': k(0, 0.1, 0.3, 0.45, 0.9, 0.2, 1.4, 0.15),
    'armL.pitch': k(0, 0, 0.4, 0.9, 0.9, 1.1, 1.2, 0.3, 1.4, 0.25),
    'armR.pitch': k(0, 0, 0.4, 0.9, 0.9, 1.1, 1.2, 0.3, 1.4, 0.25),
    'armL.raise': k(0, -1.1, 0.5, -0.4, 1.0, -0.25, 1.4, -0.5),
    'armR.raise': k(0, -1.1, 0.5, -0.4, 1.0, -0.25, 1.4, -0.5),
    'armL.elbow': k(0, 0.1, 0.9, 0.4, 1.2, 0.05),
    'armR.elbow': k(0, 0.1, 0.9, 0.4, 1.2, 0.05),
    'armL.digits': k(0, 0.6, 1.2, 0.1),
    'armR.digits': k(0, 0.6, 1.2, 0.1),
    'head.pitch': k(0, 0, 0.9, -0.4, 1.2, 0.1, 1.4, 0.05),
  },
};

/** Friendly wave — a wrist/digit articulation showcase that reads at a glance. */
const wave: AnimClip = {
  name: 'wave',
  duration: 2.4,
  loop: true,
  tracks: {
    'armR.raise': k(0, -1.1, 0.4, 0.9, 2.0, 0.9, 2.4, -1.1),
    'armR.elbow': k(0, 0.2, 0.4, 0.55, 2.0, 0.55, 2.4, 0.2),
    'armR.wrist.yaw': k(0.4, 0, 0.7, -0.45, 1.0, 0.45, 1.3, -0.45, 1.6, 0.45, 1.9, 0, 2.4, 0),
    'armR.digits': k(0, 0.2, 0.5, 0.05, 2.4, 0.2),
    'armL.raise': ARMS_DOWN_L,
    'head.roll': k(0, 0, 0.5, 0.14, 2.0, 0.14, 2.4, 0),
    'body.roll': k(0, 0, 0.5, 0.07, 2.0, 0.07, 2.4, 0),
  },
};

/**
 * The examine reel: every articulation group swept through its range, one at
 * a time, with circular patterns for head, body, each leg, each arm and each
 * wrist — John's "watch every joint do its thing" clip. Built procedurally so
 * segment timing stays consistent as channels get added.
 */
function makeCalibrate(): AnimClip {
  const tracks: Record<string, Key[]> = {};
  const SEG = 1.15; // seconds per demo segment
  const GAP = 0.2; // rest between segments
  let t = 0.15;

  const sweep = (ch: string, amp: number, lo?: number): void => {
    const min = lo ?? -amp;
    const keys = tracks[ch] ?? (tracks[ch] = []);
    keys.push({ t, v: 0 }, { t: t + SEG * 0.25, v: amp }, { t: t + SEG * 0.7, v: min }, { t: t + SEG, v: 0 });
    t += SEG + GAP;
  };
  const circle = (chA: string, chB: string, amp: number): void => {
    // Ramp in/out so the circle starts and ends at rest.
    const keysA = tracks[chA] ?? (tracks[chA] = []);
    keysA.push({ t: t - 0.01, v: 0 }); // hold zero until the segment starts
    makeCircle(tracks, chA, chB, amp, SEG, { t0: t, cycles: 2 });
    const kA = tracks[chA];
    const kB = tracks[chB];
    kA.push({ t: t + SEG + 0.12, v: 0 });
    kB.push({ t: t + SEG + 0.12, v: 0 });
    t += SEG + GAP + 0.12;
  };

  // Keep the arms parked while the non-arm groups demo (single leading key
  // would hold -1.12 for the entire clip — so release them before arm demos).
  const armsDownUntil = (until: number): void => {
    tracks['armL.raise'] = k(0, -1.12, until, -1.12, until + 0.4, 0);
    tracks['armR.raise'] = k(0, -1.12, until, -1.12, until + 0.4, 0);
  };

  sweep('head.pitch', 0.6); // nod
  sweep('head.yaw', 0.9); // shake
  circle('head.pitch', 'head.yaw', 0.45); // head roll
  sweep('body.pitch', 0.5); // hip fore/back
  sweep('body.roll', 0.5); // hip side/side
  sweep('body.yaw', 0.7); // hip twist
  circle('body.pitch', 'body.roll', 0.35); // hip circle
  sweep('legL.pitch', 0.7); // leg swings
  sweep('legL.spread', 0.5);
  circle('legL.pitch', 'legL.spread', 0.45); // leg circle
  circle('legR.pitch', 'legR.spread', 0.45);
  sweep('legL.knee', 1.4, 0); // knees (one-sided range)
  sweep('legR.knee', 1.4, 0);

  const armStart = t;
  sweep('armL.pitch', 0.9);
  sweep('armL.raise', 0.8);
  circle('armL.pitch', 'armL.raise', 0.55); // arm windmill
  circle('armR.pitch', 'armR.raise', 0.55);
  sweep('armL.elbow', 1.8, 0);
  sweep('armR.elbow', 1.8, 0);
  sweep('armL.wrist.pitch', 0.8);
  circle('armL.wrist.pitch', 'armL.wrist.yaw', 0.55); // wrist circles
  circle('armR.wrist.pitch', 'armR.wrist.yaw', 0.55);
  sweep('armL.digits', 1.1, 0); // finger curls
  sweep('armR.digits', 1.1, 0);
  armsDownUntil(armStart - GAP);

  return { name: 'calibrate', duration: t + 0.3, loop: true, tracks };
}

/** Baked-in library. The Animator UI overlays localStorage edits on top. */
export function builtinClips(): Record<string, AnimClip> {
  const list = [idle, walk, run, attack_maul, attack_puffer, attack_lance, flinch, death_back, death_fwd, wave, makeCalibrate()];
  return Object.fromEntries(list.map((c) => [c.name, c]));
}
