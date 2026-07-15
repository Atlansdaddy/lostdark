import * as THREE from 'three';

/**
 * The world's flood-fill light as a sampled volume the shader can read at ANY
 * world position — the foundation of the light-driven renderer
 * (RESEARCH_lighting.md). So terrain, flora, orb and dust can all read the SAME
 * propagating, geometry-shaped light instead of each faking their own.
 *
 * WebGL2 3D textures need a newer shader version (a blind rewrite of the whole
 * terrain shader — a black-screen risk), so the volume is packed into a 2D
 * ATLAS: the Y layers are tiled across one DataTexture and the shader does the
 * trilinear blend itself. This keeps the proven GLSL1 terrain shader intact —
 * we only ADD sampling code, guarded by a mix that defaults to 0.
 *
 * Half voxel resolution (2 world units / texel) by default: flood-fill light is
 * soft and low-frequency, so bilinear + the manual layer blend read smooth while
 * the texture stays tiny (~1 MB) for cheap re-uploads when charge re-floods it.
 *
 * Shader side (GLSL1) — see litMaterial's sampleLightVol():
 *   uniform sampler2D uLightAtlas;  uniform vec3 uLightMin;  uniform float uLightStep;
 *   uniform vec3 uLightDim;         uniform vec2 uLightTiles;
 */
export class LightVolume {
  readonly texture: THREE.DataTexture;
  /** World-space min corner (uniform `uLightMin`). */
  readonly min: THREE.Vector3;
  /** World units per texel (uniform `uLightStep`). */
  readonly step: number;
  /** Layer counts nx, ny, nz (uniform `uLightDim`). */
  readonly dim: THREE.Vector3;
  /** Atlas tile grid tilesX, tilesY (uniform `uLightTiles`). */
  readonly tiles: THREE.Vector2;

  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly tx: number;
  private readonly aw: number; // atlas width in texels
  private readonly data: Uint8Array<ArrayBuffer>;

  constructor(min: THREE.Vector3, max: THREE.Vector3, step = 2) {
    this.min = min.clone();
    this.step = step;
    this.nx = Math.max(1, Math.ceil((max.x - min.x) / step));
    this.ny = Math.max(1, Math.ceil((max.y - min.y) / step));
    this.nz = Math.max(1, Math.ceil((max.z - min.z) / step));
    this.dim = new THREE.Vector3(this.nx, this.ny, this.nz);

    // Tile the ny Y-layers into a near-square atlas grid.
    this.tx = Math.ceil(Math.sqrt(this.ny));
    const ty = Math.ceil(this.ny / this.tx);
    this.tiles = new THREE.Vector2(this.tx, ty);
    this.aw = this.tx * this.nx;
    const ah = ty * this.nz;

    this.data = new Uint8Array(new ArrayBuffer(this.aw * ah * 4));
    const tex = new THREE.DataTexture(this.data, this.aw, ah, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
  }

  /**
   * Repopulate the whole atlas. `sampleLevel(x,y,z)` gives a 0..15 flood-fill
   * light level (written to RGB, tinted in-shader). `sampleSolid(x,y,z)` marks
   * occluders — written to ALPHA (255 solid, 0 open) so the shader can
   * ray-march real shadows through the world.
   */
  rebuild(
    sampleLevel: (x: number, y: number, z: number) => number,
    sampleSolid?: (x: number, y: number, z: number) => boolean,
  ): void {
    this.rebuildLayers(0, this.ny, sampleLevel, sampleSolid);
    this.texture.needsUpdate = true;
  }

  /**
   * Repopulate only Y-layers [jStart, jEnd) — the budgeted slice a moving
   * window rebuilds per frame while the world streams. Does NOT flag the
   * texture for upload; the caller commits once the full sweep completes so
   * the shader swaps min + data atomically (no mixed-window frames).
   */
  rebuildLayers(
    jStart: number,
    jEnd: number,
    sampleLevel: (x: number, y: number, z: number) => number,
    sampleSolid?: (x: number, y: number, z: number) => boolean,
  ): void {
    const { nx, ny, nz, tx, aw, min, step, data } = this;
    for (let j = Math.max(0, jStart); j < Math.min(ny, jEnd); j++) {
      const wy = Math.round(min.y + (j + 0.5) * step);
      const baseX = (j % tx) * nx;
      const baseY = Math.floor(j / tx) * nz;
      for (let k = 0; k < nz; k++) {
        const wz = Math.round(min.z + (k + 0.5) * step);
        const rowBase = ((baseY + k) * aw + baseX) * 4;
        for (let i = 0; i < nx; i++) {
          const wx = Math.round(min.x + (i + 0.5) * step);
          const v = Math.min(255, Math.round((sampleLevel(wx, wy, wz) / 15) * 255));
          const idx = rowBase + i * 4;
          data[idx] = v;
          data[idx + 1] = v;
          data[idx + 2] = v;
          data[idx + 3] = sampleSolid && sampleSolid(wx, wy, wz) ? 255 : 0;
        }
      }
    }
  }
}
