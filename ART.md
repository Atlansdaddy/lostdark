# wAIver — Art Bible

> The visual identity. Cross-refs: lighting tech = `GDD.md §5j` / `RESEARCH_lighting.md`; orb expression = `GDD.md §5h` / `RESEARCH_orb_life.md`; biome fiction = `NARRATIVE.md`.
> **North star:** *"A world carved from black, drawn back into being by light."* Voxel **form**, cinematic **light**.
> Touchstones: **Teardown** (voxel + real light) · **Rez / Thumper** (neon geometric glow + pulse) · **Journey / Ori** (emotion through light; the orb ≈ Ori's *Sein*) · **Resogun / Dome Keeper** (clean stylized voxel) · **INSIDE / Limbo** (dark mood on a budget).

## 1. Look pillars
1. **Near-black canvas.** The default is darkness. Against black, one tuned emissive reads gorgeous — so spend the budget on the hero light (the orb), not on filling the frame.
2. **Light is the only color that matters.** Form, mood, danger, and beauty are all told in light. Surfaces are mostly dark until lit.
3. **Crisp emissive edges (the Geometry-Dash DNA, in 3D).** Rim-lit glowing boundaries define form by *light*, not texture. Clean lines, high contrast — the 2D `waiver`'s glowing-outline look, volumetric.
4. **Stylized, never photoreal.** Exaggerated, expressive light out-emotes realism (Journey/Ori/Firewatch). Chase contrast and feeling, not accuracy.
5. **Voxel form, fine grain.** Voxels are honest (destructibility + flood-fill GI) but *finer than Minecraft* + smart lighting → premium, not crude. The blockiness is a texture, not the point; darkness hides most of it anyway.
6. **The orb is the most beautiful thing on screen** — highest fidelity, softest glow, richest animation. Everything else is the stage.
7. **The orb's mood paints the world** (two-axis model, §7) — its emotion literally colors the surrounding voxels via the light system.

## 2. Render look (how it's achieved — cross-ref §5j)
- **HDR + selective bloom + ACES tone-map**, exposure pulled *down* globally so emissives punch through a dark frame.
- **Voxel flood-fill GI** → soft colored bounce (built light spreads warm color into the dark).
- **Volumetric god-rays + fog** (half-res, blue-noise) for atmosphere and to hide the world beyond the lit bubble.
- **Emissive rim/edge lighting** on material boundaries (the clean-lines look).
- **Signature screen-space FX:** caustics, refraction + chromatic dispersion, heat-haze — the "prettiest stuff is the cheap stuff."
- **No flat ambient fill.** If it isn't lit by something (orb, built light, emissive flora, a source), it's near-black.

## 3. The orb — visual language (cross-ref §5h)
- **Form:** a small geometric orb with a soft halo; a dark core inside a bright aura (you read the *light*, not a surface). Never a face, never limbs.
- **✅ CONFIRMED (slice, 2026-07-03):** core = **satin reflective black** (near-black clearcoat, broad soft reflections + slight gloss — not chrome), light lives entirely in the aura layers (rim glow + wide soft halo). The aura breathes/surges; the body stays still and dark.
- **Aura = body language:** brightness = valence, saturation + pulse-rate = arousal. Warm+bright = safe/content; cool+dim = afraid/hurt; red-vibrating = hot; blue-shivering = cold.
- **Motion is character:** easing not linear; an irregular "breath" pulse (never perfectly periodic); secondary trailing wake; anticipation micro-tells; lean toward what it's curious about.
- **The light-trail wake** it leaves is both signature and function (marks where you've been).
- **Casts real colored light** on nearby voxels — so a frightened orb turns the cave cold blue; a joyful one floods it warm gold.

## 4. Per-biome palette & light-ecology
Each biome is a distinct palette + light-source set + signature FX + mood. (Fiction: `NARRATIVE.md`.)

| Biome | Palette | Key light sources | Signature FX | Mood |
|---|---|---|---|---|
| 🍄 **The Reek** | soft teal + violet bio-glow, warm amber pockets | glowcaps, pulse-fungus, biolum. pools | drifting spore-motes; glowing volumetric **reek-mist** | dreamy, gentle, alive |
| 🧊 **The Bite** | blue-white + slow **aurora** color overhead | aurora sky, chillbloom, deepglow moss | ice **refraction** (light throws fractured copies), frost, breath-fog | breathtaking, still, lonely |
| 🌊 **The Drown** | deep navy → teal, bent **gold light-shafts** | kelp-lanterns, lantern-moss, unreachable surface ceiling | **caustics**, light-bending/refraction, reflective pools, bubbles | weightless, gorgeous, held-breath |
| 🌋 **The Sear** | molten orange/red on black, grey ash | lava, embervine, fire | **heat-haze** shimmer, emissive lava, sparks, ash-snow | volatile, gleeful, aching |
| 💎 **The Glare** | blinding white + **prism rainbow** splits, cold-bright | multiplied/reflected light itself, kindlequartz | **dispersion/refraction**, mirrors, glare-washout, chromatic | dazzling, treacherous, fun |
| 🏚️ **The Fade** | grey ash-dusk, dying **amber** beacons, electric **blue-white** | guttering beacons, sparkmoss, live arcs | **electric arcs/crackle**, flicker/fade, dust | melancholy, tender |
| 🕳️ **The Nothing** | near-total black → the **orb's light only** → climactic bright bloom | *you* (+ faint far glimmers) | void that **eats light**; the **ignite / creation** burst at the climax | awe, dread → wonder |

## 5. Color & emotion rules
- **Warm hue + high glow = safe/alive/social; cool + dim = threatened/cold/lonely.** Temperature is the safety signal.
- **Never color alone** — co-encode state with motion/shape/pulse (colorblind-safe; the research is explicit).
- **Contrast is the composition** — a single warm light in a cold dark frame is the whole shot.

## 6. UI / HUD
- **Minimal, diegetic, light-based.** Lumen/energy read on the orb itself (aura, an energy arc) where possible, not a busy HUD.
- Build/UI elements glow like everything else; menus are dark with emissive accents. No opaque game-y panels fighting the mood.
- Wayfinding is your own built light + the ping-minimap, not an overlay map (cross-ref §5e nav).

## 7. Prototype note — the "look test" comes early
A **look test** (one lit voxel room + the orb + bloom/GI/volumetrics + one biome palette) is **cheap and high-signal** — it tells you fast whether "voxel form, cinematic light" actually sings before committing. Fold it into the vertical-slice greybox (dev sandbox, §8c) as an early milestone: *does a dark voxel room with a glowing orb feel premium or crude?* Answer that before scaling content.

## 8. Open (art direction — John's to steer)
- Exact voxel grain (how fine) · degree of stylization · biome palette tuning · 2D-UI vs fully-diegetic. All settle against the look test.

**Decisions (art round, 2026-07-03):**
- **Flora/creatures = HYBRID ✅** — voxel world (destructible, honest), **smooth organic meshes for living things** (flora, enemies, the Ember). *Life has a different geometry than dead matter.*
- **Emissive rim-edges = SUBTLE ✅** — faint bright edge where lit surfaces meet darkness; neon accents reserved for special materials (crystal, Keeper-tech). Not the full outline look.
- **Voxel grain → BLOCKY + PREMIUM TEXTURING ✅ (John, 2026-07-03, after testing both)** — the surface-nets smooth terrain was built and play-tested same day; the extracted skin read as "tunnels", ground layers mismatched, flora seating broke. **John's verdict: blocky voxels with really good procedural texturing beat a bad smooth mesh.** Smooth path kept behind `waiver.smooth(true)` for a future refinement round (needs: thicker density support, layer-consistent extraction, proper flora seating) — not the default. Lesson: test the flashy direction cheap and early; the benchmark did its job.
- **Glowcap behavior = PHOSPHORESCENT ✅ (John, 2026-07-03)** — caps work like glow-in-the-dark paint: **light exposure charges them** (orb proximity slowly; the pulse strongly), they then glow bright and **decay slowly** — so pulsing through a grove paints a lit path to travel by. Perception literally leaves light behind.
- **Slice milestone order ✅:** (1) Reek-mist volumetrics → (2) orb life pass → (3) real Reek flora → then grain benchmark + next set.
