/**
 * The light-driven material (GDD §5j) — v2, textured.
 *
 * A surface is black until light reaches it. Light contributions:
 *   1. baked smooth flood-fill light (attribute `alight`) — "held" world light
 *   2. the orb's carried bubble        (uniform, moving)
 *   3. the echolocation pulse shell    (uniform, expanding)
 * All are grounded by baked AO (`aao`) so voxels sit IN the world instead of
 * floating on it.
 *
 * Surfaces are textured procedurally — no UV atlas needed:
 *   · per-voxel value variation (hash) so no two blocks are the same shade
 *   · fine 3D grain noise for material texture
 *   · soft darkened seams between voxels (reads as mortar/edges)
 *   · sky bias (up-facing slightly brighter) so forms model in the dark
 * Output is linear HDR; bloom + ACES happen in the composer.
 */

import * as THREE from 'three';
import { Light } from '../config';

export interface LitUniforms {
  uOrbPos: { value: THREE.Vector3 };
  uOrbColor: { value: THREE.Color };
  uOrbRadius: { value: number };
  uOrbIntensity: { value: number };
  uAmbient: { value: number };
  uPulseCenter: { value: THREE.Vector3 };
  uPulseRadius: { value: number };
  uPulseThickness: { value: number };
  uPulseIntensity: { value: number };
  /** Tint of the baked world light — the biome's light identity. */
  uHeldColor: { value: THREE.Color };
  /** 1 = blocky voxel detail (per-block tint + seams), 0 = smooth organic. */
  uVoxelDetail: { value: number };
  /** Moonlight: direction + strength (0 when clouds cover the moon). */
  uMoonDir: { value: THREE.Vector3 };
  uMoonI: { value: number };
}

export function createLitMaterial(): { material: THREE.ShaderMaterial; uniforms: LitUniforms } {
  const uniforms: LitUniforms = {
    uOrbPos: { value: new THREE.Vector3() },
    uOrbColor: { value: new THREE.Color(0.6, 0.85, 1.0) },
    uOrbRadius: { value: Light.orbRadius },
    uOrbIntensity: { value: Light.orbIntensity },
    uAmbient: { value: Light.ambientFloor },
    uPulseCenter: { value: new THREE.Vector3() },
    uPulseRadius: { value: -1 },
    uPulseThickness: { value: Light.pulse.thickness },
    uPulseIntensity: { value: 0 },
    uHeldColor: { value: new THREE.Color(0.62, 1.0, 0.8) }, // The Reek
    uVoxelDetail: { value: 1 }, // blocky terrain default — full voxel texturing
    uMoonDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
    uMoonI: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexColors: true,
    vertexShader: /* glsl */ `
      attribute float alight;
      attribute float aao;
      attribute float amat;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vBaked;
      varying float vAO;
      varying float vMat;
      void main() {
        vWorld = position;              // geometry is authored in world space
        vNormal = normalize(normal);
        vColor = color;
        vBaked = alight;
        vAO = aao;
        vMat = amat;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uOrbPos;
      uniform vec3 uOrbColor;
      uniform float uOrbRadius;
      uniform float uOrbIntensity;
      uniform float uAmbient;
      uniform vec3 uPulseCenter;
      uniform float uPulseRadius;
      uniform float uPulseThickness;
      uniform float uPulseIntensity;
      uniform vec3 uHeldColor;
      uniform float uVoxelDetail;
      uniform vec3 uMoonDir;
      uniform float uMoonI;

      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vBaked;
      varying float vAO;
      varying float vMat;

      // --- procedural texture helpers ---
      float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.13));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash3(i);
        float n100 = hash3(i + vec3(1,0,0));
        float n010 = hash3(i + vec3(0,1,0));
        float n110 = hash3(i + vec3(1,1,0));
        float n001 = hash3(i + vec3(0,0,1));
        float n101 = hash3(i + vec3(1,0,1));
        float n011 = hash3(i + vec3(0,1,1));
        float n111 = hash3(i + vec3(1,1,1));
        return mix(
          mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
          mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
          f.z);
      }

      // ---- per-material pattern library (id = Mat enum) ----
      // Each returns an albedo multiplier and can tint. Patterns sample WORLD
      // space, so they tile seamlessly across faces and chunks.

      void main() {
        vec3 p = vWorld + vNormal * 0.01;
        int mid = int(vMat + 0.5);

        // ---- procedural surface detail ----
        // Fine grain (two octaves of value noise) — always on: organic texture.
        float grain = 0.9 + 0.14 * vnoise(vWorld * 3.1) + 0.08 * vnoise(vWorld * 9.7);
        // Large-scale mottling so ground isn't a flat wash.
        float mottle = 0.88 + 0.24 * vnoise(vWorld * 0.35);

        // Blocky-only detail (per-voxel tint + seams) — zeroed on smooth terrain.
        vec3 voxelId = floor(vWorld - vNormal * 0.5);
        float tint = mix(1.0, 0.82 + 0.36 * hash3(voxelId), uVoxelDetail);
        vec3 fr = abs(fract(vWorld) - 0.5);
        vec3 tangentMask = 1.0 - abs(vNormal);
        vec2 fc = vec2(0.0);
        int k = 0;
        if (tangentMask.x > 0.5) { fc[k] = fr.x; k++; }
        if (tangentMask.y > 0.5) { fc[k] = fr.y; k++; }
        if (tangentMask.z > 0.5) { fc[k] = fr.z; }
        float edgeDist = 0.5 - max(fc.x, fc.y);
        float seam = mix(1.0, 0.72 + 0.28 * smoothstep(0.0, 0.09, edgeDist), uVoxelDetail);

        // ---- material identity: pattern + hue character ----
        float pat = 1.0;
        vec3 hue = vec3(1.0);
        if (mid == 1) { // STONE: strata bands + crack lines
          float bands = sin(p.y * 2.1 + vnoise(p * 0.6) * 3.5) * 0.5 + 0.5;
          float crack = smoothstep(0.74, 0.92, vnoise(p * 5.3));
          pat = (0.86 + 0.2 * bands) * (1.0 - 0.3 * crack);
          hue = mix(vec3(1.0), vec3(0.92, 0.96, 1.06), bands); // cool bands
        } else if (mid == 2) { // DIRT: patchy clumps + coarse grains
          float clump = floor(vnoise(p * 1.2) * 3.0) / 3.0;
          float grains = hash3(floor(p * 18.0));
          pat = 0.78 + 0.3 * clump + 0.14 * grains;
          hue = mix(vec3(1.0), vec3(1.14, 0.94, 0.78), clump * 0.5); // warm patches
        } else if (mid == 3) { // SAND: fine speckle + soft dune bands
          pat = 0.85 + 0.2 * hash3(floor(p * 26.0)) + 0.1 * sin(p.x * 0.8 + p.z * 0.6);
        } else if (mid == 4) { // WOOD: vertical fiber stripes
          float fiber = sin(p.y * 9.0 + vnoise(p * vec3(4.0, 0.6, 4.0)) * 4.0) * 0.5 + 0.5;
          pat = 0.8 + 0.3 * fiber;
          hue = mix(vec3(1.0), vec3(1.1, 0.92, 0.72), fiber * 0.4);
        } else if (mid == 5) { // METAL: brushed lines + rust blooms
          float brush = vnoise(vec3(p.x * 1.2, p.y * 16.0, p.z * 1.2));
          float rust = smoothstep(0.62, 0.9, vnoise(p * 0.9 + 31.0));
          pat = 0.88 + 0.16 * brush;
          hue = mix(vec3(1.0), vec3(1.25, 0.75, 0.5), rust * 0.55); // oxidised
        } else if (mid == 6 || mid == 7) { // GLASS / ICE: cold streaks
          float streak = vnoise(vec3(p.x * 0.7, p.y * 6.0, p.z * 0.7));
          pat = 0.92 + 0.16 * streak;
          hue = vec3(0.95, 1.02, 1.08);
        } else if (mid == 8) { // CRYSTAL: sharp sparkle facets
          float sparkle = pow(vnoise(p * 7.0), 6.0);
          pat = 0.9 + 2.2 * sparkle;
        } else if (mid == 9) { // GLOWCAP: porous dots
          float pores = smoothstep(0.6, 0.9, vnoise(p * 8.0));
          pat = 1.0 - 0.25 * pores;
        }

        vec3 albedo = vColor * hue * pat * tint * grain * mottle * seam;

        // ---- Reek biology swallows the grid (ground materials, up-faces) ----
        if (mid >= 1 && mid <= 3 && vNormal.y > 0.55) {
          // Mossy fungal mats: world-space patches that IGNORE tile edges.
          float mossN = vnoise(p * 0.85 + 7.0) * 0.65 + vnoise(p * 2.6 + 19.0) * 0.35;
          float moss = smoothstep(0.52, 0.72, mossN);
          vec3 mossCol = vec3(0.09, 0.2, 0.12) * (0.75 + 0.5 * vnoise(p * 6.3));
          albedo = mix(albedo, mossCol, moss * 0.85);
          // Wet dark ground bands — broad, soft, grid-agnostic.
          float wet = smoothstep(0.58, 0.8, vnoise(p * 0.2 + 41.0));
          albedo *= 1.0 - 0.32 * wet;
        }

        // ---- bump-from-noise: the surface has RELIEF under raking light.
        // Only computed where dynamic light actually reaches — everywhere
        // else is dark and relief would be invisible (darkness = perf budget).
        float odPre = distance(p, uOrbPos);
        float nearLight = step(odPre, uOrbRadius + 1.0);
        if (uPulseIntensity > 0.0 && uPulseRadius >= 0.0) {
          float pdPre = distance(p, uPulseCenter);
          nearLight = max(nearLight, step(abs(pdPre - uPulseRadius), uPulseThickness + 1.0));
        }
        vec3 bumpN = vNormal;
        if (nearLight > 0.5) {
          vec3 bt1 = normalize(cross(vNormal, vec3(0.0, 1.0, 0.001)));
          vec3 bt2 = cross(vNormal, bt1);
          float bh0 = vnoise(p * 3.4);
          float bhx = vnoise((p + bt1 * 0.22) * 3.4);
          float bhy = vnoise((p + bt2 * 0.22) * 3.4);
          bumpN = normalize(vNormal + (bt1 * (bh0 - bhx) + bt2 * (bh0 - bhy)) * 2.4);
        }

        // ---- lighting (bump normal: the texture catches raking light) ----
        // Orb bubble, facing-aware.
        float od = distance(p, uOrbPos);
        float bubble = 1.0 - clamp(od / uOrbRadius, 0.0, 1.0);
        bubble = bubble * bubble * uOrbIntensity;
        vec3 toOrb = normalize(uOrbPos - vWorld + 1e-4);
        float facing = 0.45 + 0.55 * clamp(dot(bumpN, toOrb), 0.0, 1.0);
        bubble *= facing;

        // Pulse shell.
        float pulse = 0.0;
        if (uPulseIntensity > 0.0 && uPulseRadius >= 0.0) {
          float pd = distance(p, uPulseCenter);
          float ring = 1.0 - clamp(abs(pd - uPulseRadius) / uPulseThickness, 0.0, 1.0);
          pulse = ring * ring * uPulseIntensity * facing;
        }

        // Sky bias: up-facing surfaces catch a touch more ambient — forms model.
        float sky = 0.75 + 0.25 * clamp(bumpN.y, 0.0, 1.0);

        float held = vBaked * (0.35 + 0.65 * vAO); // AO shapes the baked light
        held = held * held * 1.6; // quadratic response: bright cores, fast falloff into dark
        vec3 dyn = (bubble + pulse) * uOrbColor * vAO;

        vec3 lit = albedo * (uAmbient * sky * vAO) + albedo * held * uHeldColor + albedo * dyn;

        // Subtle emissive rim (ART.md §1.3, locked "subtle"): where a LIT
        // surface silhouettes against the dark, its edge catches a faint
        // light-colored line — form drawn by light, not texture.
        vec3 V = normalize(cameraPosition - vWorld);
        float rim = pow(1.0 - clamp(dot(vNormal, V), 0.0, 1.0), 3.5);
        lit += rim * 0.4 * (held * uHeldColor + (bubble + pulse) * uOrbColor) * vAO;

        // Moonlight: cold silver from the open sky — only when the clouds
        // part (uMoonI is gated by the CPU-side cloud check).
        lit += albedo * clamp(dot(bumpN, uMoonDir), 0.0, 1.0) * uMoonI * vec3(0.55, 0.65, 0.95) * vAO;

        // DARKNESS IS THE DRAW DISTANCE: light dies with distance from the
        // eye — but when moonlight floods in, the horizon briefly opens.
        lit *= exp(-distance(cameraPosition, vWorld) * 0.016 / (1.0 + uMoonI * 2.5));

        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });

  return { material, uniforms };
}
