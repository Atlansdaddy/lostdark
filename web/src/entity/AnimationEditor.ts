/**
 * AnimationEditor — interactive 3D pose editor for character animations.
 *
 * Load a rigged GLTF, drag bones to pose them, record keyframes, preview playback.
 * Export animations as JSON for use in CharacterAnimationManager.
 */

import * as THREE from 'three';
import type { Animation, PoseKeyframe } from './AnimationEngine';
import type { RiggedCharacter } from './Rigging';
import type { LimbPose } from './CharacterEntity';

export interface AnimationEditorState {
  currentAnimName: string;
  isRecording: boolean;
  currentTime: number;
  duration: number;
  keyframes: PoseKeyframe[];
  selectedBone: THREE.Bone | null;
}

export class AnimationEditor {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private renderer: THREE.WebGLRenderer;
  private rig: RiggedCharacter | null = null;
  private state: AnimationEditorState = {
    currentAnimName: 'untitled',
    isRecording: false,
    currentTime: 0,
    duration: 1,
    keyframes: [],
    selectedBone: null,
  };

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private dragPoint = new THREE.Vector3();
  private isDragging = false;
  private dragOffset = new THREE.Vector3();
  private boneVisuals = new Map<THREE.Bone, THREE.Object3D>();

  constructor(container: HTMLElement) {
    // Setup scene.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    // Setup camera (orthographic for pose editing).
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    this.camera = new THREE.OrthographicCamera(w / -200, w / 200, h / 200, h / -200, 0.1, 1000);
    this.camera.position.z = 10;

    // Setup renderer.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // Lighting.
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(5, 5, 5);
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0x666666));

    // Grid floor.
    const gridHelper = new THREE.GridHelper(10, 20, 0x333333, 0x222222);
    this.scene.add(gridHelper);

    // Input.
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));

    this.animate();
  }

  /** Load a rigged GLTF into the editor. */
  loadRig(rig: RiggedCharacter): void {
    // Clear old rig visuals.
    this.scene.children.forEach((child) => {
      if (child !== this.scene.background) this.scene.remove(child);
    });
    this.boneVisuals.clear();

    this.rig = rig;
    this.scene.add(rig.group);

    // Create bone visuals (small spheres + lines).
    rig.skeleton.bones.forEach((bone) => {
      const group = new THREE.Group();

      // Bone sphere (clickable).
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 16, 16),
        new THREE.MeshPhongMaterial({ color: 0x4488ff }),
      );
      sphere.userData.bone = bone;
      group.add(sphere);

      // Line to parent.
      if (bone.parent && bone.parent instanceof THREE.Bone) {
        const points = [new THREE.Vector3(), bone.position];
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: 0x88aaff }),
        );
        group.add(line);
      }

      // Label.
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#4488ff';
      ctx.font = '12px monospace';
      ctx.fillText(bone.name, 2, 20);
      const texture = new THREE.CanvasTexture(canvas);
      const spriteMat = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(0.5, 0.25, 1);
      sprite.position.y = 0.3;
      group.add(sprite);

      bone.add(group);
      this.boneVisuals.set(bone, group);
    });
  }

  /** Record current pose as a keyframe. */
  recordKeyframe(): void {
    if (!this.rig) return;

    const pose = this.extractPose();
    this.state.keyframes.push({
      t: this.state.currentTime,
      pose,
    });

    // Sort by time.
    this.state.keyframes.sort((a, b) => a.t - b.t);
  }

  /** Extract current bone rotations as a LimbPose. */
  private extractPose(): Partial<LimbPose> {
    if (!this.rig) return {};

    const pose: Partial<LimbPose> = {};
    const boneToKey: Record<string, keyof LimbPose[]> = {
      head: ['headPitch', 'headYaw'],
      body: ['bodyPitch', 'bodyRoll', 'bodyYaw'],
      leg_L: ['legLPitch', 'legLYaw'],
      leg_R: ['legRPitch', 'legRYaw'],
      arm_L: ['armLPitch', 'armLYaw', 'armLRoll'],
      arm_R: ['armRPitch', 'armRYaw', 'armRRoll'],
      hand_L: ['handLRotX', 'handLRotY'],
      hand_R: ['handRRotX', 'handRRotY'],
    };

    for (const [boneName, keys] of Object.entries(boneToKey)) {
      const bone = this.rig.bones.get(boneName);
      if (!bone) continue;

      const euler = new THREE.Euler().setFromQuaternion(bone.quaternion);
      if (keys.includes('Pitch' as keyof LimbPose)) {
        pose[keys[0]] = euler.x;
      }
      if (keys.includes('Yaw' as keyof LimbPose)) {
        pose[keys[1]] = euler.y;
      }
      if (keys.includes('Roll' as keyof LimbPose)) {
        pose[keys[2]] = euler.z;
      }
    }

    return pose;
  }

  /** Export animation as JSON-serializable object. */
  exportAnimation(): Animation {
    return {
      name: this.state.currentAnimName,
      duration: this.state.duration,
      loop: true,
      keyframes: this.state.keyframes,
    };
  }

  /** Clear all keyframes. */
  clearKeyframes(): void {
    this.state.keyframes = [];
  }

  /** Playback timeline (scrub through animation). */
  setCurrentTime(t: number): void {
    this.state.currentTime = Math.max(0, Math.min(t, this.state.duration));
  }

  /** Get current state for UI display. */
  getState(): AnimationEditorState {
    return this.state;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.renderer.domElement) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (this.isDragging && this.state.selectedBone) {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint);
      const delta = new THREE.Vector3().subVectors(this.dragPoint, this.dragOffset);
      this.state.selectedBone.position.add(delta);
      this.dragOffset.copy(this.dragPoint);
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.rig) return;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = Array.from(this.boneVisuals.values())
      .flatMap((g) => g.children)
      .filter((c) => c instanceof THREE.Mesh) as THREE.Mesh[];

    const intersects = this.raycaster.intersectObjects(meshes);
    if (intersects.length > 0) {
      const obj = intersects[0].object.parent;
      if (obj && obj.userData.bone) {
        this.state.selectedBone = obj.userData.bone;
        this.isDragging = true;
        this.dragPlane.setFromNormalAndCoplanarPoint(
          new THREE.Vector3(0, 0, 1),
          this.state.selectedBone.position,
        );
        this.raycaster.setFromCamera(this.mouse, this.camera);
        this.raycaster.ray.intersectPlane(this.dragPlane, this.dragOffset);
      }
    }
  }

  private onMouseUp(): void {
    this.isDragging = false;
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());
    this.renderer.render(this.scene, this.camera);
  }
}

/** UI for the animation editor. */
export function createAnimationEditorUI(editor: AnimationEditor): HTMLElement {
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed;
    left: 10px;
    bottom: 10px;
    background: rgba(0,0,0,0.9);
    color: #0f0;
    font-family: monospace;
    font-size: 12px;
    padding: 15px;
    border: 2px solid #0f0;
    max-width: 400px;
    z-index: 1001;
  `;

  const update = (): void => {
    const state = editor.getState();
    let html = `<div style="font-weight: bold; margin-bottom: 10px;">🎬 ANIMATION EDITOR</div>`;
    html += `<div>Anim: <input type="text" id="animName" value="${state.currentAnimName}" style="width: 100px; background: #222; color: #0f0; border: 1px solid #0f0; padding: 2px;"></div>`;
    html += `<div>Duration: <input type="range" id="duration" min="0.2" max="5" step="0.1" value="${state.duration}" style="width: 100px;"></div>`;
    html += `<div>Keyframes: ${state.keyframes.length}</div>`;
    html += `<div style="margin: 10px 0;">`;
    html += `<button id="recordBtn" style="margin-right: 5px;">Record</button>`;
    html += `<button id="playBtn" style="margin-right: 5px;">Playback</button>`;
    html += `<button id="exportBtn" style="margin-right: 5px;">Export</button>`;
    html += `<button id="clearBtn">Clear</button>`;
    html += `</div>`;
    html += `<div>Time: <input type="range" id="timeline" min="0" max="100" step="0.1" value="${(state.currentTime / state.duration) * 100}" style="width: 100%;"></div>`;
    html += `<div id="keyframeList" style="max-height: 150px; overflow-y: auto; background: #111; padding: 5px; margin-top: 10px; border: 1px solid #0f0; font-size: 10px;"></div>`;

    panel.innerHTML = html;

    // Event listeners.
    const recordBtn = panel.querySelector('#recordBtn') as HTMLButtonElement;
    const playBtn = panel.querySelector('#playBtn') as HTMLButtonElement;
    const exportBtn = panel.querySelector('#exportBtn') as HTMLButtonElement;
    const clearBtn = panel.querySelector('#clearBtn') as HTMLButtonElement;
    const timeline = panel.querySelector('#timeline') as HTMLInputElement;
    const animNameInput = panel.querySelector('#animName') as HTMLInputElement;

    recordBtn.onclick = () => {
      editor.recordKeyframe();
      update();
    };

    playBtn.onclick = () => {
      // Simple playback: scrub through timeline.
      let t = 0;
      const interval = setInterval(() => {
        editor.setCurrentTime(t);
        t += 0.016;
        if (t > state.duration) clearInterval(interval);
      }, 16);
    };

    exportBtn.onclick = () => {
      const anim = editor.exportAnimation();
      console.log(JSON.stringify(anim, null, 2));
      alert('Animation exported to console (F12)');
    };

    clearBtn.onclick = () => {
      editor.clearKeyframes();
      update();
    };

    timeline.oninput = (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      editor.setCurrentTime((val / 100) * state.duration);
    };

    animNameInput.onchange = (e) => {
      state.currentAnimName = (e.target as HTMLInputElement).value;
    };

    // Keyframe list.
    const list = panel.querySelector('#keyframeList')!;
    list.innerHTML = state.keyframes
      .map((kf, i) => `<div>${i}: t=${kf.t.toFixed(2)}s</div>`)
      .join('');
  };

  setInterval(update, 100);
  update();
  return panel;
}
