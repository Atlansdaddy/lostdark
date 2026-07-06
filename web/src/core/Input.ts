/**
 * Input abstraction (GDD §2 cross-platform: touch + mouse/kb + gamepad).
 *
 * Exposes an intent surface the orb reads — movement vector in camera space,
 * camera-orbit deltas, and edge-triggered actions. Three device schemes feed
 * the same intents:
 *
 *   KEYBOARD+MOUSE   WASD glide · SPACE wave-jump · F pulse · Shift dash/sprint
 *                    (tap = blink-dash, hold = sprint) · LMB-drag look · B ward · T tide
 *   ONE-HANDED MOUSE (design goal: full play with one hand)
 *                    LMB-drag look · RMB-hold glide forward · wheel-up jump
 *                    MMB pulse
 *   GAMEPAD          L-stick glide · R-stick look · A jump (hold = hover) · B dash
 *                    X pulse · Y ward · L3 camera view · R3 tide · Start menu
 *   TOUCH            left half = virtual move-stick · right half = look-drag
 *                    on-screen buttons: PULSE · JUMP · WARD
 *
 * Call update(dt) once per frame before reading intents (polls the gamepad).
 */

import { logger } from './log';

const TOUCH_STICK_RADIUS = 56; // px of drag for full speed
const inputLog = logger('input');

export class Input {
  private target: HTMLElement;
  private keys = new Set<string>();
  private orbitDrag = false;
  private rmbGlide = false;
  private lastX = 0;
  private lastY = 0;

  /** Touch state: one finger drives the stick, another the camera. */
  private touchMoveId: number | null = null;
  private touchMoveOrigin = { x: 0, y: 0 };
  private touchMove = { x: 0, z: 0 };
  private touchLookId: number | null = null;
  private touchLookLast = { x: 0, y: 0 };

  /** Visible dynamic joystick — a ring + nub that track the left thumb. */
  private stickBase: HTMLElement | null = null;
  private stickNub: HTMLElement | null = null;

  /** Accumulated camera-orbit delta (consumed each frame). */
  orbitDX = 0;
  orbitDY = 0;

  /** Edge-triggered actions, cleared after each frame's consume(). */
  private _pulse = false;
  private _jump = false;
  private _dash = false;
  private _buildWard = false;
  private _tide = false;
  /** Camera-mode toggle edge (KeyV / gamepad L3) — same flip as pressing V. */
  private _camToggle = false;

  /** Autoforward: toggled with KeyQ, cancelled by pulling back. */
  private autoForward = false;

  /** Pointer lock: desktop mouse-look without click-dragging. */
  private pointerLocked = false;

  /** Held (not edge) dash state per device — sprint is a HOLD. */
  private gpDashHeld = false;
  private touchDashHeld = false;
  /** Held jump state per device — HOLD to hover-boost (see Orb.update). */
  private gpJumpHeld = false;
  private touchJumpHeld = false;

  /** Gamepad state. */
  private gpMove = { x: 0, z: 0 };
  private gpDpad = { x: 0, z: 0 };
  private gpPrev = new Map<number, boolean[]>();
  private lastActivation = 'activation: none';
  private lastGamepadEvent = 'pad: waiting for browser gamepad API';

  constructor(el: HTMLElement) {
    this.target = el;
    this.target.tabIndex = this.target.tabIndex < 0 ? 0 : this.target.tabIndex;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    el.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('gamepadconnected', this.onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.target;
    });
    // On-screen action buttons for coarse-pointer (touch) devices.
    if (window.matchMedia('(pointer: coarse)').matches) this.buildTouchButtons();
  }

  private buildTouchButtons(): void {
    // Visible dynamic joystick: a ring that the left thumb summons (styled in
    // main.ts). The nub is a child so it re-centres with the base automatically.
    const base = document.createElement('div');
    base.className = 'touch-stick-base';
    const nub = document.createElement('div');
    nub.className = 'touch-stick-nub';
    base.appendChild(nub);
    document.body.appendChild(base);
    this.stickBase = base;
    this.stickNub = nub;

    // Right-thumb action cluster: a 2×2 grid of secondary verbs plus a large
    // primary PULSE dropped in the corner where the resting thumb already is.
    const wrap = document.createElement('div');
    wrap.className = 'touch-actions';
    const secondary = document.createElement('div');
    secondary.className = 'touch-secondary';
    const mk = (label: string, fire: () => void, opts: { tone?: string; primary?: boolean } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = `touch-action ${opts.tone ?? ''} ${opts.primary ? 'primary' : ''}`.replace(/\s+/g, ' ').trim();
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        fire();
      });
      (opts.primary ? wrap : secondary).appendChild(b);
      return b;
    };
    const jumpBtn = mk('JUMP', () => (this._jump = true));
    // JUMP taps a wave-jump; HELD it hover-boosts (finger up = let go / fall).
    jumpBtn.addEventListener('pointerdown', () => (this.touchJumpHeld = true));
    jumpBtn.addEventListener('pointerup', () => (this.touchJumpHeld = false));
    jumpBtn.addEventListener('pointercancel', () => (this.touchJumpHeld = false));
    jumpBtn.addEventListener('pointerleave', () => (this.touchJumpHeld = false));
    const dashBtn = mk('DASH', () => (this._dash = true));
    // DASH taps a blink-burst; HELD it also sprints (finger up = cruise).
    dashBtn.addEventListener('pointerdown', () => (this.touchDashHeld = true));
    dashBtn.addEventListener('pointerup', () => (this.touchDashHeld = false));
    dashBtn.addEventListener('pointercancel', () => (this.touchDashHeld = false));
    dashBtn.addEventListener('pointerleave', () => (this.touchDashHeld = false));
    mk('WARD', () => (this._buildWard = true));
    wrap.appendChild(secondary); // grid sits left of the primary in the flex row
    mk('PULSE', () => (this._pulse = true), { primary: true });
    document.body.appendChild(wrap);

    // TIDE is a build-time debug trigger, not a shipped verb — keep it off in a
    // corner by itself so it never reads as part of the player action cluster.
    const dev = document.createElement('button');
    dev.type = 'button';
    dev.textContent = 'TIDE';
    dev.className = 'touch-dev';
    dev.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._tide = true;
    });
    document.body.appendChild(dev);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.activateGamepadSurface();
    const k = e.code;
    if (!this.keys.has(k)) {
      // Edge actions
      if (k === 'Space') this._jump = true;
      if (k === 'KeyF') this._pulse = true;
      if (k === 'KeyQ') this.autoForward = !this.autoForward;
      if (k === 'ShiftLeft' || k === 'ShiftRight') this._dash = true;
      if (k === 'KeyB') this._buildWard = true;
      if (k === 'KeyT') this._tide = true;
    }
    this.keys.add(k);
    // Keep the page from scrolling on the movement/jump keys.
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onPointerDown = (e: PointerEvent) => {
    this.activateGamepadSurface();
    if (e.pointerType === 'touch') {
      e.preventDefault();
      if (e.clientX < window.innerWidth / 2 && this.touchMoveId === null) {
        // Left half: virtual stick anchored where the finger lands.
        this.touchMoveId = e.pointerId;
        this.touchMoveOrigin = { x: e.clientX, y: e.clientY };
        this.touchMove = { x: 0, z: 0 };
        if (this.stickBase) {
          this.stickBase.style.left = `${e.clientX}px`;
          this.stickBase.style.top = `${e.clientY}px`;
          this.stickBase.classList.add('active');
        }
        if (this.stickNub) this.stickNub.style.transform = 'translate(-50%, -50%)';
      } else if (this.touchLookId === null) {
        this.touchLookId = e.pointerId;
        this.touchLookLast = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    if (e.button === 0) {
      if (this.pointerLocked) {
        this._pulse = true; // locked: LMB IS the pulse (mouse-look is free)
      } else {
        // First click captures the mouse — fluid look, no dragging.
        // (Some embeds forbid pointer lock — swallow the rejection; the
        // drag fallback below covers those environments.)
        try {
          (this.target.requestPointerLock?.() as Promise<void> | undefined)?.catch((err) =>
            inputLog.trace('pointer lock denied — using drag fallback', err),
          );
        } catch (err) {
          inputLog.trace('pointer lock threw — using drag fallback', err);
        }
        this.orbitDrag = true; // drag fallback if lock is denied
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    } else if (e.button === 2) {
      this.rmbGlide = true; // one-handed: hold to glide forward
    } else if (e.button === 1) {
      this._pulse = true; // one-handed: middle-click pulse
      e.preventDefault();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.touchMoveId) {
        this.touchMoveId = null;
        this.touchMove = { x: 0, z: 0 };
        if (this.stickBase) this.stickBase.classList.remove('active');
      }
      if (e.pointerId === this.touchLookId) this.touchLookId = null;
      return;
    }
    if (e.button === 0) this.orbitDrag = false;
    if (e.button === 2) this.rmbGlide = false;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.touchMoveId) {
        // Stick deflection → move intent (screen-up = forward).
        const dx = (e.clientX - this.touchMoveOrigin.x) / TOUCH_STICK_RADIUS;
        const dy = (e.clientY - this.touchMoveOrigin.y) / TOUCH_STICK_RADIUS;
        const len = Math.hypot(dx, dy);
        const s = len > 1 ? 1 / len : 1;
        this.touchMove = { x: dx * s, z: dy * s };
        if (this.stickNub) {
          const px = this.touchMove.x * TOUCH_STICK_RADIUS;
          const py = this.touchMove.z * TOUCH_STICK_RADIUS;
          this.stickNub.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
        }
      } else if (e.pointerId === this.touchLookId) {
        // Thumbs sweep bigger arcs than mouse wrists — scale touch look down.
        this.orbitDX += (e.clientX - this.touchLookLast.x) * 0.75;
        this.orbitDY += (e.clientY - this.touchLookLast.y) * 0.75;
        this.touchLookLast = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    if (this.pointerLocked) {
      // Locked: raw relative motion drives the camera — no buttons needed.
      this.orbitDX += e.movementX;
      this.orbitDY += e.movementY;
      return;
    }
    if (!this.orbitDrag) return;
    this.orbitDX += e.clientX - this.lastX;
    this.orbitDY += e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) this._jump = true; // one-handed: flick up to wave-jump
  };

  private onGamepadConnected = (e: GamepadEvent) => {
    const mapping = e.gamepad.mapping || 'raw';
    this.lastGamepadEvent = `pad event: connected #${e.gamepad.index} ${mapping}`;
  };

  private onGamepadDisconnected = (e: GamepadEvent) => {
    this.lastGamepadEvent = `pad event: disconnected #${e.gamepad.index}`;
  };

  activateGamepadSurface(): void {
    window.focus();
    this.target.focus({ preventScroll: true });
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      const seen = Array.from(navigator.getGamepads()).filter((p): p is Gamepad => !!p && p.connected).length;
      this.lastActivation = `activation: focused, ${seen} pad${seen === 1 ? '' : 's'}`;
    } else {
      this.lastActivation = 'activation: focused, no Gamepad API';
    }
  }

  /** Poll gamepad. Call once per frame before reading intents. */
  update(dt: number): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const connected = Array.from(pads).filter((p): p is Gamepad => !!p && p.connected);
    const dz = (v: number, zone = 0.15) => (Math.abs(v) < zone ? 0 : v);
    if (connected.length === 0) {
      this.gpMove.x = 0;
      this.gpMove.z = 0;
      this.gpDpad.x = 0;
      this.gpDpad.z = 0;
      this.gpDashHeld = false;
      this.gpJumpHeld = false;
      this.gpPrev.clear();
      return;
    }

    let moveX = 0;
    let moveZ = 0;
    let dpadX = 0;
    let dpadZ = 0;
    let rx = 0;
    let ry = 0;
    let padDashHeld = false;
    let padJumpHeld = false;

    const nextPrev = new Map<number, boolean[]>();
    for (const gp of connected) {
      const prev = this.gpPrev.get(gp.index) ?? [];
      const stickX = dz(gp.axes[0] ?? 0);
      const stickZ = dz(gp.axes[1] ?? 0);
      if (Math.hypot(stickX, stickZ) > Math.hypot(moveX, moveZ)) {
        moveX = stickX;
        moveZ = stickZ;
      }

      const padX = (pressed(gp, 15) ? 1 : 0) - (pressed(gp, 14) ? 1 : 0);
      const padZ = (pressed(gp, 13) ? 1 : 0) - (pressed(gp, 12) ? 1 : 0);
      if (Math.hypot(padX, padZ) > Math.hypot(dpadX, dpadZ)) {
        dpadX = padX;
        dpadZ = padZ;
      }

      const lookX = dz(this.axisWithFallback(gp, [2, 4]), 0.18);
      const lookY = dz(this.axisWithFallback(gp, [3, 5]), 0.18);
      if (Math.hypot(lookX, lookY) > Math.hypot(rx, ry)) {
        rx = lookX;
        ry = lookY;
      }

      // Face buttons only (single-button verbs — no bumpers/triggers yet):
      //   A jump · B dash · X pulse · Y ward · L3 camera · R3 tide.
      // Start (9) is the menu button, handled by the menu's own pad poll.
      const edge = (i: number) => pressed(gp, i) && !prev[i];
      if (edge(0)) this._jump = true; // A
      if (edge(1)) this._dash = true; // B
      if (edge(2)) this._pulse = true; // X
      if (edge(3)) this._buildWard = true; // Y
      if (edge(11)) this._tide = true; // R3: call a tide (test)
      if (edge(10)) this._camToggle = true; // L3: flip camera mode (like KeyV)
      if (pressed(gp, 1)) padDashHeld = true; // B held → sprint
      if (pressed(gp, 0)) padJumpHeld = true; // A held → hover-boost

      nextPrev.set(gp.index, gp.buttons.map((b) => b.pressed));
    }

    this.gpMove.x = moveX;
    this.gpMove.z = moveZ;
    this.gpDpad.x = dpadX;
    this.gpDpad.z = dpadZ;
    this.gpDashHeld = padDashHeld;
    this.gpJumpHeld = padJumpHeld;
    this.orbitDX += rx * 520 * dt;
    this.orbitDY += ry * 380 * dt;
    this.gpPrev = nextPrev;
  }

  /** Jump HELD on any device → hover-boost (tap = wave-jump). Space / A / touch. */
  jumpHeld(): boolean {
    return this.keys.has('Space') || this.gpJumpHeld || this.touchJumpHeld;
  }

  /** Dash key HELD on any device → sprint at the old cruise speed (tap = dash). */
  sprinting(): boolean {
    return (
      this.keys.has('ShiftLeft') ||
      this.keys.has('ShiftRight') ||
      this.gpDashHeld ||
      this.touchDashHeld ||
      this.rmbGlide // one-handed: RMB glide cruises at sprint pace
    );
  }

  /** Horizontal movement intent in camera-local space: x = strafe, z = forward. */
  moveVector(): { x: number; z: number } {
    let x = this.gpMove.x + this.gpDpad.x + this.touchMove.x;
    let z = this.gpMove.z + this.gpDpad.z + this.touchMove.z;
    // Autoforward: glide ahead hands-free; any backward intent cancels it.
    if (this.autoForward) {
      if (z > 0.4 || this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.autoForward = false;
      else z -= 1;
    }
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.rmbGlide) z -= 1; // one-handed forward
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  /** Read + clear the accumulated orbit delta. */
  consumeOrbit(): { dx: number; dy: number } {
    const r = { dx: this.orbitDX, dy: this.orbitDY };
    this.orbitDX = 0;
    this.orbitDY = 0;
    return r;
  }

  /** Read + clear edge actions for this frame. */
  consumeActions(): {
    pulse: boolean;
    jump: boolean;
    dash: boolean;
    buildWard: boolean;
    tide: boolean;
    camToggle: boolean;
  } {
    const r = {
      pulse: this._pulse,
      jump: this._jump,
      dash: this._dash,
      buildWard: this._buildWard,
      tide: this._tide,
      camToggle: this._camToggle,
    };
    this._pulse = false;
    this._jump = false;
    this._dash = false;
    this._buildWard = false;
    this._tide = false;
    this._camToggle = false;
    return r;
  }

  debugGamepadStatus(): string {
    const hasApi = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
    const focus = typeof document !== 'undefined' && document.hasFocus ? document.hasFocus() : false;
    const visible = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    const secure = typeof window !== 'undefined' && window.isSecureContext ? 'yes' : 'no';
    const framed = isFramed() ? 'yes' : 'no';
    if (!hasApi) {
      return `pad: api unavailable | ${this.lastActivation} | focus:${focus ? 'yes' : 'no'} | vis:${visible} | secure:${secure} | frame:${framed}`;
    }
    const pads = navigator.getGamepads();
    const connected = Array.from(pads).filter((p): p is Gamepad => !!p && p.connected);
    if (connected.length === 0) {
      return `${this.lastGamepadEvent} | pad: none | ${this.lastActivation} | focus:${focus ? 'yes' : 'no'} | vis:${visible} | secure:${secure} | frame:${framed}`;
    }
    const summary = connected.slice(0, 2).map((gp) => {
      const activeButtons = gp.buttons
        .map((button, index) => (button.pressed || button.value > 0.2 ? index : null))
        .filter((index): index is number => index !== null)
        .slice(0, 4);
      const liveAxes = gp.axes
        .map((axis, index) => (Math.abs(axis) > 0.18 ? `${index}:${axis.toFixed(2)}` : null))
        .filter((value): value is string => value !== null)
        .slice(0, 4);
      const tag = gp.mapping || 'raw';
      return `#${gp.index} ${tag} a[${liveAxes.join(' ') || '-'}] b[${activeButtons.join(',') || '-'}]`;
    });
    return `${this.lastGamepadEvent} | pad: ${connected.length} ${summary.join(' | ')} | ${this.lastActivation} | focus:${focus ? 'yes' : 'no'} | vis:${visible} | secure:${secure} | frame:${framed}`;
  }

  private axisWithFallback(gp: Gamepad, indices: number[]): number {
    for (const index of indices) {
      const value = gp.axes[index];
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) > 0.001) return value;
    }
    return 0;
  }
}

function pressed(gp: Gamepad, index: number): boolean {
  return !!gp.buttons[index]?.pressed;
}

function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch (err) {
    inputLog.trace('window.top blocked (cross-origin) — assuming framed', err);
    return true;
  }
}
