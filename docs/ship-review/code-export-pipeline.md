# Ship Review — Rust Export Pipeline (`src-tauri/src/export/`)

Date: 2026-06-11. Branch: `feat/control-panel` (commit `0f51a8a`).
Scope: all 15 files under `src-tauri/src/export/` (~22.7k lines incl. tests; roughly 8–9k production), plus the two color modules the pipeline depends on (`src-tauri/src/util/color.rs`, `src-tauri/src/util/color_space.rs`) and the integration tests under `src-tauri/tests/`.

Question being answered: deep module or soup? Where does change amplification bite? Is HDR a first-class axis or bolted on? What is worth carrying into a fresh start?

---

## 1. Verdict in one paragraph

This subsystem is the **opposite of soup at the leaves and mildly soupy at the trunk**. The pure builder/math modules — `clip_chain.rs`, `layout.rs`, `corner_mask.rs`, `protocol.rs`, `color_space.rs` — are genuinely deep modules in the Ousterhout sense: small interfaces (`build_clip_video_subgraph`, `resolve_slots`, `ingest_zscale_chain`), substantial hidden functionality, pure functions, exact-string regression tests. The color architecture (atomic-axes registry + linear BT.2020 working space + per-clip ingest + per-target delivery) is a real design, not an accretion, and HDR is structurally first-class (one open correctness bug, §6). The shallowness lives in two places: `mod.rs`'s three copy-pasted channel branches (~570 lines with triplicated corner-mask/probe/validation boilerplate) and `filtergraph.rs`'s composite-mode `match` with the yuva-lift/overlay/round-trip pattern hand-expanded five times. There is also a layer of vestigial wire fields, dead functions kept for tests, stringly-typed channels, and stale workstream-numbered comments (WS0–WS10, task 020–130, "YoutubeSdr4k", "ProresMaster") that no longer match the code — the in-code version of the markdown-accrual problem.

---

## 2. Architecture as built

Three export channels dispatched on a **string** (`mod.rs:369-377`):

- **Channel A `"composite"`** (`mod.rs:760-950`) — N clip files + rawvideo map stream on stdin + optional corner-mask PNG → one FFmpeg `filter_complex` → delivery target codec. Map frames come from the orchestrator (`orchestrator.rs:223-370`) driving N Node/Chromium renderer workers over a line-JSON + length-prefixed-binary stdio protocol (`protocol.rs`).
- **Channel B `"map_only"`** (`mod.rs:380-472`) — map stream only → ProRes 4444 + alpha, padded to the slot rect on a transparent canvas ("masked positional" intermediate).
- **Channel C `"video_only"`** (`mod.rs:596-743`) — clips only, no orchestrator/worker, spawned via `FFmpegRunner` instead of `FFmpegSink`.

Invariant "B + C composites to A" is enforced structurally by sharing `clip_chain` builders (`filtergraph.rs:478-480` doc) and empirically by `tests/golden_frame_parity.rs`.

Color model (the load-bearing design):

1. **Ingest**: every input (each clip per its `SourceColorClass`, and the map's sRGB canvas) is linearized into a working space — linear light, BT.2020 primaries, full range, `gbrpf32le` (`color_space.rs:178-184`, `color.rs:114-176`).
2. **Composite**: all overlays happen with both sides in the same regime; lifts to `yuva444p10le` exist only because FFmpeg's `overlay` has no float format (`filtergraph.rs:668-867`).
3. **Delivery**: `DeliveryTarget::output_color_space()` (`delivery.rs:122-130`) → registry-generated zscale chain (`color_space.rs:321-329`) + registry-generated `-color_*` flags (`delivery.rs:335-344`) + VUI duplicate for software encoders (`delivery.rs:351-359`).

---

## 3. Deep-module scorecard (per file)

| File | Lines (prod/test) | Verdict |
|---|---|---|
| `color_space.rs` (util) | ~340/170 | **Deep.** Atomic-axes registry; adding an axis value is one enum arm + tokens. Acceptance test stated in the module doc (`color_space.rs:21-26`) and proven by HdrPq landing as table entries only (`delivery.rs:465-485` test). |
| `clip_chain.rs` | ~340/710 | **Deep.** Pure per-clip subgraph builder; focal-crop math (`:210-268`), atempo chaining (`:289-302`), trim/speed validation. Single seam keeping Channels A and C identical. |
| `layout.rs` | ~520/520 | **Deep.** Pure slot math, TS-parity-tested (`tests/layout_parity.rs`); even-dim invariants for 4:2:0 (`:301-303`, `:330-366`); the "lever model" viewport math (`:119-134`); SSAA tiering (`:173-182`). |
| `protocol.rs` | ~150/125 | **Deep.** Minimal wire codec; project state passed opaquely by design (`:23-30`) so camera/decoration evolution never touches Rust. |
| `orchestrator.rs` | ~660/150 | **Deep.** Worker lifecycle, interleaved frame assignment with documented OOM rationale (`:372-394`), single ordered drain loop, stderr-tail diagnostics, honest panic attribution sentinel (`:48-52`). |
| `corner_mask.rs` | ~150/150 | **Deep.** Pure AA rounded-rect rasterizer; hides the mask-in-RGB-not-alpha FFmpeg trap (`:10-14`). |
| `delivery.rs` | ~370/390 | **Deep, with doc rot.** Target = color regime + codec + container only; aspect/resolution deliberately externalized (`:42-55`). Stale module doc (§7.6). |
| `encoder.rs` | ~530/55 | **Adequate.** Probe + cache + per-OS candidate ladders. Windows ladders already present (`:359-391`). Stale class docs (§7.6). |
| `ffmpeg_sink.rs` / `ffmpeg_runner.rs` / `sink.rs` / `error.rs` / `resolution.rs` | small | **Adequate thin wrappers.** Deliberate `StderrRing` triplication (documented, `ffmpeg_sink.rs:252-254`). |
| `ffprobe.rs` | ~500/530 | **Adequate-deep.** One probe call yields dims/audio/color/DV/rotation/camera; rotation-aware display dims (`:215+`); mtime-keyed in-process cache (`:80-95`). |
| `filtergraph.rs` | ~940/2160 | **Mixed.** Pure argv builders (good) but composite-mode triplication (§5.1) and 211 substring asserts (§5.5). |
| `mod.rs` | ~1080/470 | **Shallowest file.** Three channel branches with copy-pasted boilerplate (§5.2), dead code, vestigial wire fields, stringly channels. |

---

## 4. Gems — hard-won knowledge that must survive any rewrite

These encode empirically-discovered FFmpeg/zimg/GPU behavior. Losing them means re-paying the debugging cost.

### 4.1 The atomic-axes color registry
`color_space.rs` entire file. One definition per axis value, separate zscale vs `-color_*` spellings (`170m` vs `smpte170m`, `limited` vs `tv` — `:73-127`), byte-equality tests against the pre-registry strings (`:385-483`). The two-step ingest shape (linearize keeping source primaries → format hop → gamut retag) is documented as load-bearing (`:271-276`).

### 4.2 Explicit-source-tags asymmetry for rawvideo (zimg error 3074)
Decoded video streams propagate container tags so zscale can infer `pin/min/rin`; bare rawvideo RGBA has none, so ALL four source tags AND output tags must be explicit or zimg fails planning with code 3074. `color.rs:438-457` (map ingest), `color_space.rs:260-276` (`explicit_source_tags` flag), and the same form reused for per-axis user overrides (`clip_chain.rs:103-139`).

### 4.3 The overlay float/4:2:0 trap — the PIP saturation + blurry-edges root cause
`overlay` accepts no float formats; feeding it `gbrpf32le` makes FFmpeg silently auto-insert swscale → yuv420 → early 4:2:0 chroma subsampling + default color tags. Fix: explicit lift of BOTH inputs to `yuva444p10le` **and** `overlay=...:format=yuv444p10` (overlay's internal default is yuv420 even with 4:4:4 inputs). `filtergraph.rs:673-737` (full root-cause comment), tests `:2653-2759`, `:2824-2981`, defense-in-depth producer-scan test `:2984-3101`. This pairs with the project rule that textual filtergraph tests can't see auto-inserted scalers — hence `-loglevel verbose` empirical validation.

### 4.4 `setparams` on synthetic sources — fatal only for HDR
`color=c=black` emits frames with unspecified color tags; overlay propagates the first input's tags; the delivery zscale then has no source regime and fails (code 3074) — SDR sometimes limps through on bt709 defaults, HDR fails hard. Fix: tag the synthetic canvas with the working space's axes. `filtergraph.rs:811-835`. This is a concrete instance of "no SDR-default reasoning" caught and fixed.

### 4.5 fps normalization after concat — the Broken-pipe bug
`overlay`'s output rate = first input's rate; clip-native `[vc]` at 30fps with a 24fps export makes `-frames:v` fire at `cap/30` s, FFmpeg closes stdin, the sink hits `Broken pipe (os error 32)`. Fix: `concat,fps={fps}` (`filtergraph.rs:627-638`; regression tests `:2117-2173`, silent Channel-C variant `:2495-2526`).

### 4.6 VUI duplicate for libx264/libx265
Both encoders silently drop `-color_primaries/-color_trc` from the bitstream VUI unless duplicated in `-x264-params`/`-x265-params`; videotoolbox honors globals directly. `delivery.rs:189-202`, `:346-359`, cross-matrix test `:703-757`.

### 4.7 Corner mask value must live in RGB, not alpha
`format=gray` computes Y from RGB and drops alpha; an alpha-encoded mask reads as uniformly opaque and silently disables corner rounding. `corner_mask.rs:10-14`. Plus `-loop 1` / `alphamerge=shortest=1` pairing to avoid encoder hang (`filtergraph.rs:343-353`).

### 4.8 yuva promotion before `pad` with transparent fill
`format=yuva444p10le` must precede `pad=...:color=#00000000` or the canvas paints opaque black (gbrpf32le has no alpha). `filtergraph.rs:49-57`, ordering pinned by test `:999-1008`.

### 4.9 Interleaved frame assignment bounds the reorder buffer
Contiguous worker ranges would park ~`(N-1)/N` of all RGBA frames in the BTreeMap at the midpoint (OOM on long 4K exports); round-robin keeps the buffer O(N). `orchestrator.rs:372-394` with completeness/disjointness tests `:693-720`.

### 4.10 Layout math invariants
- Even-dims everywhere or zscale errors with code 1027; Split snaps the **divider** to even before deriving slots so `map + video == output` exactly (`layout.rs:301-303`, `:330-366`; sweep test `:741-780`).
- Lever model: cssViewport tracks slot shape, pixelRatio absorbs resolution; drift bound `pr*0.5` (an earlier strict `<1.0` assert panicked on odd 4K slots and leaked the ffmpeg child — regression test `layout.rs:967-977`).
- SSAA on-GPU downsample so supersampling never inflates the wire (`layout.rs:153-182`, `mod.rs:516-547`).

### 4.11 Legacy SDR transfer threading (Fix #6)
`classify()` collapses bt709/smpte170m/bt470bg into `SdrBt709`, but the original trc string is threaded to pick the correct inverse EOTF (`color.rs:92-104`, `:187-205`; tests `clip_chain.rs:896-940`).

### 4.12 Probe richness in one call
Rotation-aware display dims (legacy `rotate` tag + Display Matrix side-data), DOVI side-data detection, camera make/model fallbacks through encoder/handler/`com.apple.quicktime.software` strings (`ffprobe.rs:120-160`, `:215+`).

### 4.13 ProRes `+faststart` (Fix #5)
QuickTime muxer honors moov-at-front; without it ProRes masters on slow/remote drives are unplayable until transfer completes (`delivery.rs:288-296`).

---

## 5. Soup inventory — where shallowness and change amplification live

### 5.1 Composite-mode triplication in `filtergraph.rs` (worst offender)
`build_composite_filter_complex` (`filtergraph.rs:597-899`) hand-expands the same lift→alphamerge?→overlay→round-trip→finishing sequence five times (PipMapInset ±mask, PipVideoInset ±mask, Split). PipVideoInset is literally described as "symmetric to PipMapInset — same fix in reverse" (`:756-767`) yet is a separate copy. **Adding a fourth composite mode (e.g. side-by-side with both insets, or a third stream) means re-deriving the lift discipline by hand and writing ~10 new substring tests.** A tiny internal IR (streams with known pix-fmt family + a `lift()`/`overlay()` combinator that enforces §4.3 by construction) would collapse five branches to one rule. Severity: **high** for future layout work, none for current correctness — the tests pin it exhaustively.

### 5.2 `mod.rs` channel-branch copy-paste
- Corner-mask generation + tempfile block appears three times nearly verbatim: `mod.rs:400-424` (B), `:668-692` (C), `:843-878` (A).
- Clip extraction → visibility filter → existence check → capped probe → `VisibleClipInput` mapping duplicated between C (`:614-663`) and A (`:791-838`), with the comment "070's helper, inlined for parity" (`:802`) — i.e. duplication was a deliberate choice and is now drift risk.
- `is_allowed_for_channel(channel: &str)` (`delivery.rs:154-160`), `req.channel: String` (`mod.rs:97`), dispatch on string (`mod.rs:369-377`): three magic strings ("composite", "map_only", "video_only") that an enum would make exhaustive. Severity: **medium** — a new channel or a renamed channel is a grep-and-pray change.

### 5.3 Vestigial wire/API surface
- `RenderExportRequest.audio_bitrate_kbps` is accepted, documented, threaded into `build_composite_filtergraph` — and then discarded: `let _ = audio_bitrate_kbps;` (`filtergraph.rs:564`); actual bitrate hardcoded 192k in `delivery.rs:361-363`. The wire contract lies.
- `RenderExportRequest.codec_preference` superseded by `delivery_target` for the composite path (`mod.rs:887-891`) but still on the wire.
- Dead-but-kept-for-tests: `aac_args` (`filtergraph.rs:587-595`), `select_composite_encoder`/`_with` (`mod.rs:293-336`).
- Lint-silencer functions `_working_space_ref` / `_encoder_kind_ref` (`delivery.rs:366-378`).
Severity: **medium** — each is small; together they make the request surface untrustworthy reading.

### 5.4 Stale narrative comments (in-code spec rot)
The code is written as a chronological narrative of workstreams (WS0–WS10, tasks 020–130, "Issue 2", "Fix #5/#6/#8"). Many references are now wrong:
- `delivery.rs:24-32` module doc advertises `DeliveryTarget::aspect()` / `::output_dims()` — methods that no longer exist post-Issue-2.
- Comments throughout reference retired variant names `ProresMaster`, `YoutubeSdr4k`, `social_sdr_vertical` (`filtergraph.rs:112-114`, `:1498-1503`, `mod.rs:880-886`, `delivery.rs:51-55`).
- `encoder.rs:36-38`: `H264` documented as "Not currently used by any channel" — it backs the shipping `SdrH264` target.
This is the codebase-internal twin of the "months of conflicting spec markdown" pain. The *mechanism* comments (why a filter exists) are excellent and must be kept; the *history* comments (which workstream added it) actively mislead. Severity: **medium**.

### 5.5 String-substring test regime — deliberate change amplification
`filtergraph.rs` has 211 asserts across ~2,160 test lines, most matching exact filtergraph substrings (`[vc_a][map_masked]overlay=702:1497:format=yuv444p10[vout_masked]`). Defensible: FFmpeg's failure mode is silent auto-inserted conversions, so exact strings ARE the spec (and `color_space.rs` byte-equality tests guard the empirically-validated chains). Cost: any label rename or chain reorder breaks dozens of tests, and the tests verify text, not pixels — the real backstop is the golden-frame suite (`tests/golden_frame_parity.rs`) plus the documented `-loglevel verbose` dry-run discipline. Acceptable trade, but a rewrite should keep the byte-equality tests at the registry level and pin composite structure with fewer, more semantic assertions (the producer-scan test at `filtergraph.rs:2984-3101` is the right shape). Severity: **low-medium**.

### 5.6 Minor duplication
- `trimmed_audio_span_seconds` (`filtergraph.rs:904-935`) re-implements `clip_chain`'s trim/speed validation for the silence fallback.
- Audio-subgraph + `aevalsrc` fallback + audio-concat block duplicated between C (`filtergraph.rs:366-394`) and A (`:870-896`).
- `push()` argv helper duplicated (`filtergraph.rs:184-188`, `delivery.rs:324-328`).
- `StderrRing` + `forward_stderr` triplicated (orchestrator/sink/runner) — explicitly documented as intentional (`ffmpeg_sink.rs:252-254`); fine.

### 5.7 Silent test skips (violates the loud-failure rule)
`ffmpeg_runner.rs:240-246` and `:257-262`: `if !ffmpeg_on_path() { eprintln!("ffmpeg not on PATH — skipping"); return; }`. Every integration test does this right (`panic!` with install instructions — `tests/render_export_map_only.rs:70`, `tests/color_fixtures.rs:34-75`); these two unit tests are the stragglers. Severity: **medium** (explicit project rule).

### 5.8 `FrameSink` sync trait forces a runtime bridge
`FrameSink::write_frame` is sync, so `FFmpegSink` does `block_in_place` + `Handle::block_on` per frame (`ffmpeg_sink.rs:166-171`). Works, but it's a per-frame scheduler trick on the hot path of a multi-GB stream and constrains the orchestrator to a multi-threaded runtime. An async trait (or a plain mpsc into a writer task) is the simpler shape. Severity: **low** (correct today; tripwire for refactors).

---

## 6. SDR vs HDR: first-class axis or bolt-on?

**Structurally first-class.** Evidence:

1. The working space is HDR-capable by construction: linear light, BT.2020 primaries, float (`color_space.rs:178-184`) — SDR is converted *into* the wide space, not HDR squeezed into an SDR space.
2. `DeliveryTarget::output_color_space()` is the single declaration point (`delivery.rs:122-130`); finishing filter and encoder flags both derive from it. HLG and PQ share one encoder arm differing only in the regime (`delivery.rs:245-277`); HdrPq was added as table entries with zero new filter/flag code (extensibility proof test `delivery.rs:465-485`).
3. Mixed SDR+HLG timelines are handled per-clip at ingest (`filtergraph.rs:2442-2492` test), and the one HDR-fatal-only bug found (unspecified tags on synthetic canvas) was fixed in the HDR-correct direction (§4.4) rather than special-cased for SDR.
4. Per-clip class detection includes HLG/PQ/DolbyVision with npl conventions (HLG 400 / PQ 1000) (`color_space.rs:205-221`, `color.rs:155-175`).

**Two real caveats:**

- **Open correctness bug — HDR reference white (known, diagnosed, NOT yet fixed in code).** The delivery chain `working → HLG/PQ` emits no `npl` (`color_space.rs:321-329`), so SDR-graphics content (the map canvas) lands at scene-linear white ≈62% HLG signal instead of BT.2408 reference white (203 nit / 75%) — the diagnosed "HDR map export is dark" symptom. No `npl=203` anywhere in the tree (verified by grep). Worse, the test `delivery_never_emits_npl` (`color_space.rs:477-483`) **pins the buggy behavior as a regression guard** ("matches pre-registry behavior"). The fix is one registry-level change, but that test will fight it. Severity: **high** (HDR is a co-equal ship target).
- **Channels B/C are hardcoded SDR BT.709 intermediates** (`filtergraph.rs:126-138` `push_prores_color_flags`, `:153-163` WS4 delivery transform to `SDR_BT709`). For B/C as *compositing intermediates* this is a documented scope cut, but it means there is no HDR-capable master/intermediate export today (the `Prores` target on Channel A is also BT.709-only, `delivery.rs:78-82`). A "ProRes HLG master" would be a new target — cheap under the registry, but the alpha-bearing intermediate path would need thought. Severity: **medium** (scope gap, not architecture flaw).

---

## 7. Change-amplification map

| Change | Touch points | Grade |
|---|---|---|
| **New delivery target** (e.g. ProRes HLG master) | `DeliveryTarget` arm + 5 small `match` arms in `delivery.rs` + (maybe) a `ColorSpace` const. Color flags/chains auto-derive. TS mirror of the serde string. | **A** — proven by HdrPq. |
| **New color axis value** (transfer/primaries) | One enum arm + two token strings in `color_space.rs`. | **A** — the registry's stated acceptance test. |
| **New aspect ratio** | `AspectRatio` arm + `output_dims` + `canonical_map_css_width` + 2 default-layout fns + `legal_split_sides` + `ProjectLayouts` field (`layout.rs`) + TS mirror `src/lib/layout.ts` + parity fixture + UI. ~8 places but all named, mostly one file per language. | **B** — mechanical, parity-tested. |
| **New resolution tier** | `OutputResolution` arm + `output_dims` short-edge map; lever model absorbs the rest. | **A-** |
| **New composite/layout mode** | New `CompositeMode` arm + hand-written lift/overlay branch in `filtergraph.rs` + `resolve_slots` math + corner-mask wiring in `mod.rs` + ~10 substring tests + validator + TS mirror. | **D** — see §5.1. |
| **New export channel** | String literal in 4+ places, new ~150-line branch in `mod.rs` cloning the boilerplate. | **D** — see §5.2. |
| **New decoration** (POV/trail/waypoints) | **Zero Rust changes.** Decorations live in `src/lib/mapVisuals/` + renderer sidecar; Rust transports opaque `project_state` (`protocol.rs:23-30`) and RGBA bytes. | **A** — the opaque-pass-through decision paying off. |
| **Audio bitrate actually honored** | Un-dead-end `audio_bitrate_kbps` through `delivery_encoder_args`. | trivial, just unfinished. |

---

## 8. Questionable decisions (severity-rated)

1. **HIGH — HDR delivery lacks ref-white anchoring (`npl=203`), and `delivery_never_emits_npl` pins the bug.** `color_space.rs:321-329`, `:477-483`. Diagnosed root cause of dark HDR map exports; fix is registry-level but test-guarded in the wrong direction.
2. **HIGH (future-facing) — composite-mode triplication.** `filtergraph.rs:597-899`. Five hand-expanded branches of the same lift/overlay discipline; next layout mode re-derives it manually.
3. **MEDIUM — `mod.rs` channel boilerplate duplication + stringly-typed channel.** `mod.rs:369-377`, `:400-424`/`:668-692`/`:843-878`, `delivery.rs:154-160`.
4. **MEDIUM — wire fields that lie:** `audio_bitrate_kbps` accepted-and-discarded (`filtergraph.rs:564`), `codec_preference` superseded (`mod.rs:887-891`), dead helpers kept for their tests (`mod.rs:293-336`, `filtergraph.rs:587-595`).
5. **MEDIUM — stale workstream/variant-name comments** misdocumenting current behavior (`delivery.rs:24-32`, `encoder.rs:36-38`, `filtergraph.rs:1498-1503`, `mod.rs:880-886`).
6. **MEDIUM — silent skip in `ffmpeg_runner.rs` unit tests** (`:240-246`, `:257-262`) — explicit violation of the project's loud-failure rule; the integration suite does it correctly.
7. **LOW-MEDIUM — 2,160 lines of substring assertions in `filtergraph.rs`** verify text, not pixels; heavy refactor friction. Keep registry byte-equality + golden frames; make structural tests semantic (producer-scan style).
8. **LOW — sync `FrameSink` forces per-frame `block_in_place`/`block_on`** (`ffmpeg_sink.rs:166-171`).
9. **LOW — B/C ProRes intermediates locked to BT.709 SDR** (`filtergraph.rs:126-138`) — documented scope cut, but blocks any HDR master/external-compositing workflow.
10. **LOW — `ffprobe_path()` is a bare PATH lookup** (`mod.rs:995-999`) — known, tracked as task 130, but it's a ship blocker for the bundle.

---

## 9. Fresh-start guidance

If the decision is to start over, **do not rewrite this subsystem from scratch — transplant it.** Carry whole: `color_space.rs`, `clip_chain.rs`, `layout.rs` (+ TS parity fixture), `corner_mask.rs`, `protocol.rs`, `orchestrator.rs`, `ffprobe.rs`, and the gem list in §4 verbatim (those comments are the distilled cost of months of FFmpeg debugging). Rebuild only: (a) `mod.rs` as an enum-channel dispatcher over a shared `ExportJob` preparation step (validate → probe → mask → encoder, once); (b) the composite branch of `filtergraph.rs` around a small stream/format IR that makes the yuva-lift law a constructor invariant instead of five copies; (c) the request wire type without the dead fields. Fix the `npl=203` ref-white bug at the registry level first — it's the only known *output-correctness* defect in the subsystem and it sits exactly where the architecture says one-line fixes should live.
