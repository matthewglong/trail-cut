# Handoff: Teach the Export Color Pipeline in Code (and Exactly What the Research Proposes)

You are picking up a teaching session with Matthew (creative-director background, LWC/Python dev, novice in video/color but a fast learner who wants atomic first-principles depth). A prior session taught him the *theory* of video color from scratch. **Your job now is to teach (a) what the current export pipeline code actually does, stage by stage, and (b) exactly how `PIPELINE_RESEARCH.md` proposes to change it — grounding every statement in the real code so what he learns is accurate.**

This is a **structured learning walkthrough**, not a bug-hunt or a regression archaeology project. The goal is that Matthew finishes able to make informed ACCEPT/REJECT/DEFER decisions on each research proposal because he understands both the current state and the proposed change at the level of the actual filter strings.

---

## The two symptoms that motivate everything

The export looks wrong compared to the live preview in two specific, observable ways. Keep both as the diagnostic anchors for the whole walkthrough — every concept and proposal should be tied back to which symptom it addresses (or explicitly noted as addressing neither).

1. **The map is off-color in the export** (vs the preview). This is a *color-space* problem. Candidates: the sRGB-EOTF vs BT.709-EOTF transfer-function difference (research §1.2, decision A2); whether primaries (`p=`) are correctly threaded through every zscale hop or silently relabeled (research §6); color-tag correctness at each stage; the working-space round-trip (BT.709 → BT.2020 → BT.709).

2. **Edges are blurry in the export** (vs the preview). This is a *resolution / sampling* problem. Candidates: the pixelRatio / supersampling model (research §4.1, decision B1); MapLibre's `antialias: false` default (research §1.8 / §4.2, decision B2); OpenFreeMap sprites being 1× only (research §4.4, decision B3); the chroma-subsampling kernel `f=spline36` (research §3.2, decision A1-kernel).

**Note on dither (A1-dither):** the research doc headlines it as the highest-impact fix, but it only addresses *banding in flat regions* — neither reported symptom. Matthew cannot reproduce banding in real exports, and the doc's "166 → 198 unique codes" claim did not reproduce on a controlled test. Treat A1-dither as DEFERRED/low-priority; do not center the walkthrough on it. (It's a useful illustration of "verify the doc's claims," nothing more.)

Both symptoms are fundamentally about **preview path vs export path divergence**: the same MapLibre canvas pixels are handled by two different code paths (preview in the webview, export through FFmpeg). Where they disagree is where the symptom is born. The "map shared-data contract" memory is directly relevant — any MapSettings-derived map state must live in `src/lib/mapVisuals/` and not as a direct `setPaintProperty`/`setLayoutProperty` in MapView, or the two paths diverge.

`PIPELINE_RESEARCH.md` is the proposal doc. `PIPELINE_DECISIONS.md` is the running decision record — read it; some decisions are already made.

---

## Learning contract (do not violate — this is in his memory and he will stop you if you break it)

- **Atomic first principles.** Define every domain term *before* you use it, with a concrete example. "First principles" to him means "assume zero vocabulary," not "assume basics + explain advanced." If a sentence contains a domain noun he hasn't seen, define it first.
- **One concept per beat, then check in.** Do not stack five concepts and quiz at the end. Teach one thing, verify it landed, proceed. He will say "good next" or ask a question.
- **Quiz him after each concept.** He explicitly asked for this. 2-3 questions, mix recall + application. Grade honestly — point out what's wrong, don't rubber-stamp.
- **He asks excellent lateral questions.** When he does, answer them fully even if it's a detour — those detours are where the real understanding forms. (Last session he re-derived *why* the primaries-conversion matrix must exist, from a good question.)
- **No human work estimates** (hours/days/sprints). Describe complexity by scope/risk/unknowns. The work is done by AI agents.

## What he already knows (DO NOT re-teach — build on it)

He has solid, quizzed understanding of:
1. Pixels as RGB triples; the RGB color cube; why a gradient only uses ~256 steps
2. **Primaries** (sRGB, BT.709, BT.2020), gamut, CIE chromaticity coordinates; that sRGB & BT.709 share primaries
3. **Transfer functions / gamma curves**; why 128 ≠ half-brightness; OETF vs EOTF
4. **Linearization**: why math (blending, scaling, resampling) must happen in linear light; linearize → operate → re-encode
5. **Bit depth** (8/10/float `f32`); bit depth = resolution NOT brightness range; the `255 << 2 = 1020` vs proper-scale-to-1023 gotcha
6. **SDR vs HDR**; nits; dynamic range in stops; **HLG vs PQ** (scene-referred vs display-referred); npl
7. **Quantization & banding**; **dither** (`error_diffusion` vs `ordered` vs `random`); banding risk exists ONLY at the final depth reduction
8. **FFmpeg filter chains**; **zscale** params (`p/t/m/r`, `pin/tin/min/rin`, `d`, `f`, `npl`); `format=`; `setparams=`; the "no path between colorspaces" trap
9. **YUV & the RGB↔YUV matrix** (`m=`); **chroma subsampling** (4:4:4 / 4:2:2 / 4:2:0); pixel-format notation (`gbrpf32le`, `yuva444p10le`, etc.); planar vs packed; endianness
10. **The TWO distinct 3×3 matrices**: RGB↔YUV matrix (`m=`) vs the primaries-conversion / BT.2087 matrix (`p=`→`p=`). He knows the tells.
11. **Cross-format blending** requires linear light; SDR→HDR **conform** (BT.2408, SDR white ≈ 203 nits)
12. **Code values are meaningless without full color-space tags** — why mis-tagging is the bug class behind "export ≠ preview"

There's an interactive tool at `rgb-yuv-lab.html` (repo root) he built that visualizes the RGB↔YUV matrix and primaries coordinates per standard — reference it; it does NOT yet visualize the primaries-conversion matrix.

## Hard constraints from his memory

- **HDR is near-term, not hypothetical** (`HdrHlg` ships soon). Do NOT accept any "simplify by assuming SDR-only" argument — including the research doc's §6 suggestion to drop BT.2020 working-space primaries. HDR-first is a requirement.
- **Map shared-data contract**: MapSettings-derived map state lives in `src/lib/mapVisuals/` (`resolveStaticPaints` / `buildPerFrameState`), never as a direct `setPaintProperty`/`setLayoutProperty` in MapView — else preview and export diverge. Directly relevant to the off-color symptom.
- **Loud test failures**: tests fail loudly on missing preconditions (zscale, sidecars), never silent skip-with-warning.
- **FFmpeg filter empirical validation**: textual filtergraph tests can't see FFmpeg's auto-inserted scalers; always also run a `-loglevel verbose` dry-run. `overlay`'s default `format=yuv420` silently strips chroma and color tags.
- **No leveling down**: if preview and export diverge in quality, never propose degrading the better one to match. Find why the worse one is bad and fix it.

---

## Methodology: ground every claim in the real code

The point is *accurate learning*, so don't take the research doc's word for anything — confirm it, then teach it. For each stage and each proposal:

1. **Read the actual code** at the cited `file:line`. Confirm the function exists and does what the doc says. The working tree has uncommitted changes, so **line numbers in the research doc may have drifted** — find the real location.
2. **Confirm the proposal follows from its spec citation** when one is given.
3. **Run an empirical FFmpeg test** when the claim is testable (overlay auto-insertion, tag conformance via `ffprobe`, "no path between colorspaces" reproduction, sharpness/resampling comparisons). System has `ffmpeg 8.1.1` / `libzimg`. Use `-loglevel verbose` to catch silently auto-inserted filters.
4. **Teach the concept in context**, and state plainly: here's what the code does *now*, here's what the doc proposes to change it *to*, here's which symptom it targets, here's the tradeoff.
5. Spawn subagents for heavier verification sweeps to preserve context.

Calibration example: the dither "166 → 198" claim did not reproduce on a controlled input. The doc is a useful map, not ground truth — confirm before teaching.

---

## Visual & testing component (REQUIRED — not optional)

Both symptoms are things Matthew can *see*, so the lesson must be grounded in images and numbers, not just filter strings. Every stage of the walkthrough produces a visual or measured artifact he can inspect. Theory without a corresponding picture/number is incomplete.

**Set up a lab directory** `pipeline-visuals/` at the repo root (add it to `.gitignore`). Save every artifact there with descriptive names (`stage1-canvas-preview.png`, `stage1-canvas-export.png`, `b1-pixelratio-1x-vs-2x-label-crop.png`, etc.). Tell Matthew the path each time so he can open it.

**Step 0 — establish the baseline (do this first, before any teaching).** Produce a reproducible single-frame capture of the *same* map frame from both paths:
- the **preview path** (the webview / `MapView`), and
- the **export path** (through the FFmpeg pipeline).

Force a deterministic camera and render the same frame both ways (research §5.4 sketches forcing a known camera and rendering frame 0). Put them side by side. This is the ground-truth "before" that makes both symptoms concrete. If you cannot yet make the two paths render a comparable frame, that gap is itself a finding — surface it.

**Per stage, produce one of:**
- **Color symptom → measured swatches.** Sample the same known region (e.g., a flat green map field, a route-line pixel) in preview vs export. Print the actual pixel values and the delta, *and* show the swatches side by side. A 5-code shift is invisible as text but visible as adjacent swatches.
- **Sharpness symptom → crops + a metric.** Crop the same label/route edge from both, at the same scale, and show them side by side. Where possible attach a sharpness number (e.g., SSIM against a high-supersample reference, or an edge-acutance measure). The number plus the crop together.
- **Proposed change → before/after.** For any proposal you teach, render the frame *with the current code* and *with the proposed change*, side by side, on the same content. Matthew decides ACCEPT/REJECT by looking, not by trusting the doc.

**Tools available:** `ffmpeg`/`ffprobe` 8.1.1 (render, encode, diff, tag-check), Python + PIL/numpy (pixel sampling, swatch/montage generation, SSIM), the renderer sidecar in `sidecars/renderer` (map frames), and the Playwright MCP browser tools if useful for driving the preview path. Build a small **reproducible harness** (a script or a couple of commands) so any frame can be re-rendered both ways on demand — you'll reuse it at every stage. Honor the empirical-validation memory: pair textual filtergraph reasoning with an actual `-loglevel verbose` dry-run so you catch FFmpeg's silently auto-inserted scalers.

**Quiz integration:** where natural, make a quiz question reference the artifact ("looking at the two swatches in `pipeline-visuals/stage2-...png`, which path is applying the wrong transfer curve, and how can you tell?").

---

## Suggested structure — organize by the two symptoms, follow the pixel's path

Trace one map pixel from the MapLibre canvas to the encoded file. Group the teaching into the two symptom threads.

### Thread 1 — "the map is off-color" (color path)
- **Canvas origin** (`sidecars/renderer/page/init.ts`, `sidecars/renderer/index.ts`): what color space do the raw pixels come out in (sRGB, premultiplied alpha?), and what does the export assume about them? What does the *preview* path assume? Divergence here is the prime suspect.
- **Map ingest** (`util/color.rs` — `map_ingest_filter()` and the `WORKING_SPACE_*` constants): linearize, the sRGB→linear→BT.2020 round-trip, primaries threading, the alpha-drop in `gbrpf32le` (decision C1). Research §1.2, §1.4, §1.6, §3.1, §3.4.
- **Tag preservation through composite** (`filtergraph.rs`): the `overlay` `format=` trap that strips color tags (decision C2); the `yuva444p10le` lift. Verify with a verbose dry-run.
- **Finishing tags** (`delivery.rs` — `delivery_finishing_filter()` + `setparams`): are the output `colr`/VUI tags correct per target? Research §2 table, §3.2, decision A4/A5.

### Thread 2 — "edges are blurry" (sharpness path)
- **Render geometry** (`layout.rs` — `canonical_map_viewport`, the pixelRatio model; `mod.rs` framebuffer-vs-slot invariants): is the export under-supersampling vs the Retina preview? Research §4.1, §4.5, decision B1.
- **MapLibre constructor** (`init.ts`): `antialias` and `preserveDrawingBuffer` defaults. Research §1.8 / §4.2, decision B2.
- **Sprites** (style config): OFM POI sprites are 1× only. Research §4.4, decision B3.
- **Chroma downsample kernel** (`delivery.rs`): `f=spline36` vs default `bilinear` (decision A1-kernel, already ACCEPTed).

At each stage, explicitly compare: does the **preview path** do the same thing? Divergence is the symptom's origin. Capture each decision in `PIPELINE_DECISIONS.md` (ACCEPT / REJECT / DEFER / MODIFIED + reasoning); respect decisions already there.

---

## First move

Read `PIPELINE_RESEARCH.md` and `PIPELINE_DECISIONS.md`. Then, before any teaching, do **Step 0** from the visual component: stand up the `pipeline-visuals/` lab and capture the same map frame from the preview path and the export path, side by side. Lead the session by showing Matthew that baseline — the off-color and blur should be visible in it (or, if you can't yet produce a comparable frame, that gap is your first finding to discuss).

Then orient him: confirm the two-symptom framing (off-color = color path, blurry = sharpness path), recommend starting with Thread 1 at the canvas origin (where preview/export divergence is most likely born), and ask if that's where he wants to begin. Then teach one stage at a time — verify in the code, render/measure the artifact, teach the current state, teach the proposal (with a before/after image), quiz at the end of each stage.
