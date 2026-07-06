# Ward design — locked direction (2026-07-06)

## The rule: the ward is universal; the biome skins its behavior

One consistent core silhouette and gameplay read across the whole game;
biome-specific **surface expression** only, from where it is placed.

- **Core ward** = universal light anchor
- **Biome** = local contamination / growth / material dressing

Never: reek-mushroom ward, ice ward, fire ward, crystal ward. Biome-specific
ward *shapes* fragment the design language.

## Silhouette

A **Keeper-derived anchor core** — not a mushroom, crystal, lantern, or holy
relic. The formula: **obelisk + ring + core + motes.**

- central dark shard / pylon / standing anchor
- bright internal lumen core (suspended, in a carved niche)
- circular ground ring that defines the radius
- small orbiting/inward-moving glowspheres or motes
- faint vertical beam/pulse when active
- surface veins/cracks change by biome material (texture pass only)

## Safe field: the dome is a REACTIVE state, not the default look

Default ward state:
- glowing ground ring
- inward-moving motes
- pulsing lumen core
- faint lit radius; glowspheres visible near/inside it

Under pressure (Dark Tide / recharge surge / failure / placement activation):
- the dome appears as a **thin membrane**
- visible only where darkness/tide hits; ripple impacts show the tide breaking
- edge brightens under stress; thins/flickers when failing

This fits the core loop: built light holds permanent territory and Dark Tides
test that territory (the vertical slice = place a first ward, survive a short
pressure event beside it).

## Vibe

**Ancient Keeper-relic + living light + player-built utility.**
Not sacred. Not fungal. Not biome-specific. Not clean sci-fi.

The Keepers held and hoarded light behind beacons and bastions, and fell. The
ward is the player taking that old principle and doing it *correctly*:
spreading light outward instead of hoarding it (NARRATIVE.md — *held light
dies; spread, shared light lives*).

## Biome adaptation layer (same ward, local expression)

| Biome | Ward dressing |
|-------|---------------|
| The Reek | spore motes, fungal creep around base, teal/violet mist |
| The Bite | frost rim, aurora shimmer, crystalline edge cracks |
| The Drown | caustic rings, refracted dome ripples, water-bent light |
| The Sear | heat shimmer, ember motes, molten stress cracks |
| The Glare | prism splits, hard white edges, rainbow refraction |
| The Fade | electric arcs, broken Keeper-tech panels, blue-white flicker |
| The Nothing | almost no dressing; only the orb's light and the ward core fighting void absorption |

## Implementation map

- `web/src/main.ts` — `spawnWard` builds the universal kit (anchor GLB or
  fallback shard, lumen core + point light, radius/footprint rings, beam,
  motes, reactive fresnel-membrane dome). `WARD_DRESSING` is the biome hook
  (colors/particles only). Placement sets `activation = 1` (a ~2s surge where
  the membrane is born visible, then rests).
- Anchor asset: `web/public/assets/ward/ward_anchor.glb` (Meshy, 12k tris).
  Prompts + per-biome retexture prompts: `docs/MESHY_ward.md`.
- Mechanics unchanged: `WARD_RADIUS` is still the one number = ring size =
  litMaterial `uWardPos/uWardRadius` = shelter check.
