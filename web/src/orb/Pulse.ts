/**
 * The echolocation pulse — the signature verb (GDD §8a step 1).
 *
 * A pulse is an expanding spherical shell fired from where the orb stood. It
 * travels outward, briefly lighting whatever surface it washes over, then fades.
 * Multiple can be in flight; the shader shows the strongest at each point.
 * The ambient auto-pulse (SPEC §2, ~1.6s cadence) reuses the same mechanism.
 */

import * as THREE from 'three';
import { Light } from '../config';

export class PulseWave {
  radius = 0;
  intensity: number = Light.pulse.intensity;
  readonly center = new THREE.Vector3();
  dead = false;

  constructor(center: THREE.Vector3) {
    this.center.copy(center);
  }

  update(dt: number): void {
    this.radius += Light.pulse.speed * dt;
    // Fade as it expands — spent energy thinning over a growing shell.
    const t = this.radius / Light.pulse.maxRadius;
    this.intensity = Light.pulse.intensity * Math.max(0, 1 - t);
    if (this.radius >= Light.pulse.maxRadius) this.dead = true;
  }
}

export class PulseSystem {
  waves: PulseWave[] = [];
  private ambientTimer = 0;
  private static AMBIENT_CADENCE = 1.6; // SPEC §2

  /** Manual pulse — the player fired one. */
  fire(center: THREE.Vector3): void {
    this.waves.push(new PulseWave(center));
  }

  update(dt: number, orbPos: THREE.Vector3): void {
    // Gentle ambient auto-pulse so you're never fully blind between manual ones.
    this.ambientTimer += dt;
    if (this.ambientTimer >= PulseSystem.AMBIENT_CADENCE) {
      this.ambientTimer = 0;
      const w = new PulseWave(orbPos);
      w.intensity = Light.pulse.intensity * 0.5; // softer than a manual pulse
      this.waves.push(w);
    }

    for (const w of this.waves) w.update(dt);
    this.waves = this.waves.filter((w) => !w.dead);
    // Keep the flight list bounded.
    if (this.waves.length > 8) this.waves.splice(0, this.waves.length - 8);
  }

  /** The pulse the shader should render (strongest / most recent in flight). */
  strongest(): PulseWave | null {
    let best: PulseWave | null = null;
    for (const w of this.waves) {
      if (!best || w.intensity > best.intensity) best = w;
    }
    return best;
  }
}
