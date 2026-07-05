# wAIver - Build Plan

This repo already contains a playable 2D foundation. The goal now is not to redesign the game again, but to turn the design suite into a disciplined vertical slice.

## Current baseline
- Playable orb movement, pulses, force waves, destruction, lighting, enemies, and level flow already exist.
- A sandbox scene already exists and is the right ancestor for the future dev sandbox.
- The prototype is still closer to a general wave-platformer than the documented `Reek` vertical slice.

## Vertical slice target
Build one polished intro-to-loop slice centered on `The Reek`.

The slice needs to prove:
1. `See` - pulse-driven perception is fun and readable.
2. `Move` - the orb feels alive and controllable.
3. `Gather` - the player can collect a first resource.
4. `Build` - the player can place defensive structures with low friction.
5. `Hold light` - the player survives a first gentle pressure event.
6. `One element` - one clear reaction teaches the systemic direction.

## Build strategy
Keep the work in this order so scope stays under control:

1. `Docs -> implementation map`
   - Keep the design docs as vision.
   - Translate only the vertical-slice subset into concrete code tasks.
2. `The Reek intro`
   - Replace generic tutorial framing with the hand-authored opening biome language.
   - Teach see, move, gather, build, hold-light in one continuous flow.
3. `Dev sandbox`
   - Preserve the existing sandbox lineage.
   - Add explicit toggles for tide pressure, light structures, and material/reaction tests.
4. `Core systems for the slice`
   - Resource pickup and spend loop.
   - Placeable light source or ward.
   - Local darkness pressure event.
   - A first readable biome hazard, likely mist/spores.
5. `Polish and validation`
   - Tight HUD language.
   - Better level readability.
   - Simple smoke-test path for booting the game.

## Immediate backlog
- Re-theme the first playable level as `The Reek` intro.
- Re-theme the second level around early build-and-hold-light play.
- Add a simple gatherable resource type tied to first-light construction.
- Add a first placeable light/ward object with a visible safe radius.
- Add a scripted first `Dark Tide` prototype.
- Expand the sandbox into a real developer workbench.

## Definition of done for the first milestone
The first milestone is complete when a player can:
- wake in `The Reek`
- learn pulse + movement without popups
- collect a resource
- place a first light structure
- survive a short pressure event near that light
- understand the game's loop from play alone
