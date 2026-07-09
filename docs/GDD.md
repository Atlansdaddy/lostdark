# wAIver 3D — Game Design Document (LIVING DRAFT)

> **Status:** In active design. Built through iterative design-interview rounds (John's process — "a few dozen rounds to get the vision through completely").
> **This doc is the single source of truth for the vision.** Code follows it, not the reverse.
> **Legend:** ✅ LOCKED · 🟡 PROVISIONAL (my recommendation, awaiting John's confirmation) · ❓ OPEN (queued for a future round)

---

## ▶ CURRENT ROUND — awaiting John (Round 26 · pick the thread)
✅ Enemies · ✅ discipline pass · ✅ playthrough · ✅ **Art bible** (`ART.md` — "voxel form, cinematic light": dark stylized voxel world where light is the star; Teardown-meets-Rez/Journey; crisp emissive edges = the Geometry-Dash DNA in 3D; per-biome palettes; the orb paints the world). Suite: README · GDD · NARRATIVE · SPEC · PLAYTHROUGH · ART · 3× RESEARCH.

**Pivot to production.** Options:
1. **Start the vertical slice** — The Reek MVP + dev sandbox + an early **"look test"** (does a dark voxel room with a glowing orb feel premium?). Gated ≥30 fps mid-range phone.
2. **Doc polish** — GDD de-dup sweep + extract per-system modules.
3. **Remaining threads** — confirm v1 5 · deep netcode spike · audio direction · the title.

*Recommendation: the design has earned a prototype — and the cheapest highest-signal first build is the look test.*

---

## 0. One-line pitch (working)
> *You are a pulsing orb of light in a world of living darkness. You **see** by sending out waves — and you **build** to hold the darkness back for good.*

A 3D survival-crafter where perception and construction are the same fight: pushing light into the dark.

---

## 1. Positioning — a spiritual successor, not a port

**wAIver is a new, standalone survival-crafting game** built around wave-based perception, living light, and darkness-as-gameplay. It grew out of the experimental 2D `waiver` prototype (itself born from the `wave_destruction_2d` sandbox) — but it is **not a remake or a port.** It's a *spiritual successor*: same creative DNA, a fundamentally different game.

- **What carried over (the soul):** the orb · echolocation / light-pulses · darkness as a core mechanic · wave-centric thinking · the emotional atmosphere.
- **What's new (almost everything else):** civilization-building, territory reclamation, persistent worlds, systemic physics, co-op multiplayer, survival, ecology, narrative, progression, construction.

The relationship is **Dune II → Warcraft**, **DayZ → Rust**, **Dwarf Fortress → RimWorld**: shared philosophy, its own game. The design question shifted from *"how do we make Pulse better?"* to ***"what kind of world naturally emerges if light, darkness, and waves are its foundation?"***

**Creative DNA (ancestors):** `waiver` 2D (the orb + feel) · `wave_destruction_2d` (the physics seed) · *Pulse* 2015 (the echolocation ancestor). We no longer aim to "answer" Pulse — we've moved past that question — but its documented failures (`docs/reviews.txt`) baked five fixes into our foundations:

| _Pulse_'s fatal flaw | wAIver 3D's answer |
|---|---|
| First-person → unreadable jumps | 3D but readable; controlled orb, legible traversal |
| Light didn't linger ("wave-space-wave") | Persistent light: built structures hold **permanent** light |
| "Feels like a demo," too short | **Survival-crafter with proc-gen** → effectively endless playability |
| Never learned how to deal with enemies | Enemies fear light — a teachable, coherent rule |
| Vague, pretentious story dumped on you | **Diegetic teaching** — learn powers/story through play, not tutorials |

---

## 2. Core pillars
1. **See with waves** — the world is dark; perception is an active verb (pulse to reveal). Light = currency, compass, difficulty gate, landmarks, fast-travel, and render/netcode budget, all at once.
2. **Build to survive & to hold light** — construction is a headline system, deep and central ("go hard on the build").
3. **A world that reacts** — full destructible physics + a systemic element/reaction engine; structures crumble, metal heats and explodes, chaos chain-reacts.
4. **⭐ Deeply realistic wave physics (the physics IS a moat)** — *everything is a wave / wave-type* (kinetic, thermal, light, water, EM, vapor). Use the most realistic physics feasible; target realistic-**feeling** (true equations where they sell the feel, smart approximations elsewhere). **wAIver's two moats: the darkness (art/feeling) and the physics (depth/defensibility).** Foundation already proven in `wave_destruction_2d` (real density/elastic-modulus/thermal-conductivity/specific-heat/acoustic-impedance).

**Cross-cutting requirements:**
- ⭐ **Multiplayer** (John, absolute must) — every system designed to work in shared, networked play from day one (§5i).
- ⭐ **Cross-platform: PC · laptop · tablet · mobile, one game** (John) — web/three.js one codebase, **identical game/mechanics/world/physics/MP everywhere** (deterministic → enables cross-play); **graphics auto-scale per device** via the darkness-bounded bubble (render/sim radius + lighting quality dial per device; the dark hides the difference). **Mobile = binding perf constraint** (keeps everything lean). Input abstraction (touch + mouse/kb + gamepad); orb controls are touch-friendly. See §5f.

---

## 3. Core loop ✅ (Round 1 — locked)

**Genre:** Survival-crafter-builder. A blend of all three directions offered, weighted toward survival/craft/build.

- **Primarily procedurally generated** world — the main source of playability, exploration, and replay.
- **Curated set-pieces threaded into the proc-gen** for:
  - **Storyline** beats and structure.
  - **Diegetic ability-teaching** — new powers / techniques / abilities are *learned through gameplay encounters designed to teach them*, **never through direct tutorial pop-ups**. (Think: a chamber that can only be solved once you intuit a new wave technique — the level *is* the lesson.)
  - Pacing and a sense of authored progression amid the procedural.

> **Design principle (locked):** *Proc-gen for breadth and replay; curation for meaning and teaching.* Every new mechanic gets introduced by a hand-built moment, then set loose in the procedural world.

### 3a. The Escalation Loop ✅ (the core gameplay spine — emerged R3)
> **Explore the dark** (spend light-energy, pulse to see) → **harvest deeper/darker-tier materials & elements** → **build & upgrade Bastions, Anchors, and light** → **withstand ever-larger Dark Tides & reclaim territory** → **push the frontier deeper into worse dark** → repeat.

This one loop expresses all four priorities at once: Light/Dark (P1) = the pressure · Building/destruction (P2) = the answer · Materials/Elements (P3) = what gates survival · Movement (P4) = traversal. **Difficulty scales itself** (deeper + later game = bigger tides = higher-tier bastions needed). No artificial gating — the dark IS the difficulty curve.

### 3b. Principle: **3D-native, always** ✅ (John, R3)
This is a 3D game, not a 2D one ported up. Every system is conceived **volumetrically**: bastions are 3D structures; anchor light/ward fields are volumes with line-of-sight, occlusion, and elevation; separation uses verticality; Dark Tides can come from any direction including below and above.

---

## 4. Round 1 decisions ✅ (John confirmed)

### Q2 · World identity → **"Build reclaims the dark" + reactive lighting** ✅
World is dark. Three layered light sources:
1. **Pulses** — reveal the world *temporarily* (echolocation).
2. **Built structures** — hold **permanent** light. Building = pushing the darkness back.
3. **Reactive / environmental lighting** — *exploring* an area can light it on its own: sometimes for a **reasonable duration**, sometimes **permanently** (triggered by discovery, presence, or environmental events).

> **Open design problem (John flagged):** tune reactive lighting so it's **neither too hard nor too easy** — the dark must stay a real pressure without becoming a tedious blind-stumble, and revealing must feel *earned* without babysitting the player. → dedicated round, see §5a.

### Q3 · Physics scope → **FULL multi-physics + a systemic "element table," from day one** ✅
John went big and overrode the phased plan. Destructibility is a **top-tier concept**, not later polish.
- A **periodic-table-style element/material system**: wave-based **sound/kinetics**, **water**, **heat**, **electricity**, plus solids **sand, wood, metal, glass, dirt** — and more to enumerate. Elements **react** with each other (heat+metal→melt/explode, electricity+water, water+heat→steam…) — a **systemic reaction engine** (spiritually: Noita's material sim / BOTW's "chemistry engine").
- **Full destructibility** of the world *and* built structures.
- **Thermal is in v1** (heat→melt→explode→chain reactions), ported/expanded from `wave_destruction_2d` (GPU-proven ~42fps in 2D).
- **Perf is a constraint to engineer around, not a reason to cut.** Path: GPU compute (WebGL2 / WebGPU shaders), chunked voxel sim, LOD on distant simulation. → tech-spike, §5f.

### Priority stack ✅ (John's ranking of "the most important stuff")
1. **Light / dark** — perception, reveal, reclaim
2. **Structural building & destroying**
3. **Materials & elements** — the reaction engine
4. **Movement & mechanic physics**

### Player avatar → **The living orb** ✅
Pulsing orb with **flavor and life** — varying **states and distortions**. Possibly other **geometric** forms, but **never anthropomorphized / non-geometric**. The **light, glow, and aura are the primary carriers of life and personality** — the biggest "feel." Depth TBD; John wants **web research on best-in-class examples** of conveying life/character through light/glow/aura in games. → §5g action + orb round.

---

## 5. Systems — framing (to be filled by future rounds)

### 5a. Light / Echolocation 🟡 (Round 2 locked; gradient in discussion — Round 3)
**Locked (R2):**
- **Light economy = energy pool.** Weak free baseline sense (never fully blind) + stronger manual pulse and big reveals cost regenerating energy. Built light = permanent, made from gathered materials.
- **Pulse feel = ambient auto-pulse + manual pulse on demand.**
- **Dark behavior = slow reclaim** of unlit/unmaintained areas; built light is the bulwark.

**Emerging framework (R3, provisional):**
- **Light Ecology — 6 sources:** ambient floor (per-region) · emissive world sources (bioluminescence, lava/heat, crystals, lit ruins, sky-bleed) · reactive reveal · player pulse · built light · darkness pressure (reclaim).
- **Three-tier zoning:** Lit Havens (safe) · Dim Wilds (dusk ambient, the open-world default — supports John's "not everywhere pitch black") · Deep Dark (pitch, high risk/reward).
- **Rule:** *difficulty = distance from light.* Reclaim & build push the frontier; the light↔dark axis is the difficulty/reward curve. No artificial level-gating.
- **Fairness guardrail (anti-Pulse):** never zero info — guaranteed orb aura bubble, hazard tells, rim-light on edges, audio cues.
- **Tuning knobs:** ambient floor/biome · sight-radius at floor · reclaim speed/biome · reactive-reveal generosity · exposure so dim = moody not muddy.

**Locked (R3):**
- **Havens = both** world-seeded (ruins, ember hollows, bioluminescent groves — discoverable footholds/breadcrumbs) **and** player-built (the majority of permanent light).
- **Gradient = spatial foundation + "Dark Tide" events.** Mostly darkness-by-place (learnable), with periodic **Dark Tides** that surge the dark into your territory. Tides **scale with progression/depth**: absent/gentle early → catastrophic end-game (instantly dusts low-tier builds; needs high-tier bastions). Destructive at various scales via the full physics sim. → drives building/material progression (see §3a, §5b).
- **Verticality = primary axis:** surface = dusk ambient (gentlest) → depths = pitch black, richest materials, worst things. Horizontal distance-from-haven is the secondary axis.

**Still open:** light persistence tech (volumetric vs surface-cached vs light-probe) → tech round.

### 5b. Building ❓ (the headline — Round 4 in progress)
The **defense stack** against the Dark Tide (concepts locked R3, mechanics TBD R4):
- **Bastions** — permanently-lit strongholds built to withstand destructive forces; strength scales with material tier. Tower-defense flavor.
- **Anchors / Wards** — first-class buildables projecting a **volumetric** warding light/field that keeps darkness + minions out; coverage governed by line-of-sight, occlusion, elevation → placement is a 3D spatial puzzle.
- **Separation-favoring building** — compartmentalization as defense (airgaps, bulkheads, redundant cores, moats of light, layered shells); a breach shouldn't cascade. Rewards architecture, not blobs.
- **Material-tier pressure** — last tier's walls won't survive next tier's tide; upgrading is forced progression (Valheim-like).

**Locked (R4):**
- **Placement = hybrid** — voxel/grid structural core + freeform detail/decor pieces.
- **Structural integrity = ON** — unsupported spans sag/collapse; makes destruction, tides, and separation-building meaningful.
- **Anchors = volumetric** — real 3D ward/light fields (line-of-sight, occlusion, elevation); bastion strength scales with material tier.

**Locked (R5):**
- **Build feel = deliberate-but-fluid** — structural rules, but snappy/forgiving UX (ghost preview, undo); prefab kits unlock later.
- **Granularity = multi-scale** — small voxels (detail + destruction fidelity) + larger snap pieces (walls/beams/floors) for fast base-building.
- **Blueprints = hand-place first, earn automation** — blueprints/copy-paste + assisted post-tide rebuild as progression rewards.

Still open: full material palette → element round (§5c).

### 5c. Physics / Elements / Destruction 🟡 (Round 6 locked; tech TBD)
**Locked (R6) — the "periodic table" reaction engine:**
- **Architecture = state-based / hybrid.** Materials carry live properties (temperature, charge, wetness, flammability, conductivity…); reactions fire when properties cross thresholds. Emergent, scales like a real element table (BOTW chemistry + Noita).
- **Character = emergent + chain reactions, with guardrails.** Cascades encouraged (heat+metal→melt/explode, electricity+water→shock spread, water+heat→steam…); guardrails keep it generative not un-survivable.
- **Orb wields elements.** Elements are simultaneously **building materials + crafting resources + the orb's powers.** **Learning an element = a new power** → hooks diegetic teaching + orb evolution.
- **Texture north-star:** *Noita depth with BOTW readability.*
- Elements so far: sound/kinetics, water, heat, electricity, sand, wood, metal, glass, dirt (+ **vapor/gas/steam**, +more).

**Locked (R11) — everything is a wave + realism pillar (§ pillar 4):**
- **Every element is a WAVE-TYPE.** The wave substrate is literal, not flavor:
  - **Kinetic / pressure waves** (sound, force, echolocation) — the base; universal, everywhere.
  - **Thermal waves** (heat propagation → melt/explode).
  - **Light waves** (illumination, refraction, reflection).
  - **Water / surface waves** (fluid dynamics, caustics).
  - **EM waves** (electricity, charge, conduction).
  - **Vapor / gas-pressure waves** (steam, spores, gas diffusion).
  - **Dark** = the antithesis (absence/absorption of waves).
- **Realistic-*feeling* physics** — real wave equations + real material constants (proven in `wave_destruction_2d`), tuned to *read* as real; approximate only where it doesn't cost the feel. GPU compute + darkness-bounded sim bubble makes it affordable.
- **Each element has a HOME BIOME** where it dominates the light-ecology, hazards & reactions (element × biome, §5e-B): heat→The Sear · water→The Drown · cold→The Bite · glass/crystal/light→The Glare · vapor/gas→The Reek (fungal *swamp*) · **electricity→The Fade** ✅ (Keeper-tech ran on stored light/charge; ruins crackle — R21) · sound/kinetic = universal · dark→The Nothing. Structural materials (metal/wood/stone/sand/dirt) distributed but concentrated in themed sub-zones.

**Locked (R13) — element classes + the MVP wave-quartet:**
Two classes: **wave/energy elements** (wielded) vs **material elements** (built/destroyed with).
- **⚡ MVP wave-quartet (lead the vertical slice — all are light-interactions):**
  - **Pressure** (kinetic wave) — primary verb: propulsion/traversal (the main way you move *through* water, > water itself), pushes objects, **moves/bends light**, destruction force.
  - **Light** — perception + core resource; moved by pressure, refracted by water/glass/crystal, emitted by heat & flora.
  - **Heat** — spectrum: gentle warm glow (ambient light) → burn → fire → harsh bright light; **heat-haze** (invisible waves made *visible as shimmer/distortion when light passes through*); melt/explode.
  - **Sound** (resonance wave) — **keys/locks/mechanisms via resonance** (match frequency to open/activate), resonance-lighting, puzzle interactions.
- **🌊 Water — secondary/environmental:** real water waves, but *traversed via pressure* rather than wielded. Killer feature = **projection:** orb streams water → **reflective/refractive/dispersing pools** (visual candy + light-shaping tool).
- **🧱 Material elements** (metal, wood, glass, sand, dirt, ice, crystal) — build/destroy with; distributed across biomes; not wielded.

**Still open:** full element enumeration + reaction matrix · electricity's home zone · destruction granularity (true voxels vs chunks vs marching cubes) · GPU sim approach · heat→melt→explode showcase tuning. → element-detail + tech rounds.

### 5d. Survival & Progression ✅ (Round 18 locked)
**Survival = manage two stats: Health + Light/Lumen. Light is literally life-force.**
- **Light / Lumen** — your own light sustains you. **Prolonged darkness drains lumen**; when it bottoms out it bleeds into Health → **death by darkness** ("succumbing to lack of light"). Restored by light (built, ambient, your own aura). → the dark doesn't just *hide*, it *kills*. Unifies with the §5a light economy: light = currency + compass + render/netcode budget + **life-force**.
- **Health** — depletes from **damage** (enemies, hazards) and **environmental extremes** (biome hazards). Regen tied to safety/light.
- **Environment** — biome-specific hazards that damage/drain: cold (The Bite), heat/burns (The Sear), drowning/pressure (The Drown), spores (The Reek), etc.
- **Losing = death**, from any of: **damage · enemies · succumbing to environment · lumen depletion (the dark takes you).**

**Ability / power tree ✅ (R18):**
- **Grounded — elements and/or core forces only; "nothing super crazy"** (John). Every power is an expression of the wave/element physics (pressure, light, heat, sound, water, …). Realism pillar governs: the power fantasy is *mastering real(istic) forces*, not arbitrary magic.
- **Biome-ushered progression:** "**all environments usher in new stuff**" — each biome introduces new abilities/tech/elements; you learn an element's powers by braving its biome (diegetic teaching + biome-gated). E.g. The Sear → heat mastery · The Drown → water projection · The Bite → cold · etc.
- Ability tree = **element-based, biome-gated, diegetically taught** — ties P3 (elements) + §5h (movement powers) + world progression into one.

### 5d-e. Enemies / The Dark as antagonist ✅ (R23 — full design in `NARRATIVE.md` §11 + per-biome rosters)
**The Dark is a tactical intelligence with a memory, not a mob spawner.** Full behavior model + archetypes + boss philosophy + all 7 biome rosters (folded into each biome's lore) live in `NARRATIVE.md`. Summary:
- **Behavior (world-level):** hunts your light/pulses/beacons (light = life, weapon, *lure*) · coordinates by **Tide** (surges together, any direction incl. above/below) · **probes cheap then commits** · retreats from bright light but regroups in shadow & waits for your lumen to wane (attrition) · **learns/adapts** → grows **Breachers** to beat your current defenses (forces diversification / separation-building) · attacks your **light infrastructure** (snuff a bastion = cut map/fast-travel/safety) · **fights fair** (apex heard/felt before seen) · spawns from unlit ground only · each biome's enemies = **echoes of what died there**.
- **Archetypes (shared vocabulary):** Drainer · Swarm · Lure · Stalker (heard-first) · Controller · Bruiser/Bloat · Breacher (elite) · Apex/Boss.
- **Boss philosophy:** each apex = the biome's **mechanic weaponized + its tragedy embodied**; it's the **exam for the power that biome taught**; heard-before-seen; not an HP sponge. Examples: The Reek's **Tender** (dims, doesn't die screaming), The Bite's **The Kept** (hoarded coal), The Sear's **Hearth-That-Spreads** (no attacks, only hunger — beat by running cold), The Glare's **The Flare** (a reflection of you), The Fade's **Warden of the Inward Wall** (walls face inward — turn them outward).
- **The finale (The Nothing) inverts boss design:** no healthbar — the Ember guts out, you **ignite and out-create** the Dark's total assault until the tide *recedes for the first time in the world's history.* "You didn't win the fight; you ended the reason for it."

### 5d-f. Combat & the Light Economy ✅ (R24 — the parked combat half of the enemies round, locked with John 2026-07-08)
**Combat identity = HYBRID:** direct light offense AND tactical control, both first-class.
- **DARK ARMOR (the core combat rule, John's formulation):** dark enemies wear a **dark-shell armor** with per-channel rules —
  · **Light damages the armor itself, ALWAYS — even in full dark** (a light burst is never wasted).
  · **Elemental damages through armor in the dark at reduced effect** (fire set on a shrouded enemy still burns it).
  · **Physical never damages through armor — but always MOVES them**, and **impacts deal damage through armor** (force-push into a wall / drop / slam — physics is always honest).
  · **In light: armor is gone and the enemy is weakened** — physical and elemental land direct.
  → The combo language falls out naturally: *light burst → dash-hit* · *shove → wall-slam* · *ignite in dark → herd into light → finish*. Terrain trapping (funnels, pits, elevation) is a first-class kill path.
- **Light offense** (spends **lumen**): a family of forms — **pulse / beam / laser** — at different effect levels.
- **Tactical control** (spends **energy**): **force-shove** (pressure), **sound-stun** (resonance), **terrain trapping**. Positioning is a weapon.
- **Elemental control** (spends **energy + lumen**): wielded element effects as combat verbs — ties §5c's reaction engine into fights.
- **Cost doctrine (locked):** *physical → energy · light → lumen · elemental → energy + lumen.* **Lumen = life = light = power:** as lumen falls, your light radius AND your power fall with it — being weak is *visible*. Darkness itself drains lumen (the core survival mechanic, §5d). **Glowspheres recharge lumen.**
- **GLOWCHARGE → WARDS (structural lock, corrected R24b):** lumen is the life meter, period — there is no overcharge state. **Once lumen is FULL, further collection (glowspheres, ward-basking, harvests) yields GLOWCHARGE — a banked currency.** Wards cost glowcharge to place. **You cannot build where there is no ward** — ward coverage gates construction, so expanding the buildable world = pushing the ward network outward (this IS "build reclaims the dark," §4-Q2, made mechanical). *Expansion is gated by surplus: the poor survive, the rich build.* Anything that charges inside a ward's **sphere of influence needs charging only once** — the ward's light maintains it. **Wards cannot be affected by the Dark** (no snuffing) **but CAN be physically destroyed by enemies** → defense means bodyguarding structures, not re-lighting them.
- **Harvestable/growable glowcharge sources** (John): renewable light-cultivation exists — it is NOT food; it is how you charge the orb's life and bank glowcharge.

**R25 economy locks (2026-07-08):**
- **DARK MATTER:** extinguished enemies drop **dark matter** — the material for the **highest-tier crafting AND skill growth**. Drops vary by enemy/biome: dark matter + glowcharge and/or **elemental charge** (kills feed all three currencies contextually).
- **Harvest verbs are verb-matched to material** — harvesting teaches combat's verbs: **pressure-wave mines** stone/veins · **light-siphon channel** drinks glowcharge from flora/spheres (hold-to-drain, interruptible) · **resonance cracks** crystal cleanly · **salvage-touch** disassembles Keeper ruins.
- **Elements are world-sourced + carriable:** siphon elements from the environment (fire from a hearth, cold from ice, charge from Fade ruins) into limited **element slots**; craftable **charges** as carried backup. Each biome is an armory; elemental combat is placement-driven.
- **Health regen = lumen overflow:** health knits back only while lumen is FULL and you're in safe light (ward/bastion). Field healing only via rare crafted **mendlight**. Healing = get home, get bright.
- **Environmental hazard menu** presented (cold/heat/pressure/lightning/spores/glare/resonance/corrosion/steam/void/weather incl. dark-squalls) — John's picks pending.
- **Skill growth = diegetic unlock + currency level-up:** nodes unlock through the world (teaching set-pieces, biome mastery, memory fragments — the no-tutorial lock); **dark matter + glowcharge level them up**. Story gates breadth; economy buys depth.
- **Ward/bastion anatomy (John's formulation):** **WARDS** are placed light-nodes that enable construction and **LEVEL UP** — higher level = larger area of influence, more hit points, faster recharge rate, and **buffs**. **BASTIONS** are placeable objects that grant **fast travel**, only placeable in warded areas; **traveling to/from a bastion costs glowcharge per trip** (the network has a running cost — walking stays honest).
- **Building = terrain-grade voxels + crafted functional pieces** (doors, lenses, stations, conduits); no structural-integrity sim — free-form 3D fortification for tides from any direction; build with what you mine (terrain-trap synergy).
- **Inventory = slots + weightless currencies, generously sized:** materials/items take slots (hauls and home storage matter); glowcharge/dark matter/element charges are weightless (death rules govern loss). Expedition pressure comes chiefly from the tide clock.
- **Ward destruction = territory loss with rot stakes (John: both):** buildings go dormant (no charging/building/bastion travel), charged things bleed, the dark can spawn there again, AND unwarded structures slowly decay until re-warded. Architecture is recoverable; neglect is not free.
- **Tide defense = a player-choice spectrum:** built defenses and active combat trade off — well-built means less fighting needed, strong fighting means less building needed. Both are complete answers; most players live between.
- **Recipes = inspiration from the world:** touching/harvesting a new material or salvaging Keeper tech reveals what it wants to become (scan-to-unlock, diegetic); memory fragments unlock signature recipes. No recipe grind.
- **v1 scope ✅ (R25): ALL 8 biomes ship** (Badlands added to the roster). **Progression = Valheim-style DISTANCE FROM SPAWN** — the radial macro-skeleton (difficulty = distance).
- **WORLD GEOGRAPHY ✅ (R25, John):** build outward from center — **Reek at the heart** (easy zone) → inner continent holds the **BADLANDS as the dry interior** (the American-West analogy: Wyoming/Utah/Nevada/Arizona/West-Texas — inland canyon country, home of caves & dungeons; MAY touch water but needn't) alongside the other continental biomes → **THE DROWN IS THE OCEAN** — an oceanic expanse you must **cross**, requiring an earned **traversal ability to pass over the abyssal depths** to shallower seas → **across the ocean: THE GLARE** (illusory · glass · teleporty) → Fade → Nothing at the rim. The Drown = the moat between continents, not a wet province; ocean-crossing is a progression gate AND a divable depth-biome.
- **Permanent night, living sky ✅:** always dark — the premise never relaxes. Moon phases + cloud cover modulate the faint ambient (a full clear moon = the closest thing to day); dark-squall weather dims further.
- **Multiplayer ✅: solo v1, co-op-ready bones** — world state stays deterministic-gen + delta-persistence shaped so 2–4 co-op can come post-launch without a rewrite.
- **Tide telegraphy ✅: diegetic signs only** — no gauge: distant rumbles, denser probing, flora dimming, haptics. You learn to read the pressure like weather.
- **Continent layout ✅: directional wedges + ring difficulty** — biomes occupy compass directions (per-seed), danger scales with distance in EVERY direction; you pick which biome to push, distance sets how hard.
- **Traversal chain ✅ (Sketch A):** Reek = basics (wave-jump/dash) · **Badlands = updraft-ride + wall-dash** (canyon verticality) · **Bite = ice-skim** (momentum glide) · **coast = water-skim** (pressure-ride over shallows) · **Sear = thermal soar** · **ABYSSAL PASS** (deep-Drown material upgrade) lets skimming cross open ocean → the Glare. Each biome's terrain IS its movement tutorial (diegetic-teaching lock).
- **Energy model ✅ (blend):** energy regen **scales with light level** (own aura counts, scaled by lumen) — deep dark throttles stamina hard but not to zero; cap + regen grow via defense tree/augments. Darkness starves both meters, mercy at the margins.
- **Hazards v1 ✅:** the **biome-signature six** (cold · heat · pressure/drowning · spores · glare · void) **+ lightning/static (Fade)**. Weather layer (rain/wind/fog/dark-squalls) and texture hazards (resonance/corrosion/steam) = post-v1 stubs.
- **Skill trees:** separate **offense** and **defense** trees growing bigger/better skills (forms, levels, effects). Grounded rule from §5d still governs: every skill is an expression of the wave/element physics — nothing arbitrary.
- **Death = difficulty setting (all three modes ship, player-chosen):** ① **Cold Ember + Dark Bloom** (hardest: dropped materials guarded by locally-strengthened dark that must be pushed back) · ② **classic corpse run** (items wait, world unchanged) · ③ **keep inventory, lose light** (nearby charged light snuffed instead).
- **Dark Tide cadence = clock + provocation:** a baseline escalating rhythm you can prepare for, **accelerated by your activity** (big light builds, loud mining, deep pushes advance the timer) — "how loud dare I be" becomes a play-style dial.

### 5e. World / Proc-gen 🟡 (Round 8 in progress; research running)
**Locked (R8):**
- **The two axes multiply, they don't just add.** **Depth = challenge** (danger / material-tier / tide intensity) · **Width = variety & worldbuilding** (biomes, story, distinct places).
- **Biome-flavored depths:** the vertical depth-stack *inherits the surface biome's theme* — caves/depths under a frozen biome differ from those under volcanic/fungal/etc. Content = **biomes × depth-layers** (multiplicative) → both axes stay fresh, big world with no empty stretches.
- **Water is first-class** — bodies of water across biomes; a core element (§5c) and a major aesthetic + gameplay vector.
- **Light + Water synergy 🟡 (John — "room for very cool effects"):** caustics, refraction, reflection, **bioluminescent pools** (an emissive Light-Ecology source, §5a), light scattering/bending through water, **water+heat→steam** (light-scattering fog), **water+electricity→lethal**. In 3D: a signature visual hook *and* a puzzle/traversal material — use water to shape light, not just terrain.

**Locked (R8, research-backed — full report: `RESEARCH_world_structure.md`):**
- **Structure = fixed skeleton, procedural flesh, hand-authored highlights.** ~6–8 **depth bands** × radial **frontier tiers**; **difficulty = depth × distance-from-first-light.** Each band: distinct dominant voxel + shortened wave range + new element/reaction wrinkle + a **heard-before-seen apex threat**.
- **Depth changes the RULES, not just stats** (visibility, elements, threats, material per band). Player *chooses* when to descend (agency = dread).
- **Per-biome generation rules** (own noise, dominant voxel, hazards, reaction ingredients) → biomes feel categorically different. **Many biome types** (John loves these) — frozen/volcanic/fungal/drowned/crystalline/etc., each with its own themed depths.
- **Gate via structure:** material to build wards that survive band N's Dark Tide is found only in band N-1 → **the world layout IS the tech tree.**
- **POI Diversity Rule:** every echolocation ping reveals **2–3 differentiated** hooks (vein/ruin/hazard/set-piece); never identical POIs back-to-back. Tiered hand-authored dark set-piece library seeded by frontier distance.
- **Navigation = your own light.** Emissive **bastions/wards = global landmarks** (construction is the map); **ping = temporary local minimap**; **player-placeable light-breadcrumbs** (burn out faster deeper → nav cost scales with depth); faint pull to nearest owned light so never *fully* lost, frontier stays disorienting. Shrink spaces — dark inflates perceived scale for free.
- **Fast travel = the light network:** rapid-transit **only between built + lit bastions**; earned by the core loop, can never skip the frontier (newest edge always walkable-only).
- **Persistence:** far chunks saved (IndexedDB) so built bastions stay built — required for "hold the dark back *permanently*."

### 5e-B. Biome roster & ecology 🟡 (Round 10 — roster ✅ + "stub for more"; ecology = draft)
Each biome = own gen rules + dominant voxel + element/light identity + flora + fauna + mobs + its *own* themed depths. **Data-driven & extensible — stub for more biomes** (John). Detailed enemy *systems* (AI, breachers, dark-as-antagonist) remain the parked enemies round; this is ecological flavor + identity.

> **Full worldbuilding, lore, and per-biome depth now live in `NARRATIVE.md` §10 + Biomes II–VII** (chapter-in-the-fall, flora, fauna, enemies-as-echoes, Keeper ruins, memory-fragments). Table below = quick index; enemy names updated to the locked sensory register (R21).

| # | Biome | Element / identity | Enemies (echoes of what died here) | Signature |
|---|---|---|---|---|
| I | 🍄 **The Reek** | vapor/spore + Light basics; bioluminescent (on-ramp) | Snuffers, Chokers, the Bloat | the world lights itself; reek-mist |
| II | 🧊 **The Bite** | cold/ice; aurora | The Still, Chatter, The Hush | cold dims/slows orb; brittle ice |
| III | 🌊 **The Drown** | water; caustics/light-bending | Beckons (false-light lure), Hushers, Undertows | water shapes light; pressure/drown |
| IV | 🌋 **The Sear** | heat/fire; molten light | The Overhot, Flashscabs, Smoulders | your own heat + thermal chain reactions |
| V | 💎 **The Glare** | glass/crystal/light refraction | The Doubles, Dazzlers, Splinter | reflection maze; aim/bounce light |
| VI | 🏚️ **The Fade** | **electricity** (Keeper-tech) + ruins/STORY | **Revenants**, Static-Wisps, Gutterlings | story core; live current; walls-face-inward |
| VII | 🕳️ **The Nothing** | dark/void; endgame heart | Breachers, Everythings, the Maw, Snuffkin | worst tides → **transcendence** (become the beacon) |

**Progression order ✅ (R21):** Reek → Bite → Drown → Sear → Glare → Fade → Nothing (matches the numbering). **Electricity's home = The Fade ✅** (resolves the §5c open). Each enemy is a light-fearing *echo of what the Dark consumed there* (unifies enemy design + biome + lore). **v1 = 5** (Reek/Bite/Sear/Drown/Nothing; Glare+Fade post-launch — still 🟡 to confirm; note The Fade is the story core so may warrant v1).

### 5f. Tech / three.js 🟡 (research-informed; deep tech round pending)
- **Darkness = the streaming/perf budget.** Render only the lit bubble: **~4–8 chunk render radius, ~2–4 sim radius**; far-fog fades geometry to black *before* the LOD boundary → no pop-in. World is effectively infinite (streamed on demand), GPU cost bounded to what light touches.
- **Voxel pipeline:** chunked streaming · **greedy meshing off the main thread (Web Workers)** · `THREE.LOD` · merge/instance to cut draw calls · CPU-side octree for load/unload keyed to the lit bubble + pre-fetch ring · IndexedDB persistence.
- **Physics/element sim** only within the sim radius around players + active bastions (Minecraft ticking-area model). GPU compute (WebGL2/WebGPU) for the wave/heat/reaction fields.
- **Open:** rendering approach (deferred vs forward+ for many dynamic lights) · physics lib (rapier/cannon/custom) · WebGL2 vs WebGPU target · **netcode/authority model (see §5i).**

**Cross-platform reality & de-risking (honest assessment):**
- **Cross-platform is nearly free** (web = one codebase everywhere). **The real risk is the *combination*** — full realistic physics + make-or-break lighting + destructible voxels + MP, all at once *on a phone*. Any one is fine; all maxed simultaneously is the challenge.
- **Reconcilers:** (1) **darkness bubble = the scale knob** — mobile runs a smaller lit bubble (fewer sim chunks/reactions, lighter light tier); same game, smaller radius. (2) **Authoritative server offloads the sim** for MP — phones mostly render + input → MP architecture is itself a mobile-enabler. (3) **"Same game, graphics scale"** — parity of mechanics/world/physics/cross-play, NOT identical pixels.
- **Discipline (non-negotiable):** design to the **mobile budget from day one**; **hard gate: the vertical slice runs ≥30 fps on a mid-range phone** before piling on features (the slice-first plan makes this cheap to verify); **graceful degradation** (cap concurrent reactions / lighting fidelity on weak devices — reduce, never break the rules).
- **Honest unknown:** how much full physics + lighting a low-end phone carries at once. Lighting research (running) → graphical ceiling; mobile-gated slice → sim ceiling. If reality pushes back, **dial mobile fidelity, not ambition** (PC stays lush, phone stays the same game).
- **Device quality tiers** (lineage: 2D `waiver` already auto-dropped bloom + physics substeps under FPS pressure) — formalize into low/med/high tiers auto-selected + manual override.

### 5j. Lighting — ⭐ the make-or-break graphical system ✅ (R17, research-backed — full report: `RESEARCH_lighting.md`)
**Architecture principle: a LIGHT-DRIVEN, not geometry-driven renderer** — the light (a voxel flood-fill grid) says what's visible; shade *outward from lights* into the dark. The game's thesis expressed as a renderer, and what makes it run in a browser.

**Phase 1 — WebGL2 baseline (ship this):**
1. **Clustered forward+** for many small dynamic lights (naive three.js caps ~30–50; clustered → hundreds+). Keeps transparency/MSAA/emissive (deferred breaks those).
2. **Voxel flood-fill light propagation** (worker-side) = cheap, **destructible-safe GI workhorse**; colored bounce-like spread nearly free since the world IS voxels; re-flood only dirty regions. Sells "built light holds back the dark."
3. **HDR + selective bloom (pmndrs) + ACES tone-map LAST** — non-negotiable for the glowing orb; emissives punch through, cores stay saturated. Pulse orb `emissiveIntensity` for living light.
4. **Raymarched volumetrics** half-res + blue-noise (~50 steps) for god-rays/fog; shadow only 1–3 hero lights (orb + key beacons).
5. **Signature effects = screen-space passes** (cheap): caustics (drei `Caustics`), refraction+dispersion (`MeshPhysicalMaterial.dispersion` r164+ / `MeshTransmissionMaterial`), **one heat-haze/distortion pass reused for heat/fire/water/aura**. → validates John's water-pools + refraction + heat-haze ideas as CHEAP.
6. **Render only the lit bubble** (light-cull chunks at light-level 0). Darkness = the occlusion/LOD system.

**Phase 2 — WebGPU GI upgrade (when requirable):** WebGPURenderer + **TSL** (author once → WGSL+GLSL), then **voxel cone tracing** or **3D radiance cascades** for true bounce GI (Teardown-proven for voxels). Teardown recipe: explicit lights + global shadow volume + temporal accumulation + blue noise = clean GI from ~1–2 rays/px.

**Strategy:** target **WebGPURenderer w/ WebGL2 fallback + TSL from day one**; Phase-1 in the WebGL2 subset (everyone gets a great game — covers the ~5% + mobile stability); gate heavy GI (VCT/3D-RC/compute) behind WebGPU as a quality tier. **Mobile tier drops volumetrics + shrinks bloom** (thermal) → exactly the cross-platform §5f device-tier scaling.

**Open:** clustered-forward+ (build vs existing lib) · when to enable Phase-2 GI · exact art-direction targets per biome light-ecology.

### 5i. Multiplayer ⭐ REQUIREMENT (John — "absolute must") 🟡 dedicated round pending
First-class from day one — shapes the whole architecture. Honest framing (this is the hardest part of the vision, and worth doing right):
- **The challenge:** full destructible voxels + a systemic element/reaction sim + many players is one of the hardest netcode combos in games. Naive sync of every voxel/reaction won't scale.
- **The alignment (our ace):** *the darkness limits what must be networked per player, exactly like it limits rendering.* You only need to sync the **lit bubble / area-of-interest** around each player — the dark hides the rest. The same "small bubble" that makes rendering and streaming cheap makes netcode tractable.
- **Likely model:** **authoritative server** runs the sim; clients render + predict; **area-of-interest** sync bounded to each player's lit bubble; the element/voxel field is chunked and only active chunks tick + replicate.
**Locked (R9):**
- **Scale = co-op → small server (~2–8).** Genre norm; keeps the heavy sim tractable; "hold the dark back *together*."
- **PvE-first "safe mode" for v1** — explore & tune mechanics in a forgiving space.
- **Ownership = shared world & bastions + personal orb-energy/powers.** Tides scale to party size.
- **Phased plan (locked):** **stub the architecture for full PvPvE + base raiding from day one** (ownership, damage authority, team/faction layer, raid rules all built to *toggle*), ship PvE first, arm PvPvE later as a designed future mode — never a rewrite. Destructible bastions + Dark Tide make raiding native to the fantasy.
- **Hosting (🟡 provisional):** drop-in-with-friends / private worlds first (Valheim-style); public persistent servers a later option.

**Still open (deep netcode round):** authority model specifics · client prediction/reconciliation for the voxel+element sim · hosting (dedicated vs P2P/host-migration) · how latency reconciles with the reaction sim · shared vs per-player light-reveal state.

### 5g. Narrative & Tone 🟡 (Round 20 — spine drafted; full doc: `NARRATIVE.md`)
**Spine (🟡 awaiting John's shaping):**
- **The First Light** (living light in all things: warmth/sight/memory) **died** → **the Dark** flooded in: a living hunger that eats light, warmth & **memory**; surges = **Dark Tides**; heart = **The Nothing**.
- **You = a Spark** — a new light woken since the world fell; not anthropomorphized; Lumen = life, growing brighter = progression.
- **The Keepers** came before & **failed** — they only *held* the dark (walls, hoarded light, alone). Their ruins/husks = **The Fade**. **Your path: push the dark, reclaim, share.** *Held light dies; spread & shared light lives* → story-root of build-outward **+ multiplayer.*
- **The Dark makes monsters from what it consumed** → each biome's enemies = *echoes of what died there* (unifies enemy design + biome + lore). **Revenants** = consumed Keepers (your possible future). **Breachers** = the Dark learning to counter you.
- **Guiding NPC = the Ember** — the last Keeper burned to a warm, failing light; **Spark(you)↔Ember(them)**; wordless tone-voice guide + lore vessel; **slowly fading = the emotional heart.**
- **Arc + ending ✅ (R20, John): TRANSCENDENCE, not restoration.** Awaken (a spark born) → journey the biomes (through the dark = through the end of a life, grief, unmaking) → reach **The Nothing** (the void at the bottom of an ending) → **become a NEW beacon, bright & powerful, and BUILD A NEW WORLD for life to be part of.** You don't resurrect the First Light; you transcend it. Birth→death→rebirth/creation.
- **⭐ Theme (capstone) ✅:** *the end of a life, passed through, becomes creation.* The game is an **allegory of moving through an ending into becoming** — the survival-crafting IS the act of creating life after death. Held light dies, **shared** light lives, and *you cannot keep what has ended — only create what comes next* (the Keepers clung; you transcend). MP resonance: other lives/Sparks gather to the new world you make. Tone bends from grief toward hope.
- **Delivery = diegetic** (Ember, biomes-as-chapters, memory-blooms, ruins, Revenants); never pop-ups/codex-walls (the Pulse fix).

**Authorial forks:** ending ✅ locked (transcendence/new-beacon/new-world). 🟡 remaining: the **Ember's passing** (leaning: it guts out near The Nothing, its death = the lesson of letting-go/transcendence — confirm) · **what killed the First Light** (mystery to design). Names = placeholders (sensory-register pass pending).
**Next:** biome-by-biome depth (lore/flora/fauna/enemies-renamed/Keeper-ruins/memory-fragments) once spine confirmed. Folds in the ⏸ parked enemy round.
- **Orb-life research action:** ✅ done (§5h, `RESEARCH_orb_life.md`).

### 5h. Movement & Orb Expression ✅ (Round 7 locked)
- **Locomotion = hover-glide** (John: "the only option") — the orb hovers, never walks; re-tuned for 3D with signature weightless drift. *You move like a living light.*
- **Control = snappy + momentum** — responsive/readable in the dark (fixes Pulse's clumsy jumps), with drift for life.
- **Traversal = a deep, earned toolkit** (John wants *many* movement types, made fresh by wave-tech). Confirmed directions:
  - **Wave-pulse flight / propulsion** and **much bigger wave-jumps** (power-adds).
  - **Dashes** (carried from 2D, expanded).
  - **Kinetic recoil, anchor-grapple**, and more — each learned as an element/ability (ties to §5c + diegetic teaching).
  - **Technique layer:** unlocked moves can be *modified/upgraded/chained* — mastery, not just acquisition. A tech-skill ceiling.
  - **Light-trailing traversal 🟡:** the orb leaves a glowing wake — lights where you've been (*movement = a way of seeing*, the Pulse idea made persistent) and serves as anti-lost breadcrumbs. Cross-links §5a light + §5g expression + world wayfinding.
  - **Fresh-via-waves:** every move is reskinned through the wave/echolocation lens — the genre-standard toolkit made unmistakably *this game's*.
  - **Design constraint (keep the tension):** flight & big movement powers are **earned + costly** (energy/light drain, limited charges) — a thrilling tactical payoff, never a "skip survival" button. Descent stays earned; the Escalation Loop stays intact.
- **⭐ Orb life & feel — CRITICAL immersion system ✅ (R19, research-backed — full brief: `RESEARCH_orb_life.md`):** the orb is the emotional anchor; its felt aliveness is make-or-break for player bonding. Two findings anchor it: (a) **animacy bias is hardwired** — moving/pulsing light involuntarily reads as alive (the reflex is already ours to trigger); (b) **believability = HOW motion executes (easing/accel curves), not readable poses** → **build emotion as a physics-and-curves system, not canned poses.** *Loud cues earn recognition; quiet cues earn love.*
  - **Six expressive carriers:** motion path · glow/brightness · color · pulse/rhythm · particle/aura · sound.
  - **Two-axis light-mood model:** brightness = valence, saturation+pulse-rate = arousal; warm+bright = safe, cool+dim = threatened. **⭐ The orb's mood PAINTS the voxel world** via the flood-fill GI (§5j) — frightened orb → the cave goes cold blue. Directional valence: up/toward = positive.
  - **Build order:** (1) **resting "breath" FIRST** — irregular (never perfectly periodic) brightness/scale pulse + drift = the "alive vs asset" baseline; (2) all motion via **easing, never linear**; (3) **one dominant variable per state**; (4) color=mood/pulse=arousal; (5) **grammar-based voice** (~small vocab of intent-categorized vocalizations, organic+musical, synced to the pulse); (6) **juice the world's response** to the orb.
  - **Conspicuous cues** (state gestalts): color/glow/pulse/aura/squash/particle/motion per emotion (calm/joy/fear/pain/cold/heat) — see table in brief. Elemental states from §5c (shiver=cold, red-vibrate=hot) live here. Co-encode with motion/shape (colorblind-safe), never color alone.
  - **Inconspicuous cues** (the bond): irregular breath, secondary/trailing motion (Journey's scarf), micro-hesitation/anticipation (~100–200ms wind-up), gaze-proxy via lean, tiny reactive twitches, subliminal mood-hum, imperfection tells.
  - **Reference north-star:** **Ori's Sein** (a sentient orb of light read via color+animation) + Journey/flOw/BD-1/Companion-Cube. **Context matters:** a lonely, hostile world that treats the orb as significant does half the bonding.
  - **Juice tuned to a contemplative survival tone** (dial screenshake DOWN, lean on glow/particle); **responsiveness = the orb's soul** (input lag reads as lifelessness).

---

## 6. Decisions log
- **R1:** Core loop = survival-crafter-builder, **proc-gen-primary + curated set-pieces** for story & **diegetic ability-teaching (no direct tutorials)**. ✅
- **R1:** World = **"build reclaims the dark" + reactive/environmental lighting** (temp & permanent reveal). Open sub-problem: balance so it's neither too hard nor too easy. ✅
- **R1:** Physics = **FULL multi-physics day one** — systemic **element/reaction table** (sound/kinetics, water, heat, electricity, sand, wood, metal, glass, dirt, +more), **full destructibility**, thermal incl. heat→explode→chain in v1. Perf = engineer around (GPU/chunked/LOD). ✅
- **R1:** Priority stack = **1) light/dark · 2) structural build+destroy · 3) materials/elements · 4) movement physics.** ✅
- **R1:** Avatar = **living orb**, life via light/glow/aura + states/distortions; geometric only, never anthropomorphized. ✅
- **R2:** Light economy = **energy pool** (free faint baseline + costly reveals; built light permanent) · Dark = **slow reclaim, built light is bulwark** · Pulse = **ambient auto + manual**. ✅
- **R2 caveat → R3:** Darkness is a **gradient, not global** — Light Ecology + Three-tier zoning + difficulty=distance-from-light + fairness guardrail. ✅
- **R3:** Havens = **both world-seeded + player-built** · Gradient = **spatial + scaling Dark Tide events** · **Verticality primary** (deeper=darker=harder). ✅
- **R3 (emergent spine):** **The Escalation Loop** (§3a) + **3D-native principle** (§3b). Dark Tide = scaling destructive event → **Bastions / Anchors-Wards / Separation-building / material-tier pressure** (§5b). ✅
- **R3 (parked):** Enemies from the dark, elite breachers (§5d-e) → dedicated later round. ⏸️
- **R4:** Building = **hybrid placement** (voxel core + freeform detail) · **structural integrity ON** (collapse) · **volumetric anchors/ward fields**, bastion strength by material tier. ✅
- **R5:** Build feel = **deliberate-but-fluid** · granularity = **multi-scale** (voxels + snap pieces) · **hand-place first, earn blueprints/automation.** ✅
- **R6:** Element engine = **state-based/hybrid** (property thresholds) · **emergent + chain reactions w/ guardrails** · **elements = materials + resources + wielded powers** (learn element = new power) · north-star **"Noita depth, BOTW readability."** ✅ → *completes top-3 priority stack (light/dark, building, elements).*
- **R7:** Movement = **hover-glide** (only option) · **snappy + momentum** · **traversal = earned power tree** · **orb-as-canvas** (body telegraphs elemental state: blue auras/pulses, shiver=cold, red-vibrate=hot 🟡). ✅
- **R7 → R8:** World = **"deep, far & wide"** — both vertical + horizontal axes carry weight (refines R3's verticality-primary). 🔬 research running.
- **R8:** **Depth = challenge, Width = variety/worldbuilding** · **biome-flavored depths** (biomes × depth-layers) · **water first-class** + **light+water FX** · **research-backed structure** (6–8 depth bands × frontier tiers; difficulty = depth × distance-from-light; gate-via-structure = world-is-tech-tree; POI Diversity Rule; nav via emissive bastions + ping-minimap + light-breadcrumbs; **fast travel = built-light network**; IndexedDB persistence; darkness = perf/streaming/netcode budget). ✅ Full report: `RESEARCH_world_structure.md`.
- **R8+:** ⭐ **Multiplayer = absolute must** (John) — first-class cross-cutting requirement; darkness's lit-bubble = the area-of-interest netcode budget; likely authoritative-server + AOI sync. 🟡
- **R9:** MP = **co-op/small server (2–8)** · **PvE-first "safe mode" v1** · **shared world+bastions / personal orb-energy**, tides scale to party · **stub architecture for PvPvE + base raiding from day one** (toggle-on later, no rewrite) · hosting = drop-in/private first 🟡. ✅
- **R10:** Biome **roster = 7 + "stub for more"** ✅ · each fleshed with **flora / fauna / mobs ecology** (draft, §5e-B). Enemy *systems* still parked. 🟡 open: v1 count, progression order, signature lock.
- **R11:** ⭐ **Realism pillar (pillar 4):** everything is a **wave-type** (kinetic/thermal/light/water/EM/vapor) · realistic-**feeling** physics (real constants, proven in wave_destruction_2d) · **the physics IS a moat** alongside the darkness · **each element has a home biome** (element × biome). ✅ Open: electricity's home zone.
- **R11 naming:** biome names LOCKED in the **sensory-effect** register (name = what the place does to you): **The Sear · The Drown · The Reek · The Glare · The Bite · The Fade · The Nothing.** ✅ (**The Nothing** = the deliberate endgame exception — every other biome assaults *a* sense; the Dark's heart is the absence of all → "nothing." Renamed from "The Smother," R20.)
- **R12:** Production = **vertical slice** — build the **core-loop MVP** (see/move/gather/build/hold-light/one-element) first, taught by a **diegetic tutorial on-ramp** (likely **The Reek**), expand biomes/powers/content after. **Dev sandbox / greybox test room** built early (lineage: 2D `sandbox_scene` + `--demo=`). §8. ✅
- **R13:** Element classes = **wave/energy (wielded)** vs **material (built with)**. **MVP wave-quartet: Pressure · Light · Heat · Sound** (all light-interactions); **Water = secondary/projectable** (reflective/refractive pools); materials = metal/wood/glass/sand/dirt/ice/crystal. §5c. ✅
- **R14:** Intro = **one continuous diegetic arc in The Reek** (awaken→see/move → gather/build → **first Dark Tide in the intro** (survivable-but-scary, worldbuilding glimpse of failed keepers) → aftermath). Teaches the whole loop + fear→relief→wonder hook, zero pop-ups. §8b. ✅
- **⭐ FLAGGED (John):** **Lighting is the single most important graphical piece — make-or-break.** Dedicated lighting-tech deep-dive queued; 🔬 research pre-launched (background).
- **R16:** ⭐ **Cross-platform requirement** — PC/laptop/tablet/mobile, **one game** (web/three.js); identical mechanics/world/physics/MP, **graphics auto-scale** via darkness-bubble; **mobile = binding perf constraint**; input abstraction (touch/mouse-kb/gamepad). Verdict: **ambitious but achievable with mobile-first discipline** (hard gate: slice ≥30fps on mid-range phone; graceful degradation; dial fidelity not ambition). §5f. ✅
- **R17:** ⭐ **Lighting stack LOCKED (research-backed):** **light-driven renderer** (voxel flood-fill light grid drives visibility, shade outward from lights). Phase-1 WebGL2 = clustered forward+ · flood-fill GI · HDR+selective-bloom+ACES · half-res blue-noise volumetrics · screen-space signature FX (caustics/dispersion/heat-haze) · render-only-the-lit-bubble. Phase-2 WebGPU = TSL + voxel-cone-tracing / 3D radiance cascades. Target WebGPU+WebGL2-fallback+TSL day one; mobile tier drops volumetrics/bloom. §5j. Full report: `RESEARCH_lighting.md`. ✅
- **R18:** **Survival** = Health + **Light/Lumen (light = life-force; darkness drains → death)**; losing = damage/enemy/environment/lumen-depletion. §5d. **Abilities** = element/core-force grounded ("nothing super crazy"), **biome-ushered** (each biome introduces new powers), diegetically taught. **v1 = 5 biomes** (Reek/Bite/Sear/Drown/Smother; Glare+Fade post-launch — confirm). ✅
- **R19:** ⭐ **Orb life & feel LOCKED (research-backed, `RESEARCH_orb_life.md`):** animacy bias is hardwired; **emotion = physics-and-curves, not canned poses**; six carriers; **two-axis light-mood model** (brightness=valence, saturation/pulse=arousal) that **paints the voxel world** via flood-fill GI; build order = **breath-first** (irregular pulse) → easing → one-var-per-state → grammar-voice → juice-the-world; conspicuous + inconspicuous cue lists; north-star **Ori's Sein**; responsiveness = soul; juice tuned DOWN for contemplative tone. §5h. ✅
- **R21:** ⭐ **All 7 biomes built in full depth** (`NARRATIVE.md` §10 + II–VII) — chapter-in-the-fall, flora, fauna, **enemies renamed (sensory register) as echoes of what the Dark consumed there**, Keeper ruins (each embodies "hold vs share" wordlessly), memory-fragments. **The Reek = the full first level** (hand-written). **Progression order** = Reek→Bite→Drown→Sear→Glare→Fade→Nothing ✅. **Electricity's home = The Fade** ✅. The Nothing = transcendence climax (become the beacon, build the new world, tides recede). §5e-B index updated. ✅
- **R20:** GDD read-through ✅. **Narrative SPINE drafted** (`NARRATIVE.md`, §5g): First Light died → living **Dark** (eats light+memory) → **you = a Spark** (new light) · **Keepers failed by only *holding*** (ruins/husks = The Fade) → your path = **push/reclaim/share** (root of build-outward + MP) · **Dark makes monsters from what it consumed** (biome enemies = echoes of the dead; Revenants = consumed Keepers) · guide = **the Ember** (last Keeper, fading = emotional heart) · arc = descend into The Nothing & rekindle · theme = *held light dies, shared light lives*. 🟡 forks: ending · Ember's fate · what killed the First Light. Next: biome-by-biome depth (folds in ⏸ enemy round). 🟡

## 7. Interview backlog (the "few dozen rounds")
Reordered to John's priority stack — each round locks a few cells and spawns the next:
1. ~~Round 1 foundations~~ ✅ done.
2. **Light/Dark deep-dive (P1):** the three-source model; how pulses/built/reactive light persist & decay; the "too hard vs too easy" balance; is light a spendable resource; does the dark actively encroach/reclaim.
3. **Building deep-dive (P2):** grid/voxel-snap vs freeform; block scale; buildable light sources/beacons as first-class; structural integrity & collapse in 3D; blueprints vs hand-place.
4. **Destruction granularity (P2):** true voxels vs chunks vs marching cubes; how built + natural terrain break; debris.
5. **Element/reaction engine (P3):** enumerate the full element table; define the reaction matrix; how sim scales on GPU.
6. **Movement & mechanics (P4):** orb traversal in 3D — hover/dash/jumps, wave-jumps, how movement reads in a dark world.
7. **Survival model:** resources, gathering, health/energy, threat/pressure, what "losing" means.
8. **Ability set + diegetic teaching:** what powers exist, gating order, the teaching set-piece for each.
9. **Proc-gen world:** biomes/regions, verticality (caves/depths), scale, set-piece injection into procedural terrain.
10. **Enemy/antagonist design:** shadow creatures + roster; the dark itself as a system.
11. **Orb life & feel** (with web-research from §5g): states, distortions, aura language, juice.
12. **Tech spike:** renderer (WebGL2/WebGPU, deferred lighting), voxel/meshing, physics lib, save/persistence, web-first target, multiplayer?
13. **Narrative premise & delivery.**
14. **Art direction & audio identity.**
15. … (more to emerge)

---

## 8. Build order & v1 scope ✅ (Round 12 — John's production call)
**Approach = vertical slice: build the core loop until it's *fun*, prove it in one hand-crafted on-ramp zone, then expand.** Core mechanics first; biomes/content/powers/PvP layer on *after* the mechanics are situated.

### 8a. The core loop MVP — "the biggest, most-used mechanics" (build these first)
The vertical slice must make this loop fun on its own:
1. **See** — pulse/echolocation + the lit bubble (P1). *The* signature verb.
2. **Move** — hover-glide, snappy+momentum (P4 base).
3. **Gather** — harvest materials/elements from the world.
4. **Build** — place voxels/pieces + structural integrity + place a light/anchor (P2 core).
5. **Hold light** — reclaim pressure + survive a **first, gentle Dark Tide** (the Escalation Loop in miniature).
6. **One element interaction** — a single readable reaction to introduce the engine (P3), e.g. heat, or light+water.

Everything else (full element table, 7 biomes, power tree, enemies, PvPvE) **expands outward from this** once it's proven.

### 8b. The tutorial-like on-ramp zone — the Intro Sequence ✅ (R14)
- A **hand-crafted starting area** in **The Reek** (gentle, self-lit bioluminescent biome — forgiving light while learning) that teaches the core loop **diegetically** (the level *is* the lesson — no pop-ups; per §3). Doubles as the story's opening.
- **One continuous intro arc:**
  1. **Awaken** — dim orb in a bioluminescent hollow; learn **see** (pulse) + **move** (glide) by drifting toward the glow. Curiosity teaches; no prompts.
  2. **Gather & build** — harvest glowing material, place your **first light/ward**; the hollow brightens around you. Light is something you make & own.
  3. **The FIRST DARK TIDE (in the intro)** — flora dims, a low resonance + tremor (heard-before-seen), the dark **surges in** — scary & new but **scripted-survivable**: you pull into your light and your ward *holds*. In the tide's glow, **worldbuilding**: a distant extinguished keeper-beacon — a whisper that *others held the light before, and failed.*
  4. **Aftermath** — tide recedes, world subtly darker; now you *understand* the loop (build → hold light → push out) because you lived it. Released into the game.
- Teaches **see → move → gather → build → hold light** + delivers the **fear→relief→wonder** hook + plants the story — zero pop-ups.

### 8c. Dev sandbox / test area ✅ (standard practice; already in lineage)
A **greybox dev room** for testing mechanics in isolation before they touch the real game:
- God-mode; every material/element/tool spawnable; adjustable brush.
- Buttons to **spawn a Dark Tide, spawn mobs, trigger reactions**; toggles for each system (gravity/collapse, reclaim, physics on/off).
- Free-fly camera, time controls (pause/slow/step), perf telemetry overlay.
- **Lineage:** the 2D `waiver` already had `scenes/sandbox_scene.py` + `--demo=` builders — this is the 3D descendant. Often grows into the player-facing **creative mode** later.
- Build this **early** — it's the workbench the whole vertical slice is iterated in.

**v1 biome count ✅ (R18): 5 biomes.** Proposed 5: **The Reek** (on-ramp) · **The Bite** · **The Sear** · **The Drown** · **The Nothing** (endgame). Post-launch: **The Glare**, **The Fade** (+ stub-for-more). 🟡 confirm the exact 5 (e.g. swap **The Fade** in for story if wanted).
**Open:** progression/unlock order across the 5.

---

## 9. Revision roadmap (from external review — R22)
The doc crossed from "idea dump" to "real GDD" (external review ~9.3/10). Tracked improvements, in priority order:
1. ~~**Enemy ecology + boss philosophy**~~ ✅ **DONE (R23)** — `NARRATIVE.md` §11 + 7 biome rosters; the Dark as a tactical system, archetypes, boss philosophy, per-biome encounters + apexes, the inverted finale. §5d-e.
2. **Modular structure** 🟢 started — **`README.md` = the Overview + Pillars + canon + module map** (front door). Modules: this `GDD.md` (design), `NARRATIVE.md` (story/world/enemies), `SPEC.md` (numbers), `PLAYTHROUGH.md`, `RESEARCH_*`. *Incremental:* extract Lighting/Physics/Networking/Orb/Audio/Art-Bible from their GDD sections as they mature.
3. **De-dup canon** 🟢 started — the core one-liners now stated **once in `README.md`** ("light is everything", "everything is a wave", "darkness is the perf/netcode budget", "world layout is the tech tree", "held/shared light"). *Incremental:* sweep the GDD to reference rather than restate.
4. **Intent vs implementation ladder** ✅ — `SPEC.md` tags every tech choice **Goal → Possible → Preferred → Confirmed** (nothing Confirmed pre-prototype).
5. **Measurable Spec Sheet** ✅ — `SPEC.md`: content counts, light/survival numbers, world/tide, tech/perf targets, movement — all tunable placeholders for the slice to vote on.
6. **Reduce AI-fingerprint styling / tighten prose** 🟡 incremental (ongoing as modules extract).
7. **MP conservatism** ✅ captured — `SPEC.md §6`: build **SP → co-op → dedicated → PvP**, prove sim solo first, keep toggle-stubs.
8. **Full playthrough** ✅ — `PLAYTHROUGH.md` (intro → all biomes → endgame+), doubling as a design stress-test.
> **Guiding tension (review's core note): the risk is scope, not creativity.** Hold the vertical-slice discipline; prove the core loop before expanding. Vision stays intact; revisions target *production discipline*.
