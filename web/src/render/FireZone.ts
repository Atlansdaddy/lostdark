/**
 * FireZone — the ember/coal hearth's LIFE (render/ half of the NE forge), v2.
 *
 * The v1 read as flat orange squares + confetti sparks (John: "terrible").
 * This pass replaces all three layers with the real thing:
 *
 *   • COALS  — a shader plane laid over the bed: dark coal lumps split by a
 *              RIDGED-NOISE CRACK NETWORK that glows from within, breathing
 *              slowly per-patch and flickering fast — black rock over molten
 *              light, not speckled voxels. (The Ember voxels underneath stay:
 *              they feed the flood-fill so the hearth still lights the world.)
 *   • FLAMES — noise-eroded teardrop billboards: an fbm field distorts the
 *              sample point (stronger with height) so tongues tear off and lick;
 *              a hot white core sits low, edges erode to nothing. Yaw-billboarded.
 *   • EMBERS — sparks with real-ish physics: buoyant while hot (rise fades as
 *              they cool), swirled by turbulent air (layered-sine pseudo-curl),
 *              drag, a slight sink once cold, and a sputtering blink-out. Young
 *              embers run white-orange, dying ones deep red.
 *   • LIGHT  — the hearth PointLight breathes on layered slow sines with a fast
 *              shimmer on top — restless, never a strobe.
 */

import * as THREE from 'three';
import type { Slab } from '../world/Testbeds';

/** Shared GLSL: hash/value-noise/fbm used by both the coal and flame shaders. */
const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

export class FireZone {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private readonly flames: THREE.Mesh[] = [];
  private readonly coalMat: THREE.ShaderMaterial;
  private readonly lightBase = 11; // retuned for physical 1/d² falloff (unified lighting law)

  // Ember spark pool.
  private readonly EMB_MAX = 200;
  private readonly embPos: Float32Array;
  private readonly embCol: Float32Array;
  private readonly embVel: Float32Array;
  private readonly embLife: Float32Array;
  private readonly embMaxLife: Float32Array;
  private embHead = 0;
  private readonly embGeo: THREE.BufferGeometry;
  private readonly bed: Slab;
  private acc = 0;

  constructor(hearths: THREE.Vector3[], bed: Slab, moteTexture: THREE.Texture) {
    this.bed = bed;
    const bedCx = (bed.x0 + bed.x1) / 2;
    const bedCz = (bed.z0 + bed.z1) / 2;
    const bedTopY = bed.topY + 1; // voxel at topY occupies topY..topY+1

    // --- COALS: the glowing-crack overlay across the whole bed. ---
    this.coalMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        uniform float uTime;
        ${NOISE_GLSL}
        void main() {
          vec2 p = vWorld.xz;
          // Coal lumps: broad value-noise shading over a near-black base.
          float lump = fbm(p * 0.9);
          // Crack network: ridged noise — the fold lines glow, the lumps stay dark.
          float ridge = 1.0 - abs(2.0 * fbm(p * 1.35 + 13.7) - 1.0);
          float crack = smoothstep(0.62, 0.94, ridge);
          // Molten pockets: broader hot patches where the bed burns through.
          float pocket = smoothstep(0.6, 0.92, fbm(p * 0.45 + 71.3));
          // Breathing: each patch swells and dims on its own slow clock…
          float breathe = 0.6 + 0.4 * sin(uTime * 0.55 + fbm(p * 0.33) * 12.0);
          // …with a fast faint shimmer riding on top (heat, not a strobe).
          float flick = 0.88 + 0.12 * sin(uTime * 7.0 + p.x * 3.1 + p.y * 2.3);
          float heat = clamp((crack * 0.95 + pocket * 0.7) * breathe * flick, 0.0, 1.3);
          vec3 coal = vec3(0.035, 0.030, 0.028) * (0.45 + 0.8 * lump);
          vec3 glow = vec3(1.1, 0.16, 0.015) * heat
                    + vec3(1.2, 0.55, 0.08) * heat * heat
                    + vec3(1.1, 0.95, 0.5) * pow(heat, 4.0) * 0.6;
          vec3 col = coal + glow; // linear HDR — the hot cracks bloom
          col *= exp(-distance(cameraPosition, vWorld) * 0.02); // dark at range
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const coalPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(bed.x1 - bed.x0, bed.z1 - bed.z0),
      this.coalMat,
    );
    coalPlane.geometry.rotateX(-Math.PI / 2);
    coalPlane.position.set(bedCx, bedTopY + 0.03, bedCz);
    this.group.add(coalPlane);

    // --- FLAMES: noise-eroded teardrops, 2 layered quads per hearth. ---
    const flameVert = /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const flameFrag = /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      uniform float uTime; uniform float uSeed; uniform float uIntensity;
      ${NOISE_GLSL}
      // Fire ramp: transparent → deep red → orange → white-hot.
      vec3 palette(float t) {
        vec3 c = vec3(0.0);
        c = mix(c, vec3(0.9, 0.12, 0.02), smoothstep(0.08, 0.35, t));
        c = mix(c, vec3(1.15, 0.55, 0.06), smoothstep(0.35, 0.7, t));
        c = mix(c, vec3(1.25, 1.05, 0.55), smoothstep(0.72, 1.0, t));
        return c;
      }
      void main() {
        vec2 uv = vec2(vUv.x * 2.0 - 1.0, vUv.y);
        // Rising turbulence distorts the sample point — more with height, so the
        // base sits steady and the tip tears into licking tongues.
        float n = fbm(vec2(uv.x * 1.8 + uSeed * 3.1, uv.y * 2.6 - uTime * 2.1));
        float n2 = fbm(vec2(uv.x * 3.6 - uSeed * 1.7, uv.y * 5.2 - uTime * 3.4));
        uv.x += (n - 0.5) * 0.9 * uv.y + (n2 - 0.5) * 0.35 * uv.y;
        // Teardrop body: wide base, sharp tip.
        float w = mix(0.62, 0.03, pow(clamp(uv.y, 0.0, 1.0), 1.25));
        float body = 1.0 - smoothstep(w * 0.35, w, abs(uv.x));
        float base = smoothstep(0.0, 0.08, uv.y);
        float tip = 1.0 - smoothstep(0.42, 1.0, uv.y + (n - 0.5) * 0.55);
        float f = body * base * tip * (0.72 + 0.55 * n2);
        f = clamp(f * uIntensity, 0.0, 1.0);
        // Hot core low and centered.
        float core = (1.0 - smoothstep(0.0, 0.3, abs(uv.x))) * (1.0 - smoothstep(0.05, 0.45, uv.y));
        float heat = clamp(f + core * f * 0.9, 0.0, 1.0);
        vec3 col = palette(heat);
        float a = smoothstep(0.06, 0.3, f); // eroded cut-out edges, no soft haze
        col *= exp(-distance(cameraPosition, vWorld) * 0.02);
        gl_FragColor = vec4(col * a * 1.5, a);
      }
    `;
    for (let i = 0; i < hearths.length; i++) {
      const h = hearths[i];
      for (let j = 0; j < 2; j++) {
        const w = 2.4 - j * 0.9;
        const ht = 3.2 - j * 1.1;
        const geo = new THREE.PlaneGeometry(w, ht);
        geo.translate(0, ht / 2, 0); // pivot at the base — flames grow from the coals
        const mesh = new THREE.Mesh(
          geo,
          new THREE.ShaderMaterial({
            uniforms: {
              uTime: { value: 0 },
              uSeed: { value: i * 3.7 + j * 1.9 },
              uIntensity: { value: 1 },
            },
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            vertexShader: flameVert,
            fragmentShader: flameFrag,
          }),
        );
        mesh.position.set(h.x + (j - 0.5) * 0.5, h.y, h.z + (j - 0.5) * 0.4);
        mesh.renderOrder = 3;
        mesh.layers.set(1); // effects layer — skipped by the depth prepass
        this.flames.push(mesh);
        this.group.add(mesh);
      }
    }

    // --- LIGHT: the hearth's restless warm glow. ---
    this.light = new THREE.PointLight(0xff7a2a, this.lightBase, 0, 2); // unified falloff law: 1/d², no cutoff ring
    this.light.position.set(bedCx, bedTopY + 2, bedCz);
    this.group.add(this.light);

    // --- EMBERS: spark pool. ---
    this.embPos = new Float32Array(this.EMB_MAX * 3).fill(-9999);
    this.embCol = new Float32Array(this.EMB_MAX * 3);
    this.embVel = new Float32Array(this.EMB_MAX * 3);
    this.embLife = new Float32Array(this.EMB_MAX);
    this.embMaxLife = new Float32Array(this.EMB_MAX);
    this.embGeo = new THREE.BufferGeometry();
    this.embGeo.setAttribute('position', new THREE.BufferAttribute(this.embPos, 3));
    this.embGeo.setAttribute('color', new THREE.BufferAttribute(this.embCol, 3));
    const emb = new THREE.Points(
      this.embGeo,
      new THREE.PointsMaterial({
        size: 0.13,
        map: moteTexture,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    emb.frustumCulled = false;
    emb.layers.set(1);
    this.group.add(emb);
  }

  private emitEmber(): void {
    const b = this.bed;
    const idx = this.embHead;
    this.embHead = (this.embHead + 1) % this.EMB_MAX;
    this.embPos[idx * 3] = b.x0 + 1 + Math.random() * (b.x1 - b.x0 - 2);
    this.embPos[idx * 3 + 1] = b.topY + 1;
    this.embPos[idx * 3 + 2] = b.z0 + 1 + Math.random() * (b.z1 - b.z0 - 2);
    this.embVel[idx * 3] = (Math.random() * 2 - 1) * 0.3;
    this.embVel[idx * 3 + 1] = 0.3 + Math.random() * 0.7; // gentle pop off the bed
    this.embVel[idx * 3 + 2] = (Math.random() * 2 - 1) * 0.3;
    const life = 0.8 + Math.random() * 1.8;
    this.embLife[idx] = life;
    this.embMaxLife[idx] = life;
  }

  update(dt: number, t: number, camPos: THREE.Vector3, tier: number): void {
    // Light breathes on layered slow sines + a fast shimmer — never a strobe.
    const breathe =
      0.8 + 0.14 * Math.sin(t * 6.7 + Math.sin(t * 2.9) * 2.1) + 0.06 * Math.sin(t * 19.3);
    this.light.intensity = this.lightBase * breathe;

    // Animate + yaw-billboard the flames toward the camera.
    for (const m of this.flames) {
      const mat = m.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = t;
      mat.uniforms.uIntensity.value = 0.8 + 0.35 * breathe;
      m.lookAt(camPos.x, m.position.y, camPos.z);
    }
    this.coalMat.uniforms.uTime.value = t;

    // Emit embers (rate thinned by quality tier).
    const rate = tier === 0 ? 34 : tier === 1 ? 18 : 8; // per second
    this.acc += dt * rate;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.emitEmber();
    }

    // Ember physics: buoyant while HOT (lift dies as they cool), swirled by
    // turbulent air (layered-sine pseudo-curl), drag, slight sink once cold,
    // and a sputtering blink-out at the end of life.
    for (let i = 0; i < this.EMB_MAX; i++) {
      if (this.embLife[i] <= 0) continue;
      this.embLife[i] -= dt;
      const age = 1 - this.embLife[i] / this.embMaxLife[i]; // 0 fresh → 1 dead
      const hot = Math.max(0, 1 - age * 1.25); // heat runs out before life does
      const ph = i * 2.39;
      // Turbulent swirl — cheap curl-ish wander, stronger the higher it climbs.
      const swirl = 0.55 + 0.5 * Math.min(1, (this.embPos[i * 3 + 1] - this.bed.topY) * 0.2);
      this.embVel[i * 3] += (Math.sin(t * 1.9 + ph) + 0.5 * Math.sin(t * 4.7 + ph * 1.3)) * swirl * dt;
      this.embVel[i * 3 + 2] += (Math.cos(t * 1.6 + ph) + 0.5 * Math.cos(t * 5.3 + ph * 0.7)) * swirl * dt;
      // Buoyancy fades with heat; a cold ember drifts down, ash-like.
      this.embVel[i * 3 + 1] += (2.4 * hot - 0.9 * (1 - hot)) * dt;
      // Air drag.
      const drag = 1 - 1.6 * dt;
      this.embVel[i * 3] *= drag;
      this.embVel[i * 3 + 1] *= drag;
      this.embVel[i * 3 + 2] *= drag;
      this.embPos[i * 3] += this.embVel[i * 3] * dt;
      this.embPos[i * 3 + 1] += this.embVel[i * 3 + 1] * dt;
      this.embPos[i * 3 + 2] += this.embVel[i * 3 + 2] * dt;
      // Brightness: quick catch, slow cool, sputter near death.
      const catchUp = Math.min(1, (this.embMaxLife[i] - this.embLife[i]) * 6);
      const sputter = age > 0.7 ? 0.45 + 0.55 * Math.abs(Math.sin(t * 22 + ph * 3.0)) : 1;
      const b = catchUp * sputter * Math.max(0, 1 - age) * 1.5;
      // Colour cools white-orange → deep red as it ages.
      this.embCol[i * 3] = 1.0 * b;
      this.embCol[i * 3 + 1] = (0.6 * hot + 0.1) * b;
      this.embCol[i * 3 + 2] = (0.2 * hot + 0.01) * b;
      if (this.embLife[i] <= 0) this.embPos[i * 3 + 1] = -9999;
    }
    this.embGeo.attributes.position.needsUpdate = true;
    this.embGeo.attributes.color.needsUpdate = true;
  }
}
