# wAIver — Overview

> The front door. One page: what this is, the pillars, the canon in one place, and where everything lives. Everything below is stated **once here** and referenced elsewhere — the detail lives in the modules.

## What it is
**wAIver is a new, standalone 3D survival-crafter built on wave-based perception, living light, and darkness-as-gameplay.** You are a pulsing orb of light in a world the light has left. You *see* by sending out waves; you *build* to hold the darkness back for good; and where the old light ended, you build a new world for life to begin.

It's a **spiritual successor** to the 2D `waiver` prototype — same creative DNA (orb, echolocation, living light, waves, atmosphere), a fundamentally different game (Dune II→Warcraft, DayZ→Rust). Not a port. See `GDD.md §1`.

## Pillars
1. **See with waves** — the world is dark; perception is an active verb.
2. **Build to hold light** — construction is the headline system; you reclaim the dark by building into it.
3. **A world that reacts** — full destructible physics + a systemic element/reaction engine.
4. **Deeply realistic wave-physics** — the physics is a competitive moat alongside the darkness.
- **Cross-cutting:** multiplayer (co-op → small server) · cross-platform (one game, PC→phone).

## The core loop (the Escalation Loop)
> Explore the dark → harvest deeper-tier materials → build & upgrade bastions, anchors & light → withstand ever-larger Dark Tides & reclaim territory → push deeper. **Difficulty scales itself; the dark is the difficulty curve.**

## Canon (stated once — reference, don't repeat)
- **Light is everything:** currency · compass · landmark network · fast-travel graph · render budget · netcode budget · **and life itself** (darkness drains you to death).
- **Everything is a wave** — kinetic/pressure, thermal, light, water, EM, vapor; dark is their absence.
- **Darkness is the performance (and netcode) budget** — you only render/sim/sync the lit bubble around each player; the dark hides the cost. This one alignment makes an infinite voxel world affordable on the web *and* tractable in multiplayer.
- **The world layout is the tech tree** — the material to survive a band's tide is found one band shallower.
- **Held light dies; shared light lives; you cannot keep what has ended — only create what comes next.** (The story, the multiplayer, and the ending, in one line.)
- **The orb's mood paints the world** — its emotion literally colors the environment via the light system.
- **Design principle: diegetic teaching** — the level is the lesson; no tutorial pop-ups.
- **Tone guardrail: never too heavy** — wonder and play on top, meaning underneath.

## Document map (the modules)
`BUILD_PLAN.md` is the implementation bridge from these docs to the playable vertical slice.
| Doc | What's in it |
|---|---|
| **`README.md`** (this) | Overview · pillars · canon · index |
| **`GDD.md`** | Full design: all systems (light, building, elements, survival, movement, world, lighting, multiplayer, tech), decisions log, build order, revision roadmap |
| **`NARRATIVE.md`** | Story spine · the 7 biomes in full (lore, flora, fauna, enemies) · §11 the Dark as an enemy system + boss philosophy |
| **`SPEC.md`** | Measurable targets (content counts, light/survival numbers, tech/perf) + the Goal→Preferred→Confirmed implementation ladder |
| **`PLAYTHROUGH.md`** | A full end-to-end playthrough, intro → all biomes → endgame+ |
| **`ART.md`** | Art bible: visual identity ("voxel form, cinematic light"), render look, orb visual language, per-biome palettes |
| **`RESEARCH_world_structure.md`** | Deep+wide world design (Core Keeper/Subnautica/Valheim; sources) |
| **`RESEARCH_lighting.md`** | The make-or-break lighting stack (Teardown; WebGL2→WebGPU) |
| **`RESEARCH_orb_life.md`** | Making the orb feel alive (Journey/Ori; animacy) |

*Future extraction (as modules mature, per `GDD.md §9`): Lighting.md · Physics.md · Networking.md · Orb.md · Audio.md can each lift from their GDD section.*

## Status
`BUILD_PLAN.md` now translates the vertical-slice goal into the first implementation steps.
Design + world + enemies essentially complete (~23 design rounds). **Next: the vertical slice** — The Reek MVP + dev sandbox, gated on ≥30 fps on a mid-range phone. The risk is scope, not creativity: hold the vertical-slice discipline; prove the core loop before expanding.
