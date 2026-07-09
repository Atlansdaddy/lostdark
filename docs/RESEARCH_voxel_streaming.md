# Research — Streaming Infinite Voxel Worlds + Lighting Without Eating Shit (for wAIver)

> Deep-research synthesis (2026-07-08, 104-agent verified sweep: 22 sources → 109 claims → 25 adversarially verified, 24 confirmed / 1 refuted). Feeds the worldlab (`web/src/worldlab/`) and GDD §5e/§5f. Companion to `RESEARCH_world_structure.md`.

**Framing (John):** the question is not LOD — it's how shipped engines structure infinite/huge chunked worlds and light them incrementally. Findings below are ordered that way. Confidence tags are from the adversarial verify pass.

## The convergent architecture (what everyone who shipped actually does)

1. **Heavy chunk work goes off the main thread.** [HIGH] Veloren siphons meshing to a worker pool ("so the render thread never stalls"); voxel.js learned it the hard way (~500ms/chunk main-thread stall, fixed with a Web Worker returning **transferable ArrayBuffers** — transfer, don't clone). → Our path: generate+mesh in Workers once the lab's single-thread ceiling is actually hit; the mesher already emits plain typed arrays, which is worker-shaped.
2. **Main-thread lifecycle = explicit state queues under hard ms budgets.** [MED, code-verified] noa-engine (powers bloxd.io, shipped browser Minecraft Classic) runs request → pending → mesh → remove queues, time-sliced at **5ms/tick + 3ms/render** via `performance.now()` loops. → This is exactly the worldlab ChunkManager's ring ladder + budget; our 6ms default is in the right family. Note: budgets are soft — one expensive op overshoots, which is why per-task cost (meshing) had to come down.
3. **Compact geometry: greedy meshing + baked AO + packed vertices** is the shipped-web consensus (noa: greedy mesher descended from 0fps, AO packed 2 bits/corner into a Uint8; Veloren: 8 bytes/vertex total). [HIGH] **BUT** a verified contrarian point survives: with per-vertex AO/light variance, greedy merging saves little and can cost more to compute (playspacefarer; the caveats note no measured tradeoff survived verification). → Our mesher bakes per-vertex AO *and* smooth light, which blocks naive greedy merges. Verdict for us: slab-copy optimization first (done — 5.6×), greedy only if profiling still demands it, vertex packing when memory pressure says so.
4. **Budgets are smaller than desktop intuition.** [HIGH] noa ships 24-voxel chunks at **add-distance 2** (remove 3) — a ~48m loaded radius, with horizontal/vertical distances separately configurable. Distant Horizons (desktop!) hits its ceiling near 512 chunks on RAM/GPU. **The practitioner ceiling is memory, not draw calls.** → For the S24: full-detail radius ~3–6 chunks (at 32³) is the evidence-consistent band (synthesis inference, not a measured mobile number). Darkness makes this fine.

## LOD: mostly a no for wAIver

- LOD machinery is well understood — DH's distance-banded quadtree of simplified "fake" far terrain; godot_voxel's octree of parented grids (blocks 2× children's size per level); Voxel Farm 3D clipmaps (concentric rings, ~constant data per ring). [HIGH]
- **godot_voxel's docs say it outright: more LOD levels only buy view distance, never near-field sharpness.** [HIGH] LOD is a view-distance lever; wAIver's fog/darkness caps view distance by design. State-of-the-art SVDAG streaming (Aokana 2025) treats fog-limited loading as the baseline it replaces — and doesn't support runtime voxel edits at all, so that whole branch is out for a destructible world. [MED]
- Seam handling, if we ever add one far ring: Transvoxel-style stitching matters only for smooth isosurface terrain; **overlap/skirts** is the cheap, worker-friendly, blocky-compatible option (2-1 vote: doesn't fully kill popping/z-fighting). [MED]
- **Decision: no LOD system.** Short full-detail ring + fog wall; at most one cheap low-res far shell later if a vista moment ever demands it.

## Lighting (the "without eating shit" part) — stage-4 blueprint

- **Incremental BFS flood fill over a FIFO queue is the settled algorithm.** [HIGH] Seed sources, pop nodes, update 6-neighbours. The termination rule that keeps floods LOCAL: only update a neighbour whose level is ≥2 less than current, setting it to current−1. Never reflood already-lit voxels. Naive per-level full-chunk passes are far too slow (that's ~what our LightGrid global reflood does today).
- **Two separate channels, Minecraft-style: sky light and block light.** [HIGH] Time-of-day/ambient darkness then becomes a render-time dial (shader), never a voxel relight. → For wAIver: "the dark rises" moments (Dark Tide!) can be shader-side on the sky channel — zero relight cost.
- **Baked flood light is nearly free at runtime.** [MED] Propagation only runs on light add/remove or nearby edits; many static lights (our groves, crystals, wards) cost ~nothing per frame, no shadow maps, and light naturally rounds corners.
- **Removal is the tricky half:** a second BFS whose nodes carry the removed value — lower-lit neighbours are zeroed + enqueued for removal; equal-or-brighter neighbours go onto the propagation queue and refill after removal completes. [MED]
- **Cross-border propagation: queue nodes carry a chunk reference; at an edge (x−1 == −1) redirect into the neighbour chunk. THE classic bug — the one John hit as "orb light on the next floor over" — is emplacing the new node with the WRONG chunk's reference, so the flood writes through the wrong chunk's coordinate space.** [MED] This requires neighbours loaded before lighting finalizes — which is exactly why the ring ladder orders Lit after neighbours' generation.

## Refuted / gaps (don't cite these)

- ✗ Veloren LZ4 chunk compression "~300KB → a tenth" — refuted 0-3. Don't quote chunk-compression numbers from this sweep.
- Gaps: nothing survived on Minecraft's ticket-ladder internals, Minetest, Divine Voxel Engine, Teardown, IndexedDB persistence patterns, or measured mobile-web fps-vs-radius budgets. The S24 radius/draw-call budget is OURS to measure — the worldlab's R±/HUD exists for exactly this.

## What the lab has already confirmed/applied (2026-07-08)

- Ring ladder + budget queue (= noa's pattern, independently converged): headless invariant suite passes (ladder/ownership/bounded/converge/determinism/mesher-swap).
- Slab-copy mesher port: string-keyed map lookups were ~80% of mesh cost — 57 → 10.1ms/column blocky, bit-identical output (golden-hash verified). Same trick was already in SmoothMesher.
- Surface-nets winding bug found & fixed at source (terrain invisible under front-face culling; latent in the game's own smooth toggle).
- One merged mesh per column (draw calls ÷3). John's fog-wall lock: visible radius a ring or two inside mesh radius — phone-verified "feels totally endless."

## Sources

Veloren devblog-69 · voxel-clientmc #8 · noa-engine (fenomas) repo+issues · 0fps.net (meshing pts 1–2, AO, voxel lighting, blocky LOD — Lysenko) · Seed of Andromeda flood-fill pt 1 (via mirror; TLS-rotted) · notverymoe SoA gems · PaperMC Starlight TECHNICAL_DETAILS · godot_voxel smooth-terrain docs · Distant Horizons (CurseForge) · Voxel Farm clipmaps (Cepero 2011) · Aokana (arXiv 2505.02017) · playspacefarer voxel-meshing · Drovolon Minecraft chunk-ticket gist · minecraft.wiki · voxel.js retrospective (deathcap).
