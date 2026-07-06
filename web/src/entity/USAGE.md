# Character System Usage Guide

## Quick Start

### 1. Import the System
```typescript
import { CharacterManager, BiomeTheme, createCharacterTestbed } from './entity';
```

### 2. Initialize (in main.ts game loop)
```typescript
const characterManager = new CharacterManager(scene);

// Spawn a cluster of mushroom characters
const characters = characterManager.spawnCluster(
  new THREE.Vector3(0, 2, 0), // center position
  5,                          // count
  {
    pos: new THREE.Vector3(0, 2, 0),
    maxHealth: 100,
    biome: BiomeTheme.Reek,
    weapon: 'fungal_blade', // or 'spore_staff', 'ember_lance', etc.
  }
);

// Create the debug testbed UI
const testbed = createCharacterTestbed(scene, characterManager);

// In your update loop:
characterManager.update(dt);
testbed.update();
```

### 3. Control Characters Programmatically
```typescript
const character = characters[0];

// Change state
character.setState(CharacterState.Walk);

// Apply damage
characterManager.damageCharacter(character, 25, orbPos);

// Make attack
characterManager.attackTarget(character);

// Dash
const dashDir = new THREE.Vector3(0, 0, -1);
characterManager.dash(character, dashDir, 15);
```

## Animation States

- **Idle** — default rest pose with gentle sway
- **Walk** — slow forward movement with leg animation
- **Run** — fast movement with energetic limb motion
- **Attack** — swing/cast pose (melee or ranged)
- **Dash** — explosive forward lean
- **Flinch** — recoil from damage
- **Death** — topple forward

## Weapons by Biome

### Reek
- `fungal_blade` (melee, 15 dmg)
- `spore_staff` (ranged, 8 dmg)

### Forge
- `ember_lance` (melee, 18 dmg)
- `coal_shot` (ranged, 12 dmg)

### Water
- `wave_hammer` (melee, 12 dmg)
- `torrent_burst` (ranged, 10 dmg)

### Sandbox
- `construct_fist` (melee, 16 dmg)
- `stone_shot` (ranged, 9 dmg)

## Limb Articulation

The `LimbPose` object controls every joint:

```typescript
character.setPose({
  headPitch: 0.2,        // look up/down
  headYaw: 0.1,          // look left/right
  bodyPitch: 0.15,       // lean forward/back
  bodyRoll: 0.05,        // lean left/right
  bodyYaw: 0.3,          // rotate at hip
  
  legLPitch: 0.4,        // left leg forward/back
  legLYaw: 0.1,          // left leg left/right
  legRPitch: -0.4,       // right leg forward/back
  legRYaw: -0.1,         // right leg left/right
  
  armLPitch: -0.3,       // left arm forward/back
  armLYaw: 0.2,          // left arm across body
  armLRoll: 0.1,         // left arm twist
  armRPitch: -0.3,       // right arm forward/back
  armRYaw: -0.2,         // right arm across body
  armRRoll: -0.1,        // right arm twist
  
  handLRotX: 0.1,        // left wrist flex (optional)
  handLRotY: 0.2,        // left wrist twist
  handRRotX: -0.1,       // right wrist flex
  handRRotY: -0.2,       // right wrist twist
});
```

All values in radians. Zero = neutral T-stance.

## Custom Animations

Define your own keyframe sequences:

```typescript
const customAnim = {
  name: 'custom_dance',
  duration: 2,
  loop: true,
  keyframes: [
    { t: 0, pose: { bodyRoll: 0, legLPitch: 0 } },
    { t: 0.5, pose: { bodyRoll: 0.2, legLPitch: 0.3 } },
    { t: 1, pose: { bodyRoll: -0.2, legLPitch: -0.3 } },
    { t: 1.5, pose: { bodyRoll: 0, legLPitch: 0 } },
    { t: 2, pose: { bodyRoll: 0, legLPitch: 0 } },
  ],
};

characterManager.animManager.addCustomAnimation(customAnim);
```

## Combat

### Melee Attack
```typescript
const weapon = CombatSystem.getWeapon(BiomeTheme.Reek, 'fungal_blade');
characterManager.combatSystem.meleeAttack(attacker, weapon, [targetChar]);
```

### Ranged Attack
```typescript
const projectile = characterManager.combatSystem.fireProjectile(
  attacker,
  weapon,
  targetChar.pos
);
```

### Hitboxes
Hitboxes are automatically generated per bone:
- Head: 2x multiplier (headshots)
- Body: 1x multiplier
- Limbs: 0.75x multiplier

## Rigging

### Load a Rigged GLTF
```typescript
const rig = await RiggingEngine.loadRiggedGLTF('path/to/character.glb', loader);
```

### Build Procedural Rig
```typescript
const rig = RiggingEngine.buildProceduralRig(); // uses default mushroom skeleton
```

### Custom Bone Spec
```typescript
const customRig = RiggingEngine.buildProceduralRig([
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'body', parent: 'root', pos: [0, 0.3, 0], size: [0.3, 0.6, 0.3] },
  // ... more bones
]);
```

## Debug UI (Testbed)

A floating panel appears in the top-right corner with:
- Spawn buttons (+1, +5, Clear)
- State mode toggles (Still, Walk, Move+Strafe, Attack, Dash, Cycle)
- Damage/Health display
- Action buttons (Damage, Attack, Dash)

All driven by clicking buttons or calling window functions.

## Performance Notes

- Each character is a THREE.Group with bones and a mesh
- Animations run at `character.animSpeed` (default 1x dt)
- Projectiles use simple sphere meshes; can optimize with pooling
- No frustum culling yet on characters (add if needed)

## Next Steps

1. **Import GLTF models** — swap procedural rig for real assets
2. **Tune animations** — adjust keyframe timings/amplitudes
3. **Add sound** — wire weapon/impact effects
4. **Particle effects** — emit on hit/damage
5. **AI behavior** — patrol, chase, flee logic
6. **Networking** — if multiplayer
