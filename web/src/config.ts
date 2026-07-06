/**
 * wAIver — tunables.
 *
 * Every number here is a starting hypothesis from SPEC.md, to be proven or
 * adjusted in the vertical slice. Grouped by system so the prototype can vote.
 */

export const World = {
  chunkSize: 32, // 32³ voxels/chunk (SPEC §4 [Preferred] — fewer draw calls)
  voxelSize: 1, // world units per voxel
} as const;

export const Light = {
  /** Voxel light levels are 0..MAX, Minecraft-style flood fill. */
  max: 15,
  /** Ambient floor — the barest sky-whisper on the world. Near-total black by
   *  design: nothing is visible outside the orb's sphere, a ward, a charged
   *  grove or built light, unless a full clear moon lifts it. Like a Dark Tide,
   *  but with the sky still overhead. */
  ambientFloor: 0.0015,
  /** Steady glow bubble the orb carries with it. */
  orbRadius: 7,
  orbIntensity: 0.9,
  /** Manual pulse: an expanding shell that briefly reveals what it washes over. */
  pulse: {
    speed: 34, // voxels/sec the shell travels
    maxRadius: 46, // SPEC §2: ~30–60 voxel reveal
    thickness: 6, // shell half-width in voxels
    intensity: 0.8, // a reveal, not a floodlight (tuned vs the muted grade)
    energyCost: 12, // SPEC §2: ~10–15 energy
  },
} as const;

export const Survival = {
  lumenMax: 100,
  energyMax: 100,
  energyRegenPerSec: 15, // SPEC §2 (when lit)
} as const;

/** Orb movement — hover-glide + wave-jump (GDD §5h, SPEC §5). Not flight:
 *  the orb rides a hover spring above the ground; height is earned per-jump. */
export const Move = {
  accel: 72, // how hard we chase the target velocity (snappy but not harsh)
  maxSpeed: 16.5, // horizontal glide speed (John: 25% calmer)
  damping: 5, // velocity decay when no input (the "glide"/drift tail)
  // Dash = HOLD-to-sprint at the old cruise speed (not a blink-burst).
  sprintSpeed: 22,
  sprintCostPerSec: 6, // energy drain while sprinting — speed stays a spend
  // Hover: a spring holds the orb ~hoverHeight above the nearest floor,
  // slightly underdamped so it bobs — the hover reads as effort, not a rail.
  gravity: 34,
  hoverHeight: 1.7,
  hoverStiffness: 42,
  hoverDamping: 7,
  // Wave-jump: a downward pulse that launches the orb. Chainable in the air
  // up to 3 with diminishing power, energy-gated (SPEC §5).
  jumpSpeed: 15,
  jumpChain: 3,
  jumpDecay: 0.72, // each chained jump keeps this much of the last one's power
  jumpCost: 10,
  fallGlide: 10, // terminal fall speed — the orb *drifts* down, never plummets
} as const;

export const Camera = {
  distance: 26,
  height: 10,
  followLerp: 6, // how quickly the camera chases the orb (momentum feel)
  minPitch: -0.95, // low enough to tilt up and see the moon/sky (floor-probe guards terrain)
  maxPitch: 1.3,
  orbitSpeed: 0.0026, // radians per pixel of drag
  lookSmoothing: 11, // /s — look eases toward the drag target (soft, not harsh)
  // --- Enclosure adaptation (caves) ---
  // When the orb is boxed in (low ceiling / near walls) the open-sky boom is
  // geometrically impossible, so it collides and whips. Instead we read the
  // surrounding free space and draw the camera IN + DOWN toward these tights.
  tightDistance: 6.5, // boom length in a snug cavern/tunnel
  tightHeight: 2.4, // boom rise when enclosed (near eye-level, not top-down)
  enclosureLerp: 3.5, // /s — how fast distance/height ease between open↔tight
  headroomOpen: 11, // voxels of ceiling clearance that reads as fully "open"
  lateralOpen: 9, // voxels of horizontal clearance that reads as fully "open"
  // Over-shoulder alt-rig (press V to compare): a fixed close chase.
  shoulderDistance: 4.2,
  shoulderHeight: 1.6,
  shoulderSide: 1.1, // lateral offset so the orb doesn't dead-center the view
} as const;

export const Perf = {
  targetFps: 60, // 60 PC / ≥30 mid-range phone (hard gate, SPEC §4)
  fixedTickHz: 25, // element/physics sim tick, decoupled from render (SPEC §4)
} as const;
