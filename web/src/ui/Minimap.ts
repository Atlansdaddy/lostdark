/**
 * Minimap — the corner DISCOVERY map.
 *
 * The Reek stays true to itself even here: the map is BLACK until you've been
 * somewhere. Moving through the world burns away the fog around your path
 * (soft-edged, persisted to localStorage so exploration survives reloads).
 * On top of the discovered terrain: marked locations (the testbed zones, your
 * spawn, every ward you raise), a player arrow, and a biome/POI line naming
 * where you are.
 *
 * Settings (Menu → Settings → Map): size S/M/L · shape square/round ·
 * orientation north-up / follow-view · visible on/off. All persisted.
 *
 * Implementation: pure 2D canvas — a one-time top-down bake of the voxel world
 * (1px per column, height-shaded, emissives glint, water reads as water), a
 * half-res discovery mask composited as fog, then markers/arrow in screen
 * space. No WebGL, no per-frame world reads.
 */

import { World } from '../config';
import { Mat, MATERIALS } from '../world/Materials';
import { Chunk, VoxelWorld } from '../world/VoxelWorld';
import { logger } from '../core/log';

const log = logger('minimap');

export interface MapMarker {
  x: number;
  z: number;
  icon: string;
  label: string;
  color: string;
}

export interface MapPrefs {
  visible: boolean;
  size: 'S' | 'M' | 'L';
  shape: 'square' | 'round';
  /** true = the map rotates so your view direction is up; false = north-up. */
  rotate: boolean;
  /** Minimized to a small tap-to-open icon (default true on phones). */
  collapsed: boolean;
}

const PREF_KEY = 'waiver.map.prefs';
const DISC_KEY = 'waiver.map.disc';
const SIZE_PX: Record<MapPrefs['size'], number> = { S: 140, M: 190, L: 252 };
const SIZE_SPAN: Record<MapPrefs['size'], number> = { S: 84, M: 116, L: 148 };
const REVEAL_R = 9; // discovery stamp radius, in fog cells (×2 = voxels)

export class Minimap {
  private readonly half: number;
  private readonly biomeAt: (x: number, z: number) => string;
  private readonly container: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly labelEl: HTMLDivElement;
  /** ⛶/– control that minimizes the map to an icon and back. */
  private readonly toggleBtn: HTMLButtonElement;
  /** Touch device? Phones open the map collapsed and draw it smaller. */
  private readonly coarse: boolean;
  private readonly base: HTMLCanvasElement;
  private readonly fogCanvas: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;
  /** Discovery grid at HALF map resolution (1 cell = 2 voxels), 0..255. */
  private readonly DR: number;
  private readonly disc: Uint8Array;
  private markers: MapMarker[] = [];
  private prefs: MapPrefs = { visible: true, size: 'M', shape: 'round', rotate: true, collapsed: false };
  private lastRevealX = 1e9;
  private lastRevealZ = 1e9;
  private discDirty = false;
  private saveT = 0;
  private drawT = 0;
  private labelT = 0;

  constructor(world: VoxelWorld, half: number, biomeAt: (x: number, z: number) => string) {
    this.half = half;
    this.biomeAt = biomeAt;
    this.DR = half; // (half*2 voxels) / 2 per cell
    this.disc = new Uint8Array(this.DR * this.DR);

    // --- DOM ---
    this.container = document.createElement('div');
    this.container.className = 'waiver-minimap';
    this.canvas = document.createElement('canvas');
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'waiver-minimap-label';
    // Phones open the map as a small icon so it isn't hogging the screen.
    this.coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (this.coarse) this.prefs.collapsed = true;
    // Minimize/maximize control — a normal flex child above the map (right-
    // aligned), and the ONLY thing shown while collapsed.
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.type = 'button';
    this.toggleBtn.className = 'waiver-minimap-toggle';
    this.toggleBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.setPrefs({ collapsed: !this.prefs.collapsed });
    });
    this.container.append(this.toggleBtn, this.canvas, this.labelEl);
    document.body.appendChild(this.container);
    const style = document.createElement('style');
    style.textContent = `
      .waiver-minimap {
        position: fixed;
        top: 34px;
        right: 12px;
        z-index: 28;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
        pointer-events: none;
      }
      .waiver-minimap canvas {
        border: 1px solid rgba(127, 220, 255, 0.35);
        background: rgba(2, 5, 7, 0.85);
        box-shadow: 0 0 24px rgba(0, 0, 0, 0.55), inset 0 0 18px rgba(80, 216, 255, 0.05);
      }
      .waiver-minimap-toggle {
        width: 34px;
        height: 34px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #bfefff;
        background: rgba(2, 10, 14, 0.6);
        border: 1px solid rgba(127, 220, 255, 0.4);
        box-shadow: 0 0 14px rgba(80, 216, 255, 0.12);
        font: 15px/1 ui-monospace, Menlo, Consolas, monospace;
        pointer-events: auto;
        cursor: pointer;
        -webkit-user-select: none;
        user-select: none;
        touch-action: none;
      }
      /* Collapsed: hide the map + label, leaving just the tap-to-open icon. */
      .waiver-minimap.collapsed canvas,
      .waiver-minimap.collapsed .waiver-minimap-label {
        display: none;
      }
      .waiver-minimap-label {
        max-width: 260px;
        padding: 3px 9px;
        border-radius: 6px;
        background: rgba(2, 6, 7, 0.72);
        border: 1px solid rgba(127, 220, 255, 0.22);
        color: #9fe8ff;
        font: 10px/1.4 ui-monospace, Menlo, Consolas, monospace;
        letter-spacing: 0.06em;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }
      @media (max-width: 720px), (pointer: coarse) {
        /* Clear the touch-dev TIDE button that owns the top-right on phones. */
        .waiver-minimap { top: 88px; }
      }
    `;
    document.head.appendChild(style);

    // --- offscreen layers ---
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = half * 2;
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = this.fogCanvas.height = this.DR;
    this.fogCtx = this.fogCanvas.getContext('2d')!;
    this.ctx = this.canvas.getContext('2d')!;

    this.bake(world);
    this.loadPrefs();
    this.loadDisc();
    this.rebuildFog();
    this.applyPrefs();
    window.addEventListener('pagehide', () => this.saveDisc());
  }

  // --- public API -----------------------------------------------------------

  getPrefs(): MapPrefs {
    return { ...this.prefs };
  }

  setPrefs(p: Partial<MapPrefs>): void {
    Object.assign(this.prefs, p);
    this.applyPrefs();
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(this.prefs));
    } catch (err) {
      log.debug('prefs not persisted', err);
    }
  }

  setMarkers(markers: MapMarker[]): void {
    this.markers = markers.slice();
  }

  addMarker(m: MapMarker): void {
    this.markers.push(m);
  }

  /** Per-frame driver. Reveals around the player, redraws at ~30 Hz. */
  update(dt: number, pos: { x: number; y: number; z: number }, yaw: number): void {
    if (!this.prefs.visible) return;
    // Burn away fog when we've moved a couple of voxels since the last stamp.
    const mdx = pos.x - this.lastRevealX;
    const mdz = pos.z - this.lastRevealZ;
    if (mdx * mdx + mdz * mdz > 4) {
      this.lastRevealX = pos.x;
      this.lastRevealZ = pos.z;
      this.reveal(pos.x, pos.z);
    }
    // Discovery persistence — throttled, only when something new burned in.
    this.saveT += dt;
    if (this.discDirty && this.saveT > 6) {
      this.saveT = 0;
      this.saveDisc();
    }
    // Minimized to an icon: keep revealing fog above so the map is current when
    // reopened, but skip the (costly) canvas redraw + label work entirely.
    if (this.prefs.collapsed) return;
    this.drawT += dt;
    if (this.drawT >= 1 / 30) {
      this.drawT = 0;
      this.draw(pos, yaw);
    }
    this.labelT += dt;
    if (this.labelT > 0.25) {
      this.labelT = 0;
      this.labelEl.textContent = this.biomeAt(pos.x, pos.z);
    }
  }

  // --- bake: one-time top-down view of the voxel world ----------------------

  private bake(world: VoxelWorld): void {
    const t0 = performance.now();
    const W = this.half * 2;
    const CS = World.chunkSize;
    const topY = new Int16Array(W * W).fill(-32768);
    const topMat = new Uint8Array(W * W);
    // Single pass over raw chunk data (no per-voxel world.get key churn).
    for (const c of world.chunks.values()) {
      const bX = c.cx * CS;
      const bY = c.cy * CS;
      const bZ = c.cz * CS;
      for (let lz = 0; lz < CS; lz++) {
        const gz = bZ + lz + this.half;
        if (gz < 0 || gz >= W) continue;
        for (let lx = 0; lx < CS; lx++) {
          const gx = bX + lx + this.half;
          if (gx < 0 || gx >= W) continue;
          const ci = gz * W + gx;
          if (topY[ci] >= bY + CS - 1) continue; // a higher chunk already answered
          for (let ly = CS - 1; ly >= 0; ly--) {
            const m = c.voxels[Chunk.index(lx, ly, lz)];
            if (m !== Mat.Air) {
              const wy = bY + ly;
              if (wy > topY[ci]) {
                topY[ci] = wy;
                topMat[ci] = m;
              }
              break;
            }
          }
        }
      }
    }
    const bctx = this.base.getContext('2d')!;
    const img = bctx.createImageData(W, W);
    for (let i = 0; i < W * W; i++) {
      const o = i * 4;
      if (topY[i] === -32768) {
        img.data[o + 3] = 255; // void — stays near-black
        img.data[o + 2] = 6;
        continue;
      }
      const m = topMat[i] as Mat;
      const mat = MATERIALS[m];
      let r: number;
      let g: number;
      let b: number;
      if (m === Mat.Water) {
        [r, g, b] = [30, 92, 132]; // the lake reads as WATER at a glance
      } else if (mat.emission > 0) {
        // Emissive columns (groves, crystals, embers) glint on the map.
        r = mat.emissionColor[0] * 225;
        g = mat.emissionColor[1] * 225;
        b = mat.emissionColor[2] * 225;
      } else {
        // Height-shaded albedo: valleys dim, ridges bright.
        const shade = Math.min(1.05, Math.max(0.35, 0.62 + (topY[i] - 4) * 0.03));
        r = mat.color[0] * 255 * shade;
        g = mat.color[1] * 255 * shade;
        b = mat.color[2] * 255 * shade;
      }
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
    log.info(`baked ${W}×${W} in ${Math.round(performance.now() - t0)}ms`);
  }

  // --- discovery fog ---------------------------------------------------------

  private reveal(wx: number, wz: number): void {
    const cx = (wx + this.half) / 2;
    const cz = (wz + this.half) / 2;
    const R = REVEAL_R;
    for (let dz = -R; dz <= R; dz++) {
      const iz = Math.round(cz + dz);
      if (iz < 0 || iz >= this.DR) continue;
      for (let dx = -R; dx <= R; dx++) {
        const ix = Math.round(cx + dx);
        if (ix < 0 || ix >= this.DR) continue;
        const d = Math.sqrt(dx * dx + dz * dz) / R;
        if (d > 1) continue;
        const v = Math.round(255 * (1 - Math.pow(d, 1.7)));
        const idx = iz * this.DR + ix;
        if (v > this.disc[idx]) {
          this.disc[idx] = v;
          this.discDirty = true;
        }
      }
    }
    this.rebuildFog();
  }

  /** disc → fog canvas (black, alpha = undiscovered). Upscaling smooths edges. */
  private rebuildFog(): void {
    const img = this.fogCtx.createImageData(this.DR, this.DR);
    for (let i = 0; i < this.disc.length; i++) {
      img.data[i * 4 + 3] = 255 - this.disc[i];
    }
    this.fogCtx.putImageData(img, 0, 0);
  }

  // --- drawing ----------------------------------------------------------------

  private applyPrefs(): void {
    this.container.style.display = this.prefs.visible ? 'flex' : 'none';
    this.container.classList.toggle('collapsed', this.prefs.collapsed);
    this.toggleBtn.textContent = this.prefs.collapsed ? '🗺' : '–';
    this.toggleBtn.setAttribute('aria-label', this.prefs.collapsed ? 'Open map' : 'Minimize map');
    const px = this.sizePx();
    this.canvas.style.width = this.canvas.style.height = `${px}px`;
    this.canvas.style.borderRadius = this.prefs.shape === 'round' ? '50%' : '10px';
  }

  /** Expanded map footprint. The desktop S/M/L sizes are too big for a thumb
   *  screen, so phones render at ~60% — still readable, far less in the way. */
  private sizePx(): number {
    const base = SIZE_PX[this.prefs.size];
    return this.coarse ? Math.round(base * 0.6) : base;
  }

  private draw(pos: { x: number; z: number }, yaw: number): void {
    const px = this.sizePx();
    const span = SIZE_SPAN[this.prefs.size];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== px * dpr) {
      this.canvas.width = this.canvas.height = px * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, px, px);

    // Forward direction in map space (px = world x, py = world z).
    const fwdA = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
    const theta = this.prefs.rotate ? -Math.PI / 2 - fwdA : 0;

    ctx.save();
    // Clip to the map shape.
    ctx.beginPath();
    if (this.prefs.shape === 'round') ctx.arc(px / 2, px / 2, px / 2 - 1, 0, Math.PI * 2);
    else ctx.roundRect(1, 1, px - 2, px - 2, 9);
    ctx.clip();
    ctx.fillStyle = '#020507';
    ctx.fillRect(0, 0, px, px);

    // Terrain + fog, rotated about the player. Source window is 1.45× the
    // span so a rotated square never shows empty corners.
    ctx.translate(px / 2, px / 2);
    ctx.rotate(theta);
    const scale = px / span;
    const srcHalf = span * 0.725;
    const mapX = pos.x + this.half;
    const mapZ = pos.z + this.half;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.base,
      mapX - srcHalf,
      mapZ - srcHalf,
      srcHalf * 2,
      srcHalf * 2,
      -srcHalf * scale,
      -srcHalf * scale,
      srcHalf * 2 * scale,
      srcHalf * 2 * scale,
    );
    // Fog of war (half-res grid, same window).
    ctx.drawImage(
      this.fogCanvas,
      (mapX - srcHalf) / 2,
      (mapZ - srcHalf) / 2,
      srcHalf,
      srcHalf,
      -srcHalf * scale,
      -srcHalf * scale,
      srcHalf * 2 * scale,
      srcHalf * 2 * scale,
    );
    ctx.restore();

    // Markers — screen-space so labels stay upright; clamped to the rim so
    // off-window POIs become direction pointers (how you FIND the lake).
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const c = px / 2;
    for (const m of this.markers) {
      const dx = (m.x - pos.x) * scale;
      const dz = (m.z - pos.z) * scale;
      let mx = dx * cosT - dz * sinT;
      let mz = dx * sinT + dz * cosT;
      let clamped = false;
      if (this.prefs.shape === 'round') {
        const len = Math.hypot(mx, mz);
        const lim = c - 10;
        if (len > lim) {
          mx = (mx / len) * lim;
          mz = (mz / len) * lim;
          clamped = true;
        }
      } else {
        const lim = c - 10;
        if (Math.abs(mx) > lim || Math.abs(mz) > lim) {
          const s = lim / Math.max(Math.abs(mx), Math.abs(mz));
          mx *= s;
          mz *= s;
          clamped = true;
        }
      }
      ctx.save();
      ctx.translate(c + mx, c + mz);
      ctx.shadowColor = m.color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = m.color;
      ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, 0, 0);
      if (!clamped && this.prefs.size !== 'S') {
        ctx.shadowBlur = 0;
        ctx.font = '600 8px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillStyle = 'rgba(223, 252, 241, 0.85)';
        ctx.fillText(m.label, 0, 10);
      }
      ctx.restore();
    }

    // Player arrow — center. Follow mode: always up; north-up: shows heading.
    const arrowA = this.prefs.rotate ? -Math.PI / 2 : fwdA;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(arrowA + Math.PI / 2); // triangle drawn pointing up (−y)
    ctx.shadowColor = '#8defff';
    ctx.shadowBlur = 7;
    ctx.fillStyle = '#c8f4ff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.4, 5);
    ctx.lineTo(0, 2.4);
    ctx.lineTo(-4.4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // North indicator (rim). North = world −Z.
    const nA = Math.atan2(-cosT * -1, sinT * -1); // rotate (0,-1) by theta → angle
    const nx = c + Math.cos(nA) * (c - 9);
    const nz = c + Math.sin(nA) * (c - 9);
    ctx.fillStyle = 'rgba(159, 232, 255, 0.75)';
    ctx.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, nz);
  }

  // --- persistence ------------------------------------------------------------

  private loadPrefs(): void {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) Object.assign(this.prefs, JSON.parse(raw) as Partial<MapPrefs>);
    } catch (err) {
      log.debug('prefs not loaded', err);
    }
  }

  private saveDisc(): void {
    if (!this.discDirty) return;
    this.discDirty = false;
    try {
      let s = '';
      for (let i = 0; i < this.disc.length; i += 8192) {
        s += String.fromCharCode(...this.disc.subarray(i, i + 8192));
      }
      localStorage.setItem(DISC_KEY, btoa(s));
    } catch (err) {
      log.debug('discovery not persisted', err);
    }
  }

  private loadDisc(): void {
    try {
      const raw = localStorage.getItem(DISC_KEY);
      if (!raw) return;
      const s = atob(raw);
      if (s.length !== this.disc.length) return; // world size changed — start fresh
      for (let i = 0; i < s.length; i++) this.disc[i] = s.charCodeAt(i);
    } catch (err) {
      log.debug('discovery not loaded', err);
    }
  }
}
