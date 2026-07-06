# Research — Making the Light-Orb Feel Alive & Loved (wAIver 3D)

> Web research synthesis. Cited sources in the full brief. Feeds GDD §5h (orb life & feel). Companion to `GDD.md`.
> **The orb has no face/limbs → every expressive channel re-routes into SIX carriers: motion path · glow/brightness · color · pulse/rhythm · particle/aura · sound.**

## The two findings that change everything
1. **Animacy bias is hardwired.** Humans involuntarily read life/intention into moving, pulsing light — we unconsciously interpret an irregular wave-like pulse as "breathing/dancing." The orb is already pushing a reflex the brain can't resist; the craft is *tuning* it. Aliveness is very achievable.
2. **Believability = HOW motion executes, not WHICH gesture.** In study, people couldn't tell "genuine" from "acted" idle motion above chance (53.7%) — what sold it was smooth acceleration curves & natural velocity, not readable poses. → **Build emotion as a physics-and-curves system (easing, squash/stretch, anticipation, secondary motion), NOT a library of canned poses.** Spend loudly on a few legible states; spend quietly-but-constantly on the micro-motion substrate beneath them. *The loud cues earn recognition; the quiet ones earn love.*

## Build order (prioritized)
1. **Nail the resting "breath" FIRST** — slow brightness/scale pulse (~4–8s, human-breath-like) with **irregular, non-repeating** variation + tiny positional drift/bob. This is the baseline that reads "alive vs asset." Everything else modulates it. (A *perfect* sine = machine.)
2. **Motion feel = character** — route ALL locomotion through easing curves, never linear. The orb's weight/temperament live entirely in accel/decel & overshoot.
3. **One dominant emotional variable per state** — keep states legible; layer subtleties *under*, don't compete.
4. **Color = mood dial; pulse-rate = arousal dial** (two-axis model below).
5. **Voice with a grammar, not random blips** — Journey sorted vocals into ~16 intent categories so entities "seemed halfway intelligent." Random = machine; categorized = mind.
6. **Juice the WORLD's response to the orb**, not just the orb — attachment is contextual (Companion Cube).

## The two-axis light-mood model (the orb's body language)
- **Brightness = valence** (happy↔sad) · **saturation + pulse-rate = arousal** (calm↔intense). Continuous emotional space, not just discrete states.
- **Temperature = safety signal:** warm hue + high glow = safe/alive/social; cool + dim = threatened/cold/lonely.
- **⭐ The orb is a LIGHT SOURCE — its mood PAINTS the voxel world around it** (via the flood-fill GI, §5j). Frightened orb → the whole cave goes cold blue. This is a huge, on-theme, underused channel — the orb's emotion literally colors the environment.
- **Stylized/exaggerated light beats realism for emotion** — chase expressive contrast, not physical accuracy (voxel + stylized bloom is ideal).
- Directional valence (robotics): **up/toward = positive** (curious/happy), **down/away = negative** (sad/afraid).

## CONSPICUOUS cues (player consciously reads as emotion) — state gestalts
| State | Color | Glow | Pulse | Aura/silhouette | Particle | Motion |
|---|---|---|---|---|---|---|
| Calm/content | warm amber/gold | soft steady | slow even | smooth round | drifting motes | slow arcs, gentle bob |
| Joy/discovery | bright cyan/white | swelling bloom | up-tempo | expanding halo | upward spark burst | rises, happy darts |
| Fear | cool blue | dim contracted | fast shallow | tight, trembling | inward-pulled | retreats, shrinks, low |
| Pain/damage | hot red→grey | flicker/stutter | erratic spiking | jagged/fraying | sputtering embers | recoil, wobble, squash |
| Cold (The Bite) | pale blue-white | dimmed | very slow | crystalline/frosting | frozen, still | sluggish, sinking |
| Heat/anger (The Sear) | saturated red-orange | intense flaring | hard throb | spiky flare | radiating flecks | aggressive, sharp |
Grounding: warm colors raise arousal/urgency, cool colors calm; brightness→valence, saturation→arousal; deep-red = high-arousal negative; lower-saturation = "draining/hurt." Co-encode with motion/shape (colorblind safety) — never color alone.

## INCONSPICUOUS cues (the real attachment engine — felt, not noticed)
- **Idle breathing with imperfection** — brightness+scale pulse w/ jitter + slow drift; slight pauses break monotony; **never perfectly periodic.**
- **Secondary/overlapping motion** — an aura/tail/particle wake that lags & settles after the core stops (Journey's scarf); an inner core that shifts slightly inside the outer glow.
- **Kinematic smoothness > readable gesture** — engineer smooth easing/accel/velocity, not "cute" canned gestures.
- **Anticipation micro-tells** — ~100–200ms dip/wind-up before a dash/action → the orb *intends*; players subconsciously predict it.
- **Gaze proxy via lean/elongation** — no head, so lean/stretch direction + where the aura brightens = its attention; players track "what it's looking at." Lean-toward = curiosity, lean-away = wariness.
- **Tiny reactive twitches** — faint flinch at loud sound, small brighten near light, drift toward warmth.
- **Imperfection tells** — uneven pulse, a personality "hitch," a preferred idle drift direction.
- **Subliminal audio** — a quiet hum that warms/brightens in tone near safety/warmth/companions (Journey's harp-only-when-near bonds "without players noticing").
- **Heartbeat entrainment** — a calm regular pulse (visual/haptic rumble) can entrain the player's own physiology; tie controller rumble to the orb's pulse in tense moments.

## Case studies (mine for technique)
- **Ori's Sein** = literally "a sentient orb of light," read through color changes + dynamic animations — the closest existing character to wAIver's orb. Proof it works.
- **Journey** — the scarf (secondary-motion expressiveness + energy meter), the chirp (1-button voice, press-length = coo/chirp/call/shout, harmonizes near companions), harp-only-when-near (subliminal bonding), minimalism ("perfect when you can't remove anything else").
- **flOw/Flower** — abstract, faceless, wordless avatars players still bond with via motion/color/flow-pacing. Validates wAIver's geometric approach.
- **Companion Cube** — attachment from context/framing (world calls it "your friend"), forced interaction, isolating environment. Zero animation, still loved → **a lonely hostile world that makes the orb matter does half the bonding.**
- **BD-1/WALL-E** — expressiveness via motion + Ben Burtt's beeps only; up/toward motion = positive valence.
- **Rez/Thumper** — rhythm + reactive particles = perceived vitality from pure geometry; quantize light-pulse/particle/sound to one clock.
- **LocoRoco/Slime Rancher** — squishy deformable squash/stretch + cute non-verbal voice.

## Game feel / juice (for the orb)
Responsiveness IS the orb's soul — **input lag reads as lifelessness** no matter how pretty. Vlambeer toolkit adapted: brief screen shake on impact, the "hold"/hit-stop, particles on collisions, easing over linear, screen-flash/bloom-spike/chromatic wobble on hurt, audio-visual coupling. **Caution:** wAIver is contemplative survival — dial screenshake DOWN, lean on glow/particle feedback; over-juicing fights the tone.

## Sound for a wordless character
Small grammar-based vocabulary (curious-lilt, content-hum, alarm-chirp, hurt-whimper, joyful-trill) each with pitch variants; layer organic + musical (pure synth = robotic); tie pitch/timbre of the constant hum to mood; quantize to a rhythmic clock (light+particle+sound fire together = one living thing); let the orb's state nudge the adaptive score.

## Pitfalls
Linear motion/no easing · perfectly periodic pulse · all channels screaming at once (one dominant/state) · random vocalizations · input lag · over-juicing a contemplative game · color-alone (colorblind) · neglecting context (world must treat orb as significant) · chasing photorealistic light (stylized wins).

## Sources
Disney 12 principles (Wikipedia/NYFA/CreativeBloq/Adobe/IxDF) · easing (CGWire/Animation Mentor) · Journey (Wikipedia/Grokipedia/Game Developer sound-design & Chen goals) · flOw/Flower (Game Developer/Wikipedia) · Ori & Sein (namu.wiki/Fandom) · Companion Cube (Wikipedia/Oreate) · BD-1 (Game Informer) · low-DOF robot emotion (arXiv 2605.12786) · Rez (Wikipedia/Rolling Stone) · Game Feel (Wikipedia/gamedesignskills) · Vlambeer juice (Engineering-of-Conscious-Experience/GameAnalytics/Game Developer) · idle animation (MoCap Online) · idle believability study (arXiv 2509.05023) · color psychology (Cutting Edger/Byard/Psych Today/arXiv 1701.06412/PMC8481791) · animacy of blinking light (Alibaba insights) · haptic animacy/heartbeat (arXiv 2602.07395) · visual language (Sandboxr/iXie/RMCAD).
