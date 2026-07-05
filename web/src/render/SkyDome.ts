/**
 * Night sky over The Reek — cloudy, star-pocketed, moon-cycled.
 *
 * A camera-following dome (BackSide) shaded procedurally:
 *   · deep night gradient, horizon → zenith
 *   · scrolling 3-octave cloud field; stars live ONLY in the clear pockets
 *   · a moon with a slow orbit and a phase cycle (dark-disc bite), haloed,
 *     silvering the cloud edges near it
 *
 * The SAME cloud math runs on the CPU (cloudCoverAt) so gameplay knows when
 * the moon breaks through — main.ts turns that into real moonlight on the
 * world. Sky and lighting can't disagree: one formula, two runtimes.
 */

import * as THREE from 'three';

/** CPU mirror of the shader's cloud field. Keep in lockstep with GLSL. */
function hash21(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const fy = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
  const a = hash21(xi, yi);
  const b = hash21(xi + 1, yi);
  const c = hash21(xi, yi + 1);
  const d = hash21(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function cloudFbm(x: number, y: number): number {
  return vnoise2(x, y) * 0.55 + vnoise2(x * 2.1, y * 2.1) * 0.28 + vnoise2(x * 4.4, y * 4.4) * 0.17;
}

/** Cloud coverage (0 clear → 1 covered) along a sky direction at time t. */
export function cloudCoverAt(dir: THREE.Vector3, t: number): number {
  if (dir.y <= 0.02) return 1;
  const cx = (dir.x / (dir.y + 0.45)) * 1.6 + t * 0.012;
  const cz = (dir.z / (dir.y + 0.45)) * 1.6 + t * 0.007;
  const cl = cloudFbm(cx, cz);
  const m = (cl - 0.48) / 0.14; // smoothstep window, mirrored in GLSL
  return Math.max(0, Math.min(1, m * m * (3 - 2 * Math.max(0, Math.min(1, m)))));
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private uniforms = {
    uTime: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() },
    uBiteDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() },
    uMoonBright: { value: 1.0 },
    // Dark Tide: 1 = normal night, →0 = the sky itself is smothered black.
    uDark: { value: 1.0 },
  };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform vec3 uMoonDir;
        uniform vec3 uBiteDir;
        uniform float uMoonBright;
        uniform float uDark;
        varying vec3 vDir;

        float hash21(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return a + (b - a) * f.x + (c - a) * f.y + (a - b - c + d) * f.x * f.y;
        }
        float cloudFbm(vec2 p) {
          return vnoise2(p) * 0.55 + vnoise2(p * 2.1) * 0.28 + vnoise2(p * 4.4) * 0.17;
        }

        // Domain-warped clouds → fluffy billows instead of smear.
        float clouds(vec2 p) {
          vec2 w = vec2(cloudFbm(p * 0.5 + 3.7), cloudFbm(p * 0.5 + 8.1));
          return cloudFbm(p + w * 1.4);
        }

        void main() {
          vec3 dir = normalize(vDir);
          float up = clamp(dir.y, 0.0, 1.0);

          // Night gradient: faint teal-charcoal horizon sinking into black.
          // Kept dim — the vault reads as deep night, not a lit dome.
          vec3 sky = mix(vec3(0.011, 0.017, 0.027), vec3(0.001, 0.002, 0.006), pow(up, 0.55));

          float md = dot(dir, uMoonDir);

          // ---- Painted stars: three size tiers + a faint galactic band ----
          // Each cell that wins the hash lottery gets ONE round point: a
          // jittered centre inside the cell + a smooth radial falloff, so
          // stars read as soft dots instead of filled grid squares.
          vec3 stars = vec3(0.0);
          for (int t = 0; t < 3; t++) {
            float scale = 120.0 + float(t) * 130.0;
            vec3 g = dir * scale;
            vec3 sp = floor(g);
            float h = hash21(sp.xz * 1.7 + sp.y * 13.7);
            float thresh = 0.9975 - float(t) * 0.0004;
            if (h > thresh) {
              float mag = (h - thresh) / (1.0 - thresh);
              // Jitter the star off the cell centre so it isn't grid-locked.
              vec3 jit = vec3(hash21(sp.xz + 1.3), hash21(sp.yz + 4.1), hash21(sp.xz + 7.7)) - 0.5;
              vec3 f = fract(g) - 0.5 - jit * 0.6;
              float d2 = dot(f, f);
              // Round point: soft gaussian core → a disc, not a filled cell.
              // Brighter/bigger stars get a slightly wider glow.
              float radius = 0.22 + 0.14 * mag;
              float point = exp(-d2 / (radius * radius));
              // Twinkle: each star gets its own slow speed + phase so they
              // shimmer independently (no lockstep groups) and gently.
              float tSeed = hash21(sp.xz + 2.9);
              float tw = 0.72 + 0.28 * sin(uTime * (0.4 + 0.8 * tSeed) + tSeed * 63.0);
              vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.78), hash21(sp.xz + 5.0));
              stars += tint * mag * tw * point * (0.9 + float(t) * 0.55);
            }
          }
          // Milky band: a soft diagonal wash of unresolved starlight.
          float band = smoothstep(0.35, 0.0, abs(dir.x * 0.7 + dir.y * 0.5 - dir.z * 0.5));
          stars += vec3(0.10, 0.13, 0.20) * band * (0.4 + 0.6 * cloudFbm(dir.xz * 8.0)) * up;

          // ---- Clouds: fluffy, dark-bellied, silver-rimmed by the moon ----
          vec2 cuv = dir.xz / (dir.y + 0.45) * 1.6 + vec2(uTime * 0.012, uTime * 0.007);
          float cl = clouds(cuv);
          float cover = smoothstep(0.46, 0.66, cl) * smoothstep(0.0, 0.06, dir.y);
          // Rim: cloud edges facing the moon catch a bright silver lining.
          float edge = smoothstep(0.44, 0.52, cl) * (1.0 - smoothstep(0.62, 0.72, cl));
          float silver = pow(clamp(md, 0.0, 1.0), 40.0) * uMoonBright;
          vec3 moonCol = vec3(0.82, 0.87, 1.0);
          vec3 cloudCol = vec3(0.024, 0.030, 0.044)
                        + moonCol * silver * 0.06
                        + moonCol * edge * silver * 0.9; // the backlit lining

          // ---- The moon: disc + phase bite + broad halo ----
          float disc = smoothstep(0.99955, 0.99985, md);
          float bite = smoothstep(0.99940, 0.99975, dot(dir, uBiteDir));
          float moonFace = disc * (1.0 - bite * 0.95) * uMoonBright;
          float halo = pow(clamp(md, 0.0, 1.0), 600.0) * 0.28 * uMoonBright;
          float moonVis = 1.0 - cover;
          vec3 moon = moonCol * (moonFace * 2.2 + halo) * moonVis;

          vec3 col = mix(sky + stars, cloudCol, cover) + moon;
          // Overall night dim — the sky was reading too luminous.
          col *= 0.78;
          // The Dark Tide smothers the whole vault — stars, clouds, and moon
          // all sink toward black as the tide swells.
          col *= uDark;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 20), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10; // paint first, world draws over it
    this.mesh.layers.set(1); // skipped by the depth prepass
  }

  update(
    t: number,
    camPos: THREE.Vector3,
    moonDir: THREE.Vector3,
    phase: number,
    dark = 1,
  ): void {
    this.mesh.position.copy(camPos); // the sky never parallaxes
    this.uniforms.uTime.value = t;
    this.uniforms.uDark.value = dark;
    this.uniforms.uMoonDir.value.copy(moonDir);
    // Phase: a dark disc slides across the face. 0 = new, 0.5 = full, 1 = new.
    const bite = Math.cos(phase * Math.PI * 2); // 1 covered … -1 clear
    const side = new THREE.Vector3(-moonDir.z, 0, moonDir.x).normalize();
    this.uniforms.uBiteDir.value
      .copy(moonDir)
      .addScaledVector(side, 0.028 * bite)
      .normalize();
    this.uniforms.uMoonBright.value = 0.25 + 0.75 * (0.5 - 0.5 * bite); // full = bright
  }
}
