# Research — Real-Time Lighting for wAIver 3D (make-or-break graphical system)

> Web research synthesis. Cited sources at bottom of each section. Feeds GDD §5j (lighting) + §5f (tech). Companion to `GDD.md`.
> **Core insight:** build a **light-driven, not geometry-driven renderer** — the light (a voxel flood-fill grid) tells you what's visible; shade *outward from lights* into the dark. That inversion is what lets a browser run this, and it IS the game's thesis as an architecture.

## TL;DR — Recommended lighting stack (two horizons)
Ship the **WebGL2 stack now**; author in **TSL** so the **WebGPU GI layer** drops in later without a rewrite.

**Phase 1 — WebGL2 baseline (ship this):**
1. **Clustered forward+ shading** for many small dynamic lights — the single biggest lever (naive three.js forward caps ~30–50 lights; clustered demos hit 2100 @ 60fps). Keeps transparency/MSAA/emissive (deferred kills those).
2. **Voxel flood-fill light propagation** (Minecraft-style, CPU/worker-side) = the cheap, **destructible-safe** GI workhorse. Because the world IS a voxel grid, colored bounce-like light spread is nearly free and re-floods only dirty regions on edits. This alone sells "built light holds back the dark."
3. **HDR + selective bloom + ACES tone mapping** — non-negotiable for a "you are a glowing orb" game. Emissives (`emissiveIntensity>1`) punch through a threshold bloom; ACES keeps light cores saturated instead of clipping white. Tone-map LAST.
4. **Raymarched volumetric light** at half-res + blue-noise dithering (~50 steps not 250) — god-rays/fog in the dark. Shadow only 1–3 hero lights (orb + key beacons); unshadowed cones near-free.
5. **Signature effects = screen-space passes** (cheap, reuse framebuffer): caustics (drei `Caustics`), refraction + chromatic dispersion (`MeshPhysicalMaterial.dispersion` r164+ / `MeshTransmissionMaterial`), heat-haze (one screen-space UV-distortion pass — reuse it for heat, fire, water, aura wobble).
6. **Render only the lit bubble** — light-cull: skip chunks that receive zero light. Darkness = the occlusion/LOD system.

**Phase 2 — WebGPU GI upgrade (when you can require it):** WebGPURenderer + TSL, then **voxel cone tracing** or **3D radiance cascades** for true dynamic bounce GI — both natural fits for a voxel world; Teardown proves the approach in real time.

**Teardown's recipe to copy (WebGPU):** don't light per-emissive-voxel; place explicit lights + a global 1-bit shadow volume for occlusion; lean on **temporal accumulation + blue noise** → ~1–2 rays/pixel that look clean.

## 1. Many dynamic lights
Naive forward (three.js default) caps ~30–50 lights. **Clustered forward+** (frustum split into 3D cells, each fragment iterates only its cell's lights) is the pick — keeps transparency/MSAA/emissive that deferred breaks. Layered light strategy:
- **Tier 0 hero (real shadows):** orb + 1–3 near beacons → full clustered + shadowed volumetrics.
- **Tier 1 many local (no shadows):** flora/fire/beacons → clustered point lights, tight radii (tight radius = few clusters = cheap; hundreds feasible).
- **Tier 2 ambient bounce:** the voxel flood-fill grid (texture lookup, ~free).
- **Tier 3 far/decorative:** additive emissive billboards + bloom, no shading.
Dark world helps: small-radius light in a black scene touches few clusters; most of screen has zero light.

## 2. Dynamic GI (ranked by web-feasibility)
- **A. Voxel flood-fill propagation — DO FIRST** (WebGL2, cheap, destructible-safe). Minecraft model: emitters seed a BFS decrementing per step → soft colored falloff; re-flood dirty region in a Worker; upload as 3D texture. The GI workhorse.
- **B. Baked lightmaps — REJECT** for gameplay geo (breaks on first dig). Immutable backdrops only.
- **C. Voxel Cone Tracing — marquee upgrade, WebGPU-preferred** (voxelize → mip pyramid → cone-trace for diffuse bounce+AO). WebGL2 proof exists (novalain/gi-voxels) but painful (no compute); clean on WebGPU. The Teardown-adjacent fit for a voxel world.
- **D. Radiance Cascades — exciting newcomer** (PoE2 shipped it). Noiseless, cost independent of light count. 2D RC browser-viable today; **3D RC experimental** (three-rc, Holographic RC) — watch for 12–18mo; rings around lights (needs bilinear fix).
- **E. SSGI — cheap finishing layer**, not a base (misses off-screen light). Great in dark scenes (orb lights wall → bounce to floor). WebGPU/TSL demos exist.
- **F. LPV / SDFGI — mostly skip** (flood-fill grid gives 80% for a voxel game).
Teardown breakdown: 1-bit volumetric shadow map of whole level + explicit lights + 2 AO samples + 1 shadow ray/light/pixel + spiral-blur denoise + 4× temporal = clean GI from ~1–2 rays/px.

## 3. Volumetrics (darkness makes them cheaper — short march)
Raymarched post-process: reconstruct world-pos from depth, march ray, accumulate in-scatter w/ shadow test. Blue-noise dithering: 250→~50 steps no quality loss; half-res then upscale; Henyey-Greenstein phase + Beer's law + FBM noise. Shadow only orb + 1–2 hero beacons (each shadowed light = own render). Cheaper fakes: additive cone meshes, radial-blur light-scatter. Fog also hides pop-in beyond the bubble (Enshrouded/Silent Hill trick).

## 4. Emissive + bloom (cheapest high-impact win; non-negotiable for the orb)
HDR render target → emissives `emissiveIntensity`≫1 → **selective bloom** (pmndrs `postprocessing` `SelectiveBloomEffect`, not hand-rolled layers) → **ACES Filmic** tone map LAST (`toneMappingExposure` low globally, emissives punch through). Orb aura = soft additive glow billboard + threshold bloom; pulse `emissiveIntensity` with a sine for living light. Dark scene = smaller/cheaper bloom kernel still reads dramatic. Prefer pmndrs `postprocessing` (merges passes).

## 5. Signature effects (all screen-space, cheap, darkness-friendly)
- **Water caustics:** surface normals → screen-space refracted-ray convergence (`dFdx/dFdy`) + chromatic offset. Use drei `Caustics`. Animate normals for dancing pools (the orb's projected reflective pools).
- **Refraction + chromatic dispersion:** `MeshPhysicalMaterial.dispersion` (r164+) for cheap wavelength split; `MeshTransmissionMaterial` (drei) for thick glass/crystal (transmission/IOR/`chromaticAberration`). Each transmissive object = one scene render → keep crystals few & hero.
- **Crystal:** MeshPhysicalMaterial (transmission+dispersion+IOR~2.4) + local CubeCamera env map → crystal acts as a lens splitting the orb's light.
- **Heat-haze/thermal shimmer:** screen-space UV distortion (scrolling noise masked to hot regions). Cheapest of all; build ONE distortion pass, reuse for heat/fire/water/aura.

## 6. WebGL2 vs WebGPU (mid-2026)
WebGPU ~95% support (Chrome/Edge/Firefox/Safari incl iOS); ~5% fall back to WebGL2. WebGL2 compute is dead. WebGPU unlocks compute (clean VCT, GPU voxelization/flood-fill, 1M+ particles vs ~50k, 2–10× draw calls) + path to HW ray tracing. **TSL (Three Shading Language)** = author shaders once in JS → compile to WGSL + GLSL. **Strategy: target WebGPURenderer with WebGL2 fallback from day one; keep Phase-1 techniques in the WebGL2 subset (everyone gets a great game); gate heavy GI (VCT/3D RC/compute) behind WebGPU as a quality tier.**

## 7. The dark-scene advantage (architect around it)
- **Render only the lit bubble** — light-cull chunks at light-level 0; darkness = occlusion/LOD.
- Short sightlines → cheap volumetrics/reflections (march to visibility edge) → afford higher quality where seen.
- Fewer active lights/frame (light doesn't travel far) → clustered pays only for near lights.
- Contrast does art direction free — one tuned emissive+bloom on black reads gorgeous; spend saved budget on the hero orb.
- Temporal accumulation safer in the dark (less disocclusion) → clean GI from few rays.
- **Renderer is light-driven, not geometry-driven:** the flood-fill grid says what's visible; shade outward from lights.

## Cross-platform / mobile fit (ties to GDD §5f)
WebGL2 baseline = great game for the 5% + mobile stability; heavy GI gated behind WebGPU as a tier. **Mobile thermal/memory:** expose a quality tier that drops volumetrics + shrinks bloom (fat HDR target + many fullscreen passes overheat phones). This is exactly the device-tier scaling the cross-platform requirement needs.

## Pitfalls / web gotchas
three.js built-in lighting won't scale (add clustered forward+) · deferred fights bloom/glass (fat G-buffer, no MSAA) · baked lightmaps break on destruction · WebGL2 has no compute (VCT hacky/slow — save for WebGPU) · raymarch without depth-stop leaks light through walls · volumetric banding needs blue-noise+jitter · radiance cascades ring + 3D RC still experimental (don't bet core loop on it) · transmission/dispersion each cost a scene render (few hero crystals) · selective bloom is a three.js pain point (use pmndrs) · tone-map LAST or emissives clip white (ACES>Reinhard) · each shadowed volumetric light = own shadow render (shadow 1–3 hero only) · custom raymarch depth defeats early-Z (copy depth at checkpoints) · mobile thermal (expose a tier that drops volumetrics/bloom).

## Key sources
Teardown frame breakdown (acko.net) · Voxagon blog · gi-voxels (WebGL VCT) · radiance cascades (jason.today, 80.lv, Holographic RC arXiv 2505.02041, three-rc) · voxel flood-fill (0fps.net, Seed of Andromeda, Minecraft wiki) · clustered/forward+ (AmanSachan1 2100-lights, YangH34) · Heckel (volumetrics, caustics) · drei MeshTransmissionMaterial/Caustics · MeshPhysicalMaterial.dispersion r164+ · UnrealBloomPass / selective bloom (pmndrs postprocessing) · screen-space distortion (Halladay, Codrops) · WebGPU/TSL (threejsroadmap, utsubo migration guide + 2026 recap).
