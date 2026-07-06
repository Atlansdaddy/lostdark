import * as THREE from 'three';

/**
 * Reek ground-smoke — a THIN, swirling, murky layer that hugs the traversed
 * ground and stays CONTAINED to a radius around the orb, so it never washes the
 * horizon (that was the failure of a global height-fog slab: grazing rays
 * integrate it to infinity → grey soup).
 *
 * Technique (per the high-perf ground-fog approach, discourse.threejs.org):
 *   - NOT a full-screen post-process, NOT a depth-prepass. Just a few horizontal
 *     planes stacked a few units off the ground — cheap, and they depth-test
 *     against the real scene so mushrooms in front occlude the smoke for free.
 *   - The plane stack FOLLOWS the orb (recentred each frame) and fades to zero
 *     at its radius, so smoke only ever exists around the player — the distance
 *     is untouched. Thin: the stack spans only `thickness` world units.
 *   - Swirl is domain-warped 2-octave value noise sampled in WORLD space, so
 *     moving parts real smoke and it curls over time. Murk that only reads where
 *     the orb's light is near — dark away from light, never a flat wash.
 */
export class GroundFog {
  readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;
  private groundY = 0; // smoothed floor height (see setOrb — kills the voxel-snap judder)
  private grounded = false;

  constructor(radius = 26, layers = 5, thickness = 1.2) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false, // smoke doesn't occlude itself in the depth buffer…
      depthTest: true, //   …but IS occluded by nearer opaque geometry
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uOrb: { value: new THREE.Vector3() }, // world orb pos (pocket + lit centre)
        uColor: { value: new THREE.Color(0.30, 0.46, 0.40) }, // murky Reek green-grey
        uRadius: { value: radius },
        uGroundY: { value: 0 },
        uThickness: { value: thickness },
        uDensity: { value: 0.9 }, // overall opacity of the murk
        uOrbColor: { value: new THREE.Color(0.55, 0.9, 1.0) },
        uOrbReach: { value: 12.0 }, // how far the orb lights the smoke
        uMoon: { value: 0 },
        // Fog lights: orb (slot 0) + nearest charged shrooms / wards / crystals.
        // The mist is a LIT medium — every light glows through the air it's near,
        // not just the orb. This is the "shrooms illuminate the fog" fix.
        uLightCount: { value: 0 },
        uLightPos: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
        uLightColor: { value: Array.from({ length: 8 }, () => new THREE.Color()) },
        uLightInt: { value: new Float32Array(8) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vWorld;
        uniform float uTime;
        uniform vec3 uOrb;
        uniform vec3 uColor;
        uniform float uRadius;
        uniform float uGroundY;
        uniform float uThickness;
        uniform float uDensity;
        uniform vec3 uOrbColor;
        uniform float uOrbReach;
        uniform float uMoon;
        #define NLIGHTS 8
        uniform int uLightCount;
        uniform vec3 uLightPos[NLIGHTS];
        uniform vec3 uLightColor[NLIGHTS];
        uniform float uLightInt[NLIGHTS];

        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float vnoise(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                         mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                         mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        // Domain-warped 2-octave noise → curling smoke, cheap.
        float smoke(vec3 p) {
          float t = uTime * 0.3;
          vec3 w = p;
          w.x += 0.7 * sin(p.z * 0.6 + t);
          w.z += 0.7 * cos(p.x * 0.6 - t);
          float f = 0.65 * vnoise(w * 0.45 + vec3(t * 0.25, 0.0, -t * 0.2));
          f += 0.35 * vnoise(w * 1.05 + vec3(-t * 0.3, 0.0, t * 0.25));
          return f;
        }

        void main() {
          vec2 d = vWorld.xz - uOrb.xz;
          float rr = dot(d, d);
          float R = uRadius;
          // CONTAINMENT: hard zero beyond the radius, smooth fade toward it →
          // the horizon never sees any smoke.
          float radial = 1.0 - smoothstep(R * 0.45, R, sqrt(rr));
          if (radial <= 0.001) discard;

          // THIN: this plane sits at some height in the band; fade out toward
          // the top so the layer feels only a sliver deep.
          float h = clamp((vWorld.y - uGroundY) / uThickness, 0.0, 1.0);
          float heightFade = 1.0 - h; // densest right at the ground

          float n = smoke(vWorld);
          float murk = smoothstep(0.35, 0.85, n); // clumps + clear gaps (swirl)
          if (murk <= 0.001) discard;

          // The orb pushes a clear pocket around itself so you can see your feet.
          float pocket = 1.0 - 0.8 * exp(-rr * 0.05);

          float a = uDensity * radial * heightFade * murk * pocket;
          a = clamp(a, 0.0, 0.85);
          if (a <= 0.003) discard;

          // LIT medium, not a flat wash: the smoke brightens where ANY light —
          // orb, charged shroom, ward, crystal — reaches it, so groves glow
          // through the air like the orb does. Away from all light it's near-black
          // murk, never grey soup. This is real per-light in-scatter in the mist.
          vec3 lightSum = vec3(0.0);
          for (int i = 0; i < NLIGHTS; i++) {
            if (i >= uLightCount) break;
            float li = uLightInt[i];
            if (li <= 0.001) continue;
            vec3 dl = vWorld - uLightPos[i];
            float d2 = dot(dl, dl);
            lightSum += uLightColor[i] * li * exp(-d2 / (uOrbReach * uOrbReach));
          }
          vec3 col = uColor * (0.10 + uMoon * 0.5) + lightSum * 1.1;
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    for (let i = 0; i < layers; i++) {
      const g = new THREE.PlaneGeometry(radius * 2, radius * 2, 1, 1);
      g.rotateX(-Math.PI / 2); // lay it flat
      const m = new THREE.Mesh(g, this.mat);
      m.position.y = (i / Math.max(1, layers - 1)) * thickness;
      m.renderOrder = 12; // after opaque scene, before/with other transparents
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** Recentre the stack on the orb (x,z) and anchor its height to the TRUE floor
   *  under the orb — NOT orb.y − hoverHeight. Using the real floor is what stops
   *  the fog riding the orb's hover-bob and jumps (it stays on the ground while
   *  the orb rises above it), which read as "the fog travels with the orb". */
  setOrb(p: THREE.Vector3, floorY: number, orbColor: THREE.Color): void {
    // floorY comes from the voxel floor probe, so it SNAPS a whole unit when you
    // cross a block edge — a hard jump reads as the fog juddering. Ease toward it
    // so the plane glides between levels instead of popping. (Snap on the first
    // frame so it doesn't ramp up from y=0 on spawn.)
    if (!this.grounded) {
      this.groundY = floorY;
      this.grounded = true;
    } else {
      this.groundY += (floorY - this.groundY) * 0.08;
    }
    this.group.position.set(p.x, this.groundY, p.z);
    this.mat.uniforms.uOrb.value.copy(p);
    this.mat.uniforms.uGroundY.value = this.groundY;
    this.mat.uniforms.uOrbColor.value.copy(orbColor);
  }

  /** Fog lights (orb in slot 0, then nearest world lights) — each glows through
   *  the mist near it. Capped at the uniform array length. */
  setLights(lights: { pos: THREE.Vector3; color: THREE.Color; intensity: number }[]): void {
    const posArr = this.mat.uniforms.uLightPos.value as THREE.Vector3[];
    const colArr = this.mat.uniforms.uLightColor.value as THREE.Color[];
    const intArr = this.mat.uniforms.uLightInt.value as Float32Array;
    const n = Math.min(lights.length, posArr.length);
    this.mat.uniforms.uLightCount.value = n;
    for (let i = 0; i < n; i++) {
      posArr[i].copy(lights[i].pos);
      colArr[i].copy(lights[i].color);
      intArr[i] = lights[i].intensity;
    }
  }

  setTime(t: number): void {
    this.mat.uniforms.uTime.value = t;
  }

  setMoon(i: number): void {
    this.mat.uniforms.uMoon.value = i;
  }

  dispose(): void {
    this.mat.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
