/**
 * MobileShell — reclaim the phone: keep the screen awake and take the full
 * glass in WHATEVER orientation it's held (portrait or landscape — no forced
 * rotation). Two browser capabilities, each feature-detected and failing soft:
 *
 *   Screen Wake Lock  Android Chrome ✓ · iPadOS 16.4+ Safari ✓ · older iOS ✗
 *                     Re-acquired after the tab is backgrounded (the OS drops
 *                     the lock on every visibility change).
 *   Fullscreen        Android Chrome ✓ · iPad Safari ✓ (iPadOS 15+) · iPhone ✗
 *                     Requested on the FIRST user gesture (a tap/keypress) so it
 *                     rides a real activation — browsers reject it otherwise.
 *                     Skipped when already running as an installed PWA (there
 *                     are no browser bars to hide).
 *
 * On iPhone the reliable way to lose the Safari chrome is "Add to Home Screen"
 * (standalone display via the manifest), which this module detects and respects.
 */

import { logger } from './log';

const log = logger('shell');

/** Fullscreen only makes sense on touch devices with browser chrome to reclaim. */
function isCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** True when launched from the home screen (iOS `standalone` or PWA display-mode). */
function isStandalone(): boolean {
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  const displayStandalone =
    typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  return iosStandalone || displayStandalone;
}

class MobileShell {
  private wakeLock: WakeLockSentinel | null = null;
  private wantWakeLock = false;
  private started = false;

  /**
   * Wire up the shell. Safe to call once at boot. `autoFullscreen` gates the
   * take-the-glass-on-first-tap behaviour (default on for touch); pass false to
   * only manage the wake lock and expose manual toggles.
   */
  start(opts: { autoFullscreen?: boolean } = {}): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    // Keep the display awake for the whole session; re-take it whenever the tab
    // returns to the foreground (the lock is dropped on background/lock).
    this.requestWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantWakeLock) this.requestWakeLock();
    });

    const wantFs = opts.autoFullscreen ?? isCoarsePointer();
    if (wantFs && !isStandalone()) {
      // A visible, direct-tap button is the ONLY reliable way in: the auto
      // first-gesture below is often swallowed by the menu/joystick that
      // receives the very first touch, so give the player an explicit control.
      this.buildFullscreenButton();
      // Bonus auto-attempt on the first gesture that reaches window. Latches
      // once; harmless if it's beaten to it by the button.
      const onFirstGesture = () => {
        if (!this.fullscreen) this.enterFullscreen();
        window.removeEventListener('pointerdown', onFirstGesture);
        window.removeEventListener('keydown', onFirstGesture);
      };
      window.addEventListener('pointerdown', onFirstGesture, { once: true });
      window.addEventListener('keydown', onFirstGesture, { once: true });
    }
  }

  /** A small ⛶ control, top-right, that toggles fullscreen on a direct tap. */
  private buildFullscreenButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shell-fullscreen-btn';
    btn.setAttribute('aria-label', 'Toggle fullscreen');
    const paint = () => (btn.textContent = this.fullscreen ? '⤡' : '⛶');
    paint();
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleFullscreen();
    });
    document.addEventListener('fullscreenchange', paint);
    const style = document.createElement('style');
    style.textContent = `
      .shell-fullscreen-btn {
        position: fixed;
        top: max(6px, env(safe-area-inset-top));
        right: max(6px, env(safe-area-inset-right));
        z-index: 40;
        width: 38px;
        height: 38px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #bfefff;
        background: rgba(2, 10, 14, 0.5);
        border: 1px solid rgba(127, 220, 255, 0.4);
        box-shadow: 0 0 16px rgba(80, 216, 255, 0.14);
        font: 16px/1 ui-monospace, Menlo, Consolas, monospace;
        pointer-events: auto;
        -webkit-user-select: none;
        user-select: none;
        touch-action: none;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(btn);
  }

  // --- Wake lock -----------------------------------------------------------

  private async requestWakeLock(): Promise<void> {
    this.wantWakeLock = true;
    const wl = (navigator as unknown as { wakeLock?: WakeLock }).wakeLock;
    if (!wl) {
      log.debug('Screen Wake Lock unsupported here — display may dim during play');
      return;
    }
    try {
      this.wakeLock = await wl.request('screen');
      this.wakeLock.addEventListener('release', () => log.trace('wake lock released'));
      log.debug('screen wake lock held');
    } catch (err) {
      // Thrown when the tab isn't visible/active — harmless; we re-try on
      // visibilitychange.
      log.trace('wake lock request failed (likely backgrounded)', err);
    }
  }

  // --- Fullscreen ----------------------------------------------------------

  get fullscreen(): boolean {
    return !!document.fullscreenElement;
  }

  private async enterFullscreen(): Promise<void> {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (!request) {
      log.debug('Fullscreen API unavailable (iPhone Safari) — use Add to Home Screen');
      return;
    }
    try {
      await request.call(el);
      // No orientation lock — fullscreen honours whatever way the phone is held
      // (portrait OR landscape); the UI layout adapts to both.
    } catch (err) {
      log.trace('fullscreen request denied', err);
    }
  }

  private exitFullscreen(): void {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    try {
      exit?.call(doc);
    } catch (err) {
      log.trace('exit fullscreen threw', err);
    }
  }

  /** Manual flip for a menu/button. Returns the requested target state. */
  toggleFullscreen(): boolean {
    if (this.fullscreen) {
      this.exitFullscreen();
      return false;
    }
    this.enterFullscreen();
    return true;
  }
}

/** Shared instance — one shell owns the wake lock + fullscreen state. */
export const mobileShell = new MobileShell();
