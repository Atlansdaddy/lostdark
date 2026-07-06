# Meshy prompts — Ward anchor (reusable)

Copy-paste blocks for regenerating or re-dressing the ward anchor in Meshy
(web UI or API / `scripts/meshy-gen.mjs`). The ward is **universal**: one
Keeper-anchor silhouette everywhere; only the *dressing* (texture pass,
particles, colors) changes per biome. Never generate biome-specific ward
*shapes* — that fragments the design language.

Silhouette formula: **obelisk + ring + core + motes.**
The GLB is only the obelisk + plinth. The lumen core, radius ring, motes,
beam, and reactive dome are procedural in-engine (`spawnWard` in
`web/src/main.ts`) — do not ask Meshy for glow, crystals, or lanterns.

---

## Generation settings

| Setting          | Value        |
|------------------|--------------|
| Model            | meshy-6 (latest) |
| Topology         | triangle     |
| Target polycount | 12,000 (wards are rare, but keep tris sane — see FPS memory: 31k-tri props tanked the frame) |
| Formats          | glb          |
| PBR              | on (refine)  |
| Remove lighting  | on (refine — game has its own light; baked shading fights it) |

## Preview prompt (geometry)

```
Ancient keeper obelisk anchor: a single tall tapered monolithic pylon of dark
weathered basalt, angular faceted shard silhouette, an empty diamond-shaped
hollow niche carved clean through the pylon at two-thirds of its height,
standing on a low circular stone plinth base etched with concentric grooves,
hairline cracks and shallow carved runic channels running up the faces,
ancient ruined relic infrastructure, fantasy game environment prop, strong
clean silhouette, no crystals, no lantern, no glow
```

Key intent, if rewording:
- **empty** hollow niche at ~2/3 height — the engine renders its own lumen core there
- circular plinth footprint — echoes the gameplay radius ring
- dark, weathered, ancient — failed Keeper infrastructure, not clean sci-fi, not sacred
- explicitly negative: crystals / lanterns / glow (Meshy loves adding them)

## Texture refine prompt (base / universal)

```
Near-black weathered basalt stone, dark charcoal with a faint cold teal-grey
undertone, matte and eroded, fine hairline cracks, shallow carved channels
slightly lighter than the surrounding stone, ancient wind-worn relic surface,
no glow, no bright colors, no moss
```

Albedo must stay **dark but nonzero** — the game is black-until-lit and a
0x000000 albedo can never be lit (only emissive survives). The in-engine
loader also clamps albedo luminance as a safety net.

---

## Per-biome dressing (retexture passes — same mesh, new skin)

Use `meshy_retexture` on the finished task with these prompts when each biome
lands. Engine-side dressing (mote colors, particles, dome tint) is separate,
in `WARD_DRESSING` in `main.ts`.

| Biome | Retexture prompt |
|-------|------------------|
| **The Reek** | dark basalt dusted with teal-violet spore bloom, faint fungal creep climbing the lower third, matte, no glow |
| **The Bite** | dark basalt rimed with frost, thin ice glaze on upward faces, crystalline hairline cracks, cold blue-white edges, no glow |
| **The Drown** | dark basalt darkened by water, wet sheen, pale mineral tide-lines ringing the base, barnacle-fine crust in the grooves, no glow |
| **The Sear** | dark basalt heat-scorched, ashen scale flaking on one side, molten-stress cracks (dark, not glowing), charred base, no glow |
| **The Glare** | dark basalt polished glassy on flat facets, hard white-lit edges, faint prismatic sheen in the carved channels, no glow |
| **The Fade** | dark basalt patched with broken keeper-tech panels, corroded conduit stubs, scorch marks of old arcing, no glow |
| **The Nothing** | bare near-featureless dark basalt, surface pitted as if dissolving, all carving half-erased, no glow |

---

## Task provenance (this session, 2026-07-06)

| Stage | Task ID | Notes |
|-------|---------|-------|
| Preview (meshy-6) | `019f3948-bbde-7ab7-8c77-785e08890faf` | geometry above (20 cr) |
| Refine (PBR) | `019f394f-ec82-7154-aac1-93b179fb7e55` | universal texture above (10 cr) |

Output lands at `web/public/assets/ward/ward_anchor.glb`.
