# Ship Review — Test Coverage & Quality Infrastructure Audit

Date: 2026-06-11. Branch at audit time: `feat/control-panel` (dirty working tree).
Scope: all frontend Vitest suites, `src-tauri/tests/`, inline Rust `#[cfg(test)]` modules, and `src-tauri/sidecars/renderer/__tests__/`.

This is the permanent record for the "start over vs. clean up" decision. Every claim cites a file:line.

---

## 1. Inventory — what exists and what actually runs

### 1.1 Frontend (Vitest, `vitest.config.ts`)

- 37 test files under `src/` (jsdom environment). Verified by running `npm run test:run` on 2026-06-11:
  **914 passed, 1 failed, 7 skipped, 6.7s wall clock.**
- The 1 failure is branch WIP: `src/components/ExportModal/__tests__/ExportChip.test.tsx:173` expects chip label `'4K·30·HDR'`, code now emits `'4K·30·HLG'` (`ExportChip.tsx` is modified in the working tree). Stale expectation, not a product bug.
- The skip block is `src/lib/cameraIntent.validation.test.ts:40` — a deliberately gated one-shot validation probe (`VALIDATION_PROBE=1`), which also hardcodes a personal path: `const TEST_PROJECT_PATH = '/Users/personal/Desktop/bri test/MyHike.trailcut/project.json'` (line 23).
- `vitest.config.ts` declares coverage thresholds (`perFile: true, lines: 90`) **but only for `src/lib/**`** — components, hooks, screens are excluded from measurement entirely, and the threshold is only checked by `npm run test:coverage`, which nothing automates (see §4.2).

### 1.2 Rust (`src-tauri`)

Verified by running `cargo test` on 2026-06-11 (all green):

| Suite | Tests run by default | Notes |
|---|---|---|
| inline `src/**` unit tests | **329 passed in 0.14s** | distribution in §1.4 |
| `tests/color_fixtures.rs` (1,567 lines) | 15 passed, 1 ignored (DV placeholder) | spawns real ffmpeg/ffprobe/exiftool |
| `tests/encoder_probe.rs` | 1 passed | real ffmpeg probe + cache |
| `tests/layout_parity.rs` | 2 passed | shared TS/Rust fixture |
| `tests/orchestrator.rs` | 2 passed | spawns real bundled renderer worker via node |
| `tests/golden_frame_parity.rs` | **0 (feature-gated)** | `--features integration_export` + `TRAILCUT_CHROME_BIN` |
| `tests/golden_frame_regenerate.rs` | 0 (feature-gated + `#[ignore]`) | manual regen tool |
| `tests/render_export_composite.rs` (815 lines) | 0 (feature-gated) | full end-to-end export, pixel spot checks |
| `tests/render_export_map_only.rs` / `_video_only.rs` | 0 (feature-gated) | alpha-channel and matrix coverage behind `integration_export` / `integration_export_matrix` |

### 1.3 Sidecar renderer (`src-tauri/sidecars/renderer/__tests__/`, `vitest.renderer.config.ts`)

- 5 test files: `painterPatch.test.ts`, `tileCache.test.ts`, `trailcutFetch.test.ts` (pure unit), `protocol.test.ts`, `tileCacheKeyParity.test.ts` (process-level: spawn worker, need built `dist/` + `TRAILCUT_CHROME_BIN` + network on first run).
- Run via separate `npm run test:renderer`; `protocol.test.ts:136-153` `beforeAll` **throws** on missing bundle or missing chrome env — loud, correct.
- Two **manual probe scripts that assert nothing**: `colorParityProbe.ts` (245 lines, pixel statistics + PNG dump for eyeballing) and `perfProbe.ts` (198 lines). They are diagnostic tooling, not regression tests.

### 1.4 Inline Rust unit-test distribution (`grep -c '#[test]'`)

filtergraph.rs 38, clip_chain.rs 35, commands/project.rs 35, util/color.rs 33, util/log_detection.rs 25, commands/ffmpeg.rs 23, export/layout.rs 21, models.rs 19, export/ffprobe.rs 19, export/mod.rs 17, export/delivery.rs 15, util/color_space.rs 14, corner_mask.rs 9, protocol.rs 8, orchestrator.rs 8, encoder.rs 4, ffmpeg_runner.rs 3, camera_presets.rs 2, ffmpeg_sink.rs 1.

**Zero tests:** `util/hash.rs`, `util/exiftool.rs`, `export/resolution.rs`, `export/error.rs`, `commands/recent.rs`, `commands/media.rs`, `commands/gpx.rs`.

---

## 2. What is genuinely verified vs. what merely executes

### 2.1 Genuinely verified (strong)

- **Color *metadata* pipeline end-to-end.** `tests/color_fixtures.rs` drives the production `generate_proxy` / `generate_thumbnail` / `delivery_finishing_filter` code against five committed real video fixtures (`src-tauri/fixtures/color/`) and asserts ffprobe-readback color tags field-by-field (`assert_color_tags`, color_fixtures.rs:248-287), exactly-one-`colr`-atom container hygiene via a hand-rolled ISO-BMFF box walker (lines 318-449), `+faststart` moov-before-mdat byte layout (lines 740-762), and sRGB ICC presence via real exiftool (lines 821-869). Negative cases included (zero-atom fixture, lines 572-584). This is real verification, not execution theater.
- **Filtergraph structure.** 38 unit tests in `export/filtergraph.rs` plus integration-level structural assertions: `ws3_pip_composite_matches_split_composite_within_tolerance` (color_fixtures.rs:1163-1325) asserts every composite mode carries identical working-space ingest chains; `ws3_masked_pip_composite_overlay_inputs_share_format_family` (color_fixtures.rs:1327-1481) encodes a root-caused production bug (mixed pixel-format-family overlay → silent swscale with default tags) as **positive AND negative** substring assertions (`expected_overlay` / `forbidden_overlay`, lines 1396-1422).
- **Runtime zimg planning.** `map_ingest_filter_runs_on_bare_rawvideo_rgba` (color_fixtures.rs:1502-1567) pipes raw RGBA into real ffmpeg stdin to prove the map-ingest chain initializes against an untagged stream — the "code 3074: no path between colorspaces" regression. This is the codified form of the project's "textual filter tests can't see FFmpeg's silent auto-inserted scalers" lesson.
- **Camera/timeline math.** `src/lib/cameraIntent.test.ts` (1,485 lines) covers transition boundary placement under bias (-1/0/+1), first-clip clamps, both-sides overrun clamping, feel ordering, arc symmetry, purity, and no-inverted-spans invariants (test list at lines 604-981). `routeLocation.test.ts` (823 lines) is similar caliber. This is the deepest behavioral coverage in the repo.
- **Schema migrations.** Contrary to the suspicion in the audit brief, migrations are well covered: ~20 dedicated tests in `commands/project.rs:713+` spanning `migrate_v1_to_v2_lifts_schema_version` (line 740) through `migrate_v8_to_v9_stamps_version_and_defaults_working_color_space` (line 1676), including additive-only checks and per-field override preservation (e.g. `migrate_v7_to_v8_pov_pulse_radius_override_preserved`, line 1627).
- **Layout parity across language ports.** One shared fixture (`tests/fixtures/layout_parity.json`) consumed by both `tests/layout_parity.rs:63-123` and `src/lib/__tests__/layout.test.ts`. The Rust side even asserts fixture completeness (`covered >= fixture.cases.len()`, layout_parity.rs:117-122) so new cases can't silently skip the canonical-viewport assertion.
- **Orchestrator happy path.** `tests/orchestrator.rs:124-162` drives the real bundled node worker (1 and 2 workers, mid-run recycle) and asserts ordering, frame size, and non-all-zero first frame.
- **Worker frame assignment math.** `export/orchestrator.rs:657-720` — interleave, congruence-mod-stride, and complete-and-disjoint union over edge cases including `worker_count > total`.

### 2.2 Executes but verifies weakly (by design, but worth naming)

- **`render_export_*` integration suites** assert container shape (codec/dims/audio/duration band) plus deliberately weak pixel checks: "non-black" and "differs by >30 in some channel" (`render_export_composite.rs:479-488`, comment at 464-466: "we're confirming the composite ran, not pixel-equal-asserting"). They prove plumbing, not color fidelity — see §3.1.
- **UI component tests** (ExportModal suite, MapToolbar/ColorSection/ShapeSection, LayoutConfigurator, etc.) are render-and-assert-DOM tests of leaf components. Reasonable, but the composition surfaces (`ProjectView.tsx`, `App.tsx`, `MapView.tsx`, `Timeline/`, `VideoPreview/`, `WaypointsPanel/`) have **zero** tests.

---

## 3. The recurring roadblocks vs. regression coverage

### 3.1 HDR color correctness — NO pixel-level regression coverage (the biggest hole)

Every HDR assertion in the repo lives at one of two levels:

1. **Filter-string substrings** — e.g. `util/color.rs:849-860` (`ingest_filter_for_hlg_uses_arib_std_b67_with_npl_400`, `..._pq_uses_smpte2084_with_npl_1000`), `export/delivery.rs:466-489` (`hdr_pq_target_generates_pq_bt2020_finishing_and_encoder_flags` asserts the exact zscale string and x265 params).
2. **Output container/tag readback** — `ws4_each_delivery_target_emits_expected_color_tags` (color_fixtures.rs:1108-1159) probes HdrHlg/HdrPq outputs for `bt2020 / arib-std-b67 / bt2020nc / tv` tags and colr-atom count.

**Nothing anywhere measures output signal values.** The already-diagnosed production bug — HDR-HLG map export dark because SDR map graphics land at ~62% HLG signal instead of BT.2408 reference white (203 nit → 75%) — passes *every existing test*: the filter strings are "as designed," the tags are correct, and no test decodes an HDR output frame and asserts a known-white map pixel lands near signal 0.75. Confirmed: `grep -rn "203"` across `util/color.rs`, `util/color_space.rs`, `export/delivery.rs` returns nothing; no test references reference white or BT.2408. The single recurring roadblock that has burned the most time has zero automated detection at any level — and the fixture + ffprobe + frame-extraction machinery needed to build that test (e.g. `extract_rgba_frame`, render_export_composite.rs:160-189; synthetic-clip builders, color_fixtures.rs:935-983) already exists in-repo.

The same gap applies to the documented "off-color map + blurry edges" preview/export divergence: `colorParityProbe.ts` was written to investigate it but is a manual script with no assertions (header comment, lines 1-13: "One-off probe... report pixel statistics... write the frame as PNG to /tmp for visual inspection").

### 3.2 Map decoration fidelity — thin and indirect

- `src/lib/mapVisuals/shapes.ts` is **920 lines** of canvas-rasterized SDF icon construction (waypoint shapes, pin geometry, outline thickness math) — the exact code being fixed on this branch ("fixing shapes, specifically the pin shape", commit 8f27b8c) — and has **no test file**. Coverage is only incidental: `styleSpec.test.ts:349-419` asserts the *expression strings* that select icons by shape name, not the rendered icon geometry. A broken pin tip, wrong anchor, or outline-band regression is invisible to the suite. (Canvas rasterization in jsdom is a real obstacle, but a node-canvas or fixture-PNG harness was never built.)
- The golden-frame fixture (`tests/fixtures/golden-frames/`) renders **route line + live marker only**, one camera path, one style, no waypoints, no shapes, no gradients (README.md:7-31). So even the heavyweight pixel-exact guard covers a small slice of decoration space — and it only runs when someone sets `TRAILCUT_CHROME_BIN` and passes `--features integration_export` (§4.1).
- The 4:2:0 decoration-crispness problem (documented, fix deferred) similarly has no harness that would detect re-regression of whatever pipeline-side mitigation lands.

### 3.3 Preview/export parity — guarded at production, not at consumption

The mapVisuals contract is well tested where the tuples are *produced* (`styleSpec.test.ts` 654 lines, `perFrame.test.ts` 612 lines, `animations.test.ts` 322 lines — including purity and per-mode source rules). But it is **not** tested where the tuples are *applied*:

- `MapView.tsx:661-723` hand-applies `state.paints.waypointPrimaryColor`, `waypointIconSize`, `pulseRadius`, etc., layer by layer, property by property.
- The sidecar's `page/init.ts:509-533` and `:789-805` does its own independent application.
- Nothing asserts the two application sites cover the same (layer, property) set. A new field added to `PerFramePaints` and wired into only one consumer is a silent preview/export divergence — exactly the failure mode the contract exists to prevent. `MapView.tsx` itself has zero tests of any kind (only `SourceFormatConfirmDialog.test.tsx` exists in `src/components/__tests__/`).
- Mitigation that *does* exist: the protocol test's determinism check (`protocol.test.ts:231-264`, two renders at same `project_time_ms` must be byte-identical) and the golden frames — both gated behind manual env setup.

---

## 4. Loud-failure rule compliance

### 4.1 Violation: golden_frame_parity silently skips

`tests/golden_frame_parity.rs:249-258`:

```rust
if !chrome_bin_env_present() {
    eprintln!("SKIP golden_frame_parity_chromium: TRAILCUT_CHROME_BIN not set. ...");
    return;
}
```

with an explicit rationalization at lines 103-113 ("Skipping (instead of panicking) keeps `cargo test --features integration_export` green by default"). This is a direct violation of the project rule that tests must fail loud on missing preconditions — and it's the **flagship parity guard** that can false-green. Everything else complies:

- `assert_ffmpeg_has_zscale` panics with install instructions (color_fixtures.rs:63-79) and even states the rule in its doc comment ("silent skip-with-warning produces false-green runs").
- exiftool missing → panic (color_fixtures.rs:828-834); ffmpeg/ffprobe missing → panic (color_fixtures.rs:34-52, encoder_probe.rs:28-41, render_export_composite.rs:89-98).
- Renderer bundle missing → panic (orchestrator.rs:55-63, render_export_composite.rs:75-87, golden_frame_parity.rs:89-101).
- Sidecar protocol test `beforeAll` throws on missing bundle/chrome env (protocol.test.ts:136-153).

### 4.2 The structural loudness problem: there is no CI

`.github/workflows` does not exist; no CI config of any kind in the repo. Consequences:

- The 6,000+ lines of `src-tauri/tests/` and the 914-test frontend suite run only when an agent or Matthew remembers to run them.
- The feature-gated suites (`integration_export`, `integration_export_matrix`, golden frames) additionally require `npm run build:renderer` and `TRAILCUT_CHROME_BIN`; nothing in the repo invokes them. The golden PNGs were last regenerated 2026-05-17 while this branch actively modifies `sidecars/renderer/index.ts` and `page/init.ts` — whether parity still holds is currently unknown.
- The vitest coverage thresholds (90% lines per-file for `src/lib`) are enforced by no automated process.
- The working tree currently has a failing test (§1.1) — exactly what an un-run suite produces.

### 4.3 Dead feature flag / unfulfilled test promise

`Cargo.toml:44` declares `integration_export_parity` ("gates the cross-channel compositing-parity sub-test... B+C externally vs A directly") but **no test gates on it** — `grep -rn integration_export_parity src-tauri/tests` matches only the deferral comment at `render_export_composite.rs:24-26`. The LAYOUT.md §6 "B + C composites to A" parity guarantee rests solely on the structural argument that both channels share `build_clip_chain`/`corner_mask` (comment, lines 27-30).

---

## 5. Untested-entirely list

**Rust:** `util/exiftool.rs` (0 tests — the CreationDate → CreateDate → MediaCreateDate fallback chain at `util/exiftool.rs:26-61` is a stated key design decision and is unguarded; a parsing regression silently reorders every user's timeline), `commands/media.rs` (import/merge/dedup-by-path), `commands/gpx.rs`, `commands/recent.rs`, `util/hash.rs`, `export/error.rs`, `export/resolution.rs` (covered only indirectly via layout fixture). Export **error paths**: `orchestrator.rs::finalize_worker_error` (line 586), worker-crash recovery, sink failure propagation, recycle-on-error — none covered; `ffmpeg_sink.rs` has exactly 1 test (stderr ring eviction, line 294); orchestrator integration tests are happy-path only.

**Frontend:** `MapView.tsx`, `ProjectView.tsx`, `App.tsx`, `Timeline/`, `VideoPreview/`, `WaypointsPanel/`, `Toolbar.tsx`, `hooks/useProject.ts`, `useAutoSave.ts` (debounced save — data-loss surface), `useRecentProjects.ts`, `lib/waypoints.ts`, `lib/livePlayhead.ts`, `lib/mapVisuals/shapes.ts` (§3.2), `lib/mapVisuals/sources.ts` (only indirect via perFrame), all of `shortcuts/`.

---

## 6. Gems — harnesses worth carrying into any rewrite

1. **`tests/color_fixtures.rs` as a whole** (1,567 lines). The expected-tag table mirrored against a fixtures README (lines 102-185), the diff-style `assert_color_tags` (248-287), the dependency-free ISO-BMFF `colr`-atom walker (318-449), loud zscale/exiftool/ffmpeg guards, the WS-staged structure with `#[ignore]` + rationale for the DV placeholder (633-654). Encodes months of color-pipeline lessons (the x264-params VUI splice note at 716-725, the FFmpeg-8 ProRes colr-atom behavioral note at 451-467) as executable assertions.
2. **The golden-frame determinism design** (`golden_frame_parity.rs:1-39` header + `fixtures/golden-frames/README.md`). The determinism contract is *structural* (frozen clock, zero-duration paint transitions, on-disk tile cache, hand-authored point-intent timeline — no Van Wijk arcs), byte-exact with no tolerance, failure dumps rendered PNGs to a kept tempdir with diagnostic pixel counts (golden_frame_parity.rs:312-357), and the README states the regen discipline outright: "The parity test failing on its own is **information** — investigate before regenerating. Regen-on-failure defeats the entire test" (README.md:65-67), plus a documented kill-the-patch sanity check (README.md:94-103).
3. **Cross-port shared fixtures.** (a) `tests/fixtures/layout_parity.json` consumed by both Rust and TS layout tests with a completeness assertion (layout_parity.rs:117-122); (b) `__tests__/setupFixture.ts` bundled to `dist/setup_fixture.cjs` and exec'd by the Rust orchestrator/composite tests with JSON-on-stdin overrides (setupFixture.ts:1-14, render_export_composite.rs:250-296) — "single source of truth so the two test sites can't drift" actually achieved.
4. **The masked-PIP overlay-family regression test** (color_fixtures.rs:1327-1481): a real root-caused bug preserved as paired expected/forbidden filtergraph shapes, with the failure message naming the original bug.
5. **`map_ingest_filter_runs_on_bare_rawvideo_rgba`** (color_fixtures.rs:1502-1567): runtime zimg-planning verification complementing string-level tests — the codified "empirically validate FFmpeg filters" lesson.
6. **Ratio-based timing assertion** in `encoder_probe.rs:126-166`: cache-hit must be 2× faster than a forced re-probe *on the same machine in the same run* — verifies caching behavior without any absolute-threshold flakiness.
7. **`tileCacheKeyParity.test.ts`** (header, lines 1-15): deliberately *non-circular* — instead of re-asserting the unit-mocked invariant, it inspects what the real worker wrote to disk and matches sha256-of-original-URL shard paths, catching a hash-on-wrong-URL regression "even if every unit test still passes."
8. **`cameraIntent.test.ts` + `routeLocation.test.ts`** (2,300 lines combined): genuine behavioral coverage of the transition/boundary math with named invariants (purity, no inverted spans, clamp semantics).
9. **Renderer determinism test** (`protocol.test.ts:231-264`): two renders at the same `project_time_ms` must be byte-identical — the cheapest possible statement of the export contract.

---

## 7. Questionable decisions (with severity)

| # | Finding | Location | Severity |
|---|---|---|---|
| Q1 | No pixel-/signal-level HDR output verification anywhere; the diagnosed HLG ref-white bug passes the entire suite. HDR is a co-equal CURRENT delivery target per project rules. | `export/delivery.rs:380+` (string tests), `color_fixtures.rs:1108-1159` (tag tests); absence everywhere else | **high** |
| Q2 | No CI of any kind; coverage thresholds, feature-gated integration suites, and golden frames are enforced by nothing. Working tree currently red (1 test). | `.github/` absent; `package.json` scripts; `Cargo.toml:34-44` | **high** |
| Q3 | `golden_frame_parity` silently skips when `TRAILCUT_CHROME_BIN` unset — explicit violation of the loud-failure rule on the flagship parity guard. | `tests/golden_frame_parity.rs:103-113, 249-258` | **high** |
| Q4 | 920-line `shapes.ts` (SDF icon rasterization; pin shape under active repair) has no direct test; decoration fidelity guarded only by expression-string assertions and a 4-frame golden fixture with no waypoints/shapes/gradients. | `src/lib/mapVisuals/shapes.ts`; `styleSpec.test.ts:349-419`; `fixtures/golden-frames/README.md:7-31` | **high** |
| Q5 | mapVisuals contract untested at the consumption layer: MapView and sidecar `init.ts` each hand-apply per-frame paints with no test that the two application sites match; `MapView.tsx` has zero tests. | `MapView.tsx:661-723`; `sidecars/renderer/page/init.ts:509-533, 789-805` | **medium** |
| Q6 | Export orchestration error paths untested (worker crash, sink failure, `finalize_worker_error`); `error.rs` 0 tests, `ffmpeg_sink.rs` 1 test. | `export/orchestrator.rs:586`; `export/error.rs`; `export/ffmpeg_sink.rs:289` | **medium** |
| Q7 | `util/exiftool.rs` 0 tests — CreationDate fallback chain (named key design decision) unguarded; ditto media import merge/dedup and GPX parsing commands. | `util/exiftool.rs:26-61`; `commands/media.rs`; `commands/gpx.rs` | **medium** |
| Q8 | `integration_export_parity` feature declared but no test behind it; the B+C≡A compositing-parity guarantee was deferred and never landed. | `Cargo.toml:40-44`; `render_export_composite.rs:24-30` | **medium** |
| Q9 | End-to-end pixel checks in render_export suites are intentionally weak (">30 in some channel"); fine as plumbing checks, but they are the *only* default-runnable visual checks of composite output. | `render_export_composite.rs:464-488` | **low** |
| Q10 | `colorParityProbe.ts` / `perfProbe.ts` are assertion-free manual scripts living in `__tests__/` — useful diagnostics, but their placement implies coverage that doesn't exist. | `sidecars/renderer/__tests__/colorParityProbe.ts:1-13` | **low** |
| Q11 | Validation probe hardcodes a personal desktop path; gated and self-described as temporary, but still committed. | `src/lib/cameraIntent.validation.test.ts:23` | **low** |
| Q12 | `passWithNoTests: true` in the main vitest config — a glob regression silently yields a green empty run. | `vitest.config.ts` | **low** |

---

## 8. Verdict input

The test infrastructure is one of the **strongest** parts of this codebase — markedly deeper than typical for a project this age. The fixture/harness layer (color fixtures, golden frames, cross-port shared fixtures, determinism contracts) embodies real hard-won knowledge and should be preserved nearly verbatim in any rewrite; rebuilding it from scratch would re-pay months of FFmpeg/zimg/MapLibre archaeology.

But the suite's shape mirrors the owner's stated pain precisely: coverage is excellent where modules are deep and pure (camera math, filter-string builders, migrations, layout), and absent exactly where the recurring roadblocks live — HDR *signal correctness*, decoration *pixels*, and the preview/export *application* seam. The tests verify that the strings and tags are as designed; nothing verifies that the design produces correct light. Combined with no CI, the guard rails that do exist (golden frames, renderer protocol tests) are opt-in and quietly stale-able.

Salvage recommendation: **keep-with-cleanup.** Carry the harnesses (§6) forward as-is; fix Q3 (loud skip), add CI as the first structural change, and the single highest-leverage new test is an HDR output-frame signal-level assertion (white map pixel ≈ 0.75 HLG) built from machinery that already exists in `color_fixtures.rs` + `render_export_composite.rs`.
