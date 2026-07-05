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
        uMistDensity: { value: 0.03 }, // a readable bank, not soup
        uMistHeight: { value: 1.7 }, // waist-high, thinning fast above
        uMistTop: { value: 6.0 }, // fog only exists below this world-Y
        uScatter: { value: 0.02 }, // per-light in-scatter strength
        uOrbPos: { value: new THREE.Vector3() },
        uMoonI: { value: 0 }, // moonlight silvers the fog banks
        uBoost: { value: 1.0 }, // transient bloom (pulse firing, events)
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
        uniform float uMoonI;
        uniform float uBoost;

        varying vec2 vUv;

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

          // ---- 1. Low ground-fog: exponential bank hugging the floor, that
          // the orb PARTS as it moves through. 6 segments for a smooth clear. ----
          float mist = 0.0;
          float seg = rayLen / 6.0;
          for (int i = 0; i < 6; i++) {
            float t = (float(i) + 0.5) * seg;
            vec3 sp = ro + rd * t;
            if (sp.y > uMistTop) continue;             // fog is a low layer only
            float dens = exp(-max(sp.y, 0.0) / uMistHeight);
            // Reactive: the orb pushes a clear pocket around itself.
            float part = 1.0 - 0.85 * exp(-dot(sp.xz - uOrbPos.xz, sp.xz - uOrbPos.xz) * 0.06);
            mist += dens * part * seg;
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
          mistLight += vec3(0.030, 0.042, 0.038);            // whisper of self-glow
          mistLight += vec3(0.55, 0.65, 0.95) * uMoonI * 0.6; // moonlit fog
          vec3 fog = uMistColor * mist * mistLight + scatter * uScatter;
          // Soft ceiling: mist saturates instead of whiting the frame out.
          fog = fog / (1.0 + fog);
          // The mist itself is swallowed by darkness at range (extinction) —
          // the horizon of this world is always black.
          fog *= exp(-rayLen * 0.02) * uBoost;
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

  /** Orb position — the fog parts a clear pocket around it. */
  setOrb(p: THREE.Vector3): void {
    this.material.uniforms.uOrbPos.value.copy(p);
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
