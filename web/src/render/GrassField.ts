/**
 * Reek-grass — high-density instanced blade field that REACTS.
 *
 * Technique per the 2025 state of the art (Codrops fluffy-grass, the 1.5M-blade
 * interactive field, Gjoreski's shader notes):
 *   · real tapered blade geometry (7 verts), one InstancedMesh PER REGION so
 *     frustum culling drops whole chunks of field off-screen
 *   · every motion in the vertex shader: layered wind (sway + gust + per-blade
 *     phase), displacement ∝ height² so roots stay planted
 *   · player reaction is a uniform: blades bend radially away from the orb
 *     with smoothstep falloff — zero CPU per frame
 *   · wAIver's own twist: the ECHOLOCATION PULSE ripples the field as its
 *     shell passes — perception physically stirs the world
 *   · shading matches the voxel world: per-blade baked flood-fill light,
 *     root AO, tip gradient, orb-bubble dynamic light, distance-extinction
 *     to black (darkness is the draw distance here too).
 */

import * as THREE from 'three';

const REGION = 32; // tufts grouped into REGION² world-unit cells for culling
const BLADES_PER_TUFT = 5;

interface Tuft {
  x: number;
  y: number;
  z: number;
  light: number; // baked flood-fill light 0..1 at spawn
}

export interface GrassUniforms {
  uTime: { value: number };
  uOrbPos: { value: THREE.Vector3 };
  uOrbColor: { value: THREE.Color };
  uPulseCenter: { value: THREE.Vector3 };
  uPulseRadius: { value: number };
  uPulseIntensity: { value: number };
  uHeldColor: { value: THREE.Color };
  uMoonI: { value: number };
  // Shared light-volume atlas (main.ts overwrites these entries with the SAME
  // uniform objects the terrain/flora use — one global lighting engine). The
  // alpha channel is world solidity; grass shadow-marches its orb bubble against
  // it so the bubble can't pass through walls (the "false circle" bug).
  uLightAtlas: { value: THREE.Texture | null };
  uLightMin: { value: THREE.Vector3 };
  uLightStep: { value: number };
  uLightDim: { value: THREE.Vector3 };
  uLightTiles: { value: THREE.Vector2 };
}

export class GrassField {
  private tufts: Tuft[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  readonly uniforms: GrassUniforms = {
    uTime: { value: 0 },
    uOrbPos: { value: new THREE.Vector3() },
    uOrbColor: { value: new THREE.Color(0.42, 0.85, 1.0) },
    uPulseCenter: { value: new THREE.Vector3() },
    uPulseRadius: { value: -1 },
    uPulseIntensity: { value: 0 },
    uHeldColor: { value: new THREE.Color(0.62, 1.0, 0.8) },
    uMoonI: { value: 0 },
    uLightAtlas: { value: null },
    uLightMin: { value: new THREE.Vector3(-128, -14, -128) },
    uLightStep: { value: 2 },
    uLightDim: { value: new THREE.Vector3(1, 1, 1) },
    uLightTiles: { value: new THREE.Vector2(1, 1) },
  };
  private material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aPhase;
        attribute float aLight;
        varying float vH;
        varying float vLight;
        varying float vPhase;
        varying float vRipple;
        varying vec3 vWorld;
        varying vec3 vBase;
        varying float vWide;

        uniform float uTime;
        uniform vec3 uOrbPos;
        uniform vec3 uPulseCenter;
        uniform float uPulseRadius;
        uniform float uPulseIntensity;

        void main() {
          vH = uv.y;
          vLight = aLight;
          vPhase = aPhase;

          // Anti-grain (John: "light should be nice and smooth"): a blade
          // thinner than a pixel renders as a flickering dot, and the lit
          // field reads as stipple. Widen blades with camera distance so
          // they never go subpixel; the fragment divides brightness by the
          // same factor so the field's total light is unchanged.
          vec3 base0 = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float camD = distance(cameraPosition, base0);
          vWide = clamp(camD * 0.06, 1.0, 2.6);
          vec3 lpos = position;
          lpos.x *= vWide;

          // Blade-local position through the instance transform.
          vec4 wp = instanceMatrix * vec4(lpos, 1.0);
          vec3 base = base0;
          vBase = base0;

          // Bend weight: tips move, roots stay planted.
          float bendW = vH * vH;

          // --- Wind: global sway + travelling gust + per-blade jitter ---
          float sway = sin(uTime * 1.35 + aPhase + base.x * 0.14 + base.z * 0.09);
          float gust = sin(uTime * 0.5 - base.x * 0.045 - base.z * 0.03);
          gust = max(0.0, gust) * sin(uTime * 2.2 + aPhase * 2.3);
          float jitter = sin(uTime * 3.1 + aPhase * 5.7) * 0.25;
          vec2 windDir = normalize(vec2(0.8, 0.45));
          wp.xz += windDir * (sway * 0.09 + gust * 0.16 + jitter * 0.05) * bendW;

          // --- Player: blades part around the orb (smoothstep falloff) ---
          vec2 away = wp.xz - uOrbPos.xz;
          float d = length(away);
          float push = smoothstep(2.6, 0.35, d) * step(abs(uOrbPos.y - base.y), 3.5);
          wp.xz += (away / max(d, 0.001)) * push * 0.6 * bendW;
          wp.y -= push * 0.3 * bendW; // trampled flat, springs back

          // --- The pulse ripples the field as its shell passes ---
          vRipple = 0.0;
          if (uPulseIntensity > 0.0 && uPulseRadius >= 0.0) {
            float pd = distance(wp.xyz, uPulseCenter);
            float ring = 1.0 - clamp(abs(pd - uPulseRadius) / 3.0, 0.0, 1.0);
            ring *= uPulseIntensity;
            vec2 out2 = normalize(wp.xz - uPulseCenter.xz + 1e-4);
            wp.xz += out2 * ring * 0.38 * bendW;
            vRipple = ring;
          }

          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vH;
        varying float vLight;
        varying float vPhase;
        varying float vRipple;
        varying vec3 vWorld;
        varying vec3 vBase;
        varying float vWide;

        uniform vec3 uOrbPos;
        uniform vec3 uOrbColor;
        uniform vec3 uHeldColor;
        uniform float uMoonI;
        uniform sampler2D uLightAtlas;
        uniform vec3 uLightMin;
        uniform float uLightStep;
        uniform vec3 uLightDim;
        uniform vec2 uLightTiles;

        // Flood-fill light level from the shared atlas (red) — the SAME smooth
        // per-fragment read the terrain uses. Grass used to bake ONE light value
        // per blade at spawn (aLight), so around a charged shroom neighbouring
        // blades held different quantized levels — the grainy shroom pools. The
        // orb bubble was analytic (smooth); this makes held/grove light match.
        float sampleLightVol(vec3 wp) {
          vec3 v = (wp - uLightMin) / uLightStep;
          float nx = uLightDim.x, ny = uLightDim.y, nz = uLightDim.z;
          float tX = uLightTiles.x, tY = uLightTiles.y;
          float aw = tX * nx, ah = tY * nz;
          float cx = clamp(v.x, 0.5, nx - 0.5);
          float cz = clamp(v.z, 0.5, nz - 0.5);
          float fy = v.y - 0.5;
          float s0 = clamp(floor(fy), 0.0, ny - 1.0);
          float s1 = clamp(s0 + 1.0, 0.0, ny - 1.0);
          float wy = clamp(fy - s0, 0.0, 1.0);
          vec2 t0 = vec2(mod(s0, tX), floor(s0 / tX));
          vec2 t1 = vec2(mod(s1, tX), floor(s1 / tX));
          vec2 uv0 = vec2(t0.x * nx + cx, t0.y * nz + cz) / vec2(aw, ah);
          vec2 uv1 = vec2(t1.x * nx + cx, t1.y * nz + cz) / vec2(aw, ah);
          return mix(texture2D(uLightAtlas, uv0).r, texture2D(uLightAtlas, uv1).r, wy);
        }

        // World solidity from the shared light-volume atlas (alpha) — the same
        // data the terrain/flora shadow-march. Nearest Y-slice, crisp walls.
        float sampleSolid(vec3 wp) {
          vec3 v = (wp - uLightMin) / uLightStep;
          float nx = uLightDim.x, ny = uLightDim.y, nz = uLightDim.z;
          float tX = uLightTiles.x, tY = uLightTiles.y;
          float aw = tX * nx, ah = tY * nz;
          float cx = clamp(v.x, 0.5, nx - 0.5);
          float cz = clamp(v.z, 0.5, nz - 0.5);
          float s = clamp(floor(v.y), 0.0, ny - 1.0);
          vec2 t = vec2(mod(s, tX), floor(s / tX));
          vec2 uv = vec2(t.x * nx + cx, t.y * nz + cz) / vec2(aw, ah);
          return texture2D(uLightAtlas, uv).a;
        }
        // Shadow march toward the orb — a wall between blade and orb blocks the
        // bubble (no more lit-grass circles through solid terrain). Short march:
        // only runs inside the bubble, so the field at large pays nothing.
        // Jittered sample offsets — same anti-ring treatment as litMaterial
        // (fixed-step binary marches paint concentric rings around any light
        // near solid voxels). Reach unchanged: walls are 1 voxel thick, so the
        // march must sample right up to the light or it leaks through them.
        float marchJitter(vec3 p) {
          return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        }
        // Continuous transmittance march (matches litMaterial): binary hit tests
        // made the jitter read as grain at light-pool edges; smooth accumulated
        // occlusion doesn't.
        float orbShadow(vec3 p) {
          vec3 d = uOrbPos - p;
          float dist = length(d);
          if (dist < 1.5) return 1.0;
          vec3 dir = d / dist;
          float march = min(dist - 1.0, 10.0);
          float j = marchJitter(p);
          float trans = 1.0;
          for (int i = 1; i <= 10; i++) {
            float s = float(i) + j;
            if (s >= march) break;
            trans *= 1.0 - smoothstep(0.25, 0.75, sampleSolid(p + dir * s));
            if (trans < 0.03) return 0.0;
          }
          return trans;
        }

        void main() {
          // Per-blade tint: greens drifting toward teal, from the phase hash.
          float t = fract(vPhase * 0.618);
          vec3 rootCol = vec3(0.05, 0.13, 0.09);
          vec3 tipCol = mix(vec3(0.16, 0.5, 0.3), vec3(0.14, 0.45, 0.42), t);
          vec3 albedo = mix(rootCol, tipCol, vH);

          // Shading LOD: near blades light per-pixel; far blades light ONCE at
          // their base, so a distant blade is a soft uniform stroke instead of
          // a bright tip-dot (the other half of the grain).
          float lodT = smoothstep(12.0, 30.0, distance(cameraPosition, vWorld));
          vec3 lightP = mix(vWorld, vBase + vec3(0.0, 0.5, 0.0), lodT);

          // Light: ambient whisper + held flood-fill light (per-fragment, same
          // smooth atlas read as the terrain) + the orb's bubble — radius
          // matches the engine's orbRadius (9), and the bubble is OCCLUDED
          // like every other light in the game.
          float od = distance(lightP, uOrbPos);
          float bubble = 1.0 - clamp(od / 9.0, 0.0, 1.0);
          bubble = bubble * bubble * 0.9;
          if (bubble > 0.004) bubble *= orbShadow(lightP + vec3(0.0, 0.4, 0.0));

          float volL = sampleLightVol(lightP);
          float held = volL * volL * 1.6;
          vec3 lit = albedo * (0.05 + held) * uHeldColor
                   + albedo * bubble * uOrbColor;

          // Root AO — blades sit IN the ground, not on it.
          lit *= 0.4 + 0.6 * vH;

          // The pulse leaves a brief luminous kiss as it passes.
          lit += vRipple * uOrbColor * 0.5 * vH;

          // Moonlight silvers the blade tips when the clouds part.
          lit += albedo * uMoonI * vec3(0.55, 0.65, 0.95) * vH * 0.8;

          // Widened blades give back the brightness the widening added — the
          // field's total light stays constant, the flicker doesn't.
          lit /= vWide;

          // Darkness is the draw distance, for grass too — moonlight opens it.
          lit *= exp(-distance(cameraPosition, vWorld) * 0.016 / (1.0 + uMoonI * 2.5));

          gl_FragColor = vec4(lit, 1.0);
        }
      `,
    });
  }

  /** Register a tuft during world generation. */
  addTuft(x: number, y: number, z: number, bakedLight: number): void {
    // One NaN reaching the GPU blacks out the whole bloom chain — never trust.
    this.tufts.push({ x, y, z, light: Number.isFinite(bakedLight) ? bakedLight : 0 });
  }

  /** Build per-region InstancedMeshes (call once, after generation). */
  build(scene: THREE.Scene): number {
    // Tapered blade: 3 stacked quads narrowing to a tip point.
    const blade = new THREE.BufferGeometry();
    const W = 0.055;
    const H = 1.0; // unit height — instance scale sets the real height
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const rows = [0, 0.45, 0.8, 1.0];
    const widths = [1, 0.72, 0.38, 0];
    for (let r = 0; r < rows.length; r++) {
      const y = rows[r] * H;
      const w = widths[r] * W;
      if (w > 0) {
        pos.push(-w, y, 0, w, y, 0);
        uv.push(0, rows[r], 1, rows[r]);
      } else {
        pos.push(0, y, 0);
        uv.push(0.5, 1);
      }
    }
    // rows 0..2 are pairs (indices 0..5), tip is index 6
    idx.push(0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6);
    blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    blade.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    blade.setIndex(idx);
    blade.computeVertexNormals();

    // Group tufts into regions.
    const regions = new Map<string, Tuft[]>();
    for (const t of this.tufts) {
      const key = `${Math.floor(t.x / REGION)},${Math.floor(t.z / REGION)}`;
      let arr = regions.get(key);
      if (!arr) {
        arr = [];
        regions.set(key, arr);
      }
      arr.push(t);
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const frac = (v: number) => Math.abs(Math.sin(v)) % 1;
    let total = 0;

    for (const tufts of regions.values()) {
      const count = tufts.length * BLADES_PER_TUFT;
      const mesh = new THREE.InstancedMesh(blade, this.material, count);
      const phases = new Float32Array(count);
      const lights = new Float32Array(count);
      let i = 0;
      const bounds = new THREE.Box3();
      for (const t of tufts) {
        for (let b = 0; b < BLADES_PER_TUFT; b++) {
          const ox = (frac(t.x * 7.3 + b * 13.1) - 0.5) * 1.1;
          const oz = (frac(t.z * 11.7 + b * 17.9) - 0.5) * 1.1;
          const h = 0.45 + frac(t.x + t.z * 3 + b) * 0.75;
          eul.set(
            (frac(b * 7 + t.x) - 0.5) * 0.3,
            frac(t.x * 3.1 + t.z * 1.7 + b) * 6.283,
            (frac(b * 5 + t.z) - 0.5) * 0.3,
          );
          q.setFromEuler(eul);
          p.set(t.x + 0.5 + ox, t.y, t.z + 0.5 + oz);
          s.set(1, h, 1);
          m4.compose(p, q, s);
          mesh.setMatrixAt(i, m4);
          phases[i] = frac(t.x * 12.9 + t.z * 7.8 + b * 3.3) * 6.283 + b;
          lights[i] = t.light;
          i++;
          bounds.expandByPoint(p);
        }
      }
      mesh.geometry = blade.clone(); // per-mesh geometry so attributes differ
      mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
      mesh.geometry.setAttribute('aLight', new THREE.InstancedBufferAttribute(lights, 1));
      bounds.expandByScalar(2.5); // wind/bend slack
      mesh.geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
      mesh.name = 'grass'; // bucket tag for the tri-budget profiler
      mesh.frustumCulled = true;
      mesh.layers.set(1); // skipped by the depth prepass (fog needn't see grass)
      scene.add(mesh);
      this.meshes.push(mesh);
      total += count;
    }
    this.tufts.length = 0;
    return total;
  }

  update(
    time: number,
    orbPos: THREE.Vector3,
    orbColor: THREE.Color,
    pulseCenter: THREE.Vector3,
    pulseRadius: number,
    pulseIntensity: number,
  ): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uOrbPos.value.copy(orbPos);
    this.uniforms.uOrbColor.value.copy(orbColor);
    this.uniforms.uPulseCenter.value.copy(pulseCenter);
    this.uniforms.uPulseRadius.value = pulseRadius;
    this.uniforms.uPulseIntensity.value = pulseIntensity;
  }
}
