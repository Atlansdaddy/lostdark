/**
 * CharacterTestbed — demo UI for mushroom characters.
 *
 * Spawns characters, lets you toggle states, apply damage, attack.
 * Mount this in a corner (or full-screen for testing).
 */

import * as THREE from 'three';
import { CharacterEntity, CharacterState } from './CharacterEntity';
import { CharacterManager } from './CharacterManager';
import { BiomeTheme } from './CombatSystem';

export enum TestbedDisplayMode {
  Still = 'still',
  Walk = 'walk',
  MoveAndStrafe = 'move+strafe',
  Attack = 'attack',
  Dash = 'dash',
  Cycle = 'cycle',
}

export interface CharacterTestbedUI {
  container: HTMLDivElement;
  update(): void;
}

export function createCharacterTestbed(
  scene: THREE.Scene,
  manager: CharacterManager,
): CharacterTestbedUI {
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(0,0,0,0.8);
    color: #0f0;
    font-family: monospace;
    font-size: 12px;
    padding: 10px;
    border: 1px solid #0f0;
    max-width: 300px;
    z-index: 1000;
    line-height: 1.4;
  `;
  document.body.appendChild(container);

  let displayMode = TestbedDisplayMode.Still;
  let selectedCharacter: CharacterEntity | null = null;
  let cycleIndex = 0;
  let spawnCount = 0;

  const updateUI = (): void => {
    const chars = manager.getCharacters();
    let html = `<div>🍄 MUSHROOM TESTBED</div>`;
    html += `<hr style="margin: 5px 0; border: 1px solid #0f0; opacity: 0.5;">`;
    html += `<div>Spawned: ${chars.length}</div>`;
    html += `<div>Alive: ${manager.getAliveCharacters().length}</div>`;

    if (selectedCharacter) {
      const health = Math.round(selectedCharacter.health);
      const healthBar =
        '█'.repeat(Math.round(health / 10)) + '░'.repeat(10 - Math.round(health / 10));
      html += `<div>Selected Health: [${healthBar}] ${health}/${selectedCharacter.maxHealth}</div>`;
      html += `<div>State: ${selectedCharacter.state}</div>`;
    }

    html += `<hr style="margin: 5px 0; border: 1px solid #0f0; opacity: 0.5;">`;
    html += `<div><strong>SPAWN</strong></div>`;
    html += `<button onclick="window.__testbed_spawn(1)">+1</button> `;
    html += `<button onclick="window.__testbed_spawn(5)">+5</button> `;
    html += `<button onclick="window.__testbed_clear()">Clear</button><br>`;

    html += `<div style="margin-top: 10px;"><strong>MODE</strong></div>`;
    const modes = [
      TestbedDisplayMode.Still,
      TestbedDisplayMode.Walk,
      TestbedDisplayMode.MoveAndStrafe,
      TestbedDisplayMode.Attack,
      TestbedDisplayMode.Dash,
      TestbedDisplayMode.Cycle,
    ];
    for (const mode of modes) {
      const active = displayMode === mode ? '▶ ' : '  ';
      html += `<button onclick="window.__testbed_mode('${mode}')">${active}${mode}</button><br>`;
    }

    html += `<div style="margin-top: 10px;"><strong>ACTIONS</strong></div>`;
    html += `<button onclick="window.__testbed_damage(10)">Dmg -10</button><br>`;
    html += `<button onclick="window.__testbed_attack()">Attack</button><br>`;
    html += `<button onclick="window.__testbed_dash()">Dash</button><br>`;

    container.innerHTML = html;
  };

  const updateCharacterState = (): void => {
    if (!selectedCharacter || !selectedCharacter.isAlive()) return;

    switch (displayMode) {
      case TestbedDisplayMode.Still:
        selectedCharacter.setState(CharacterState.Idle);
        selectedCharacter.vel.set(0, 0, 0);
        break;
      case TestbedDisplayMode.Walk:
        selectedCharacter.setState(CharacterState.Walk);
        // Walk forward continuously.
        const walkDir = new THREE.Vector3().copy(selectedCharacter.facing).normalize();
        selectedCharacter.vel.set(walkDir.x * 2, selectedCharacter.vel.y, walkDir.z * 2);
        break;
      case TestbedDisplayMode.MoveAndStrafe:
        // Strafe in a circle.
        selectedCharacter.setState(CharacterState.Run);
        const t = performance.now() * 0.001;
        const angle = t * 0.5;
        selectedCharacter.vel.set(Math.cos(angle) * 4, selectedCharacter.vel.y, Math.sin(angle) * 4);
        selectedCharacter.yaw = angle;
        break;
      case TestbedDisplayMode.Attack:
        if (selectedCharacter.state !== CharacterState.Attack) {
          selectedCharacter.setState(CharacterState.Attack);
        }
        break;
      case TestbedDisplayMode.Dash:
        if (selectedCharacter.state !== CharacterState.Dash) {
          const dashDir = new THREE.Vector3().copy(selectedCharacter.facing).normalize();
          selectedCharacter.vel.copy(dashDir).multiplyScalar(15);
          selectedCharacter.setState(CharacterState.Dash);
        }
        break;
      case TestbedDisplayMode.Cycle:
        // Cycle through states.
        const states = [
          CharacterState.Idle,
          CharacterState.Walk,
          CharacterState.Run,
          CharacterState.Attack,
          CharacterState.Dash,
        ];
        const now = Math.floor(performance.now() / 2000); // 2s per state
        cycleIndex = now % states.length;
        selectedCharacter.setState(states[cycleIndex]);
        if (cycleIndex === 1) {
          const walkDir = new THREE.Vector3().copy(selectedCharacter.facing).normalize();
          selectedCharacter.vel.set(walkDir.x * 2, selectedCharacter.vel.y, walkDir.z * 2);
        } else if (cycleIndex === 2) {
          const runDir = new THREE.Vector3().copy(selectedCharacter.facing).normalize();
          selectedCharacter.vel.set(runDir.x * 4, selectedCharacter.vel.y, runDir.z * 4);
        }
        break;
    }
  };

  // Attach to window for button callbacks.
  (window as any).__testbed_spawn = (count: number) => {
    const chars = manager.spawnCluster(
      new THREE.Vector3(0, 2, 0),
      count,
      {
        pos: new THREE.Vector3(0, 2, 0),
        biome: BiomeTheme.Reek,
        weapon: 'fungal_blade',
      },
    );
    if (chars.length > 0) selectedCharacter = chars[0];
    updateUI();
  };

  (window as any).__testbed_mode = (mode: string) => {
    displayMode = mode as TestbedDisplayMode;
    updateUI();
  };

  (window as any).__testbed_damage = (amount: number) => {
    if (selectedCharacter) {
      selectedCharacter.takeDamage(amount);
      updateUI();
    }
  };

  (window as any).__testbed_attack = () => {
    if (selectedCharacter) {
      manager.attackTarget(selectedCharacter);
      updateUI();
    }
  };

  (window as any).__testbed_dash = () => {
    if (selectedCharacter) {
      const dir = new THREE.Vector3().copy(selectedCharacter.facing).normalize();
      manager.dash(selectedCharacter, dir, 15);
      updateUI();
    }
  };

  (window as any).__testbed_clear = () => {
    manager.clear();
    selectedCharacter = null;
    updateUI();
  };

  return {
    container,
    update(): void {
      updateCharacterState();
      updateUI();
    },
  };
}
