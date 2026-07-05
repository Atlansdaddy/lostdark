/**
 * Moon god-rays — screen-space Light Shafts (the technique Unreal ships).
 *
 * Not literal ray tracing (WebGL2 can't) — the same post-process every
 * real-time engine uses for volumetric shafts: build an OCCLUSION mask (bright
 * where the open sky shows, black on every silhouette), then RADIALLY BLUR it
 * outward from the moon's on-screen position. Geometry between you and the moon
 * carves the shafts. Additively composited, then the bloom pass downstream
 * softens the crests. Gated by moon phase + cloud cover so the rays only spear
 * through when the moon is genuinely out.
 *
 * Sky pixels read as far-plane in the depth prepass (the sky dome is on the
 * effects layer the prepass skips), so `depth >= ~1.0` IS "open sky" — the
 * occlusion mask falls out of depth for free.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const SAMPLES = 48;

export class GodRaysPass extends Pass {
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;

  constructor(depthTexture: THREE.DepthTexture) {
    super();
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: depthTexture },
        uMoonScreen: { value: new THREE.Vector2(0.5, 0.7) },
        uIntensity: { value: 0 }, // 0 = moon clouded/absent → pass is a no-op
        uColor: { value: new THREE.Color(0.72, 0.82, 1.0) },
        uDecay: { value: 0.965 },
        uWeight: { value: 0.5 },
        uExposure: { value: 0.32 },
        uAspect: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        #define SAMPLES ${SAMPLES}
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2 uMoonScreen;
        uniform float uIntensity;
        uniform vec3 uColor;
        uniform float uDecay;
        uniform float uWeight;
        uniform float uExposure;
        uniform float uAspect;
        varying vec2 vUv;

        void main() {
          vec4 scene = texture2D(tDiffuse, vUv);
          if (uIntensity <= 0.001) { gl_FragColor = scene; return; }

          // March from this pixel toward the moon, accumulating "sky showing".
          vec2 delta = (vUv - uMoonScreen);
          delta *= 1.0 / float(SAMPLES) * 0.85;
          vec2 coord = vUv;
          float illum = 1.0;
          float shaft = 0.0;
          // Radial falloff so shafts fade with distance from the disc.
          for (int i = 0; i < SAMPLES; i++) {
            coord -= delta;
            float d = texture2D(tDepth, coord).x;
            float sky = step(0.9999, d); // 1 = open sky, 0 = silhouette
            shaft += sky * illum * uWeight;
            illum *= uDecay;
          }
          shaft /= float(SAMPLES);

          // Shafts live NEAR the moon only — no ambient wash across the frame.
          vec2 md = (vUv - uMoonScreen);
          md.x *= uAspect;
          float prox = exp(-dot(md, md) * 3.2);
          vec3 rays = uColor * shaft * uExposure * uIntensity * prox;

          gl_FragColor = vec4(scene.rgb + rays, scene.a);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setMoon(screen: THREE.Vector2, intensity: number, aspect: number): void {
    this.material.uniforms.uMoonScreen.value.copy(screen);
    this.material.uniforms.uIntensity.value = intensity;
    this.material.uniforms.uAspect.value = aspect;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
