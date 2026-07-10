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
  orbRadius: 9, // bigger carried bubble so nearby flora reads
  orbIntensity: 1.1, // slightly brighter
  /** Manual pulse: an expanding shell that briefly reveals what it washes over. */
  pulse: {
    speed: 22, // voxels/sec — slower so the shell lingers a little longer
    maxRadius: 34, // ~25% smaller reveal (was 46)
    thickness: 4.5, // shell half-width, ~25% smaller (was 6)
    intensity: 1.2, // brighter reveal (was 0.8)
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
  // World-scale retune (John, R25): with a multi-km world the orb must feel
  // SMALL in it — glide dropped to 1/3, sprint to 1/2 of the demo-era values
  // (16.5/22). Travel time IS the world size. Dash kept at absolute reach —
  // it reads as a bigger commitment now, which suits its cost.
  accel: 26, // scaled with maxSpeed so the chase feel (accel/speed) is unchanged
  maxSpeed: 5.5, // horizontal glide speed (was 16.5)
  damping: 5, // velocity decay when no input (the "glide"/drift tail)
  // Sprint = HOLD to cruise faster, paid per-second in energy.
  sprintSpeed: 11, // (was 22)
  sprintCostPerSec: 6, // energy drain while sprinting — speed stays a spend
  // Dash = a dedicated blink-burst on TAP, distinct from sprint. Works on the
  // ground and in the air; air dashes are limited and refresh on landing.
  dash: {
    speed: 30, // burst velocity along the dash direction (~65% of the old burst)
    duration: 0.12, // seconds the burst holds (float, no gravity) — tuned to ~half the old reach
    cooldown: 0.45, // min seconds between dashes — a beat, not spammable
    cost: 14, // energy per dash — a real spend, like the pulse
    airMax: 1, // air dashes allowed per airtime (refreshes when grounded)
  },
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
  // Hover-boost: HOLD jump to rise and hover, topping out around 0.75 of a full
  // triple-jump's height above the floor — but energy burns fast. Tap = the
  // ballistic wave-jump above; hold = a sustained, deliberate lift you pay for.
  hoverBoost: {
    ceiling: 5, // voxels above the floor the sustained hover tops out at (~0.75× triple-jump)
    accel: 48, // upward accel while held (beats gravity 34 so it climbs)
    riseSpeed: 7, // capped climb speed while boosting (a fresh jump's pop rides above it)
    costPerSec: 26, // energy/sec — the "burns fast" spend
  },
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

/** Diagnostics: logging verbosity + the error-resilience knobs. See core/log.ts
 *  and ui/DevOverlay.ts. Overridable at runtime via ?log= / localStorage /
 *  window.waiver.setLogLevel(). */
export const Debug = {
  /** Default log level in dev / prod when nothing overrides it. */
  logLevelDev: 'debug',
  logLevelProd: 'warn',
  /** Entries kept in the ring buffer that backs the overlay + dumpLogs(). */
  ringBufferSize: 500,
  /** Key that toggles the on-screen log panel (invisible-devtools testing). */
  overlayHotkey: '`',
  /** Consecutive frame() throws before the loop halts and shows the crash card.
   *  One bad frame is a hiccup; a stuck stream of them is a fatal loop. */
  frameErrorLimit: 5,
} as const;
