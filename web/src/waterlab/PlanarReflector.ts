/**
 * PlanarReflector — provider #1 of wAIver's reflection engine.
 *
 * True mirrored-scene reflections for horizontal planes (water now; any flat
 * mirror later). The scene is re-rendered from a camera reflected about the
 * plane into a half-res target with an OBLIQUE near plane (the projection's
 * near plane is bent onto the water plane, so geometry below the surface is
 * clipped exactly — no underwater ghosts) — the same math as THREE.Reflector,
 * extracted so the texture can feed OUR shaders instead of replacing them.
 *
 * Engine shape (see task: reflection engine): siblings SSR + cubemap probes
 * arrive with the Glare stages; all providers hand surfaces a texture + a
 * projective texture matrix and stay out of the material's way.
 *
 * Budget rules baked in: ONE active plane (the caller picks the body the
 * camera is near), half resolution, and the caller skips rendering entirely
 * when the camera is under the surface.
 */

import * as THREE from 'three';

export class PlanarReflector {
  readonly texture: THREE.Texture;
  /** Projective matrix mapping world → reflection UV (uniform uReflMatrix). */
  readonly textureMatrix = new THREE.Matrix4();

  private readonly rt: THREE.WebGLRenderTarget;
  private readonly mirrorCam = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly rPos = new THREE.Vector3();
  private readonly rTarget = new THREE.Vector3();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();

  constructor(scale = 0.5) {
    this.rt = new THREE.WebGLRenderTarget(
      Math.max(256, Math.floor(innerWidth * scale)),
      Math.max(256, Math.floor(innerHeight * scale)),
      { depthBuffer: true },
    );
    this.texture = this.rt.texture;
    addEventListener('resize', () => {
      this.rt.setSize(
        Math.max(256, Math.floor(innerWidth * scale)),
        Math.max(256, Math.floor(innerHeight * scale)),
      );
    });
  }

  /**
   * Render the mirrored scene for a horizontal plane at `level`.
   * `hidden` are meshes to exclude (the reflective surfaces themselves).
   */
  /**
   * `below` = the camera is UNDER the surface: render the internal mirror
   * (the underwater scene reflected back down — total internal reflection).
   * The mirror math is identical; only the clip side flips.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    level: number,
    hidden: THREE.Object3D[],
    below = false,
  ): void {
    const cam = this.mirrorCam;
    if (below) this.plane.set(new THREE.Vector3(0, -1, 0), level);
    else this.plane.set(new THREE.Vector3(0, 1, 0), -level);

    // Reflect the eye and its look direction about the plane (horizontal
    // plane → trivial y-mirror; keeps the math readable and branch-free).
    this.rPos.copy(camera.position);
    this.rPos.y = 2 * level - this.rPos.y;
    camera.getWorldDirection(this.rTarget);
    this.rTarget.y *= -1;
    cam.position.copy(this.rPos);
    cam.up.set(0, -1, 0); // flipped world: keep handedness so faces stay correct
    cam.lookAt(this.rPos.clone().add(this.rTarget));
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.near = camera.near;
    cam.far = camera.far;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // World → reflection UV (0..1 bias) for projective sampling.
    this.textureMatrix.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // Oblique near plane: clip exactly at the water plane (Lengyel's method).
    const p = this.plane.clone().applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    const proj = cam.projectionMatrix;
    this.q.x = (Math.sign(this.clip.x) + proj.elements[8]) / proj.elements[0];
    this.q.y = (Math.sign(this.clip.y) + proj.elements[9]) / proj.elements[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + proj.elements[10]) / proj.elements[14];
    this.clip.multiplyScalar(2.0 / this.clip.dot(this.q));
    proj.elements[2] = this.clip.x;
    proj.elements[6] = this.clip.y;
    proj.elements[10] = this.clip.z + 1.0;
    proj.elements[14] = this.clip.w;

    // Render with the reflective surfaces hidden.
    const vis = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXr;
    hidden.forEach((o, i) => (o.visible = vis[i]));
  }
}
