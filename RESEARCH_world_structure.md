# Research — Structuring a "Deep, Far & Wide" Dark Survival-Crafter (for wAIver 3D)

> Web research synthesis (Round 8). Cited sources at bottom. Feeds GDD §5e (world), §5f (tech), §5h (traversal). Companion to `GDD.md`.

**Central truth:** wAIver's darkness is not just theme — it's the mechanic that makes a deep+far+wide world tractable. Short sightlines are simultaneously the horror aesthetic, the difficulty gate, the navigation tension, and the #1 performance ally. Nearly every recommendation leverages that single alignment.

## Top recommendations (prioritized)
1. **Light = the universal currency of all three axes.** Depth (down), frontier distance (out), and safety are all read as "how far from light am I." Darkness is the compass *and* the threat meter — the world never feels aimless. (Subnautica dread model.)
2. **Player-built lit bastions ARE the POIs, landmarks, and fast-travel network — all at once.** The player *manufactures* the compass of desire by pushing light outward. Solves "wide but empty," navigation, and fast travel in one systemic stroke.
3. **Darkness = performance budget, not cost.** Naturally short sightlines → render only the lit bubble (~4–8 chunk render radius, ~2–4 sim). Fog eats geometry before LOD → no pop-in. This is why a three.js/web voxel world can feel huge.
4. **Curated set-pieces blended INTO proc-gen; never pure random.** (NMS-launch lesson.) Fixed macro-skeleton + procedural fill + hand-authored "weenies" (Noita model).
5. **Gate progression by depth/frontier tier (Valheim-style); Dark Tide = the boss-equivalent.** Each tier unlocks the material to survive the next tier's dark → world layout *is* the tech tree.
6. **POI Diversity Rule:** any echolocation ping should reveal **2–3 differentiated** points of interest (resource / ruin / hazard / set-piece), never a wall of identical dark. Never place identical POIs back-to-back without a divider.

## 1. Verticality = danger/darkness/reward — **depth must change the RULES, not just resources**
- **Subnautica** — depth as dread engine; player *chooses* to descend (agency = fear); threats heard before seen. → each wAIver depth tier shortens wave range, raises tide frequency, adds a "heard-before-seen" apex threat.
- **Terraria** — discrete named layers, each with own material/enemies/reward. → name & theme depth bands; change the dominant voxel per band so mining *feels* different deep.
- **Core Keeper (closest model)** — proc-gen *underground*; start at lit **Core**, dig outward through concentric biome rings of rising difficulty; base = safe haven + launch point; bosses gate new areas. **wAIver ≈ Core Keeper in 3D with light instead of tile-reveal — mine hardest.**
- **Deep Rock Galactic** — verticality as pressure (costs, forces commitment), not decoration.
- **Noita** — fixed vertical skeleton, procedurally fleshed; deeper = new reaction ingredients → depth escalates *emergent chaos*, not just HP. (Perfect for wAIver's element engine.)
- **Actionable:** ~6–8 depth bands. Each = distinct dominant voxel + shortened wave range + new element/reaction wrinkle + signature apex threat (heard first) + one tier-gating material for the next band. Player chooses when to descend.

## 2. Horizontal breadth (avoid "wide but empty") = density discipline + differentiation + navigational pull
- **POI Diversity Rule** (operational metric): ≥3 differentiated POIs on the horizon; no identical POIs back-to-back without a barrier. (BOTW: a new event ~every 40s.)
- **Pacing:** too dense = chaos, too sparse = tedium; use terrain to divide regions; from any hub see ≥2 landmarks ("compass of desire" + desire lines).
- **Valheim** wins breadth via procedural+handcrafted biomes with strict resource/boss gate → every trek has a reason. **NMS** = raw scale w/o curation reads empty.
- **7DTD** — tiered (skull-rated) hand-authored POI library scattered by risk/loot. **Grounded** — small obscure differentiated biomes + big *and* hidden landmarks; auto-mark on discovery.
- **Actionable:** dark caps sightlines → "horizon" is small/controllable, perfect for the POI rule. Author a tiered library of dark set-pieces (fallen light-keeper ruins, reaction hazards, deep-material veins), seed by frontier distance.

## 3. Navigation & wayfinding in the dark — **wAIver's fantasy becomes a feature**
- **Shrink spaces to fight disorientation** — darkness *inflates perceived scale for free*; a dark world should be smaller than it looks.
- **"Weenies"** (big distinctive emissive landmarks) are the backbone; in the dark a single tall glowing structure is a global landmark.
- **Light IS wayfinding** — bright directional = "go here," dim/ambient = mystery/danger. Use global (far-visible) + local (close) landmarks.
- **Breadcrumbing** — player-placed markers/lights for return routes.
- **Actionable (superpower):** emissive **bastions/wards = global landmarks** (the player's construction is the map); **echolocation ping = temporary local minimap**; **player-placeable light-breadcrumbs** (deeper = burn out faster → nav cost scales with depth); keep the lit bubble small (~2–4 chunks); faint directional pull to nearest owned light so never *fully* lost, but unlit frontier stays disorienting.

## 4. Scale & streaming for a voxel world in three.js/web — **darkness is the streaming budget**
- Chunked streaming + **greedy meshing** + `THREE.LOD`; merge/instance geometry to cut draw calls (biggest web lever); mesh **off the main thread (Web Workers)** to avoid hitches.
- CPU-side **octree** to filter chunk load by LOD-error vs distance.
- **Web targets:** aim below native — **~4–8 chunk render radius, ~2–4 sim radius** (Minecraft defaults 6–10 / 4–8 are the north star). The dark hides this completely.
- **Alignment:** far-fog/darkness fades geometry to black *before* the LOD/draw boundary → no pop-in (the thing native voxel games fight hardest is free here).
- **Persist far chunks (IndexedDB)** so built bastions stay built — required for "hold the dark back *permanently*."

## 5. Procedural + curated blend — **fixed skeleton, procedural flesh, hand-authored highlights**
- Macro skeleton: deterministic depth bands + radial frontier tiers; difficulty = depth × distance-from-first-light.
- Per-biome **generation rules** (own noise params, dominant voxel, element hazard, reaction ingredients) → biomes feel *categorically* different, not reskinned.
- Curated seed library of hand-built dark set-pieces at authored densities per tier (each a memorable "weenie").
- **Gate via structure:** the material to build wards that survive band N's Dark Tide is found only in band N-1 → the world's layout *is* the tech tree.

## 6. Fast travel vs earned traversal — **fast travel = the light network**
- Fast travel is a tax on exploration; only levy it once exploration is "paid for." Node-based/earned is the shipped middle ground. Core Keeper withholds long-distance travel until later.
- **Actionable (on-theme):** rapid-transit **only between bastions you've built and lit** → fast travel is earned by the core loop and can never skip the frontier (newest/most dangerous edge is always un-networked, reached on foot through the dark). Traversal powers (dash-through-dark, longer wave range, light-lantern extending the safe bubble) are rewards for pushing deeper. Keep the frontier walkable-only (the first trek into new dark = the Subnautica "should I dive?" moment).

## Pitfalls to avoid
1. Pure random proc-gen → emotional emptiness (NMS launch).
2. Depth that only changes stats, not rules → grind.
3. "Wide but empty" — <3 differentiated POIs on the horizon.
4. Getting lost with no emissive anchors/breadcrumbs/bounded bubble → frustration not dread.
5. Over-scoping web draw distance (fight both perf and horror). Let dark/fog eat geometry first.
6. Meshing on the main thread → web jank. Greedy-mesh in workers; instance.
7. Free/early fast travel that skips the frontier → hides best content, breaks fantasy.
8. Scripted scares over player-choice dread (Subnautica's power = *you* choose to descend).
9. Not persisting the built world → breaks "hold the dark back permanently."

## Sources
Subnautica dread (Game Studies) · Core Keeper (Wikipedia, PC Gamer) · Terraria Layers (Wiki) · Deep Rock cave-gen (Ghost Ship) · Noita (GDC Vault, 80.lv) · Dome Keeper systems (Game Developer) · Valheim Progression (Wiki) · POI Diversity Rule (MY.GAMES) · Open-world map design (Winorm) · Navigation in a Dark Game (Game Developer) · Wayfinding (Level Design Book, PMC review) · No Man's Sky proc-gen lessons (Big Games Space) · 7 Days to Die POIs (Wiki, OfZenAndComputing) · Grounded biomes/Sites & Wonders (Wiki) · Minecraft sim/render distance (Microsoft Learn) · three.js perf (utsubo, three.js forum) · GPU voxel rendering (arXiv 2505.02017) · Fast-travel debate (Push Square, Stray Pixels).
