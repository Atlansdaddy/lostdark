/**
 * Reek-mist — analytic volumetric fog (ART.md §2, RESEARCH_lighting Phase-1).
 *
 * A full-screen pass after the scene render. For every pixel we reconstruct
 * the view ray from depth, then add:
 *
 *   1. HEIGHT MIST — exponential ground fog, integrated along the ray in a few
 *      analytic segments. The Reek's ankle-deep glow-mist.
 *   2. PER-LIGHT IN-SCATTER — for each fog light (orb, glowcaps, wards) the
 *      inverse-square scattering integral along the ray has a closed form:
 *        ∫ dt / (|P(t)-L|²)  =  [ atan((t-a)/h) ] / h
 *      Exact, noise-free, no marching, no half-res blur — cheap enough for
 *      the phone gate, and lights genuinely GLOW THROUGH the air.
 *
 * The dark stays dark: mist only exists where light reaches it — the fog is
 * lit medium, not grey soup. Runs before bloom so glowing air blooms too.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export const MAX_FOG_LIGHTS = 12;

export class VolumetricFogPass extends Pass {
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;

  /** World-space fog lights, updated per-frame by the scene. */
  readonly lightPos: THREE.Vector3[] = [];
  readonly lightColor: THREE.Color[] = [];
  readonly lightIntensity: Float32Array = new Float32Array(MAX_FOG_LIGHTS);

  constructor(
    private camera: THREE.PerspectiveCamera,
    private depthTexture: THREE.DepthTexture,
  ) {
    super();
    this.needsSwap = true;

    for (let i = 0; i < MAX_FOG_LIGHTS; i++) {
      this.lightPos.push(new THREE.Vector3());
      this.lightColor.push(new THREE.Color(0, 0, 0));
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: this.depthTexture },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uLightPos: { value: this.lightPos },
        uLightColor: { value: this.lightColor },
        uLightIntensity: { value: this.lightIntensity },
        uMistColor: { value: new THREE.Color(0.45, 0.85, 0.65) }, // Reek green
        uMistDensity: { value: 0.06 }, // low murk — a dark bank, NOT the white carpet
        uMistHeight: { value: 0.7 }, // falloff scale — fog stays substantial higher up (was 0.35 sliver)
        uMistTop: { value: 1.7 }, // band rises to ~orb hover height (was 1.1 ankle-deep)
        uScatter: { value: 0.05 }, // per-light in-scatter strength (glow in air)
        uOrbPos: { value: new THREE.Vector3() },
        uGroundY: { value: 0 }, // world-Y of the ground the player is on
        uMoonI: { value: 0 }, // moonlight silvers the fog banks
        uBoost: { value: 1.0 }, // transient bloom (pulse firing, events)
        uTime: { value: 0 }, // drives the swirling smoke
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        #define N_LIGHTS ${MAX_FOG_LIGHTS}

        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform mat4 uInvProj;
        uniform mat4 uInvView;
        uniform vec3 uCamPos;
        uniform vec3 uLightPos[N_LIGHTS];
        uniform vec3 uLightColor[N_LIGHTS];
        uniform float uLightIntensity[N_LIGHTS];
        uniform vec3 uMistColor;
        uniform float uMistDensity;
        uniform float uMistHeight;
        uniform float uMistTop;
        uniform float uScatter;
        uniform vec3 uOrbPos;
        uniform float uGroundY;
        uniform float uMoonI;
        uniform float uBoost;
        uniform float uTime;

        varying vec2 vUv;

        // Cheap value noise → fbm with domain-warp, so the mist SWIRLS and has
        // murky body instead of a smooth gradient. Sampled in world space so
        // moving through it parts real smoke.
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
        // Swirl: warp the sample domain by a slow rotating flow, then fbm. This
        // reads as smoke curling, not just sliding.
        float smoke(vec3 p) {
          float t = uTime * 0.35;
          vec3 w = p;
          w.x += 0.6 * sin(p.z * 0.7 + t);
          w.z += 0.6 * cos(p.x * 0.7 - t);
          float f = 0.55 * vnoise(w * 0.5 + vec3(t * 0.3, 0.0, -t * 0.2));
          f += 0.30 * vnoise(w * 1.1 + vec3(-t * 0.4, t * 0.1, t * 0.3));
          f += 0.15 * vnoise(w * 2.3 + 7.0);
          return f;
        }

        vec3 worldFromDepth(vec2 uv, float depth) {
          vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec4 view = uInvProj * ndc;
          view /= view.w;
          return (uInvView * view).xyz;
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          float depth = texture2D(tDepth, vUv).x;
          vec3 worldEnd = worldFromDepth(vUv, depth);

          vec3 ro = uCamPos;
          vec3 rd = worldEnd - ro;
          float rayLen = length(rd);
          rayLen = min(rayLen, 120.0); // cap the sky
          rd /= max(rayLen, 1e-4);

          // ---- 1. Thin ground-smoke: a low murky sliver hugging the traversed
          // ground (anchored to uGroundY), that the orb PARTS as it moves. We
          // clip the march to just the Y-band [ground, ground+top] and take all
          // our steps INSIDE it, so a thin layer still samples densely. ----
          float yLo = uGroundY;
          float yHi = uGroundY + uMistTop;
          float tEnter = 0.0, tExit = rayLen;
          if (abs(rd.y) > 1e-4) {
            float ta = (yLo - ro.y) / rd.y;
            float tb = (yHi - ro.y) / rd.y;
            tEnter = max(0.0, min(ta, tb));
            tExit = min(rayLen, max(ta, tb));
          } else if (ro.y < yLo || ro.y > yHi) {
            tExit = -1.0; // ray runs parallel, outside the band → no smoke
          }
          float mist = 0.0;
          if (tExit > tEnter) {
            float seg = (tExit - tEnter) / 10.0;
            float dither = hash(vec3(gl_FragCoord.xy, uTime)) * seg; // kill banding
            for (int i = 0; i < 10; i++) {
              vec3 sp = ro + rd * (tEnter + (float(i) + 0.5) * seg + dither);
              float dens = exp(-max(sp.y - uGroundY, 0.0) / uMistHeight);
              // Modulate density with the drifting smoke — clumps and thins, but
              // NEVER to zero. A hard smoothstep gate punched the thin band full
              // of holes: it read as sparse patches, not a bank, and there was no
              // continuous body left to see the drift move through. Keep a floor.
              dens *= 0.2 + 0.8 * smoke(sp); // ~0.2..1.0 — dark wisp-gaps for contrast, clumps on top
              // Reactive: the orb pushes a clear pocket around itself.
              float part = 1.0 - 0.85 * exp(-dot(sp.xz - uOrbPos.xz, sp.xz - uOrbPos.xz) * 0.06);
              mist += dens * part * seg;
            }
          }
          mist *= uMistDensity;

          // Mist is only visible where light reaches it: gather nearby light.
          vec3 mistLight = vec3(0.0);

          // ---- 2. Analytic per-light in-scatter ----
          vec3 scatter = vec3(0.0);
          for (int i = 0; i < N_LIGHTS; i++) {
            float inten = uLightIntensity[i];
            if (inten <= 0.001) continue;
            vec3 L = uLightPos[i];
            // Extinction: a light's glow-in-air dies with its distance from
            // the eye — far groves cannot whitewash the frame.
            inten *= exp(-length(L - ro) * 0.028);
            if (inten <= 0.001) continue;
            // Closest approach of the ray to the light.
            float a = dot(L - ro, rd);
            float h2 = dot(L - ro, L - ro) - a * a;
            float h = sqrt(max(h2, 0.02));
            // ∫₀^len dt/((t-a)²+h²) = (atan((len-a)/h) − atan(−a/h)) / h
            float integral = (atan((rayLen - a) / h) - atan(-a / h)) / h;
            vec3 c = uLightColor[i] * inten * integral;
            scatter += c;
            // The same light also illuminates the height mist near its path.
            float distToRaySeg = h + max(0.0, -a) + max(0.0, a - rayLen);
            mistLight += uLightColor[i] * inten * 0.4 / (1.0 + distToRaySeg * distToRaySeg * 0.1);
          }

          // Many nearby lights must never stack into a washout.
          mistLight = min(mistLight, vec3(0.9));
          // Fog luminance: nearby lights + a faint self-glow (banks read even
          // in the dark) + moonlight silvering the whole layer when it lands.
          mistLight += vec3(0.006, 0.009, 0.008);            // barest self-glow — NOT a wash
          mistLight += vec3(0.55, 0.65, 0.95) * uMoonI * 0.28; // moonlit fog — a touch, not a floodlit carpet
          vec3 fog = uMistColor * mist * mistLight + scatter * uScatter;
          // Soft ceiling: mist saturates instead of whiting the frame out.
          fog = fog / (1.0 + fog);
          // The mist itself is swallowed by darkness at range (extinction) — the
          // horizon is always black. Steeper now so the TALLER band stays a fog you
          // stand IN, not a translucent wash smeared over the whole distant frame.
          fog *= exp(-rayLen * 0.045) * uBoost;
          gl_FragColor = vec4(base.rgb + fog, base.a);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Transient atmosphere bloom (1 = calm; pulse firing pushes it up). */
  setBoost(v: number): void {
    this.material.uniforms.uBoost.value = v;
  }

  /** Orb position + the true floor-Y under it. The floor level anchors the
   *  smoke band so it sits ON the ground. Passing the REAL floor (not
   *  orb.y − hoverHeight) is what stops the band from riding the hover-spring
   *  bob — that vertical wobble is why the fog read as a detached floating sheet. */
  setOrb(p: THREE.Vector3, floorY: number): void {
    this.material.uniforms.uOrbPos.value.copy(p);
    this.material.uniforms.uGroundY.value = floorY;
  }

  /** Elapsed seconds — drives the swirling smoke. */
  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  /** Moonlight strength — fog banks silver over when the clouds part. */
  setMoon(i: number): void {
    this.material.uniforms.uMoonI.value = i;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    this.material.uniforms.uInvView.value.copy(this.camera.matrixWorld);
    this.material.uniforms.uCamPos.value.copy(this.camera.position);

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
