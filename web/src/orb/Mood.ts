/**
 * The orb's mood — the two-axis light-mood model (RESEARCH_orb_life, GDD §5h).
 *
 *   valence  (−1..1)  : brightness + warmth.  positive = warm gold, safe;
 *                       negative = cold blue, threatened.
 *   arousal  ( 0..1)  : pulse rate + saturation. calm breathes slow and deep;
 *                       alarmed flickers fast and tight.
 *
 * Everything eases — moods LINGER and fade, never snap (emotion is a
 * physics-and-curves system, not canned poses). Events push targets; targets
 * decay back to a resting calm. The mood color paints the orb's aura, its
 * cast light, the fog it breathes through, and its trailing wake — the orb's
 * emotion literally colors the world.
 */

import * as THREE from 'three';

export type MoodEvent = 'joy' | 'fear' | 'effort' | 'hurt';

const REST_VALENCE = 0.15;
const REST_AROUSAL = 0.2;

export class OrbMood {
  valence = REST_VALENCE;
  arousal = REST_AROUSAL;

  /** Current mood color — read every frame by the renderer wiring. */
  readonly color = new THREE.Color(0.42, 0.85, 1.0);
  /** Aura/light brightness multiplier. */
  brightness = 1;
  /** Breath/pulse rate for the orb's living rhythm. */
  pulseRate = 1.6;

  private vTarget = REST_VALENCE;
  private aTarget = REST_AROUSAL;
  private sustain = 0;

  private readonly calm = new THREE.Color(0.42, 0.85, 1.0);
  private readonly warm = new THREE.Color(1.0, 0.8, 0.45);
  private readonly cold = new THREE.Color(0.28, 0.42, 0.95);

  /** A discrete emotional beat. */
  event(e: MoodEvent): void {
    switch (e) {
      case 'joy': // found something, made something
        this.vTarget = 0.9;
        this.aTarget = Math.max(this.aTarget, 0.55);
        this.sustain = 1.3;
        break;
      case 'fear': // the dark surges
        this.vTarget = -0.8;
        this.aTarget = 0.9;
        this.sustain = 2.2;
        break;
      case 'effort': // dash, wave-jump — a spike of arousal, not of mood
        this.aTarget = Math.max(this.aTarget, 0.65);
        this.sustain = Math.max(this.sustain, 0.35);
        break;
      case 'hurt':
        this.vTarget = -0.95;
        this.aTarget = 1;
        this.sustain = 1;
        break;
    }
  }

  /** Continuous pressure (e.g. tide intensity 0..1) — keeps fear alive. */
  setThreat(level: number): void {
    if (level > 0.05) {
      this.vTarget = Math.min(this.vTarget, -0.75 * level);
      this.aTarget = Math.max(this.aTarget, 0.85 * level);
      this.sustain = Math.max(this.sustain, 0.3);
    }
  }

  update(dt: number): void {
    // Events hold their targets briefly, then everything drifts home.
    this.sustain -= dt;
    if (this.sustain <= 0) {
      this.vTarget += (REST_VALENCE - this.vTarget) * Math.min(1, dt * 0.9);
      this.aTarget += (REST_AROUSAL - this.aTarget) * Math.min(1, dt * 0.9);
    }
    // Moods linger: valence eases slower than arousal (feelings outlast reflexes).
    this.valence += (this.vTarget - this.valence) * Math.min(1, dt * 2.6);
    this.arousal += (this.aTarget - this.arousal) * Math.min(1, dt * 4.5);

    // Color: calm cyan → warm gold (positive) or → cold deep blue (negative).
    if (this.valence >= 0) {
      this.color.copy(this.calm).lerp(this.warm, this.valence * 0.85);
    } else {
      this.color.copy(this.calm).lerp(this.cold, -this.valence);
    }
    this.brightness = 0.85 + 0.35 * this.valence + 0.15 * this.arousal;
    this.pulseRate = 1.1 + 2.4 * this.arousal;
  }
}
