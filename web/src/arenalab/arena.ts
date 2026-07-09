/**
 * ARENALAB — character & combat testbed (John). The mushroom folk + the orb's
 * damage verbs in a flat arena, isolated from the world: iterate on combat
 * feel, animation, and (soon) the R24 Dark-Armor rules without booting the
 * Reek. Runs at /arenalab.html on the lab server; game code is consumed
 * read-only (FolkManager is the same class main.ts drives).
 *
 * Verbs wired exactly like main.ts wires them:
 *   DASH  — burst move; folk.beginDash() + dashSweep() while dashing
 *   WAVE  — folk.applyForceWave(orb.pos): radial shove + falloff damage
 * Folk fight back in ATTACK mode (spore-bolts shove the orb via onOrbHit).
 */

import * as THREE from 'three';
import { FolkManager } from '../entity/FolkManager';
import { logger } from '../core/log';

const log = logger('arenalab');

// --- Boilerplate: renderer, error surface, camera ------------------------------

const app = document.getElementById('app')!;
const errBox = document.createElement('div');
errBox.style.cssText =
  'position:fixed;bottom:8px;left:8px;right:8px;z-index:99;color:#ff8080;font:10px/1.4 ui-monospace,monospace;' +
  'background:#200608ee;padding:6px 8px;border-radius:6px;white-space:pre-wrap;display:none;';
document.body.appendChild(errBox);
addEventListener('error', (e) => {
  errBox.style.display = 'block';
  errBox.textContent = `⚠ ${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}`;
});

const COARSE = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070c);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 400);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Arena: flat slab + rim, braziers for light ---------------------------------

const ARENA_R = 26;
const ground = new THREE.Mesh(
  new THREE.CylinderGeometry(ARENA_R, ARENA_R, 1, 48),
  new THREE.MeshLambertMaterial({ color: 0x2e3340 }),
);
ground.position.y = -0.5;
scene.add(ground);
const rim = new THREE.Mesh(
  new THREE.TorusGeometry(ARENA_R, 0.35, 8, 64).rotateX(Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x53e0ff, transparent: true, opacity: 0.35 }),
);
rim.position.y = 0.15;
scene.add(rim);

const ambient = new THREE.AmbientLight(0xffffff, 1.5);
scene.add(ambient);
scene.add(new THREE.HemisphereLight(0x22304a, 0x0a0c12, 0.5));
let dark = false;
const braziers: THREE.PointLight[] = [];
for (let i = 0; i < 3; i++) {
  const a = (i / 3) * Math.PI * 2;
  const L = new THREE.PointLight(0x9dffb0, 1.6, 26, 1.8);
  L.position.set(Math.cos(a) * (ARENA_R - 5), 2.2, Math.sin(a) * (ARENA_R - 5));
  scene.add(L);
  braziers.push(L);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9dffb0 }));
  bulb.position.copy(L.position);
  scene.add(bulb);
}

// --- The orb stand-in: movable light with dash + wave ----------------------------

const orb = {
  pos: new THREE.Vector3(0, 1.6, 10),
  vel: new THREE.Vector3(),
  dashing: false,
  dashT: 0,
  dashStarted: false,
};
const orbMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.5, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0x101418 }),
);
scene.add(orbMesh);
const orbLight = new THREE.PointLight(0x9fd6ff, 2.2, 22, 1.8);
scene.add(orbLight);
const orbGlow = new THREE.Mesh(
  new THREE.SphereGeometry(0.62, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0x9fd6ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending }),
);
scene.add(orbGlow);
let hitFlash = 0;

// mote texture for FolkEffects (radial gradient, same recipe as the game's)
const moteCanvas = document.createElement('canvas');
moteCanvas.width = moteCanvas.height = 64;
{
  const g = moteCanvas.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
}
const moteTexture = new THREE.CanvasTexture(moteCanvas);

// --- Folk ------------------------------------------------------------------------

const folk = new FolkManager({
  scene,
  solid: (_x, y, _z) => y <= 0, // flat arena floor
  moteTexture,
  getOrbPos: () => orb.pos,
  onOrbHit: (from, power) => {
    const push = orb.pos.clone().sub(from).setY(0).normalize().multiplyScalar(power * 4);
    orb.vel.add(push);
    hitFlash = 1;
  },
});
let folkReady = false;
void folk.load().then(() => {
  folk.spawnAll(new THREE.Vector3(0, 0, -6), new THREE.Vector3(0, 0, 1));
  folkReady = true;
  updateHud();
});

// --- Controls: WASD/stick move, dash, wave ----------------------------------------

let yaw = 0;
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') dash();
  if (e.code === 'KeyQ') wave();
  if (e.code === 'KeyM') {
    folk.cycleMode();
    updateHud();
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));

function dash(): void {
  if (orb.dashing) return;
  orb.dashing = true;
  orb.dashStarted = true;
  orb.dashT = 0.16;
  const dir = lastMove.lengthSq() > 0.01 ? lastMove.clone().normalize() : new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  orb.vel.addScaledVector(dir, 26);
}
function wave(): void {
  folk.applyForceWave(orb.pos.clone());
  ringPulse = 1;
}
let ringPulse = 0;

const lastMove = new THREE.Vector3();
const stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
if (COARSE) {
  const btn = (label: string, right: number, bottom: number, onTap: () => void): void => {
    const b = document.createElement('div');
    b.textContent = label;
    b.style.cssText =
      `position:fixed;right:${right}px;bottom:${bottom}px;width:60px;height:60px;display:flex;align-items:center;` +
      'justify-content:center;border-radius:50%;background:#1c2836cc;color:#9fd6ff;font-size:13px;z-index:10;touch-action:none;';
    b.addEventListener('touchstart', (e) => {
      e.preventDefault();
      onTap();
    }, { passive: false });
    document.body.appendChild(b);
  };
  btn('DASH', 14, 96, dash);
  btn('WAVE', 14, 26, wave);
  const el = renderer.domElement;
  el.addEventListener('touchstart', (e) => {
    for (const t of Array.from(e.changedTouches)) {
      if (!stick.active) Object.assign(stick, { active: true, id: t.identifier, ox: t.clientX, oy: t.clientY });
    }
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (stick.active && t.identifier === stick.id) {
        stick.x = THREE.MathUtils.clamp((t.clientX - stick.ox) / 60, -1, 1);
        stick.y = THREE.MathUtils.clamp((t.clientY - stick.oy) / 60, -1, 1);
      }
    }
  }, { passive: false });
  const end = (e: TouchEvent): void => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === stick.id) Object.assign(stick, { active: false, id: -1, x: 0, y: 0 });
    }
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

// --- Panel + HUD --------------------------------------------------------------------

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:10;display:flex;flex-direction:column;gap:6px;';
document.body.appendChild(panel);
const mkBtn = (label: string, onTap: (b: HTMLButtonElement) => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'min-width:100px;padding:9px 10px;border:1px solid #2a3c52;border-radius:8px;background:#0d1622cc;' +
    'color:#9fd6ff;font:11px ui-monospace,Menlo,monospace;touch-action:manipulation;text-align:left;';
  b.addEventListener('click', () => onTap(b));
  panel.appendChild(b);
  return b;
};

const modeBtn = mkBtn('MODE: still', () => {
  const order = ['still', 'walk', 'move', 'attack'] as const;
  folk.setMode(order[(order.indexOf(folk.mode) + 1) % order.length]);
  updateHud();
});
mkBtn('WAVE', () => wave());
mkBtn('DASH', () => dash());
mkBtn('DARK', (b) => {
  dark = !dark;
  ambient.intensity = dark ? 0.12 : 1.5;
  scene.background = new THREE.Color(dark ? 0x010204 : 0x05070c);
  for (const L of braziers) L.intensity = dark ? 2.4 : 1.6;
  b.style.background = dark ? '#3a6ea5cc' : '#0d1622cc';
});
mkBtn('RESPAWN: on', (b) => {
  folk.respawnEnabled = !folk.respawnEnabled;
  b.textContent = `RESPAWN: ${folk.respawnEnabled ? 'on' : 'off'}`;
});

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;top:8px;left:8px;z-index:10;color:#9fd6ff;font:11px/1.5 ui-monospace,Menlo,monospace;' +
  'background:#060a10c0;padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre-wrap;max-width:calc(100vw - 130px);';
document.body.appendChild(hud);
let fps = 60;
function updateHud(): void {
  modeBtn.textContent = `MODE: ${folk.mode}`;
  const alive = folk.folk.filter((f) => f.state === 'alive').length;
  hud.textContent =
    `ARENALAB  folk ${alive}/${folk.folk.length}${folkReady ? '' : ' (loading…)'}\n` +
    `${fps.toFixed(0)} fps · draws ${renderer.info.render.calls} · tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k\n` +
    `WASD/stick move · SPACE/DASH · Q/WAVE · M cycles mode\n` +
    `ATTACK mode = they fight back (spore-bolts shove the orb)`;
}

// --- Loop ------------------------------------------------------------------------------

let last = performance.now();
let hudT = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

  // movement
  const wish = new THREE.Vector3();
  if (keys.has('KeyW')) wish.z -= 1;
  if (keys.has('KeyS')) wish.z += 1;
  if (keys.has('KeyA')) wish.x -= 1;
  if (keys.has('KeyD')) wish.x += 1;
  wish.add(new THREE.Vector3(stick.x, 0, stick.y));
  if (wish.lengthSq() > 1) wish.normalize();
  lastMove.copy(wish);
  orb.vel.addScaledVector(wish, 60 * dt);
  orb.vel.multiplyScalar(Math.exp(-4.2 * dt));
  orb.pos.addScaledVector(orb.vel, dt);
  const r = Math.hypot(orb.pos.x, orb.pos.z);
  if (r > ARENA_R - 1) {
    const inward = -((r - (ARENA_R - 1)) * 6);
    orb.pos.x += (orb.pos.x / r) * inward * dt * 10;
    orb.pos.z += (orb.pos.z / r) * inward * dt * 10;
  }
  orb.pos.y = 1.6;
  if (orb.dashing) {
    orb.dashT -= dt;
    if (orb.dashT <= 0) orb.dashing = false;
  }

  orbMesh.position.copy(orb.pos);
  orbGlow.position.copy(orb.pos);
  orbLight.position.copy(orb.pos);
  hitFlash = Math.max(0, hitFlash - dt * 3);
  ringPulse = Math.max(0, ringPulse - dt * 2);
  (orbGlow.material as THREE.MeshBasicMaterial).opacity = 0.25 + hitFlash * 0.5;
  (rim.material as THREE.MeshBasicMaterial).opacity = 0.35 + ringPulse * 0.5;

  // camera: soft chase behind the orb
  const camTarget = new THREE.Vector3(orb.pos.x, 0, orb.pos.z);
  const camPos = new THREE.Vector3(orb.pos.x, 14, orb.pos.z + 20);
  camera.position.lerp(camPos, 1 - Math.exp(-4 * dt));
  camera.lookAt(camTarget.x, 2, camTarget.z);

  // folk combat wiring — exactly main.ts's contract
  if (folkReady) {
    if (orb.dashStarted) {
      folk.beginDash();
      orb.dashStarted = false;
    }
    if (orb.dashing) folk.dashSweep(orb.pos);
    folk.update(dt, camera, { paused: false, dashing: orb.dashing, dashStarted: false });
  }

  hudT += dt;
  if (hudT > 0.33) {
    hudT = 0;
    updateHud();
  }
  renderer.render(scene, camera);
});

log.info('arenalab up');
