/**
 * Entity module exports.
 */

export {
  CharacterEntity,
  CharacterState,
  type LimbPose,
  ZERO_POSE,
  type WeaponInstance,
} from './CharacterEntity';

export {
  AnimationEngine,
  CharacterAnimationManager,
  type PoseKeyframe,
  type Animation,
} from './AnimationEngine';

export { RiggingEngine, type RiggedCharacter, type BoneSpec } from './Rigging';

export {
  CombatSystem,
  BiomeTheme,
  type WeaponDef,
  type Projectile,
  type Hitbox,
} from './CombatSystem';

export {
  CharacterManager,
  type CharacterSpawnConfig,
} from './CharacterManager';

export {
  createCharacterTestbed,
  TestbedDisplayMode,
  type CharacterTestbedUI,
} from './CharacterTestbed';
