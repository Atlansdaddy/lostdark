/**
 * FolkEffects — pooled particles, projectiles and health bars for the folk.
 *
 * Same discipline as BuildSandbox's debris: flat typed arrays over one
 * THREE.Points per pool, additive mote sprites, zero per-frame allocation.
 * Everything here lives on LAYER 1 (effects — skipped by the fog depth
 * prepass), matching every other additive FX in the game.
 */

import * as THREE from 'three';

/** A spore-bolt in flight. Damage/knock resolution is the CALLER's job via
 *  the onHit callback — effects only fly, trail, and burst. */
export interface Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  color: THREE.Color;
  sprite: THREE.Sprite;
  trailAcc: number;
  /** 'orb' hit → callback with impact point; 'world' hit → just a burst. */
  onHit: ((point: THREE.Vector3) => void) | null;
}

const MOTES_MAX = 420;
const PROJ_MAX = 24;
const GRAV = 4.5; // spores are floaty — a fraction of world gravity

export class FolkEffects {
  readonly group = new THREE.Group();

  // --- mote pool -----------------------------------------------------------
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly base: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private head = 0;
  private readonly geo: THREE.BufferGeometry;

  // --- projectiles ---------------------------------------------------------
  private readonly projectiles: Projectile[] = [];
  private readonly spritePool: THREE.Sprite[] = [];
  private readonly moteTexture: THREE.Texture;

  constructor(scene: THREE.Scene, moteTexture: THREE.Texture) {
    this.moteTexture = moteTexture;

    this.pos = new Float32Array(MOTES_MAX * 3).fill(-9999);
    this.col = new Float32Array(MOTES_MAX * 3);
    this.vel = new Float32Array(MOTES_MAX * 3);
    this.life = new Float32Array(MOTES_MAX);
    this.maxLife = new Float32Array(MOTES_MAX);
    this.base = new Float32Array(MOTES_MAX * 3);
    this.drag = new Float32Array(MOTES_MAX);
    this.grav = new Float32Array(MOTES_MAX);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const points = new THREE.Points(
      this.geo,
      new THREE.PointsMaterial({
        size: 0.3,
        map: moteTexture,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    points.frustumCulled = false;
    points.layers.set(1); // effects layer — skipped by the depth prepass
    this.group.add(points);
    scene.add(this.group);
  }

  /** Radial burst — spore pops, impact sparks, death puffs. */
  burst(
    center: THREE.Vector3,
    color: THREE.Color | number,
    opts: { count?: number; speed?: number; life?: number; up?: number; drag?: number; grav?: number } = {},
  ): void {
    const { count = 14, speed = 3.2, life = 0.9, up = 1.2, drag = 2.2, grav = GRAV } = opts;
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % MOTES_MAX;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.pos[i * 3] = center.x;
      this.pos[i * 3 + 1] = center.y;
      this.pos[i * 3 + 2] = center.z;
      this.vel[i * 3] = Math.sin(ph) * Math.cos(th) * s;
      this.vel[i * 3 + 1] = Math.cos(ph) * s * 0.7 + up * Math.random();
      this.vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * s;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.drag[i] = drag;
      this.grav[i] = grav;
      this.base[i * 3] = c.r;
      this.base[i * 3 + 1] = c.g;
      this.base[i * 3 + 2] = c.b;
    }
  }

  /** Single drifting mote — projectile trails, weapon swing trails. */
  mote(p: THREE.Vector3, color: THREE.Color | number, life = 0.5, driftY = 0.3): void {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    const i = this.head;
    this.head = (this.head + 1) % MOTES_MAX;
    this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.08;
    this.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * 0.08;
    this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.08;
    this.vel[i * 3] = (Math.random() - 0.5) * 0.3;
    this.vel[i * 3 + 1] = driftY * (0.5 + Math.random() * 0.5);
    this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    this.life[i] = this.maxLife[i] = life;
    this.drag[i] = 1.2;
    this.grav[i] = 0;
    this.base[i * 3] = c.r;
    this.base[i * 3 + 1] = c.g;
    this.base[i * 3 + 2] = c.b;
  }

  /** Launch a spore-bolt. Returns null if the pool is exhausted. */
  fireProjectile(
    from: THREE.Vector3,
    toward: THREE.Vector3,
    opts: { speed?: number; color?: number; life?: number; arc?: number; onHit?: (p: THREE.Vector3) => void } = {},
  ): Projectile | null {
    if (this.projectiles.length >= PROJ_MAX) return null;
    const { speed = 13, color = 0xb28aff, life = 2.6, arc = 1.6, onHit } = opts;

    let sprite = this.spritePool.pop();
    if (!sprite) {
      sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.moteTexture,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sprite.scale.setScalar(0.55);
      sprite.layers.set(1);
    }
    (sprite.material as THREE.SpriteMaterial).color.set(color);
    sprite.visible = true;
    sprite.position.copy(from);
    this.group.add(sprite);

    const dir = toward.clone().sub(from).normalize();
    const p: Projectile = {
      pos: from.clone(),
      vel: dir.multiplyScalar(speed).add(new THREE.Vector3(0, arc, 0)), // lob
      life,
      color: new THREE.Color(color),
      sprite,
      trailAcc: 0,
      onHit: onHit ?? null,
    };
    this.projectiles.push(p);
    return p;
  }

  /**
   * Advance motes + projectiles.
   * @param solid   voxel query for world impacts
   * @param orbPos  the player — projectiles pop against the orb's bubble
   * @param onOrbHit fired when a bolt reaches the orb
   * @param lightAt  0..1 how lit a point is (motes dim with distance from
   *                 the orb — the dark eats stray light, same as debris)
   */
  update(
    dt: number,
    solid: (x: number, y: number, z: number) => boolean,
    orbPos: THREE.Vector3,
    onOrbHit?: (p: Projectile) => void,
  ): void {
    // Motes: ballistic + drag + fade. Colour = base × life-fade × orb-light.
    for (let i = 0; i < MOTES_MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -9999;
        continue;
      }
      const dragK = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= dragK;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dragK - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= dragK;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const fade = Math.min(1, this.life[i] / (this.maxLife[i] * 0.45));
      this.col[i * 3] = this.base[i * 3] * fade;
      this.col[i * 3 + 1] = this.base[i * 3 + 1] * fade;
      this.col[i * 3 + 2] = this.base[i * 3 + 2] * fade;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;

    // Projectiles.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.vel.y -= GRAV * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.sprite.position.copy(p.pos);

      p.trailAcc += dt;
      if (p.trailAcc > 0.035) {
        p.trailAcc = 0;
        this.mote(p.pos, p.color, 0.45, 0.1);
      }

      const hitWorld = solid(Math.floor(p.pos.x), Math.floor(p.pos.y), Math.floor(p.pos.z));
      const hitOrb = p.pos.distanceToSquared(orbPos) < 1.1;
      if (hitWorld || hitOrb || p.life <= 0) {
        this.burst(p.pos, p.color, { count: 16, speed: 2.6, life: 0.8, grav: 1.5 });
        if (hitOrb) onOrbHit?.(p);
        p.onHit?.(p.pos);
        this.releaseProjectile(i);
      }
    }
  }

  private releaseProjectile(idx: number): void {
    const p = this.projectiles[idx];
    p.sprite.visible = false;
    p.sprite.removeFromParent();
    this.spritePool.push(p.sprite);
    this.projectiles.splice(idx, 1);
  }
}

// --- Health bars ------------------------------------------------------------

/** Thin glowing bar over a folk's head: hidden until hurt, fades back out.
 *  Teal → ember-red as health drains (readable in a black world). */
export class HealthBar {
  readonly group = new THREE.Group();
  private fg: THREE.Mesh;
  private bg: THREE.Mesh;
  private visibleFor = 0;

  constructor() {
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x081014,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const fgMat = new THREE.MeshBasicMaterial({
      color: 0x54e8c8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.075), bgMat);
    this.fg = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.045), fgMat);
    this.fg.position.z = 0.001;
    this.group.add(this.bg, this.fg);
    this.group.renderOrder = 6;
    this.bg.layers.set(1);
    this.fg.layers.set(1);
    this.group.visible = false;
  }

  /** Pop the bar visible (damage just landed). */
  show(): void {
    this.visibleFor = 3.2;
  }

  update(dt: number, frac: number, camera: THREE.Camera): void {
    this.visibleFor = Math.max(0, this.visibleFor - dt);
    const alpha = Math.min(1, this.visibleFor / 0.5);
    this.group.visible = alpha > 0.01;
    if (!this.group.visible) return;

    this.group.quaternion.copy(camera.quaternion); // billboard
    const f = Math.max(0, Math.min(1, frac));
    this.fg.scale.x = Math.max(0.001, f);
    this.fg.position.x = -0.34 * (1 - f); // shrink from the right
    const mat = this.fg.material as THREE.MeshBasicMaterial;
    mat.color.setHSL(0.45 * f + 0.02, 0.85, 0.55); // teal → red
    mat.opacity = alpha * 0.95;
    (this.bg.material as THREE.MeshBasicMaterial).opacity = alpha * 0.6;
  }
}

// --- Hit flash ---------------------------------------------------------------

/** Boost every emissive on a model for a beat when damage lands. */
export class HitFlash {
  private mats: { m: THREE.MeshStandardMaterial; base: number }[] = [];
  private t = 0;

  constructor(root: THREE.Object3D) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const raw of list) {
        const m = raw as THREE.MeshStandardMaterial;
        if (m.emissive) this.mats.push({ m, base: m.emissiveIntensity ?? 1 });
      }
    });
  }

  flash(): void {
    this.t = 0.18;
  }

  update(dt: number): void {
    if (this.t <= 0) return;
    this.t = Math.max(0, this.t - dt);
    const boost = 1 + 5 * (this.t / 0.18);
    for (const e of this.mats) e.m.emissiveIntensity = e.base * boost;
  }
}
