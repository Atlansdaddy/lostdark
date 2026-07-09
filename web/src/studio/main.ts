/**
 * Animator Studio — the animation engine's workbench, on its OWN page.
 *
 * This deliberately does NOT run inside the game (`/index.html` → src/main.ts):
 * the studio is a tool, so it gets neutral tool lighting, an orbit camera and
 * a DOM UI instead of the game's darkness rules. It shares only the engine —
 * SkeletonMap / PoseRig / AnimClip — so anything authored here drives the same
 * rigs in-game unchanged.
 *
 * Serve:  npm run dev  →  http://localhost:5173/studio.html
 * Load:   drop any rigged .glb (Meshy/Mixamo-style) onto the page, use the
 *         Load GLB button, or pass ?model=assets/path/to.glb
 *
 * Panels: left = semantic pose channels (+ raw bone:* channels you mint from
 * the bone tree) · right = slot mapping, bone tree, GLTF-embedded clips ·
 * bottom = clip transport: keyframe, scrub, play, export/import JSON.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SkeletonMap, type SlotName } from '../entity/SkeletonMap';
import { PoseRig, CHANNEL_GROUPS, type Pose } from '../entity/PoseRig';
import { sampleClip, cloneClip, type AnimClip, type Key } from '../entity/AnimClip';

// --- Scene: neutral three-point tool lighting (a workbench, not the Reek) ---

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(2.4, 1.6, 3.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0x8fb5c8, 0x1a2026, 0.9));
const key = new THREE.DirectionalLight(0xfff2df, 2.2);
key.position.set(2, 4, 3);
const rim = new THREE.DirectionalLight(0x9fd8ff, 0.8);
rim.position.set(-3, 2, -2);
scene.add(key, rim);
scene.add(new THREE.GridHelper(10, 20, 0x2a3a48, 0x16202a));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Rig state ---------------------------------------------------------------

let skel: SkeletonMap | null = null;
let rig: PoseRig | null = null;
let poseRoot: THREE.Group | null = null;
let skelHelper: THREE.SkeletonHelper | null = null;
let mixer: THREE.AnimationMixer | null = null;
let gltfClips: THREE.AnimationClip[] = [];
/** 'pose' = PoseRig drives the bones · 'gltf' = an embedded clip's mixer does. */
let mode: 'pose' | 'gltf' = 'pose';

/** Live slider state — THE pose while not playing. */
const poseValues: Pose = {};

// --- Clip state ---------------------------------------------------------------

function makeClip(name: string): AnimClip {
  return { name, duration: 2, loop: true, tracks: {} };
}
const clips: AnimClip[] = [makeClip('clip_01')];
let clip: AnimClip = clips[0];
let playhead = 0;
let playing = false;

// --- Tiny DOM helpers ----------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (HTMLElement | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

function panel(id: string): HTMLDivElement {
  const p = el('div', { className: 'panel' });
  p.id = id;
  document.body.appendChild(p);
  return p;
}

const posePanel = panel('pose');
const rigPanel = panel('rig');
const transport = panel('transport');
const dropHint = document.getElementById('drop')!;

// --- Pose panel: semantic channel sliders (+ minted raw bone channels) ---------

interface SliderRow {
  input: HTMLInputElement;
  val: HTMLSpanElement;
  row: HTMLDivElement;
}
const sliders = new Map<string, SliderRow>();

function addSlider(parent: HTMLElement, id: string, min: number, max: number): void {
  const input = el('input', { type: 'range' });
  input.min = String(min);
  input.max = String(max);
  input.step = '0.01';
  input.value = '0';
  const val = el('span', { className: 'val', textContent: '0.00' });
  const label = el('label', { textContent: id.replace(/^bone:/, '⚙') , title: `${id} — click to zero` });
  const row = el('div', { className: 'row' }, label, input, val);
  input.addEventListener('input', () => {
    poseValues[id] = parseFloat(input.value);
    val.textContent = poseValues[id].toFixed(2);
  });
  label.addEventListener('click', () => {
    input.value = '0';
    poseValues[id] = 0;
    val.textContent = '0.00';
  });
  parent.appendChild(row);
  sliders.set(id, { input, val, row });
  poseValues[id] = poseValues[id] ?? 0;
}

function buildPosePanel(): void {
  posePanel.replaceChildren();
  for (const g of CHANNEL_GROUPS) {
    posePanel.appendChild(el('h3', { textContent: g.label }));
    for (const c of g.channels) addSlider(posePanel, c.id, c.min, c.max);
  }
  const reset = el('button', { textContent: 'zero all channels' });
  reset.addEventListener('click', () => {
    for (const [id, s] of sliders) {
      poseValues[id] = 0;
      s.input.value = '0';
      s.val.textContent = '0.00';
    }
  });
  posePanel.appendChild(el('h3', { textContent: 'Raw bones' }));
  posePanel.appendChild(
    el('div', { className: 'tname', textContent: 'click a bone in the tree → sliders appear here' }),
  );
  bonesHost = el('div');
  posePanel.appendChild(bonesHost);
  posePanel.appendChild(el('h3', { textContent: '' }));
  posePanel.appendChild(reset);
}
let bonesHost: HTMLDivElement = el('div');

/** Mint bone:<Name>.x/y/z sliders for a bone picked in the tree. */
function mintBoneChannels(name: string): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    const id = `bone:${name}.${axis}`;
    if (!sliders.has(id)) addSlider(bonesHost, id, -Math.PI, Math.PI);
  }
}

/** Push a (sampled or loaded) pose into the sliders so scrub → tweak → re-key works. */
function syncSliders(pose: Pose): void {
  for (const [id, s] of sliders) {
    const v = pose[id] ?? 0;
    poseValues[id] = v;
    s.input.value = String(v);
    s.val.textContent = v.toFixed(2);
  }
}

/** Mark rows whose channel has keys in the current clip (keyed = amber value). */
function refreshKeyedMarks(): void {
  for (const [id, s] of sliders) s.row.classList.toggle('keyed', !!clip.tracks[id]?.length);
}

// --- Rig panel: slot mapping · bone tree · embedded GLTF clips -----------------

function buildRigPanel(): void {
  rigPanel.replaceChildren();
  if (!skel) {
    rigPanel.appendChild(el('h3', { textContent: 'Rig' }));
    rigPanel.appendChild(el('div', { className: 'tname', textContent: 'no model loaded' }));
    return;
  }
  const s = skel;

  rigPanel.appendChild(el('h3', { textContent: 'Slot mapping' }));
  const slotNames = [...s.slots.keys(), ...s.unresolved()] as SlotName[];
  const allSlots = [...new Set(slotNames)];
  for (const slot of allSlots) {
    const sel = el('select');
    sel.appendChild(el('option', { value: '', textContent: '—' }));
    for (const b of s.boneNames) sel.appendChild(el('option', { value: b, textContent: b }));
    sel.value = s.slots.get(slot) ?? '';
    sel.addEventListener('change', () => {
      if (sel.value) {
        s.remap(slot, sel.value);
        rig?.rebind();
      }
      buildRigPanel(); // re-render missing marks
    });
    const label = el('label', {
      textContent: slot,
      className: s.slots.has(slot) ? '' : 'slot-missing',
    });
    rigPanel.appendChild(el('div', { className: 'row' }, label, sel));
  }

  if (gltfClips.length) {
    rigPanel.appendChild(el('h3', { textContent: 'Embedded clips' }));
    for (const c of gltfClips) {
      const play = el('button', { textContent: `▶ ${c.name}` });
      play.addEventListener('click', () => {
        if (!mixer) return;
        mixer.stopAllAction();
        mixer.clipAction(c).reset().play();
        mode = 'gltf';
        playing = false;
      });
      rigPanel.appendChild(el('div', { className: 'row' }, play));
    }
    const stop = el('button', { textContent: '■ back to pose mode' });
    stop.addEventListener('click', () => {
      mixer?.stopAllAction();
      s.resetToRest(s.boneNames);
      mode = 'pose';
    });
    rigPanel.appendChild(el('div', { className: 'row' }, stop));
  }

  rigPanel.appendChild(el('h3', { textContent: `Bones (${s.boneNames.length})` }));
  rigPanel.appendChild(
    el('div', { className: 'tname', textContent: 'click → raw channel sliders (left panel)' }),
  );
  for (const name of s.boneNames) {
    const b = el('div', { className: 'bone', textContent: name, title: name });
    b.addEventListener('click', () => mintBoneChannels(name));
    rigPanel.appendChild(b);
  }
}

// --- Transport: clip management · keyframing · timeline · JSON I/O -------------

let timeline!: HTMLInputElement;
let timeLabel!: HTMLSpanElement;
let clipSelect!: HTMLSelectElement;
let nameInput!: HTMLInputElement;
let durInput!: HTMLInputElement;
let loopInput!: HTMLInputElement;
let playBtn!: HTMLButtonElement;
let tracksHost!: HTMLDivElement;

function upsertKey(keys: Key[], t: number, v: number): void {
  const hit = keys.find((k) => Math.abs(k.t - t) < 0.02);
  if (hit) {
    hit.v = v;
    return;
  }
  keys.push({ t, v });
  keys.sort((a, b) => a.t - b.t);
}

/** Key the CURRENT pose at the playhead: every non-zero channel, plus every
 *  channel the clip already tracks (so animating back to 0 works). */
function keyPose(): void {
  for (const [id, v] of Object.entries(poseValues)) {
    if (Math.abs(v) < 1e-4 && !clip.tracks[id]) continue;
    const keys = clip.tracks[id] ?? (clip.tracks[id] = []);
    upsertKey(keys, playhead, v);
  }
  refreshKeyedMarks();
  buildTracksList();
}

function buildTracksList(): void {
  tracksHost.replaceChildren();
  const entries = Object.entries(clip.tracks);
  if (!entries.length) {
    tracksHost.appendChild(el('span', { className: 'tname', textContent: 'no tracks yet — pose, then Key' }));
    return;
  }
  for (const [ch, keys] of entries) {
    const del = el('button', { textContent: '✕', title: `delete track ${ch}` });
    del.addEventListener('click', () => {
      delete clip.tracks[ch];
      refreshKeyedMarks();
      buildTracksList();
    });
    tracksHost.appendChild(
      el('div', { className: 'row' }, el('label', { textContent: `${ch} (${keys.length})`, title: ch }), del),
    );
  }
}

function selectClip(c: AnimClip): void {
  clip = c;
  playhead = 0;
  playing = false;
  nameInput.value = c.name;
  durInput.value = String(c.duration);
  loopInput.checked = c.loop;
  timeline.max = String(c.duration);
  timeline.value = '0';
  playBtn.textContent = '▶';
  refreshKeyedMarks();
  buildTracksList();
}

function rebuildClipSelect(): void {
  clipSelect.replaceChildren();
  for (let i = 0; i < clips.length; i++) {
    clipSelect.appendChild(el('option', { value: String(i), textContent: clips[i].name }));
  }
  clipSelect.value = String(clips.indexOf(clip));
}

function scrubTo(t: number): void {
  playhead = t;
  timeline.value = String(t);
  timeLabel.textContent = `${t.toFixed(2)}s`;
  if (rig && mode === 'pose') {
    const pose: Pose = {};
    sampleClip(clip, t, pose);
    syncSliders(pose);
  }
}

function buildTransport(): void {
  clipSelect = el('select');
  clipSelect.addEventListener('change', () => selectClip(clips[Number(clipSelect.value)]));

  nameInput = el('input', { type: 'text' });
  nameInput.style.width = '110px';
  nameInput.addEventListener('change', () => {
    clip.name = nameInput.value || clip.name;
    rebuildClipSelect();
  });

  const newBtn = el('button', { textContent: 'new' });
  newBtn.addEventListener('click', () => {
    clips.push(makeClip(`clip_${String(clips.length + 1).padStart(2, '0')}`));
    selectClip(clips[clips.length - 1]);
    rebuildClipSelect();
  });
  const dupBtn = el('button', { textContent: 'dup' });
  dupBtn.addEventListener('click', () => {
    clips.push(cloneClip(clip, `${clip.name}_copy`));
    selectClip(clips[clips.length - 1]);
    rebuildClipSelect();
  });

  durInput = el('input', { type: 'number' });
  durInput.min = '0.1';
  durInput.step = '0.1';
  durInput.style.width = '54px';
  durInput.addEventListener('change', () => {
    clip.duration = Math.max(0.1, parseFloat(durInput.value) || clip.duration);
    durInput.value = String(clip.duration);
    timeline.max = String(clip.duration);
  });

  loopInput = el('input', { type: 'checkbox', checked: true });
  loopInput.addEventListener('change', () => (clip.loop = loopInput.checked));

  playBtn = el('button', { textContent: '▶' });
  playBtn.addEventListener('click', () => {
    playing = !playing;
    if (playing) mode = 'pose';
    playBtn.textContent = playing ? '⏸' : '▶';
  });

  timeline = el('input', { type: 'range' });
  timeline.id = 'timeline';
  timeline.min = '0';
  timeline.max = String(clip.duration);
  timeline.step = '0.01';
  timeline.value = '0';
  timeline.addEventListener('input', () => {
    playing = false;
    playBtn.textContent = '▶';
    scrubTo(parseFloat(timeline.value));
  });
  timeLabel = el('span', { className: 'val', textContent: '0.00s' });

  const keyBtn = el('button', { textContent: '◆ key' });
  keyBtn.addEventListener('click', keyPose);

  const exportBtn = el('button', { textContent: 'export json' });
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(clip, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${clip.name}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const importInput = el('input', { type: 'file' });
  importInput.accept = '.json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as AnimClip;
      if (typeof data.name !== 'string' || typeof data.duration !== 'number' || !data.tracks) {
        throw new Error('not an AnimClip');
      }
      clips.push(data);
      selectClip(data);
      rebuildClipSelect();
    } catch (err) {
      alert(`import failed: ${(err as Error).message}`);
    }
    importInput.value = '';
  });
  const importBtn = el('button', { textContent: 'import json' });
  importBtn.addEventListener('click', () => importInput.click());

  const loadBtn = el('button', { textContent: 'Load GLB' });
  loadBtn.addEventListener('click', () => glbInput.click());

  const helperInput = el('input', { type: 'checkbox' });
  helperInput.addEventListener('change', () => {
    if (skelHelper) skelHelper.visible = helperInput.checked;
  });

  tracksHost = el('div');
  tracksHost.id = 'tracks';
  tracksHost.style.maxHeight = '52px';
  tracksHost.style.overflowY = 'auto';
  tracksHost.style.flex = '0 0 190px';

  transport.replaceChildren(
    loadBtn,
    clipSelect,
    nameInput,
    newBtn,
    dupBtn,
    el('span', { className: 'tname', textContent: 'dur' }),
    durInput,
    el('span', { className: 'tname', textContent: 'loop' }),
    loopInput,
    playBtn,
    timeline,
    timeLabel,
    keyBtn,
    exportBtn,
    importBtn,
    importInput,
    el('span', { className: 'tname', textContent: 'skeleton' }),
    helperInput,
    tracksHost,
  );
  buildTracksList();
}

// --- Model loading: file picker · drag-drop · ?model= --------------------------

const loader = new GLTFLoader();
const glbInput = el('input', { type: 'file' });
glbInput.accept = '.glb,.gltf';
glbInput.style.display = 'none';
document.body.appendChild(glbInput);
glbInput.addEventListener('change', () => {
  const f = glbInput.files?.[0];
  if (f) loadFile(f);
  glbInput.value = '';
});

function loadFile(f: File): void {
  const url = URL.createObjectURL(f);
  loader.load(
    url,
    (gltf) => {
      URL.revokeObjectURL(url);
      onModel(gltf.scene, gltf.animations);
    },
    undefined,
    (err) => {
      URL.revokeObjectURL(url);
      alert(`load failed: ${String(err)}`);
    },
  );
}

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

function onModel(root: THREE.Object3D, animations: THREE.AnimationClip[]): void {
  // Clear the previous character.
  if (poseRoot) scene.remove(poseRoot);
  if (skelHelper) scene.remove(skelHelper);
  mixer?.stopAllAction();
  mode = 'pose';

  // SkeletonMap reads rest quats relative to the loaded scene node, so build it
  // BEFORE any wrapper transforms (translation below is fine — quats untouched).
  skel = new SkeletonMap(root);

  // Feet-at-origin wrapper: root.* channels topple around ground contact.
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= bounds.min.y;
  poseRoot = new THREE.Group();
  poseRoot.add(root);
  scene.add(poseRoot);

  rig = new PoseRig(skel, poseRoot);
  mixer = new THREE.AnimationMixer(root);
  gltfClips = animations;

  skelHelper = new THREE.SkeletonHelper(root);
  skelHelper.visible = false;
  scene.add(skelHelper);

  // Frame the camera on the character.
  const size = bounds.getSize(new THREE.Vector3());
  const h = Math.max(size.y, 0.5);
  controls.target.set(0, h * 0.55, 0);
  camera.position.set(h * 1.4, h * 0.8, h * 1.9);

  dropHint.style.display = 'none';
  buildRigPanel();
  refreshKeyedMarks();

  const missing = skel.unresolved();
  if (missing.length) {
    console.warn(`[studio] unresolved slots: ${missing.join(', ')} — remap in the Rig panel`);
  }
}

// --- Boot ----------------------------------------------------------------------

buildPosePanel();
buildRigPanel();
buildTransport();
rebuildClipSelect();
selectClip(clip);

const modelParam = new URLSearchParams(location.search).get('model');
if (modelParam) {
  loader.load(
    modelParam,
    (gltf) => onModel(gltf.scene, gltf.animations),
    undefined,
    (err) => console.warn(`[studio] ?model= load failed`, err),
  );
}

// Dev handle, same spirit as the game's window.waiver.
(window as unknown as Record<string, unknown>).waiverStudio = {
  get rig() {
    return rig;
  },
  get skel() {
    return skel;
  },
  get clip() {
    return clip;
  },
  clips,
  poseValues,
};

const clock = new THREE.Clock();
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (mode === 'gltf') {
    mixer?.update(dt);
  } else if (rig) {
    if (playing) {
      playhead += dt;
      if (!clip.loop && playhead >= clip.duration) {
        playhead = clip.duration;
        playing = false;
        playBtn.textContent = '▶';
      }
      const t = clip.loop ? playhead % clip.duration : playhead;
      timeline.value = String(t);
      timeLabel.textContent = `${t.toFixed(2)}s`;
      const pose: Pose = {};
      sampleClip(clip, playhead, pose);
      syncSliders(pose);
      rig.apply(pose);
    } else {
      rig.apply(poseValues);
    }
  }

  controls.update();
  renderer.render(scene, camera);
}
frame();
