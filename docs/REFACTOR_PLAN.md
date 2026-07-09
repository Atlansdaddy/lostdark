# REFACTOR PLAN — from a 5k-line monofile to the LUMEN engine

> John (2026-07-09): "a 5k-LOC monofile is stupid and bad coding." Correct.
> `main.ts` is ~4,900 lines mixing engine systems, gameplay, FX, UI, input,
> debug tooling, and module-level side effects. This is the extraction plan.
> Companion decision: we are NOT leaving three.js — we are naming and owning
> the engine that already exists on top of it (see conversation 2026-07-09:
> every profile showed our costs live in OUR systems, not three's; the
> centerpiece lighting already bypasses three's lighting entirely).

## Target shape

```
web/src/
  engine/              ← the LUMEN engine. Owns nothing game-specific.
    core/              log, event bus, config schema, RNG/noise utils
    world/             VoxelWorld, Materials, ColumnGenerator contract
    stream/            ChunkManager (ring ladder), unload/trim, persistence (IndexedDB)
    light/             LightGrid (+addLight), incremental flood (LabLight lineage),
                       LightVolume, the lumen pipeline contracts
    render/            VoxelMesher, SmoothMesher, litMaterial, post passes, DRS
    gen/               CaveGen, TowerGen, dungeon stamping, biome field helpers
    entity/            FolkManager stack, AnimClip/AnimPlayer, PoseRig, SkeletonMap
  game/                ← wAIver, a CONSUMER of engine/
    boot.ts            staged loading screen (owns #boot)
    world.ts           Reek assembly: ReekGen + testbeds + POI hooks + spawn
    orb/               movement, camera rig, verbs (pulse/dash/wave/ward)
    survival/          lumen/energy/health meters, glowcharge (R24/R25)
    combat/            Dark Armor rules, folk combat wiring, damage routing
    ui/                HUD, menu, minimap, touch controls, metrics bar
    fx/                aura, trails, tide visuals, sky, weather
    main.ts            ~100 lines: compose engine + game systems, run the loop
  labs/                worldlab, cavelab, towerlab, arenalab, studio
                       (labs consume engine/ exactly like game/ does — they are
                        the proof the engine works standalone)
```

## Principles (the "best practices" being bought)

1. **No module-level side effects.** Today main.ts builds the world at import
   time (why the boot screen needed top-level await). Everything becomes
   explicit: `const engine = createEngine(cfg); const game = createGame(engine)`.
2. **Engine never imports game.** Direction is law. Labs already model it.
3. **One loop owner.** A `System` interface (`update(dt)`), a fixed-order
   array; frame() stops being a 400-line function.
4. **Dependencies by injection, not global reach.** FolkDeps already does this
   right — that pattern everywhere. No system touches another's internals.
5. **Events for cross-cutting** (orbHit, wardPlaced, tideStarted) — the R24
   systems (glowcharge, skill trees) subscribe instead of splicing into frame().
6. **Move-only commits vs change-only commits.** A refactor commit NEVER edits
   logic; a logic commit never moves files. Reviewable, bisectable.
7. **Green gates every commit:** tsc 0 errors (newly achieved — keep it),
   all 5 headless suites pass, game boots + plays on the phone.

## Migration phases (each independently shippable)

**Phase 0 — freeze & harness (half a session).**
Commit everything (done). Wire the 5 headless suites + tsc into one
`npm run check` script. Capture behavior checklist (boot, move, pulse, ward,
dash, folk, tide, testbeds) to re-verify per phase.

**Phase 1 — leaf extractions (1 session).** Pull self-contained blocks out of
main.ts with zero behavior change: aura, sky/moon, trails, camera rig, input
bindings, dev overlay wiring, metrics bar, border whisper. Each becomes a
module with an explicit `create*()`; main.ts shrinks ~1,500 lines.

**Phase 2 — engine/ formation (1 session).** Most engine files already exist
as separate modules (world/, lighting/, render/, entity/, dungeonlab gens) —
this phase is directory moves + import paths + severing main.ts reach-ins
(replace direct access with constructor deps). Labs' imports update.

**Phase 3 — game systems out (2–3 sessions, one system per commit).** Orb
(movement+verbs), survival meters, wards, tide, minimap/HUD/menu, folk wiring.
The frame() body becomes a systems array as it empties. This is the carve —
each commit is played on the phone before the next starts.

**Phase 4 — composition root (small).** main.ts = create engine → create
systems → loop. Target ≤150 lines.

**Phase 5 — the payoff: streaming swap.** Replace the fixed 256×256 arena
with engine/stream's ChunkManager (worldlab's ladder is already tested at
invariant level). generateReek's per-chunk port rides in as `game/world.ts`'s
ColumnGenerator. The demo becomes the game; REEK_HALF_INIT dies; the border
whisper generalizes to the world-rim mechanic. This is its own milestone and
should NOT be attempted mid-carve.

## Explicit non-goals

- Rewriting the WebGL layer / dropping three.js (cost >> benefit; revisit only
  at a WebGPU migration, via three's WebGPURenderer).
- Any behavior change during phases 1–4 (players shouldn't be able to tell).
- Perfect abstractions on day one — the seams follow the existing labs' proven
  contracts (ColumnGenerator, FolkDeps, MesherFn), not speculative interfaces.
```
