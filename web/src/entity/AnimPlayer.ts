/**
 * AnimPlayer — clip playback + blending for one rigged character.
 *
 * Two animation SYSTEMS feed the same skeleton:
 *   • POSE clips — our channel keyframes (AnimClip) applied through PoseRig.
 *   • GLTF clips — baked THREE.AnimationClips that ship inside the Meshy rig
 *     (walking/running), played through a THREE.AnimationMixer and addressed
 *     by the name prefix "gltf:".
 *
 * Pose→pose transitions crossfade in CHANNEL space (cheap, always smooth).
 * System switches (pose↔gltf) crossfade in BONE space: snapshot every local
 * quat at the switch and slerp from the snapshot to the new system's output
 * for a beat — so toggling walk (gltf) → attack (pose) never pops.
 *
 * OVERLAYS are additive pose clips (damage flinch) stacked on whatever the
 * base is doing, with a weight envelope so they fade in/out cleanly. The
 * owner can also pass per-frame additive channels (head-look at the orb).
 */

import * as THREE from 'three';
import { type AnimClip, crossedEvents, sampleClip } from './AnimClip';
import type { Pose, PoseRig, RigSnapshot } from './PoseRig';

const SYSTEM_FADE = 0.22; // seconds for the bone-space snapshot crossfade

interface PoseInstance {
  clip: AnimClip;
  time: number;
  speed: number;
  /** One-shot end already reported? (holds last frame after). */
  ended: boolean;
}

interface Overlay {
  clip: AnimClip;
  time: number;
  weight: number;
}

export class AnimPlayer {
  private rig: PoseRig;
  /** Live clip registry — a getter so Animator-UI edits apply immediately. */
  private clips: () => Record<string, AnimClip>;
  private mixer: THREE.AnimationMixer | null;
  private gltfClips = new Map<string, THREE.AnimationClip>();
  private gltfAction: THREE.AnimationAction | null = null;

  private cur: PoseInstance | null = null;
  private prev: PoseInstance | null = null;
  private fade = 0; // 0..1 progress of prev→cur crossfade
  private fadeTime = 0.18;

  private system: 'pose' | 'gltf' = 'pose';
  private curGltfName: string | null = null;
  private sysSnap: RigSnapshot | null = null;
  private sysBlend = 1; // 1 = fully on the new system

  private overlays: Overlay[] = [];
  private eventCbs: ((type: string) => void)[] = [];
  private endCbs: ((clipName: string) => void)[] = [];

  /** Editor hooks: pause playback + scrub the base clip by hand. */
  paused = false;

  constructor(
    rig: PoseRig,
    clips: () => Record<string, AnimClip>,
    mixerRoot?: THREE.Object3D,
    gltfAnimations?: THREE.AnimationClip[],
  ) {
    this.rig = rig;
    this.clips = clips;
    this.mixer = mixerRoot && gltfAnimations?.length ? new THREE.AnimationMixer(mixerRoot) : null;
    for (const c of gltfAnimations ?? []) this.gltfClips.set(c.name, c);
  }

  /** Names playable on this character: pose clips + "gltf:" baked clips. */
  availableClips(): string[] {
    const out = Object.keys(this.clips());
    for (const name of this.gltfClips.keys()) out.push(`gltf:${name}`);
    return out;
  }

  /** First baked clip whose name matches (Meshy ships "Walking"/"Running",
   *  but exporter capitalization drifts — match, don't hard-code). */
  findGltf(re: RegExp): string | null {
    for (const name of this.gltfClips.keys()) if (re.test(name)) return `gltf:${name}`;
    return null;
  }

  currentName(): string | null {
    if (this.system === 'gltf') return this.curGltfName;
    return this.cur?.clip.name ?? null;
  }

  /** Duration of the active base clip (editor timeline). */
  duration(): number {
    if (this.system === 'gltf') {
      return this.gltfAction?.getClip().duration ?? 0;
    }
    return this.cur?.clip.duration ?? 0;
  }

  time(): number {
    if (this.system === 'gltf') return this.gltfAction?.time ?? 0;
    return this.cur?.time ?? 0;
  }

  /** Scrub the base clip to an absolute time (editor). */
  scrub(t: number): void {
    if (this.system === 'gltf') {
      if (this.gltfAction) {
        this.gltfAction.time = Math.max(0, Math.min(t, this.gltfAction.getClip().duration));
        this.mixer?.update(0);
      }
      return;
    }
    if (this.cur) {
      this.cur.time = Math.max(0, Math.min(t, this.cur.clip.duration));
      this.cur.ended = false;
    }
  }

  onEvent(cb: (type: string) => void): void {
    this.eventCbs.push(cb);
  }

  onEnd(cb: (clipName: string) => void): void {
    this.endCbs.push(cb);
  }

  /**
   * Play a base clip by name. "gltf:Walking" routes to the mixer; everything
   * else must exist in the clip registry. Returns false if the name is
   * unknown (caller falls back — e.g. run → walk).
   */
  play(name: string, opts: { fade?: number; speed?: number; restart?: boolean } = {}): boolean {
    const { fade = 0.18, speed = 1, restart = false } = opts;

    if (name.startsWith('gltf:')) {
      const clip = this.gltfClips.get(name.slice(5));
      if (!clip || !this.mixer) return false;
      if (this.system === 'gltf' && this.curGltfName === name && !restart) {
        if (this.gltfAction) this.gltfAction.timeScale = speed;
        return true;
      }
      // Bone-space snapshot BEFORE the mixer takes over.
      this.sysSnap = this.rig.snapshot();
      this.sysBlend = 0;
      this.gltfAction?.stop();
      this.gltfAction = this.mixer.clipAction(clip);
      this.gltfAction.reset();
      this.gltfAction.setLoop(THREE.LoopRepeat, Infinity);
      this.gltfAction.timeScale = speed;
      this.gltfAction.play();
      this.system = 'gltf';
      this.curGltfName = name;
      this.cur = null;
      this.prev = null;
      return true;
    }

    const clip = this.clips()[name];
    if (!clip) return false;

    if (this.system === 'pose' && this.cur?.clip.name === name && !restart) {
      this.cur.speed = speed;
      return true;
    }

    if (this.system === 'gltf') {
      // Leaving the mixer: snapshot bones, kill the action, fade to pose.
      this.sysSnap = this.rig.snapshot();
      this.sysBlend = 0;
      this.gltfAction?.stop();
      this.gltfAction = null;
      this.curGltfName = null;
      this.system = 'pose';
      this.prev = null;
      this.cur = { clip, time: 0, speed, ended: false };
      return true;
    }

    // Pose→pose: channel-space crossfade.
    this.prev = this.cur;
    this.cur = { clip, time: 0, speed, ended: false };
    this.fade = 0;
    this.fadeTime = Math.max(0.01, fade);
    return true;
  }

  /** Stack an additive overlay (flinch). Restarts if already active. */
  playOverlay(name: string, weight = 1): void {
    const clip = this.clips()[name];
    if (!clip) return;
    const existing = this.overlays.find((o) => o.clip.name === name);
    if (existing) {
      existing.time = 0;
      existing.weight = weight;
      return;
    }
    this.overlays.push({ clip, time: 0, weight });
  }

  /**
   * Advance + apply to the skeleton. `extraAdd` are additive channels the
   * owner computes per frame (head-look). While `paused`, time stands still
   * but the CURRENT pose still applies — that's what makes scrubbing work.
   */
  update(dt: number, extraAdd?: Pose): void {
    const step = this.paused ? 0 : dt;

    if (this.system === 'gltf') {
      this.mixer?.update(step);
      // Overlays + procedural adds still run over the mixer output.
      if (this.overlays.length || (extraAdd && Object.keys(extraAdd).length)) {
        const pose = this.samplePoseLayers(step, {}, extraAdd);
        this.rig.apply(pose);
      }
    } else if (this.cur) {
      const c = this.cur;
      const prevT = c.time;
      c.time += step * c.speed;
      // One-shot end: report once, then hold the final frame.
      if (!c.clip.loop && !c.ended && c.time >= c.clip.duration) {
        c.time = c.clip.duration;
        c.ended = true;
        for (const cb of this.endCbs) cb(c.clip.name);
      }
      // Events fire only off the active clip (not the fading one).
      if (step > 0) {
        for (const ev of crossedEvents(c.clip, prevT, c.time)) {
          for (const cb of this.eventCbs) cb(ev.type);
        }
      }

      this.fade = Math.min(1, this.fade + (step > 0 ? dt : 0) / this.fadeTime);
      const base: Pose = {};
      if (this.prev && this.fade < 1) {
        if (!this.paused) this.prev.time += dt * this.prev.speed;
        const w = 1 - this.fade;
        sampleClip(this.prev.clip, this.prev.time, base, this.smooth(w));
        sampleClip(c.clip, c.time, base, this.smooth(this.fade));
      } else {
        this.prev = null;
        sampleClip(c.clip, c.time, base, 1);
      }

      const pose = this.samplePoseLayers(step, base, extraAdd);
      this.rig.apply(pose);
    }

    // Bone-space crossfade after a system switch.
    if (this.sysBlend < 1 && this.sysSnap) {
      this.sysBlend = Math.min(1, this.sysBlend + dt / SYSTEM_FADE);
      this.rig.blendFromSnapshot(this.sysSnap, this.smooth(this.sysBlend));
      if (this.sysBlend >= 1) this.sysSnap = null;
    }
  }

  /** Overlays (with fade envelopes) + per-frame additive channels. */
  private samplePoseLayers(step: number, base: Pose, extraAdd?: Pose): Pose {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const o = this.overlays[i];
      o.time += step;
      if (o.time >= o.clip.duration && !o.clip.loop) {
        this.overlays.splice(i, 1);
        continue;
      }
      // Envelope: quick fade-in, fade-out over the last 20%.
      const u = o.time / o.clip.duration;
      const env = Math.min(1, o.time / 0.05) * (u > 0.8 ? (1 - u) / 0.2 : 1);
      sampleClip(o.clip, o.time, base, o.weight * env);
    }
    if (extraAdd) {
      for (const [ch, v] of Object.entries(extraAdd)) {
        if (v !== 0) base[ch] = (base[ch] ?? 0) + v;
      }
    }
    return base;
  }

  private smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }
}
