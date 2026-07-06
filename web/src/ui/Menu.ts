/**
 * wAIver — front-of-house: title screen, intro primer, pause menu, save/load.
 *
 * The game boots straight into a live, breathing world; this overlay sits on
 * top of it (the Reek keeps idling behind the glass) and gates when the player
 * actually takes control. It owns NO game state — everything it needs it asks
 * of the host through a small {@link MenuBridge}, so main.ts stays the single
 * source of truth for spores, wards, and the orb.
 *
 * Flow invariant that keeps save/load honest: the TITLE screen is only ever
 * shown over a pristine, just-booted world (first load, or after a reload
 * triggered by "Quit to Title"). So loading a save from the title can spawn
 * saved wards straight onto a clean world with nothing to undo. Mid-game loads
 * instead set a resume flag and reload, so they too land on a clean world.
 */

const K = {
  introSeen: 'waiver.introSeen',
  resume: 'waiver.resume', // transient: "on next boot, auto-load the save"
} as const;

/** The seam between the menu and the running game. main.ts implements this. */
export interface MenuBridge {
  /** Does a persisted save exist? */
  hasSave(): boolean;
  /** Summary of the persisted save for the Load panel (null if none). */
  saveInfo(): { savedAt: number; spores: number; wards: number } | null;
  /** Capture the live game state and persist it. */
  writeSave(): void;
  /** Apply the persisted save to the (pristine) world in place. */
  loadSaveInPlace(): boolean;
  /** Erase the persisted save. */
  deleteSave(): void;
  /** true = freeze gameplay (menu is up), false = hand control back. */
  setPaused(paused: boolean): void;
}

type Screen = 'title' | 'intro' | 'controls' | 'load' | 'settings' | 'pause' | 'playing';

interface IntroPanel {
  glyph: string;
  title: string;
  body: string[];
}

/** The primer — first-run onboarding, replayable from Settings. Copy carries
 *  the fiction AND the four verbs the whole loop is built on. */
const INTRO: IntroPanel[] = [
  {
    glyph: '◍',
    title: 'You wake in The Reek',
    body: [
      'A drowned world of black mist and phosphor groves, sunk under a sky that only remembers the moon.',
      'You are a mote of light adrift in it — a small, stubborn glow the dark would love to swallow.',
    ],
  },
  {
    glyph: '❍',
    title: 'You are the light',
    body: [
      'The Reek is lit only by what you carry and what you kindle. Move, and a pocket of the world resolves around you; drift too far from any light and the black closes back in.',
      'Your glow is your life. Guard it.',
    ],
  },
  {
    glyph: '◌',
    title: 'Pulse to see',
    body: [
      'Send out a pulse and a wavefront of light races outward, washing over the terrain and the groves — a breath of vision reaching far past your little bubble.',
      'It is how you read the dark before you cross it. It also stirs the flora, and answers where the light-spores hide.',
    ],
  },
  {
    glyph: '✦',
    title: 'Gather glowspores',
    body: [
      'Scattered through the mist are glowspores — motes of stored light. Drift into them to gather them.',
      'They are the currency of survival. A small handful buys your first foothold against the dark.',
    ],
  },
  {
    glyph: '❈',
    title: 'Shape a ward',
    body: [
      'Spend your glowspores to raise a ward: a fixed wellspring of held light that throws a dome of safety over the ground.',
      'Inside a ward the dark cannot drain you, and your Lumen refills. Held light is the only light the tide cannot take.',
    ],
  },
  {
    glyph: '≋',
    title: 'The Dark Tide',
    body: [
      'Sometimes the whole vault goes cold. A Dark Tide sweeps in from the horizon, swallowing the world from far to near until nothing but your own bubble survives.',
      'Out in the open it drains you fast. Shelter in a ward, and watch it break against your circle of light.',
    ],
  },
];

// --- Controls reference. One source of truth, shown as its own tabbed screen
// (before first play + from Settings). Bindings mirror core/Input.ts exactly. ---
type DeviceKey = 'kbm' | 'xbox' | 'ps' | 'pad' | 'touch';
interface ControlGroup {
  title: string;
  rows: [action: string, binding: string][];
}
interface Device {
  key: DeviceKey;
  label: string;
  note?: string;
  groups: ControlGroup[];
}
const DEVICES: Device[] = [
  {
    key: 'kbm',
    label: 'Keyboard & Mouse',
    groups: [
      {
        title: 'Move & look',
        rows: [
          ['Look around', 'Move mouse (click to lock) · or drag'],
          ['Glide', 'W A S D · or arrows'],
          ['Dash — hold', 'Shift'],
          ['Cruise — auto-forward', 'Q'],
        ],
      },
      {
        title: 'Actions',
        rows: [
          ['Wave-jump', 'Space'],
          ['Pulse — echolocate', 'F  (or click when locked)'],
          ['Raise a ward', 'B'],
          ['Call a tide — test', 'T'],
        ],
      },
      {
        title: 'One-handed mouse',
        rows: [
          ['Glide forward', 'Hold right mouse'],
          ['Wave-jump', 'Mouse wheel up'],
          ['Pulse', 'Middle click'],
        ],
      },
      { title: 'Menus', rows: [['Open / close menu', 'Esc'], ['Navigate', 'Arrows · Enter']] },
    ],
  },
  {
    key: 'xbox',
    label: 'Xbox',
    groups: [
      {
        title: 'Move & look',
        rows: [
          ['Glide', 'Left stick · or D-pad'],
          ['Look around', 'Right stick'],
          ['Dash — hold', 'Ⓑ  or  RB'],
          ['Cruise — auto-forward', 'L3  (click left stick)'],
        ],
      },
      {
        title: 'Actions',
        rows: [
          ['Wave-jump', 'Ⓐ'],
          ['Pulse — echolocate', 'Ⓧ  (or LT / RT)'],
          ['Raise a ward', 'Ⓨ'],
          ['Call a tide — test', '☰ Menu'],
        ],
      },
      {
        title: 'Menus',
        rows: [
          ['Navigate', 'D-pad / stick'],
          ['Select · Back', 'Ⓐ · Ⓑ'],
          ['Skip intro', '☰ Menu'],
        ],
      },
    ],
  },
  {
    key: 'ps',
    label: 'PlayStation',
    groups: [
      {
        title: 'Move & look',
        rows: [
          ['Glide', 'Left stick · or D-pad'],
          ['Look around', 'Right stick'],
          ['Dash — hold', '○  or  R1'],
          ['Cruise — auto-forward', 'L3  (click left stick)'],
        ],
      },
      {
        title: 'Actions',
        rows: [
          ['Wave-jump', '✕'],
          ['Pulse — echolocate', '□  (or L2 / R2)'],
          ['Raise a ward', '△'],
          ['Call a tide — test', 'Options'],
        ],
      },
      {
        title: 'Menus',
        rows: [
          ['Navigate', 'D-pad / stick'],
          ['Select · Back', '✕ · ○'],
          ['Skip intro', 'Options'],
        ],
      },
    ],
  },
  {
    key: 'pad',
    label: 'Generic pad',
    note: 'Positions on a standard controller — bottom / right / left / top face buttons.',
    groups: [
      {
        title: 'Move & look',
        rows: [
          ['Glide', 'Left stick · or D-pad'],
          ['Look around', 'Right stick'],
          ['Dash — hold', 'Right face · or right bumper'],
          ['Cruise — auto-forward', 'Left stick click'],
        ],
      },
      {
        title: 'Actions',
        rows: [
          ['Wave-jump', 'Bottom face button'],
          ['Pulse — echolocate', 'Left face · or triggers'],
          ['Raise a ward', 'Top face button'],
          ['Call a tide — test', 'Start'],
        ],
      },
      {
        title: 'Menus',
        rows: [
          ['Navigate', 'D-pad / stick'],
          ['Select · Back', 'Bottom · right face'],
          ['Skip intro', 'Start'],
        ],
      },
    ],
  },
  {
    key: 'touch',
    label: 'Mobile',
    note: 'The screen splits in two: left thumb glides, right thumb looks.',
    groups: [
      {
        title: 'Move & look',
        rows: [
          ['Glide', 'Left half — drag a virtual stick'],
          ['Look around', 'Right half — drag'],
        ],
      },
      {
        title: 'On-screen buttons',
        rows: [
          ['Pulse — echolocate', 'PULSE'],
          ['Wave-jump', 'JUMP'],
          ['Dash — hold to sprint', 'DASH'],
          ['Raise a ward', 'WARD'],
          ['Call a tide — test', 'TIDE'],
        ],
      },
      { title: 'Menus', rows: [['Navigate', 'Tap the on-screen options']] },
    ],
  },
];

/** Build a DOM element with props + children in one call (keeps render tidy). */
function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  props: Partial<HTMLElementTagNameMap[Tag]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown> & { class?: string };
  if (cls) node.className = cls;
  Object.assign(node, rest);
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

export class Menu {
  private bridge: MenuBridge;
  private root: HTMLDivElement;
  private panel: HTMLDivElement;
  private screen: Screen = 'title';
  private introIdx = 0;
  /** onDone callback for the intro (fresh-start vs replay-from-settings). */
  private introThen: () => void = () => {};
  /** Controls screen: which device tab, and whether we're in the onboarding
   *  flow (→ "Enter The Reek") vs viewing it from Settings (→ "Back"). */
  private ctrlDevice: DeviceKey = 'kbm';
  private controlsOnboarding = false;
  /** When set, the next collectFocus() parks focus on the button with this
   *  exact label instead of the primary (keeps tab focus while switching). */
  private refocusText: string | null = null;

  // --- Gamepad / keyboard menu navigation. The game's Input surface only feeds
  // gameplay, so menus poll the pad themselves: D-pad / stick move a focus
  // highlight, A confirms, B goes back. Runs only while a menu screen is up.
  private focusables: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private padRaf = 0;
  private padPrev: boolean[] = [];
  private navHeld = 0; // last stepped direction, for press-then-repeat
  private navRepeatAt = 0; // performance.now() when the held dir may step again

  constructor(bridge: MenuBridge) {
    this.bridge = bridge;
    this.injectStyle();
    this.panel = el('div', { class: 'wm-panel' });
    this.root = el('div', { class: 'wm-root' }, [this.panel]);
    document.body.appendChild(this.root);
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Keyboard drives the menus too: arrows move focus, Enter confirms, Esc
   *  toggles pause / steps back. Ignored entirely while playing (bar Esc). */
  private onKey(e: KeyboardEvent): void {
    // On the intro, Esc / X bail out of the whole primer (the ✕ affordance).
    if (this.screen === 'intro' && (e.code === 'Escape' || e.code === 'KeyX')) {
      e.preventDefault();
      this.finishIntro();
      return;
    }
    // On the controls screen, Esc / X leaves it: into play (onboarding) or
    // back to Settings (viewer).
    if (this.screen === 'controls' && (e.code === 'Escape' || e.code === 'KeyX')) {
      e.preventDefault();
      if (this.controlsOnboarding) this.enterFromControls();
      else this.open('settings');
      return;
    }
    if (e.code === 'Escape') {
      if (this.screen === 'playing') this.open('pause');
      else if (this.screen === 'pause') this.resume();
      else if (this.screen !== 'title') this.pressBack();
      return;
    }
    if (this.screen === 'playing') return;
    switch (e.code) {
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        this.move(-1);
        break;
      case 'ArrowDown':
      case 'ArrowRight':
      case 'Tab':
        e.preventDefault();
        this.move(1);
        break;
      case 'Enter':
      case 'Space':
        e.preventDefault();
        this.confirm();
        break;
    }
  }

  /** First frame of the session: resume a save, or show the title. */
  boot(): void {
    if (localStorage.getItem(K.resume) === '1') {
      localStorage.removeItem(K.resume);
      this.bridge.loadSaveInPlace();
      this.enterPlay();
      return;
    }
    this.open('title');
  }

  // --- screen orchestration ------------------------------------------------

  private open(screen: Screen): void {
    this.screen = screen;
    this.bridge.setPaused(true);
    document.body.classList.add('waiver-menu-open');
    this.root.classList.remove('wm-hidden');
    this.render();
    this.startPad();
  }

  private enterPlay(): void {
    this.screen = 'playing';
    this.root.classList.add('wm-hidden');
    document.body.classList.remove('waiver-menu-open');
    this.stopPad();
    this.bridge.setPaused(false);
  }

  private resume(): void {
    this.enterPlay();
  }

  private startFresh(): void {
    if (!localStorage.getItem(K.introSeen)) {
      this.introThen = () => this.enterPlay();
      this.open('intro');
    } else {
      this.enterPlay();
    }
  }

  private continueGame(): void {
    // Title is always over a pristine world → apply in place.
    if (this.bridge.loadSaveInPlace()) this.enterPlay();
  }

  /** Mid-game load must land on a clean world: flag + reload, boot() applies. */
  private reloadResume(): void {
    localStorage.setItem(K.resume, '1');
    location.reload();
  }

  private quitToTitle(): void {
    localStorage.removeItem(K.resume);
    location.reload();
  }

  // --- rendering -----------------------------------------------------------

  private render(): void {
    this.panel.replaceChildren();
    switch (this.screen) {
      case 'title':
        this.renderTitle();
        break;
      case 'intro':
        this.renderIntro();
        break;
      case 'controls':
        this.renderControls();
        break;
      case 'load':
        this.renderLoad();
        break;
      case 'settings':
        this.renderSettings();
        break;
      case 'pause':
        this.renderPause();
        break;
    }
    this.collectFocus();
  }

  // --- focus + pad navigation ----------------------------------------------

  /** Re-index the focusable buttons after a render and park focus on the
   *  primary action (falls back to the first button). */
  private collectFocus(): void {
    this.focusables = Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button'));
    let idx = -1;
    if (this.refocusText) {
      idx = this.focusables.findIndex((b) => (b.textContent?.trim() ?? '') === this.refocusText);
      this.refocusText = null;
    }
    if (idx < 0) idx = this.focusables.findIndex((b) => b.classList.contains('wm-primary'));
    this.focusIdx = idx >= 0 ? idx : 0;
    this.applyFocus();
  }

  private applyFocus(): void {
    this.focusables.forEach((b, i) => b.classList.toggle('wm-focus', i === this.focusIdx));
    this.focusables[this.focusIdx]?.focus({ preventScroll: true });
  }

  private move(delta: number): void {
    const n = this.focusables.length;
    if (n === 0) return;
    this.focusIdx = (this.focusIdx + delta + n) % n;
    this.applyFocus();
  }

  private confirm(): void {
    this.focusables[this.focusIdx]?.click();
  }

  /** B / Esc affordance: click a Back / Resume button if the screen has one
   *  (tolerates decorated labels like "‹ Back"). */
  private pressBack(): void {
    const back = this.focusables.find((b) => /(^|\s)(back|resume)$/i.test(b.textContent?.trim() ?? ''));
    back?.click();
  }

  private startPad(): void {
    if (this.padRaf) return;
    this.padPrev = [];
    this.navHeld = 0;
    const loop = () => {
      this.pollPad();
      this.padRaf = requestAnimationFrame(loop);
    };
    this.padRaf = requestAnimationFrame(loop);
  }

  private stopPad(): void {
    if (this.padRaf) cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
  }

  private pollPad(): void {
    const pads =
      typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    if (!gp) return;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const pressed = (i: number) => !!gp.buttons[i]?.pressed;
    const axis = (i: number) => gp.axes[i] ?? 0;

    // Direction from D-pad OR either stick — any axis cycles the focus list.
    const prevDir =
      pressed(12) || pressed(14) || axis(1) < -0.55 || axis(0) < -0.55 ? -1 : 0;
    const nextDir =
      pressed(13) || pressed(15) || axis(1) > 0.55 || axis(0) > 0.55 ? 1 : 0;
    const dir = prevDir || nextDir;
    if (dir === 0) {
      this.navHeld = 0;
    } else if (dir !== this.navHeld || now >= this.navRepeatAt) {
      this.move(dir);
      // Longer delay before the first auto-repeat, then a steady tick.
      this.navRepeatAt = now + (dir !== this.navHeld ? 360 : 130);
      this.navHeld = dir;
    }

    // A (0) confirms, B (1) backs — edge-triggered against last frame.
    // Start (9) skips the intro, matching the ✕ / X affordance.
    const edge = (i: number) => pressed(i) && !this.padPrev[i];
    if (this.screen === 'intro' && edge(9)) this.finishIntro();
    else if (edge(0)) this.confirm();
    else if (edge(1)) this.pressBack();
    this.padPrev = gp.buttons.map((b) => b.pressed);
  }

  private button(label: string, onClick: () => void, kind: 'primary' | 'ghost' = 'ghost'): HTMLButtonElement {
    const b = el('button', { class: `wm-btn wm-${kind}`, type: 'button', textContent: label });
    b.addEventListener('click', onClick);
    return b;
  }

  private brand(sub: string): HTMLDivElement {
    return el('div', { class: 'wm-brand' }, [
      el('div', { class: 'wm-logo', textContent: 'wAIver' }),
      el('div', { class: 'wm-sub', textContent: sub }),
    ]);
  }

  private renderTitle(): void {
    const hasSave = this.bridge.hasSave();
    const actions = el('div', { class: 'wm-actions' });
    if (hasSave) actions.append(this.button('Continue', () => this.continueGame(), 'primary'));
    actions.append(this.button('New Game', () => this.startFresh(), hasSave ? 'ghost' : 'primary'));
    if (hasSave) actions.append(this.button('Load', () => this.open('load')));
    actions.append(this.button('Settings', () => this.open('settings')));
    this.panel.append(
      this.brand('The Reek'),
      el('p', {
        class: 'wm-tagline',
        textContent: 'A mote of light, adrift in a drowned dark. Keep it burning.',
      }),
      actions,
      el('div', { class: 'wm-foot', textContent: 'v0.1 · vertical slice' }),
    );
  }

  private renderIntro(): void {
    const p = INTRO[this.introIdx];
    const dots = el(
      'div',
      { class: 'wm-dots' },
      INTRO.map((_, i) => el('span', { class: `wm-dot ${i === this.introIdx ? 'on' : ''}`.trim() })),
    );
    const nav = el('div', { class: 'wm-actions wm-row' });
    if (this.introIdx > 0) {
      nav.append(this.button('Back', () => {
        this.introIdx--;
        this.render();
      }));
    }
    const last = this.introIdx === INTRO.length - 1;
    nav.append(
      this.button(last ? 'Controls ›' : 'Next', () => {
        if (last) this.openControls(true); // last onboarding beat before play
        else {
          this.introIdx++;
          this.render();
        }
      }, 'primary'),
    );
    this.panel.append(
      el('button', { class: 'wm-skip', type: 'button', textContent: 'Skip intro  ✕ / X' }, []),
      el('div', { class: 'wm-glyph', textContent: p.glyph }),
      el('h2', { class: 'wm-h2', textContent: p.title }),
      el('div', { class: 'wm-body' }, p.body.map((line) => el('p', { textContent: line }))),
      dots,
      nav,
    );
    const skip = this.panel.querySelector<HTMLButtonElement>('.wm-skip');
    skip?.addEventListener('click', () => this.finishIntro());
  }

  private finishIntro(): void {
    localStorage.setItem(K.introSeen, '1');
    this.introIdx = 0;
    this.introThen();
  }

  /** Open the controls reference. onboarding=true → primary is "Enter The Reek"
   *  and finishing it starts play; false → it's a viewer with a Back button. */
  private openControls(onboarding: boolean): void {
    this.controlsOnboarding = onboarding;
    this.open('controls');
  }

  /** Finish onboarding from the controls screen → mark seen, start play. */
  private enterFromControls(): void {
    localStorage.setItem(K.introSeen, '1');
    this.introIdx = 0;
    this.introThen();
  }

  private renderControls(): void {
    const dev = DEVICES.find((d) => d.key === this.ctrlDevice) ?? DEVICES[0];
    // Device tabs — each a focusable button so the pad/keyboard can switch too.
    const tabs = el(
      'div',
      { class: 'wm-tabs' },
      DEVICES.map((d) => {
        const t = el('button', {
          class: `wm-tab ${d.key === this.ctrlDevice ? 'active' : ''}`.trim(),
          type: 'button',
          textContent: d.label,
        });
        t.addEventListener('click', () => {
          if (this.ctrlDevice === d.key) return;
          this.ctrlDevice = d.key;
          this.refocusText = d.label; // keep focus on the tab after re-render
          this.render();
        });
        return t;
      }),
    );

    const groups = el(
      'div',
      { class: 'wm-ctrl-groups' },
      dev.groups.map((g) =>
        el('div', { class: 'wm-ctrl-group' }, [
          el('div', { class: 'wm-ctrl-gtitle', textContent: g.title }),
          ...g.rows.map((r) =>
            el('div', { class: 'wm-ctrl-row' }, [
              el('span', { class: 'wm-ctrl-act', textContent: r[0] }),
              el('span', { class: 'wm-ctrl-bind', textContent: r[1] }),
            ]),
          ),
        ]),
      ),
    );

    const actions = el('div', { class: 'wm-actions wm-row' });
    if (this.controlsOnboarding) {
      actions.append(
        this.button('‹ Back', () => {
          this.introIdx = INTRO.length - 1;
          this.open('intro');
        }),
        this.button('Enter The Reek', () => this.enterFromControls(), 'primary'),
      );
    } else {
      actions.append(this.button('Back', () => this.open('settings'), 'primary'));
    }

    this.panel.append(
      el('h2', { class: 'wm-h2', textContent: 'Controls' }),
      tabs,
      dev.note ? el('p', { class: 'wm-ctrl-note', textContent: dev.note }) : el('span'),
      groups,
      actions,
    );
  }

  private renderLoad(): void {
    const info = this.bridge.saveInfo();
    const body = el('div', { class: 'wm-slot' });
    if (info) {
      body.append(
        el('div', { class: 'wm-slot-title', textContent: 'Saved run' }),
        el('div', {
          class: 'wm-slot-meta',
          textContent: `${info.spores} glowspores · ${info.wards} ward${info.wards === 1 ? '' : 's'} · ${timeAgo(info.savedAt)}`,
        }),
      );
    } else {
      body.append(el('div', { class: 'wm-slot-meta', textContent: 'No saved run yet.' }));
    }
    const actions = el('div', { class: 'wm-actions wm-row' });
    actions.append(this.button('Back', () => this.open(this.cameFromPause ? 'pause' : 'title')));
    if (info) {
      actions.append(
        this.button('Delete', () => {
          this.bridge.deleteSave();
          this.render();
        }),
        this.button('Load', () => {
          if (this.cameFromPause) this.reloadResume();
          else this.continueGame();
        }, 'primary'),
      );
    }
    this.panel.append(
      el('h2', { class: 'wm-h2', textContent: 'Load' }),
      body,
      actions,
    );
  }

  private renderSettings(): void {
    const list = el('div', { class: 'wm-settings' });
    // Controls is LIVE — view the bindings for any device, any time.
    const controlsRow = el('button', { class: 'wm-set-row wm-set-live', type: 'button' }, [
      el('div', { class: 'wm-set-name', textContent: 'Controls' }),
      el('div', { class: 'wm-set-hint', textContent: 'View bindings — keyboard, controller, mobile' }),
      el('div', { class: 'wm-set-go', textContent: 'View ›' }),
    ]);
    controlsRow.addEventListener('click', () => this.openControls(false));
    list.append(controlsRow);
    // Stubbed pipes — wired visually, contents land in a later pass.
    for (const [name, hint] of [
      ['Graphics', 'Quality, bloom, volumetrics'],
      ['Audio', 'Master, ambience, effects'],
    ]) {
      list.append(
        el('div', { class: 'wm-set-row' }, [
          el('div', { class: 'wm-set-name', textContent: name }),
          el('div', { class: 'wm-set-hint', textContent: hint }),
          el('div', { class: 'wm-set-soon', textContent: 'soon' }),
        ]),
      );
    }
    const actions = el('div', { class: 'wm-actions wm-row' });
    actions.append(
      this.button('Replay intro', () => {
        this.introThen = () => this.open(this.cameFromPause ? 'pause' : 'title');
        this.introIdx = 0;
        this.open('intro');
      }),
      this.button('Back', () => this.open(this.cameFromPause ? 'pause' : 'title'), 'primary'),
    );
    this.panel.append(
      el('h2', { class: 'wm-h2', textContent: 'Settings' }),
      list,
      actions,
    );
  }

  /** Track whether Load/Settings were opened from the pause menu (for Back). */
  private cameFromPause = false;

  private renderPause(): void {
    this.cameFromPause = true;
    const actions = el('div', { class: 'wm-actions' });
    actions.append(
      this.button('Resume', () => this.resume(), 'primary'),
      this.button('Save', () => {
        this.bridge.writeSave();
        this.flashToast('Progress saved');
      }),
    );
    if (this.bridge.hasSave()) actions.append(this.button('Load', () => this.open('load')));
    actions.append(
      this.button('Settings', () => this.open('settings')),
      this.button('Quit to Title', () => this.quitToTitle()),
    );
    this.panel.append(
      this.brand('Paused'),
      actions,
      el('div', { class: 'wm-foot', textContent: 'ESC to resume' }),
    );
  }

  private flashToast(msg: string): void {
    const t = el('div', { class: 'wm-toast', textContent: msg });
    this.root.append(t);
    // Force reflow so the fade-in transition actually runs.
    void t.offsetWidth;
    t.classList.add('show');
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, 1100);
  }

  private injectStyle(): void {
    const s = document.createElement('style');
    s.textContent = `
      body.waiver-menu-open .hud,
      body.waiver-menu-open .metrics-bar,
      body.waiver-menu-open .touch-actions,
      body.waiver-menu-open .touch-stick-base,
      body.waiver-menu-open #light-toggle { display: none !important; }

      .wm-root {
        position: fixed;
        inset: 0;
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: max(20px, env(safe-area-inset-top)) 20px;
        color: #dffcf1;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        background:
          radial-gradient(120% 90% at 50% 42%, rgba(2, 8, 10, 0.35) 0%, rgba(1, 4, 6, 0.86) 62%, rgba(0, 2, 3, 0.96) 100%);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        animation: wm-fade 0.5s ease;
      }
      .wm-hidden { display: none !important; }
      @keyframes wm-fade { from { opacity: 0; } to { opacity: 1; } }

      .wm-panel {
        width: min(440px, 100%);
        max-height: 100%;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 18px;
        padding: 30px 26px 26px;
        border: 1px solid rgba(127, 255, 209, 0.18);
        border-radius: 14px;
        background: rgba(3, 10, 12, 0.62);
        box-shadow: 0 0 60px rgba(54, 226, 177, 0.06), inset 0 0 40px rgba(2, 20, 16, 0.5);
        text-align: center;
      }

      .wm-brand { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .wm-logo {
        font-size: 40px;
        letter-spacing: 0.14em;
        color: #7fffd1;
        text-shadow: 0 0 30px rgba(80, 255, 202, 0.5), 0 0 10px rgba(127, 255, 209, 0.7);
      }
      .wm-sub {
        font-size: 11px;
        letter-spacing: 0.42em;
        text-transform: uppercase;
        color: rgba(159, 232, 255, 0.7);
        padding-left: 0.42em;
      }
      .wm-tagline {
        max-width: 34ch;
        font-size: 12.5px;
        line-height: 1.6;
        color: rgba(223, 252, 241, 0.72);
        margin: -4px 0 2px;
      }

      .wm-actions { display: flex; flex-direction: column; gap: 9px; width: 100%; max-width: 300px; }
      .wm-actions.wm-row { flex-direction: row; justify-content: center; }
      .wm-actions.wm-row .wm-btn { flex: 1; }
      .wm-btn {
        appearance: none;
        cursor: pointer;
        padding: 12px 16px;
        font: 600 12.5px/1 ui-monospace, Menlo, Consolas, monospace;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #bff3e2;
        background: rgba(8, 20, 18, 0.55);
        border: 1px solid rgba(127, 255, 209, 0.28);
        border-radius: 8px;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.06s ease, box-shadow 0.15s ease;
      }
      .wm-btn:hover {
        background: rgba(16, 40, 34, 0.8);
        border-color: rgba(127, 255, 209, 0.7);
        box-shadow: 0 0 18px rgba(80, 255, 202, 0.14);
      }
      .wm-btn:active { transform: translateY(1px); }
      .wm-btn:focus-visible { outline: none; }
      .wm-focus, .wm-skip.wm-focus {
        border-color: rgba(157, 255, 216, 0.95) !important;
        box-shadow: 0 0 0 1px rgba(157, 255, 216, 0.5), 0 0 22px rgba(80, 255, 202, 0.28) !important;
      }
      .wm-btn.wm-focus::before {
        content: '›';
        position: absolute;
        left: -16px;
        color: #7fffd1;
        text-shadow: 0 0 8px rgba(127, 255, 209, 0.9);
      }
      .wm-btn { position: relative; }
      .wm-primary {
        color: #04140f;
        background: linear-gradient(180deg, #9dffd8, #4fe0b6);
        border-color: rgba(157, 255, 216, 0.9);
        text-shadow: 0 1px 0 rgba(255, 255, 255, 0.35);
      }
      .wm-primary:hover { background: linear-gradient(180deg, #b6ffe4, #63e9c4); }

      .wm-foot { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(159, 232, 255, 0.4); }

      /* Intro */
      .wm-skip {
        align-self: flex-end;
        cursor: pointer;
        padding: 4px 8px;
        margin: -14px -8px 0 0;
        font: 10.5px ui-monospace, Menlo, Consolas, monospace;
        letter-spacing: 0.1em;
        color: rgba(159, 232, 255, 0.55);
        background: none;
        border: none;
      }
      .wm-skip:hover { color: #9fe8ff; }
      .wm-glyph {
        font-size: 46px;
        line-height: 1;
        color: #7fffd1;
        text-shadow: 0 0 26px rgba(80, 255, 202, 0.55);
        margin-top: 2px;
      }
      .wm-h2 {
        font-size: 19px;
        letter-spacing: 0.06em;
        color: #eafff7;
        font-weight: 600;
      }
      .wm-body { display: flex; flex-direction: column; gap: 11px; max-width: 40ch; }
      .wm-body p { font-size: 13px; line-height: 1.62; color: rgba(223, 252, 241, 0.82); }
      .wm-dots { display: flex; gap: 7px; margin-top: 2px; }
      .wm-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: rgba(127, 255, 209, 0.22);
        transition: background 0.2s ease, box-shadow 0.2s ease;
      }
      .wm-dot.on { background: #7fffd1; box-shadow: 0 0 8px rgba(127, 255, 209, 0.8); }

      /* Load */
      .wm-slot {
        width: 100%;
        padding: 16px;
        border: 1px solid rgba(127, 255, 209, 0.2);
        border-radius: 10px;
        background: rgba(6, 16, 14, 0.5);
      }
      .wm-slot-title { font-size: 13px; color: #cfeee2; letter-spacing: 0.06em; margin-bottom: 6px; }
      .wm-slot-meta { font-size: 11.5px; color: rgba(159, 232, 255, 0.72); line-height: 1.5; }

      /* Settings */
      .wm-settings { width: 100%; display: flex; flex-direction: column; gap: 8px; }
      .wm-set-row {
        display: flex; align-items: center; gap: 10px;
        padding: 11px 13px;
        border: 1px solid rgba(127, 255, 209, 0.14);
        border-radius: 9px;
        background: rgba(6, 16, 14, 0.4);
        opacity: 0.72;
        text-align: left;
      }
      .wm-set-name { font-size: 12.5px; color: #cfeee2; min-width: 74px; letter-spacing: 0.04em; }
      .wm-set-hint { font-size: 11px; color: rgba(159, 232, 255, 0.55); flex: 1; }
      .wm-set-soon {
        font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
        color: #04140f; background: rgba(127, 255, 209, 0.6);
        padding: 3px 7px; border-radius: 5px;
      }
      /* A live (clickable) settings row */
      .wm-set-live {
        appearance: none; cursor: pointer; width: 100%;
        opacity: 1;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .wm-set-live:hover, .wm-set-live.wm-focus {
        background: rgba(16, 40, 34, 0.7);
        border-color: rgba(127, 255, 209, 0.7) !important;
        box-shadow: 0 0 18px rgba(80, 255, 202, 0.14) !important;
      }
      .wm-set-go { font-size: 10px; letter-spacing: 0.12em; color: #7fffd1; white-space: nowrap; }

      /* Controls reference */
      .wm-tabs {
        display: flex; gap: 6px; width: 100%;
        overflow-x: auto; padding-bottom: 4px;
        scrollbar-width: thin;
      }
      .wm-tab {
        appearance: none; cursor: pointer; white-space: nowrap;
        padding: 7px 11px;
        font: 600 10.5px/1 ui-monospace, Menlo, Consolas, monospace;
        letter-spacing: 0.06em;
        color: rgba(191, 243, 226, 0.7);
        background: rgba(8, 20, 18, 0.5);
        border: 1px solid rgba(127, 255, 209, 0.2);
        border-radius: 7px;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
      }
      .wm-tab:hover { color: #cfeee2; border-color: rgba(127, 255, 209, 0.5); }
      .wm-tab.active {
        color: #04140f;
        background: linear-gradient(180deg, #9dffd8, #4fe0b6);
        border-color: rgba(157, 255, 216, 0.9);
      }
      .wm-tab.wm-focus { box-shadow: 0 0 0 1px rgba(157, 255, 216, 0.6), 0 0 16px rgba(80, 255, 202, 0.25) !important; }
      .wm-ctrl-note {
        width: 100%; text-align: left;
        font-size: 11px; line-height: 1.5; color: rgba(159, 232, 255, 0.62);
        margin: -6px 0 -2px;
      }
      .wm-ctrl-groups { width: 100%; display: flex; flex-direction: column; gap: 13px; }
      .wm-ctrl-group { width: 100%; }
      .wm-ctrl-gtitle {
        font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
        color: #7fffd1; text-align: left;
        padding-bottom: 6px; margin-bottom: 4px;
        border-bottom: 1px solid rgba(127, 255, 209, 0.14);
      }
      .wm-ctrl-row {
        display: flex; align-items: baseline; gap: 12px;
        padding: 4px 0;
      }
      .wm-ctrl-act { flex: 1; text-align: left; font-size: 12px; color: rgba(223, 252, 241, 0.8); }
      .wm-ctrl-bind {
        flex-shrink: 0; text-align: right;
        font-size: 11.5px; font-weight: 600; color: #c7fbe8;
        letter-spacing: 0.02em;
      }

      /* Toast */
      .wm-toast {
        position: fixed;
        left: 50%; bottom: 34px; transform: translate(-50%, 10px);
        z-index: 210;
        padding: 10px 18px;
        color: #04140f;
        background: linear-gradient(180deg, #9dffd8, #4fe0b6);
        border-radius: 8px;
        font: 600 11.5px/1 ui-monospace, Menlo, Consolas, monospace;
        letter-spacing: 0.1em;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
        opacity: 0;
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;
      }
      .wm-toast.show { opacity: 1; transform: translate(-50%, 0); }

      @media (max-width: 520px), (pointer: coarse) {
        .wm-logo { font-size: 34px; }
        .wm-panel { gap: 15px; padding: 24px 18px 20px; }
        .wm-glyph { font-size: 40px; }
        .wm-h2 { font-size: 17px; }
        .wm-body p { font-size: 12.5px; }
      }
    `;
    document.head.appendChild(s);
  }
}
