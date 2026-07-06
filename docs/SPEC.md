# wAIver — Spec Sheet (measurable targets)

> Companion to `GDD.md`. **Every number here is a tunable starting hypothesis to be proven or adjusted in the vertical slice — not a commitment.** Numbers exist so the game becomes *measurable*; the prototype gets a vote.
>
> **Implementation ladder (per the review):** each technical choice is tagged
> **[Goal]** (the intent, locked) · **[Possible]** (options on the table) · **[Preferred]** (current lean) · **[Confirmed]** (proven in code — none yet, pre-prototype).
> Design *intent* is committed; *implementation* stays loose until the slice votes.

## 1. Content counts (v1 target)
| Thing | v1 target | Full/roadmap | Notes |
|---|---|---|---|
| Biomes | **5** | 7 + stub-for-more | v1: Reek·Bite·Drown·Sear·Nothing (Fade/Glare post-launch; Fade may pull into v1 for story) |
| Depth bands / biome | 3 | up to 3–4 | content = biomes × bands (multiplicative) |
| Wave/energy elements (wielded) | 4 (MVP quartet) | 6–8 | Pressure·Light·Heat·Sound (+Water, +Electricity, +vapor, +dark) |
| Material elements (built with) | ~7 | 10–14 | metal·wood·glass·sand·dirt·ice·crystal (+stone, +biome-natives) |
| Enemy archetypes (shared) | 8 | 8 | Drainer·Swarm·Lure·Stalker·Controller·Bruiser·Breacher·Apex |
| Enemies per biome | 3–4 + 1 apex | same | ~30–35 distinct across the full 7 |
| Bosses / apexes | 5 | 7 + finale | 1 per biome; The Nothing = inverted finale |
| Primary powers taught | 5 (1/biome) | 7 | biome-ushered; diegetically taught |
| Movement moves | ~5 | ~8 | hover-glide base + wave-jump·dash·flight·recoil·grapple (earned) |
| Crafting / material tiers | ~4 | 6–8 | ≈ depth bands; tier N wards need tier N-1 material |
| Buildable defense types | ~4 | 8+ | wall·anchor/ward·beacon·bastion-core (+separation pieces) |

## 2. Light & survival (the core numbers)
| Spec | Target (placeholder) | Ladder |
|---|---|---|
| Lumen (life) max | 100 | [Goal] stat exists; value TBD |
| Free baseline sight radius (never blind) | ~4–6 voxels | [Preferred] |
| Manual pulse reveal radius | ~30–60 voxels (scales w/ upgrade) | [Preferred] |
| Ambient auto-pulse cadence | ~1.6 s (carried from 2D) | [Preferred] |
| Manual pulse energy cost | ~10–15 energy | [Goal] costs energy |
| Energy pool max / regen (lit) | 100 / ~15/s | [Preferred] |
| Lumen drain in full dark | ~2–4 /s (→ health when empty) | [Goal] dark kills; rate TBD |
| Built-light (beacon) radius | ~16–24 voxels | [Preferred] |
| Ward/anchor field radius | ~24–40 voxels (volumetric, occluded) | [Preferred] |
| Darkness reclaim rate (unlit ground) | slow: minutes; scales by biome/depth | [Goal] |
| Health | ~5 (i-frames on hit) | [Preferred] carried from 2D |

## 3. World, tides & difficulty
| Spec | Target | Ladder |
|---|---|---|
| Difficulty formula | **depth × distance-from-first-light** | [Goal] |
| Depth bands (full game) | 6–8 | [Preferred] |
| Dark Tide intensity tiers | 1–6 (map to depth band) | [Goal] scales; curve TBD |
| Tide cadence | periodic + escalating; gentle→catastrophic | [Goal] |
| World extent | effectively infinite (streamed) | [Goal] |
| Persistence | far chunks → IndexedDB | [Preferred] |

## 4. Tech & performance targets
| Spec | Target | Ladder |
|---|---|---|
| FPS target | 60 PC / **≥30 mid-range phone (hard gate)** | [Goal] |
| Chunk size | 32³ voxels | [Possible] 16³ vs 32³ · [Preferred] 32³ (fewer draw calls) |
| Render radius | ~6 chunks PC / ~4 mobile | [Preferred] (dark hides the edge) |
| Sim radius (physics/reactions) | ~3 chunks PC / ~2 mobile | [Preferred] |
| Element/physics sim tick | ~20–30 Hz (decoupled from render) | [Preferred] |
| Renderer | WebGPU + WebGL2 fallback + TSL | [Preferred] (see §5j) |
| Lighting GI | voxel flood-fill (WebGL2) → VCT/3D-RC (WebGPU) | [Preferred] |
| Physics lib | rapier / cannon / custom voxel | [Possible] |
| Meshing | greedy, off-main-thread (workers) | [Preferred] |
| Netcode | authoritative server + AOI (lit-bubble) sync | [Preferred] |
| Player count | 2–8 (co-op → small server) | [Goal] |

## 5. Movement (placeholders, tune for feel)
| Spec | Target | Ladder |
|---|---|---|
| Orb glide speed | tune to "readable in the dark" | [Goal] hover-glide, snappy+momentum |
| Dash speed / duration / cost | ~140 / 0.12 s / ~20 energy (from 2D) | [Preferred] |
| Wave-jump count / cost | up to 3, diminishing, energy-gated | [Preferred] |
| Flight / big moves | earned + costly (drain/charges) | [Goal] never a "skip survival" button |

## 6. Build order gate (the discipline)
- **Hard gate before scope expands:** the vertical slice (The Reek MVP + dev sandbox) runs **≥30 fps on a mid-range phone** with the core loop fun. [Goal]
- Graceful degradation on weak devices: cap concurrent reactions + lighting fidelity; never break the rules. [Goal]
- Prove SP sim first → co-op → dedicated → PvP (build in that order; keep toggle-stubs). [Goal]
