/**
 * Haptics — per-verb vibration feedback for touch play (GDD §2 cross-platform).
 *
 * Each of the orb's verbs gets its own short signature so the phone *speaks* the
 * action back to the thumb: a crisp tick when a pulse leaves, a thump on a
 * wave-jump, a snap on a dash, a two-beat confirm when a ward seats, and a low
 * rolling rumble when a Dark Tide arrives. Patterns are deliberately terse —
 * constant buzzing feels cheap; these are punctuation, not a soundtrack.
 *
 * Platform reality (honest): `navigator.vibrate` is Android/Chromium only.
 * iOS/iPadOS Safari has NO web vibration at all, so on the iPad every call here
 * silently no-ops — feature-detected once, never throws. The visual/audio game
 * is unchanged there; only the buzz is missing.
 *
 * Off switch: persisted in localStorage['waiver.haptics'] ('off' disables),
 * default on. Menu can flip it via `haptics.enabled = false`.
 */

import { logger } from './log';

const log = logger('haptics');
const STORE_KEY = 'waiver.haptics';

type Pattern = number | number[];

/** Signature vibration per verb. The thumb reads *rhythm* (how many buzzes and
 *  how long), not milliseconds — a phone motor needs ~20ms just to spin up, so
 *  16 vs 22ms feel identical. These are deliberately far apart in COUNT and
 *  LENGTH so each verb is unmistakable: 1-short · 1-long · 2-fast · 3-rising ·
 *  long-rolling. Tune the numbers live if any still blur together. */
const SIGNATURES = {
  pulse: 25, //           ONE crisp tap — the wave leaving the orb
  jump: 60, //            ONE heavy thump, clearly longer than a pulse
  dash: [18, 45, 18], //  TWO fast staccato hits — a blink that snaps
  ward: [30, 45, 40, 45, 75], // THREE rising beats — the anchor seating home
  tide: [160, 80, 160, 80, 280], // a long ominous roll — dread before you see it
  land: 14, //            the faintest tap — weight touching down (used sparingly)
} satisfies Record<string, Pattern>;

export type HapticVerb = keyof typeof SIGNATURES;

class Haptics {
  /** True only where the browser actually exposes vibration (Android/Chromium). */
  readonly supported: boolean =
    typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  private _enabled: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORE_KEY);
    } catch (err) {
      log.trace('localStorage unavailable — haptics default on', err);
    }
    this._enabled = stored !== 'off';
    if (!this.supported) log.debug('web vibration unsupported here (iOS/desktop) — haptics inert');
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(on: boolean) {
    this._enabled = on;
    try {
      localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch (err) {
      log.trace('could not persist haptics preference', err);
    }
    if (!on) this.stop();
  }

  /** Fire a verb's signature. Cheap and safe to call every time it happens. */
  fire(verb: HapticVerb): void {
    if (!this.supported || !this._enabled) return;
    try {
      navigator.vibrate(SIGNATURES[verb]);
    } catch (err) {
      // A malformed pattern or a locked-down embed can throw — never let a buzz
      // take down a frame.
      log.throttle('vibrate-fail', 5000, 'trace', 'vibrate() threw', err);
    }
  }

  /** Cancel any ongoing vibration (e.g. when muting or pausing). */
  stop(): void {
    if (!this.supported) return;
    try {
      navigator.vibrate(0);
    } catch (err) {
      log.trace('vibrate(0) threw', err);
    }
  }
}

/** Shared instance — the whole app talks to one haptics surface. */
export const haptics = new Haptics();
