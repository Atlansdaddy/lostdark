/**
 * AnimatorUI — the in-game animation workbench (toggle: K).
 *
 * This is the view/tweak/iterate surface for the mushroom folk:
 *   • pick a folk (or ALL) · flip the STILL/WALK/MOVE/ATTACK toggle (M cycles)
 *   • play any clip — ours or Meshy's baked gltf: clips — pause, scrub, speed
 *   • POSE mode: freeze the selected folk and drive every articulation
 *     channel live with sliders (head/body/legs/arms/wrists/digits + root)
 *   • EDIT mode: work on a copy of any pose clip — scrub the timeline, move
 *     sliders, hit KEY to write keyframes at the playhead, delete keys,
 *     change duration, save (persists via localStorage into the live game),
 *     export/import JSON so tuned clips can be baked into folkClips.ts
 *   • RAW BONES: every bone Meshy shipped (cap, head_end, …) is listed and
 *     drivable via bone:<Name>.<axis> channels — extra rig points on demand
 *   • combat sanity buttons: hit / kill / revive / bring-to-orb
 *
 * Plain DOM, no framework, styled to sit with the game's dev overlays.
 */

import * as THREE from 'three';
import { cloneClip, sampleClip, type AnimClip } from './AnimClip';
import type { FolkManager } from './FolkManager';
import { FOLK_MODES, type FolkMode, type MushroomFolk } from './MushroomFolk';
import { CHANNEL_GROUPS, type Pose } from './PoseRig';

const PANEL_CSS = `
position:fixed;top:8px;right:8px;width:350px;max-height:94vh;overflow-y:auto;z-index:1200;
background:rgba(6,10,12,.93);color:#9fe8d8;border:1px solid #1f4a3e;border-radius:6px;
font:11px/1.45 ui-monospace,Consolas,monospace;padding:10px 12px;
`;
const BTN = 'background:#0d1f1a;color:#9fe8d8;border:1px solid #2a5a4a;border-radius:3px;padding:2px 7px;margin:1px 2px;cursor:pointer;font:inherit;';
const BTN_ON = 'background:#1f6a52;color:#eafff6;border:1px solid #4adfb0;border-radius:3px;padding:2px 7px;margin:1px 2px;cursor:pointer;font:inherit;';
const INPUT = 'background:#08110e;color:#9fe8d8;border:1px solid #2a5a4a;border-radius:3px;font:inherit;padding:1px 4px;';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export class AnimatorUI {
  private mgr: FolkManager;
  private getOrb: () => THREE.Vector3;
  private root: HTMLDivElement;
  private open = false;

  private selIdx = 0; // index into mgr.folk; -1 = ALL
  private posing = false;
  private editing: AnimClip | null = null;
  private playhead = 0;
  private playInEdit = false;
  private speed = 1;
  private scratch: Pose = {};
  private selBone: string | null = null;
  private raf = 0;
  private timeLabel: HTMLSpanElement | null = null;
  private timeSlider: HTMLInputElement | null = null;
  private sliderRefs = new Map<string, { input: HTMLInputElement; readout: HTMLSpanElement }>();

  constructor(mgr: FolkManager, getOrb: () => THREE.Vector3) {
    this.mgr = mgr;
    this.getOrb = getOrb;
    this.root = el('div', PANEL_CSS);
    this.root.style.display = 'none';
    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'KeyK') this.toggle();
      if (e.code === 'KeyM') {
        const m = this.mgr.cycleMode();
        if (this.open) this.rebuild();
        else this.flashModeToast(m);
      }
    });
  }

  toggle(): void {
    this.open = !this.open;
    this.root.style.display = this.open ? 'block' : 'none';
    if (this.open) {
      this.rebuild();
      this.tick();
    } else {
      cancelAnimationFrame(this.raf);
      this.stopPosing();
    }
  }

  private flashModeToast(mode: FolkMode): void {
    const t = el('div', `${PANEL_CSS};width:auto;padding:6px 14px;top:40%;right:50%;transform:translateX(50%);font-size:14px;`, `folk mode: ${mode.toUpperCase()}`);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 900);
  }

  private sel(): MushroomFolk | null {
    if (this.selIdx === -1) return this.mgr.folk[0] ?? null;
    return this.mgr.folk[this.selIdx] ?? null;
  }

  private targets(): MushroomFolk[] {
    return this.selIdx === -1 ? this.mgr.folk : this.sel() ? [this.sel()!] : [];
  }

  // --- per-frame: apply pose/edit preview + refresh readouts -----------------

  private tick = (): void => {
    if (!this.open) return;
    this.raf = requestAnimationFrame(this.tick);
    const f = this.sel();
    if (!f) return;

    if (this.editing) {
      if (this.playInEdit) {
        this.playhead = (this.playhead + 0.016 * this.speed) % this.editing.duration;
        if (this.timeSlider) this.timeSlider.value = String(this.playhead);
        this.refreshSlidersFromClip();
      }
      // Preview = clip at playhead, with any slider-touched channels overriding.
      const pose: Pose = {};
      sampleClip(this.editing, this.playhead, pose);
      Object.assign(pose, this.scratch);
      f.editorPose = pose;
    } else if (this.posing) {
      f.editorPose = this.scratch;
    }

    if (this.timeLabel) {
      const t = this.editing ? this.playhead : f.player.time();
      const d = this.editing ? this.editing.duration : f.player.duration();
      this.timeLabel.textContent = `${t.toFixed(2)} / ${d.toFixed(2)}s`;
      if (!this.editing && this.timeSlider && !f.player.paused) {
        this.timeSlider.max = String(d);
        this.timeSlider.value = String(t);
      }
    }
  };

  private stopPosing(): void {
    this.posing = false;
    this.editing = null;
    this.playInEdit = false;
    this.scratch = {};
    for (const f of this.mgr.folk) {
      f.editorPose = null;
      f.player.paused = false;
    }
  }

  // --- UI construction --------------------------------------------------------

  private rebuild(): void {
    this.root.textContent = '';
    this.sliderRefs.clear();
    const f = this.sel();

    const h = el('div', 'font-size:12px;color:#4adfb0;margin-bottom:6px;', '🍄 FOLK ANIMATOR');
    h.append(el('span', 'float:right;color:#5a8a7a;', 'K close · M mode'));
    this.root.append(h);

    // --- folk selector ---
    const selRow = el('div', 'margin-bottom:6px;');
    const allBtn = el('button', this.selIdx === -1 ? BTN_ON : BTN, 'ALL');
    allBtn.onclick = () => {
      this.selIdx = -1;
      this.rebuild();
    };
    selRow.append(allBtn);
    this.mgr.folk.forEach((folk, i) => {
      const b = el('button', i === this.selIdx ? BTN_ON : BTN, `${folk.def.name.split(' ')[1] ?? folk.def.id}#${folk.uid}`);
      b.title = `${folk.def.name} — ${Math.max(0, Math.round(folk.hp))}/${folk.def.hp} hp, ${folk.state}`;
      b.onclick = () => {
        this.selIdx = i;
        this.rebuild();
      };
      selRow.append(b);
    });
    this.root.append(selRow);

    // --- mode toggle (the STILL/WALK/MOVE/ATTACK ask) ---
    const modeRow = el('div', 'margin-bottom:6px;');
    modeRow.append(el('span', 'color:#5a8a7a;', 'mode '));
    for (const m of FOLK_MODES) {
      const active = this.selIdx === -1 ? this.mgr.mode === m : this.sel()?.mode === m;
      const b = el('button', active ? BTN_ON : BTN, m.toUpperCase());
      b.onclick = () => {
        this.stopPosing();
        if (this.selIdx === -1) this.mgr.setMode(m);
        else if (this.sel()) this.sel()!.mode = m;
        this.rebuild();
      };
      modeRow.append(b);
    }
    this.root.append(modeRow);

    // --- combat sanity ---
    const combatRow = el('div', 'margin-bottom:8px;');
    const mkBtn = (label: string, fn: () => void, title = ''): void => {
      const b = el('button', BTN, label);
      b.onclick = () => {
        fn();
        this.rebuild();
      };
      if (title) b.title = title;
      combatRow.append(b);
    };
    mkBtn('hit 15', () => this.targets().forEach((t) => t.damage(15, this.getOrb(), this.mgr.effects)));
    mkBtn('kill', () => this.targets().forEach((t) => t.damage(9999, this.getOrb(), this.mgr.effects)));
    mkBtn('revive', () => this.targets().forEach((t) => t.respawn()));
    mkBtn(
      'to orb',
      () => {
        const orb = this.getOrb();
        this.targets().forEach((t, i) => {
          t.anchor.set(orb.x + 2.5 + i * 1.6, orb.y, orb.z + 2.5);
          t.group.position.copy(t.anchor);
        });
      },
      'teleport selection next to the orb',
    );
    const resp = el('button', this.mgr.respawnEnabled ? BTN_ON : BTN, 'respawn');
    resp.title = 'fallen folk regrow at their anchor';
    resp.onclick = () => {
      this.mgr.respawnEnabled = !this.mgr.respawnEnabled;
      this.rebuild();
    };
    combatRow.append(resp);
    this.root.append(combatRow);

    if (!f) {
      this.root.append(el('div', 'color:#e8a54a;', 'no folk spawned (models still loading?)'));
      return;
    }

    // --- clip playback ---
    const clipBox = el('div', 'border-top:1px solid #1f4a3e;padding-top:6px;margin-bottom:6px;');
    clipBox.append(el('span', 'color:#5a8a7a;', 'clip '));
    const clipSel = el('select', INPUT) as HTMLSelectElement;
    for (const name of f.player.availableClips()) {
      const o = el('option', '', name) as HTMLOptionElement;
      o.value = name;
      if (this.mgr.hasOverride(name)) o.textContent = `${name} *`;
      clipSel.append(o);
    }
    const current = f.player.currentName();
    if (current) clipSel.value = current;
    clipBox.append(clipSel);

    const play = el('button', BTN, '▶ play');
    play.onclick = () => {
      this.stopPosing();
      this.targets().forEach((t) => {
        t.mode = 'still';
        t.player.play(clipSel.value, { restart: true, speed: this.speed });
        t.player.paused = false;
      });
      this.rebuild();
    };
    const pause = el('button', f.player.paused ? BTN_ON : BTN, '⏸');
    pause.onclick = () => {
      this.targets().forEach((t) => (t.player.paused = !t.player.paused));
      this.rebuild();
    };
    clipBox.append(play, pause);

    // speed
    const spd = el('input', INPUT + 'width:64px;') as HTMLInputElement;
    spd.type = 'range';
    spd.min = '0.1';
    spd.max = '2';
    spd.step = '0.05';
    spd.value = String(this.speed);
    spd.oninput = () => {
      this.speed = parseFloat(spd.value);
      spdLabel.textContent = `×${this.speed.toFixed(2)}`;
    };
    const spdLabel = el('span', 'color:#5a8a7a;', `×${this.speed.toFixed(2)}`);
    clipBox.append(spd, spdLabel);

    // timeline
    const tRow = el('div');
    this.timeSlider = el('input', INPUT + 'width:210px;vertical-align:middle;') as HTMLInputElement;
    this.timeSlider.type = 'range';
    this.timeSlider.min = '0';
    this.timeSlider.step = '0.01';
    this.timeSlider.max = String(this.editing ? this.editing.duration : f.player.duration());
    this.timeSlider.oninput = () => {
      const t = parseFloat(this.timeSlider!.value);
      if (this.editing) {
        this.playhead = t;
        this.playInEdit = false;
        this.refreshSlidersFromClip();
      } else {
        this.targets().forEach((tg) => {
          tg.player.paused = true;
          tg.player.scrub(t);
        });
      }
    };
    this.timeLabel = el('span', 'color:#5a8a7a;margin-left:6px;');
    tRow.append(this.timeSlider, this.timeLabel);
    clipBox.append(tRow);
    this.root.append(clipBox);

    // --- pose / edit switches ---
    const editRow = el('div', 'margin-bottom:6px;');
    const poseBtn = el('button', this.posing && !this.editing ? BTN_ON : BTN, '✋ pose');
    poseBtn.title = 'freeze the selected folk; sliders drive the body live';
    poseBtn.onclick = () => {
      if (this.posing && !this.editing) this.stopPosing();
      else {
        this.stopPosing();
        this.posing = true;
        this.scratch = {};
      }
      this.rebuild();
    };
    const editBtn = el('button', this.editing ? BTN_ON : BTN, '✎ edit clip');
    editBtn.title = 'work on a copy of the selected clip: scrub, pose, KEY';
    editBtn.onclick = () => {
      if (this.editing) {
        this.stopPosing();
      } else {
        const src = this.mgr.clips()[clipSel.value.replace(/ \*$/, '')];
        if (!src) {
          alert('pick a POSE clip (gltf: clips are baked — copy their feel into a new clip instead)');
          return;
        }
        this.stopPosing();
        this.posing = true;
        this.editing = cloneClip(src);
        this.playhead = 0;
        this.scratch = {};
      }
      this.rebuild();
    };
    editRow.append(poseBtn, editBtn);
    this.root.append(editRow);

    // --- edit workbench ---
    if (this.editing) this.buildEditBench();

    // --- channel sliders ---
    if (this.posing || this.editing) this.buildSliders();

    // --- raw bones ---
    this.buildBonePanel(f);
  }

  private buildEditBench(): void {
    const e = this.editing!;
    const box = el('div', 'border:1px solid #2a5a4a;border-radius:4px;padding:6px;margin-bottom:6px;');
    box.append(el('div', 'color:#4adfb0;margin-bottom:4px;', `editing: ${e.name}`));

    const nameIn = el('input', INPUT + 'width:110px;') as HTMLInputElement;
    nameIn.value = e.name;
    nameIn.onchange = () => (e.name = nameIn.value.trim() || e.name);
    const durIn = el('input', INPUT + 'width:44px;') as HTMLInputElement;
    durIn.value = String(e.duration);
    durIn.onchange = () => {
      const d = parseFloat(durIn.value);
      if (d > 0.05) e.duration = d;
      this.rebuild();
    };
    const loopBtn = el('button', e.loop ? BTN_ON : BTN, 'loop');
    loopBtn.onclick = () => {
      e.loop = !e.loop;
      this.rebuild();
    };
    box.append(el('span', 'color:#5a8a7a;', 'name '), nameIn, el('span', 'color:#5a8a7a;', ' dur '), durIn, loopBtn);

    const row2 = el('div', 'margin-top:4px;');
    const playBtn = el('button', this.playInEdit ? BTN_ON : BTN, this.playInEdit ? '⏸ preview' : '▶ preview');
    playBtn.onclick = () => {
      this.playInEdit = !this.playInEdit;
      this.scratch = {};
      this.rebuild();
    };
    const keyBtn = el('button', BTN, '⏺ KEY');
    keyBtn.title = 'write every touched slider as a keyframe at the playhead';
    keyBtn.onclick = () => {
      const touched = Object.keys(this.scratch);
      for (const ch of touched) {
        const keys = e.tracks[ch] ?? (e.tracks[ch] = []);
        const t = Math.round(this.playhead * 100) / 100;
        const existing = keys.findIndex((key) => Math.abs(key.t - t) < 0.02);
        if (existing >= 0) keys[existing].v = this.scratch[ch];
        else {
          keys.push({ t, v: this.scratch[ch] });
          keys.sort((a, b) => a.t - b.t);
        }
      }
      this.scratch = {};
      this.rebuild();
    };
    const saveBtn = el('button', BTN, '💾 save');
    saveBtn.title = 'persists to localStorage and drives the live game';
    saveBtn.onclick = () => {
      this.mgr.saveClip(cloneClip(e));
      this.rebuild();
    };
    const exportBtn = el('button', BTN, '⇩ export');
    exportBtn.onclick = () => {
      const json = JSON.stringify(e, null, 2);
      console.log(`[folk] clip "${e.name}" JSON:\n${json}`);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${e.name}.clip.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    const importBtn = el('button', BTN, '⇧ import');
    importBtn.onclick = () => {
      const raw = prompt('paste clip JSON');
      if (!raw) return;
      try {
        const clip = JSON.parse(raw) as AnimClip;
        if (!clip.name || !clip.tracks) throw new Error('not a clip');
        this.mgr.saveClip(clip);
        this.editing = cloneClip(clip);
        this.rebuild();
      } catch (err) {
        alert(`bad clip JSON: ${String(err)}`);
      }
    };
    row2.append(playBtn, keyBtn, saveBtn, exportBtn, importBtn);
    box.append(row2);

    // Track list: every channel with keys; click a chip to delete that key.
    const tracks = el('details', 'margin-top:4px;');
    const nTracks = Object.keys(e.tracks).length;
    tracks.append(el('summary', 'cursor:pointer;color:#5a8a7a;', `tracks (${nTracks})`));
    for (const [ch, keys] of Object.entries(e.tracks)) {
      const row = el('div', 'margin:2px 0;');
      const del = el('button', BTN + 'padding:0 4px;', '×');
      del.title = `delete the whole ${ch} track`;
      del.onclick = () => {
        delete e.tracks[ch];
        this.rebuild();
      };
      row.append(del, el('span', 'color:#7ab8a8;', ` ${ch}: `));
      keys.forEach((key, i) => {
        const chip = el('button', BTN + 'padding:0 4px;', `${key.t.toFixed(2)}:${key.v.toFixed(2)}`);
        chip.title = 'click to delete this key';
        chip.onclick = () => {
          keys.splice(i, 1);
          if (!keys.length) delete e.tracks[ch];
          this.rebuild();
        };
        row.append(chip);
      });
      tracks.append(row);
    }
    box.append(tracks);
    this.root.append(box);
  }

  private buildSliders(): void {
    const f = this.sel();
    if (!f) return;
    const base: Pose = {};
    if (this.editing) sampleClip(this.editing, this.playhead, base);

    for (const group of CHANNEL_GROUPS) {
      const d = el('details', 'margin-bottom:2px;');
      if (group.label.startsWith('Head') || group.label.startsWith('Body')) d.open = true;
      d.append(el('summary', 'cursor:pointer;color:#4adfb0;', group.label));
      for (const ch of group.channels) {
        const row = el('div', 'display:flex;align-items:center;gap:4px;');
        row.append(el('span', 'width:88px;color:#7ab8a8;overflow:hidden;', ch.id.replace(/^(arm|leg)([LR])\./, '$2.')));
        const s = el('input', 'flex:1;') as HTMLInputElement;
        s.type = 'range';
        s.min = String(ch.min);
        s.max = String(ch.max);
        s.step = '0.01';
        const v0 = this.scratch[ch.id] ?? base[ch.id] ?? 0;
        s.value = String(v0);
        const read = el('span', 'width:40px;color:#5a8a7a;', v0.toFixed(2));
        s.oninput = () => {
          const v = parseFloat(s.value);
          this.scratch[ch.id] = v;
          read.textContent = v.toFixed(2);
        };
        const zero = el('button', BTN + 'padding:0 4px;', '0');
        zero.onclick = () => {
          delete this.scratch[ch.id];
          s.value = String(base[ch.id] ?? 0);
          read.textContent = (base[ch.id] ?? 0).toFixed(2);
        };
        row.append(s, read, zero);
        d.append(row);
        this.sliderRefs.set(ch.id, { input: s, readout: read });
      }
      this.root.append(d);
    }
  }

  /** While previewing an edit, sliders follow the clip (untouched ones). */
  private refreshSlidersFromClip(): void {
    if (!this.editing) return;
    const base: Pose = {};
    sampleClip(this.editing, this.playhead, base);
    for (const [ch, ref] of this.sliderRefs) {
      if (ch in this.scratch) continue;
      const v = base[ch] ?? 0;
      ref.input.value = String(v);
      ref.readout.textContent = v.toFixed(2);
    }
  }

  private buildBonePanel(f: MushroomFolk): void {
    const d = el('details', 'border-top:1px solid #1f4a3e;margin-top:6px;padding-top:4px;');
    d.append(el('summary', 'cursor:pointer;color:#4adfb0;', `raw bones (${f.skel.boneNames.length})`));

    const unresolved = f.skel.unresolved();
    if (unresolved.length) {
      d.append(el('div', 'color:#e8a54a;', `unmapped slots: ${unresolved.join(', ')}`));
    }

    const list = el('div', 'max-height:120px;overflow-y:auto;margin:4px 0;');
    for (const name of f.skel.boneNames) {
      const b = el('button', name === this.selBone ? BTN_ON : BTN, name);
      b.onclick = () => {
        this.selBone = name;
        this.rebuild();
      };
      list.append(b);
    }
    d.append(list);

    if (this.selBone) {
      d.append(el('div', 'color:#5a8a7a;', `bone:${this.selBone} — local rotation (keyable channels)`));
      for (const axis of ['x', 'y', 'z'] as const) {
        const ch = `bone:${this.selBone}.${axis}`;
        const row = el('div', 'display:flex;align-items:center;gap:4px;');
        row.append(el('span', 'width:24px;color:#7ab8a8;', axis));
        const s = el('input', 'flex:1;') as HTMLInputElement;
        s.type = 'range';
        s.min = '-3.14';
        s.max = '3.14';
        s.step = '0.01';
        s.value = String(this.scratch[ch] ?? 0);
        const read = el('span', 'width:40px;color:#5a8a7a;', (this.scratch[ch] ?? 0).toFixed(2));
        s.oninput = () => {
          if (!this.posing && !this.editing) {
            this.posing = true; // grab the body the moment a bone slider moves
          }
          this.scratch[ch] = parseFloat(s.value);
          read.textContent = s.value;
        };
        row.append(s, read);
        d.append(row);
      }
    }

    // Model facing fix: if a folk walks backwards, flip it here, live.
    const yawRow = el('div', 'margin-top:4px;');
    yawRow.append(el('span', 'color:#5a8a7a;', 'model facing '));
    for (const [label, yaw] of [
      ['0°', 0],
      ['180°', Math.PI],
    ] as const) {
      const b = el('button', Math.abs(f.modelWrap.rotation.y - yaw) < 0.01 ? BTN_ON : BTN, label);
      b.onclick = () => {
        this.targets().forEach((t) => (t.modelWrap.rotation.y = yaw));
        this.rebuild();
      };
      yawRow.append(b);
    }
    d.append(yawRow);
    this.root.append(d);
  }
}
