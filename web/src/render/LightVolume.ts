import * as THREE from 'three';

/**
 * The world's light as a sampled 3D volume — the foundation of the light-driven
 * renderer (RESEARCH_lighting.md §TL;DR-2). The voxel flood-fill is packed into
 * a Data3DTexture that ANY material can sample at a world position, so terrain,
 * flora, the orb and dust all read the SAME propagating, geometry-shaped light
 * instead of each faking their own.
 *
 * Half voxel resolution (2 world units / texel) by default: flood-fill light is
 * soft and low-frequency, so trilinear filtering reads smooth while the texture
 * stays small enough (~1 MB) to re-upload cheaply when charge re-floods it.
 *
 * Shader side — map a world position into the volume and sample it:
 *   uniform highp sampler3D uLightVol;
 *   uniform vec3 uLightMin;      // world-space min corner
 *   uniform vec3 uLightInvSize;  // 1 / (max - min)
 *   vec3 c = (worldPos - uLightMin) * uLightInvSize;   // -> 0..1
 *   vec3 worldLight = texture(uLightVol, c).rgb;       // 0..1 per channel
 * (Sampling outside 0..1 clamps to the edge — dark, which is correct.)
 */
export class LightVolume {
  readonly texture: THREE.Data3DTexture;
  /** World-space min corner (shader uniform `uLightMin`). */
  readonly min: THREE.Vector3;
  /** 1 / world extent (shader uniform `uLightInvSize`). */
  readonly invSize: THREE.Vector3;

  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly step: number;
  private readonly data: Uint8Array;

  constructor(min: THREE.Vector3, max: THREE.Vector3, step = 2) {
    this.min = min.clone();
    this.step = step;
    const sx = max.x - min.x;
    const sy = max.y - min.y;
    const sz = max.z - min.z;
    this.invSize = new THREE.Vector3(1 / sx, 1 / sy, 1 / sz);
    this.nx = Math.max(1, Math.ceil(sx / step));
    this.ny = Math.max(1, Math.ceil(sy / step));
    this.nz = Math.max(1, Math.ceil(sz / step));

    // RGBA8: RGB = colored light, A reserved (solidity for the shadow pass).
    // Explicit ArrayBuffer backing so the type matches Data3DTexture's source.
    this.data = new Uint8Array(new ArrayBuffer(this.nx * this.ny * this.nz * 4));
    const tex = new THREE.Data3DTexture(this.data, this.nx, this.ny, this.nz);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;
  }

  /** Texel count, for logging/debug. */
  get texelCount(): number {
    return this.nx * this.ny * this.nz;
  }

  /**
   * Repopulate the whole volume from the flood-fill. `sampleLevel(x,y,z)` gives
   * a 0..15 light level at a world voxel. Written grayscale for now (the shader
   * tints it with the biome's held-light color, matching today's terrain look);
   * per-source color is a later pass that fills RGB directly.
   */
  rebuild(sampleLevel: (x: number, y: number, z: number) => number): void {
    const { nx, ny, nz, min, step, data } = this;
    let p = 0;
    for (let k = 0; k < nz; k++) {
      const wz = Math.round(min.z + (k + 0.5) * step);
      for (let j = 0; j < ny; j++) {
        const wy = Math.round(min.y + (j + 0.5) * step);
        for (let i = 0; i < nx; i++) {
          const wx = Math.round(min.x + (i + 0.5) * step);
          const v = Math.min(255, Math.round((sampleLevel(wx, wy, wz) / 15) * 255));
          data[p] = v;
          data[p + 1] = v;
          data[p + 2] = v;
          data[p + 3] = 255;
          p += 4;
        }
      }
    }
    this.texture.needsUpdate = true;
  }
}
