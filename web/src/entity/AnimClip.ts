/**
 * AnimClip — keyframed channel animation, JSON-serializable.
 *
 * A clip is a set of per-channel keyframe tracks over PoseRig channels (see
 * PoseRig.ts for the channel vocabulary). Clips are plain data: the Animator
 * UI edits them live, exports them as JSON, and the baked-in library
 * (folkClips.ts) is just the same data checked into source.
 *
 * Sampling is CYCLIC for looping clips — the gap between the last key and the
 * first key (across the wrap) interpolates smoothly, so a loop never pops.
 * Events (strike / muzzle / footstep) fire as the playhead crosses their time.
 */

export type Ease = 'smooth' | 'linear' | 'in' | 'out';

export interface Key {
  t: number; // seconds from clip start
  v: number;
  e?: Ease; // easing INTO this key (default 'smooth')
}

export interface ClipEvent {
  t: number;
  type: string; // 'strike' | 'muzzle' | 'footstep' | anything a listener wants
}

export interface AnimClip {
  name: string;
  duration: number; // seconds
  loop: boolean;
  tracks: Record<string, Key[]>; // channel → sorted keys
  events?: ClipEvent[];
}

function ease(t: number, kind: Ease | undefined): number {
  switch (kind) {
    case 'linear':
      return t;
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    default:
      return t * t * (3 - 2 * t); // smoothstep
  }
}

/**
 * Sample one track at time `time` (already wrapped into [0, duration)).
 * Looping clips interpolate across the wrap; one-shots clamp at the ends.
 */
function sampleTrack(keys: Key[], time: number, duration: number, loop: boolean): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1) return keys[0].v;

  if (time <= keys[0].t) {
    if (!loop) return keys[0].v;
    // Wrap segment: last key → (first key + duration).
    const a = keys[n - 1];
    const b = keys[0];
    const span = duration - a.t + b.t;
    if (span <= 1e-6) return b.v;
    const u = (time + duration - a.t) / span;
    return a.v + (b.v - a.v) * ease(u, b.e);
  }
  if (time >= keys[n - 1].t) {
    if (!loop) return keys[n - 1].v;
    const a = keys[n - 1];
    const b = keys[0];
    const span = duration - a.t + b.t;
    if (span <= 1e-6) return a.v;
    const u = (time - a.t) / span;
    return a.v + (b.v - a.v) * ease(u, b.e);
  }
  // Binary search would be overkill — tracks hold a handful of keys.
  for (let i = 0; i < n - 1; i++) {
    if (time >= keys[i].t && time <= keys[i + 1].t) {
      const a = keys[i];
      const b = keys[i + 1];
      const span = b.t - a.t;
      if (span <= 1e-6) return b.v;
      const u = (time - a.t) / span;
      return a.v + (b.v - a.v) * ease(u, b.e);
    }
  }
  return keys[n - 1].v;
}

/** Sample every track into `out` (accumulating: out[ch] += value·weight). */
export function sampleClip(clip: AnimClip, time: number, out: Record<string, number>, weight = 1): void {
  const t = clip.loop
    ? ((time % clip.duration) + clip.duration) % clip.duration
    : Math.min(Math.max(time, 0), clip.duration);
  for (const [ch, keys] of Object.entries(clip.tracks)) {
    const v = sampleTrack(keys, t, clip.duration, clip.loop);
    out[ch] = (out[ch] ?? 0) + v * weight;
  }
}

/** Events whose time was crossed moving prevT → newT (loop-aware). */
export function crossedEvents(clip: AnimClip, prevT: number, newT: number): ClipEvent[] {
  if (!clip.events?.length) return [];
  const out: ClipEvent[] = [];
  if (!clip.loop) {
    for (const ev of clip.events) if (ev.t > prevT && ev.t <= newT) out.push(ev);
    return out;
  }
  const d = clip.duration;
  const a = ((prevT % d) + d) % d;
  const b = ((newT % d) + d) % d;
  for (const ev of clip.events) {
    const crossed = a <= b ? ev.t > a && ev.t <= b : ev.t > a || ev.t <= b; // wrapped
    if (crossed) out.push(ev);
  }
  return out;
}

// --- Authoring helpers (used by folkClips.ts and nothing else hot) ---------

/** Shorthand key list: k(0,0.5, 0.3,-0.5, ...) → [{t,v},...] */
export function k(...tv: number[]): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i + 1 < tv.length; i += 2) keys.push({ t: tv[i], v: tv[i + 1] });
  return keys;
}

/**
 * Circular motion: drive chA with cos and chB with sin over `duration` —
 * two channels 90° out of phase = the limb tip traces a circle. This is the
 * building block for head rolls, hip circles, leg/arm/wrist circles.
 */
export function makeCircle(
  tracks: Record<string, Key[]>,
  chA: string,
  chB: string,
  amp: number,
  duration: number,
  opts: { phase?: number; t0?: number; cycles?: number } = {},
): void {
  const { phase = 0, t0 = 0, cycles = 1 } = opts;
  const STEPS = 8 * cycles; // 8 keys/cycle ≈ circle within 1% with smoothstep
  const a: Key[] = tracks[chA] ?? (tracks[chA] = []);
  const b: Key[] = tracks[chB] ?? (tracks[chB] = []);
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS;
    const ang = phase + u * Math.PI * 2 * cycles;
    const t = t0 + u * duration;
    a.push({ t, v: Math.cos(ang) * amp, e: 'linear' });
    b.push({ t, v: Math.sin(ang) * amp, e: 'linear' });
  }
}

/** Deep-clone a clip (the Animator UI's duplicate/edit-working-copy). */
export function cloneClip(clip: AnimClip, newName?: string): AnimClip {
  return {
    name: newName ?? clip.name,
    duration: clip.duration,
    loop: clip.loop,
    tracks: Object.fromEntries(
      Object.entries(clip.tracks).map(([ch, keys]) => [ch, keys.map((key) => ({ ...key }))]),
    ),
    events: clip.events?.map((ev) => ({ ...ev })),
  };
}
