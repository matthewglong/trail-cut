# Task 100 — Additional layouts + aspects (Split mode; 4:5 and 16:9)

**Step**: Export pipeline (data + matrix coverage — the layout system stops being "9:16 PiP only" and becomes the full Layout × Aspect × Channel matrix LAYOUT.md §3 promises)
**Estimated effort**: 8–12h
**Status**: pending
**Depends on**: 050 (`LayoutConfig`, `ProjectLayouts`, `defaultLayout`, `resolveSlots`, parity fixture), 060 (Channel B filtergraph + integration test scaffolding), 070 (Channel C filtergraph + integration test scaffolding), 080 (`Project::default()` seeding for 9:16; `LayoutPreview` component), 090 (Channel A filtergraph + `CompositeMode::Split` already in `filtergraph.rs`).

## Goal

Promote the layout system from "9:16 PiP, validated end-to-end" to "all six (mode × aspect) cells from LAYOUT.md §3, validated end-to-end across all three channels." After this task:

- Fresh projects ship with **all three aspects seeded** — `Project::default()` populates `aspect_9_16`, `aspect_4_5`, and `aspect_16_9` with their `defaultLayout(...)` values. 080's "9:16 only on creation" rule retires.
- A new `Project.selected_export_aspect: AspectRatio` field decides which aspect each `render_export` call targets. Stored as creative-content state (travels with the project bundle), defaults to `9_16`, backfilled on load for v4 projects.
- Split-mode starter geometry is callable via a new `defaultSplitLayout(aspect)` helper alongside the existing PiP-flavored `defaultLayout(aspect)`. Used by 110's mode toggle when the user switches PiP → Split; 100 ships the helper and tests, not the toggle.
- The integration-test matrix expands from "PiP-9:16 only" to **(PiP, Split) × (9:16, 4:5, 16:9) × (A, B, C)** — 18 cells, with Split's locked orientation per aspect (LAYOUT.md §3) honored. Existing PiP-9:16 tests stay; Split + non-9:16 cells are added.
- `LayoutPreview` (the read-only overlay from 080) is verified to render correctly for all six (mode × aspect) cells via tests; the component's aspect-fit math is already aspect-agnostic, so this is verification, not new code.
- The export-trigger surface in `ProjectView.tsx` reads `project.selected_export_aspect` instead of hard-coding `'9_16'`. **No new picker UI ships in 100** — the field is plumbed; surfacing it as an aspect picker is a follow-up wired alongside the configurator (110) or its successor.

This task is the bridge between "the pipeline works for the headline case" (post-090) and "the pipeline is ready for the configurator UI to mutate freely" (post-110). 110 produces all six cells via interactive editing; without 100, 110 would have no test ground for non-9:16 / non-PiP edits, and an export against a 4:5 Split layout would hit cold filtergraph code paths for the first time only when a user tries it.

**The load-bearing invariant — every (mode × aspect × channel) cell is paved end-to-end before the configurator ships.** The configurator UI (110) lets a user produce *any* `LayoutConfig` for *any* aspect for *any* channel. If even one cell of the matrix is broken at the filtergraph layer when the user lands there, the configurator becomes a bug-discovery surface rather than an editing surface. 100 closes this gap: every cell in LAYOUT.md §3, validated by an integration test, paved before the user can mutate into it. The existing `CompositeMode::Split` branch from 090 already exists in code — 100 verifies it produces the right pixels and extends coverage to 4:5 / 16:9, which until now were aspect-agnostic in code but unexercised in tests.

**The second load-bearing invariant — Split's orientation is locked by aspect.** LAYOUT.md §3: "16:9 → vertical divider (left/right); 9:16 / 4:5 → horizontal divider (top/bottom). Inverse-orientation splits are not supported in v1." This rule lives in `defaultSplitLayout` (returns a side-locked orientation per aspect) and in 110's mode toggle / swap (constrains `video_side` to the legal subset for the active aspect). 100 codifies the rule in `defaultSplitLayout` and in a new `legalSplitSides(aspect): readonly SplitSide[]` helper that 110 will consume for its UI affordances.

## Files to touch

- Modified: `src/lib/layout.ts`:
  - **Add**: `defaultPipLayout(aspect): PipLayout` — the existing `defaultLayout` body, extracted by name. The current `defaultLayout(aspect)` keeps its signature and delegates to `defaultPipLayout(aspect)` (backward-compatible re-export — every existing caller still gets the PiP starter). Rationale: 110's mode toggle synthesizes a fresh PiP when the user switches Split → PiP; calling `defaultPipLayout` is more legible than `defaultLayout`, which now reads ambiguously.
  - **Add**: `defaultSplitLayout(aspect): SplitLayout` — returns a starter Split layout with the aspect's locked orientation:
    - `9_16`: `{ mode: 'split', video_side: 'top', divider: 0.5 }` (top half is video, bottom is map).
    - `4_5`: `{ mode: 'split', video_side: 'top', divider: 0.5 }`.
    - `16_9`: `{ mode: 'split', video_side: 'left', divider: 0.5 }` (left half is video, right is map).
  - **Add**: `legalSplitSides(aspect): readonly SplitSide[]` — for `9_16` and `4_5` returns `['top', 'bottom']`; for `16_9` returns `['left', 'right']`. Used by 110's swap-toggle UI to constrain `video_side` to the legal subset; in 100, exposed and tested only.
  - **Add (optional, scoped to this task)**: `clampLayout(layout, aspect): LayoutConfig` — pure helper that clamps inset coordinates to `[0, 1]`, clamps inset dimensions so the rect fits inside the frame, and clamps Split divider to `[0.05, 0.95]` (avoiding degenerate zero-width slots). Used in 110 for live drag clamping; landed here as a pure helper with full tests so 110 can consume it without bringing its own validation. If scope creep concerns arise at acceptance time, defer this to 110 — no consumer in 100 itself relies on it. **Recommended**: include here so 110 stays focused on UI.

- New: `src/lib/__tests__/layout.test.ts` additions (or co-located test file if `layout.test.ts` already exists from 050):
  - `defaultPipLayout` / `defaultLayout` agreement: each aspect produces the same `PipLayout` from both names.
  - `defaultSplitLayout` returns the aspect-locked orientation: `9_16` → `'top'`, `4_5` → `'top'`, `16_9` → `'left'`.
  - `legalSplitSides` returns the right pair per aspect.
  - `defaultSplitLayout(aspect)` produces non-degenerate slot rects via `resolveSlots` for each aspect (both `map_slot.w * h > 0` and `video_slot.w * h > 0`).
  - `clampLayout` (if shipped here): clamps PiP inset out-of-range coordinates back into the frame; clamps Split divider out of `[0.05, 0.95]` to the boundary; passes through valid layouts unchanged.

- Modified: `src-tauri/src/export/layout.rs` — Rust mirrors:
  - **Add**: `default_pip_layout(aspect) -> LayoutConfig` (the current `default_layout` body extracted by name).
  - **Add**: `default_split_layout(aspect) -> LayoutConfig` matching the TS values.
  - **Add**: `legal_split_sides(aspect) -> &'static [SplitSide]`.
  - **Add (if shipped)**: `clamp_layout(layout: &LayoutConfig, aspect: AspectRatio) -> LayoutConfig`.
  - Each new function gets a parity-fixture entry (see below).

- Modified: `src-tauri/tests/fixtures/layout_parity.json` — extend the 050 parity fixture with cases that exercise all six (mode × aspect) cells. New cases:
  - `defaultSplitLayout('9_16')` → expected `SlotResolution`.
  - `defaultSplitLayout('4_5')` → expected `SlotResolution`.
  - `defaultSplitLayout('16_9')` → expected `SlotResolution`.
  - `defaultPipLayout('4_5')` and `defaultPipLayout('16_9')` if not already present from 050.
  - Rationale for fixture-driven coverage: 050's fixture is the single point where TS and Rust agree on slot math; every new layout shape that ships in code lands an entry here so drift surfaces at test time. Both `npm run test:run` (TS) and `cargo test --test layout_parity` (Rust) load the same file.

- Modified: `src/types.ts`:
  - **Add**: `Project.selected_export_aspect: AspectRatio` — required field after backfill. The Rust side guarantees population on load; the TS type tightens to non-optional.
  - **Add**: re-export `defaultPipLayout`, `defaultSplitLayout`, `legalSplitSides`, and (if shipped) `clampLayout` from `layout.ts` if `types.ts` is the conventional import surface for layout helpers. (Confirm at acceptance time — 080 and 090 both import directly from `lib/layout`, suggesting `types.ts` is for shared types only. If so, skip the re-export.)

- Modified: `src-tauri/src/models.rs`:
  - **Add**: `Project.selected_export_aspect: AspectRatio` (with `#[serde(default = "default_selected_aspect")]` returning `AspectRatio::AspectNineSixteen`). No schema bump (additive field with a serde default; v4 projects without the field deserialize cleanly).
  - **Update `Project::default()`**: seed all three aspects, not just 9:16.
    ```rust
    layouts: Some(ProjectLayouts {
        aspect_9_16: Some(default_pip_layout(AspectRatio::AspectNineSixteen)),
        aspect_4_5: Some(default_pip_layout(AspectRatio::AspectFourFive)),
        aspect_16_9: Some(default_pip_layout(AspectRatio::AspectSixteenNine)),
    }),
    selected_export_aspect: AspectRatio::AspectNineSixteen,
    ```

- Modified: `src-tauri/src/commands/project.rs`:
  - **Extend the 080 backfill**: after the v4 deserialize, in addition to populating `layouts` when `None`, also seed individual `aspect_4_5` / `aspect_16_9` entries when the existing `layouts` is present but those entries are null. **Important — preserve user intent**: only auto-seed at *project load* if the project predates 100's landing (detectable by the absence of `selected_export_aspect`, which is the 100-introduced field). Once a project has been loaded by a 100-aware build (and `selected_export_aspect` is present), null entries are *intentional* — the configurator UI (110) will introduce a "clear this aspect" affordance, and re-seeding on every load would override that. The detection rule:
    ```rust
    let mut needs_full_seed = project.layouts.is_none();
    let is_pre_100 = !raw_value.get("selected_export_aspect").is_some();
    // ... existing 080 backfill for layouts.is_none() ...
    if is_pre_100 {
        if let Some(layouts) = project.layouts.as_mut() {
            if layouts.aspect_4_5.is_none() {
                layouts.aspect_4_5 = Some(default_pip_layout(AspectRatio::AspectFourFive));
            }
            if layouts.aspect_16_9.is_none() {
                layouts.aspect_16_9 = Some(default_pip_layout(AspectRatio::AspectSixteenNine));
            }
        }
    }
    ```
    `selected_export_aspect` itself is supplied by serde's `default` annotation when missing — no manual backfill needed for that field.
  - **Backfill is read-time only** (same pattern as 080): the disk file picks up the seeded values on the next save, not on the read itself.

- Modified: `src/hooks/useAutoSave.ts` — defensive backfill at the construction site (mirrors 080):
  - If `project.selected_export_aspect` is missing, default to `'9_16'` before saving.
  - If `project.layouts` exists but individual aspect entries are null *and* this is a fresh load (no `selected_export_aspect` was set on the loaded value), seed them. Apply the same "pre-100 only" detection — once a project is 100-aware, null entries are user-intent and stay null.

- Modified: `src/lib/exportRequest.ts` — no API change. The `aspect` parameter already exists on `ExportRequestInputs`; the caller now reads it from `project.selected_export_aspect` rather than hard-coding `'9_16'`. Add a unit test asserting that `pickLayout` returns the seeded value (not the fallback) for all three aspects when the project carries fully-seeded layouts.

- Modified: `src/screens/ProjectView.tsx`:
  - The three export handlers (`handleExportMapOnly` / `handleExportVideoOnly` / `handleExportComposite`) read `project.selected_export_aspect` and pass it to `buildExportRequest`. The output-file extension stays per-channel (`.mov` for B/C, `.mp4` for A); aspect doesn't change extension.
  - The `LayoutPreview` overlay in the editor reads `project.selected_export_aspect` and `project.layouts[aspect]` (currently hard-coded to `'9_16'`). The toggle's tooltip text updates to "Show the {aspect} layout overlay" with the active aspect interpolated.
  - **No aspect picker UI in this task.** The selected aspect is a single project field; surfacing it as a picker is a follow-up. To make 100 testable end-to-end without a picker, expose a developer-mode keyboard shortcut or temp `<select>` near the Show layout toggle that mutates `project.selected_export_aspect` for the current session. Document its temporary nature in a code comment so 110 (or its UI follow-up) can replace it cleanly. Treat the temp control as scaffolding, not a deliverable.

- Modified: `src/components/LayoutPreview/__tests__/LayoutPreview.test.tsx`:
  - Add cases for all six (mode × aspect) cells. The component is aspect-agnostic; this is verification, not new behavior. Each case asserts the rendered SVG's `viewBox` matches `OUTPUT_DIMS[aspect]`, both rects render with the slot rects from `resolveSlots`, and (for PiP) the corner radius applies to the right slot per `corner_radius_slot`.

- Modified: `src-tauri/tests/render_export_map_only.rs`, `render_export_video_only.rs`, `render_export_composite.rs`:
  - Each gains a parametrized matrix sub-test that runs the export at all six (mode × aspect) cells legal for the channel. Existing 9:16-PiP cases stay (they're the smoke baseline); the matrix tests gate behind `--features integration_export_matrix` (a new sub-feature) since they run 5–6× as many exports as the existing suite.
  - Per cell, the assertions match what 060/070/090 already check (FFprobe dims, codec, frame count, audio if applicable, sampled pixels at known coordinates) — only the input layout and aspect change. The fixture project is the same 2-clip fixture 070/090 already use.
  - Split-orientation legality assertion: each test constructs the Split layout via `default_split_layout(aspect)` (Rust) so the fixture's `video_side` matches the aspect-locked orientation; constructing an inverse-orientation Split (e.g., `'left'` at `9_16`) is *not tested* here — that's a "the type allows it; the configurator forbids it" surface validated in 110.

- New (optional): `src-tauri/tests/render_export_split_legality.rs` — a thin test that constructs an inverse-orientation Split (`'left'` at `9_16`) and runs `render_export`. Asserts: either the export errors at `validate_request` (preferred — the validator could grow a `legal_split_sides` check), or the export succeeds with degenerate-but-correct output (the math still works; it just produces a layout the UX disallows). Pick one and document. **Recommended**: validator rejects with `RenderExportError::validation`; cleaner contract, surfaces bad project files. Add the corresponding TS-side check in `buildExportRequest` so the editor catches it before IPC. If skipped here, list as an open question.

- Modified: `docs/export/tasks/README.md` — flip 100 to ⬜→🟡→✅ as it lands; link this file. Update row 110's "Depends on" to add 100 (the configurator's swap-toggle and mode-toggle consume `legalSplitSides` and `defaultSplitLayout` from this task).

- Untouched in this task: the configurator UI (110) — 100 ships data + tests + a temporary aspect-selection scaffold; 110 ships the configurator. WYSIWYG live-preview (the editor's MapView pane rendering at slot dims, LAYOUT.md §5) — separate concern, separate task. Per-clip layout overrides (LAYOUT.md §4 v2+). Animated layout transitions (v2+). Sidecar bundling (130).

## Deliverables

### `defaultSplitLayout` (in `src/lib/layout.ts`)

```ts
/** Reasonable starting Split layout per aspect, with the orientation locked
 *  per LAYOUT.md §3 (16:9 → vertical divider; 9:16 / 4:5 → horizontal). The
 *  user can flip `video_side` to the other legal side via the swap toggle in
 *  the configurator (110); inverse-orientation splits are forbidden. */
export function defaultSplitLayout(aspect: AspectRatio): SplitLayout {
  switch (aspect) {
    case '9_16':
    case '4_5':
      return { mode: 'split', video_side: 'top', divider: 0.5 };
    case '16_9':
      return { mode: 'split', video_side: 'left', divider: 0.5 };
  }
}

/** The two `video_side` values legal for a given aspect's Split orientation.
 *  The configurator's swap toggle (110) constrains its choices to this
 *  subset; the validator (`buildExportRequest` / `validate_request`) rejects
 *  out-of-set values. */
export function legalSplitSides(aspect: AspectRatio): readonly SplitSide[] {
  return aspect === '16_9' ? (['left', 'right'] as const) : (['top', 'bottom'] as const);
}
```

### `Project::default` change (in `src-tauri/src/models.rs`)

```rust
impl Default for Project {
    fn default() -> Self {
        Project {
            schema_version: CURRENT_SCHEMA_VERSION,
            // ...existing fields...
            // 100: seed all three aspects on creation. 080's "9:16 only on
            // creation" rule retires — every cell in LAYOUT.md §3 now lands
            // a starter the user can edit, swap, or replace via the
            // configurator (110).
            layouts: Some(ProjectLayouts {
                aspect_9_16: Some(default_pip_layout(AspectRatio::AspectNineSixteen)),
                aspect_4_5: Some(default_pip_layout(AspectRatio::AspectFourFive)),
                aspect_16_9: Some(default_pip_layout(AspectRatio::AspectSixteenNine)),
            }),
            selected_export_aspect: AspectRatio::AspectNineSixteen,
            // ...
        }
    }
}
```

### `selected_export_aspect` serde wiring (in `src-tauri/src/models.rs`)

```rust
fn default_selected_aspect() -> AspectRatio {
    AspectRatio::AspectNineSixteen
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    // ...
    #[serde(default = "default_selected_aspect")]
    pub selected_export_aspect: AspectRatio,
    // ...
}
```

The serde default handles three cases without explicit backfill code:
1. v4 projects from before 100: field absent → `9_16`.
2. v4 projects from 100+: field present → round-trips.
3. New projects: `Project::default()` populates it explicitly.

### Integration-test matrix (sketch, applied to all three channels)

```rust
// src-tauri/tests/render_export_map_only.rs
#[test]
#[cfg_attr(not(feature = "integration_export_matrix"), ignore)]
fn channel_b_full_matrix() {
    for aspect in [AspectRatio::AspectNineSixteen, AspectRatio::AspectFourFive, AspectRatio::AspectSixteenNine] {
        for layout in [
            default_pip_layout(aspect),
            default_split_layout(aspect),
        ] {
            let request = build_test_request(aspect, layout, /* channel */ "map_only");
            let summary = run_render_export_blocking(request).expect("export ok");
            let probed = ffprobe_output(&summary.output_path);
            let dims = output_dims(aspect);
            assert_eq!(probed.video.width, dims.w);
            assert_eq!(probed.video.height, dims.h);
            assert_eq!(probed.video.codec, "prores");
            assert_eq!(probed.video.pix_fmt, "yuva444p10le");
            // Per-aspect / per-mode pixel sampling at known coords (slot
            // center vs. masked region) — same shape as 060's existing test,
            // generalized over the input layout.
        }
    }
}
```

The same matrix applies to `render_export_video_only` (Channel C — mirror of B with audio assertions) and `render_export_composite` (Channel A — H.265 assertions, opaque-output assertion, both `inset_source` flips for PiP, no `inset_source` for Split). Channel A's matrix also runs the compositing-parity sub-test (B+C externally → vs A directly) at one non-9:16 aspect to catch aspect-specific drift.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] **`Project::default()` test**: all three of `aspect_9_16`, `aspect_4_5`, `aspect_16_9` are `Some(...)` after `Project::default()`. Each entry's `resolve_slots` returns non-degenerate slot rects.
- [ ] **`load_project` migration / backfill tests**:
  - A v4 `project.json` without `selected_export_aspect` deserializes with `selected_export_aspect = AspectNineSixteen` via the serde default.
  - A v4 `project.json` with `layouts: { '9_16': {...}, '4_5': null, '16_9': null }` and no `selected_export_aspect` (a pre-100 project that landed after 080) loads with all three aspects seeded (the pre-100 detection rule fires).
  - A v4 `project.json` with `layouts: { '9_16': {...}, '4_5': null, '16_9': null }` *and* `selected_export_aspect: '9_16'` (a post-100 project where the user has explicitly cleared 4:5 and 16:9 via a future 110 affordance) loads with `aspect_4_5` and `aspect_16_9` *staying null* — user intent preserved.
  - A round-trip test: load a v4 project, mutate `selected_export_aspect` to `'4_5'`, save, reload — value persists.
- [ ] **TS layout parity**: `npm run test:run` includes the new `defaultSplitLayout` / `legalSplitSides` cases. The shared parity fixture has new entries for all six (mode × aspect) cells, and both ports agree.
- [ ] **Rust layout parity**: `cargo test --test layout_parity` passes for the new fixture entries.
- [ ] **`legalSplitSides` correctness**: `9_16` and `4_5` return `['top', 'bottom']`; `16_9` returns `['left', 'right']`. Same in both ports.
- [ ] **`defaultSplitLayout` correctness**: returns the aspect-locked orientation per the deliverable above.
- [ ] **`LayoutPreview` matrix tests** (`src/components/LayoutPreview/__tests__/`): the read-only overlay renders correctly for all six cells. Each test asserts the SVG's `viewBox` matches `OUTPUT_DIMS[aspect]` and both rects render at the slot rects from `resolveSlots`.
- [ ] **Integration matrix passes** (`cargo test --test render_export_map_only --test render_export_video_only --test render_export_composite --features integration_export_matrix`): all 18 cells (6 layouts × 3 channels) produce valid output. Sampled pixel assertions match what each channel test already checks at 9:16-PiP, generalized.
- [ ] **Compositing parity at non-9:16** (`cargo test --test render_export_composite --features integration_export_parity`): the existing B+C-vs-A pixel diff test runs at one non-9:16 aspect (pick `4_5`, the densest pixel count of the three) and passes the same tolerance budget as 9:16. Catches aspect-specific drift in `overlay` coordinate math.
- [ ] **Split-legality enforcement** (if shipped): a `LayoutDescriptor` with `mode: 'split'` and an inverse-orientation `video_side` (e.g., `'left'` at `9_16`) is rejected by `validate_request` before any FFmpeg work begins, with `RenderExportError::validation` and a message that names the legal sides for the aspect. The TS-side `buildExportRequest` mirrors the check (throws synchronously). If deferred, listed as an open question with rationale.
- [ ] **`pickLayout` fallback is cold** for fully-seeded projects: an instrumentation hook in `pickLayout`'s fallback path (a `console.warn` or a test-only counter) is asserted not to fire during the matrix integration runs. Mirrors 080's "fallback cold on fresh projects" check, generalized to all three aspects.
- [ ] **No regression at 9:16-PiP**: the existing 060/070/090 integration tests continue to pass without `--features integration_export_matrix`. The matrix tests are additive.
- [ ] **Manual smoke test on macOS dev machine**: open a fresh project, use the temp aspect control to switch `selected_export_aspect` to `4_5`. The Layout overlay redraws at 4:5 dims. Run "Export composite (.mp4)" — output `.mp4` is 1080×1350. Repeat for `16_9` (output 1920×1080). Switch to a Split layout via the temp control (or by hand-editing `project.json`); export again — both outputs render correctly.
- [ ] **No reimplementation of layout math**:
  - `grep -nE "1080.*1350|1920.*1080|1080.*1920|video_side|legalSplitSides" src/ src-tauri/src/` returns matches only in `layout.ts` / `layout.rs` / their tests / the parity fixture / 110-bound consumers (which don't exist yet).
  - `grep -nE "default_split_layout|default_pip_layout|defaultSplitLayout|defaultPipLayout" src/ src-tauri/src/` shows the helpers used by callers, not redefined elsewhere.
- [ ] `docs/export/tasks/README.md` row 100 flipped to ✅; row 110 dependencies updated to include 100; this file linked.

## Implementation notes

**Why seed all three aspects on creation now (vs 080's "9:16 only").** 080's rationale was "don't impose aesthetic decisions on aspects the user may not use." That made sense when the configurator UI didn't exist and a user might reasonably never touch 4:5 / 16:9. Post-100, the matrix is fully exercised: every aspect produces correct exports, the configurator (110) lets users mutate any aspect freely, and the LayoutPreview supports all aspects. Carrying a starter for every aspect is no longer "aesthetic imposition" — it's "a sensible default the configurator opens with." The "user has explicitly cleared this aspect" use case is preserved via the pre-100 detection rule in the load backfill, which respects intent on post-100 saves.

**Why `selected_export_aspect` lives on the project, not in transient editor state.** The user's choice of "this video is for Reels (9:16)" or "this video is for IG feed (4:5)" is a creative-content decision. It belongs in the bundle so that opening a `.trailcut` file in any session — or sharing it with a collaborator — preserves the authoring context. localStorage would lose this on machine swap; in-memory state would lose it on reload. Project-bundle storage is the lowest-friction correct answer.

**Why the field is `selected_export_aspect`, not `aspect`.** The latter reads as "the project's aspect," which is wrong — a project can be exported at multiple aspects, and each has its own layout. The verbose name makes it clear: "this is the aspect the *export* is currently targeting," not "this is the project's aspect." Same noun-phrase that the configurator's UI will use ("Selected export aspect: 4:5").

**Why no aspect-picker UI in 100.** UI surface area is the user's concern, not the export pipeline's. The data plumbing (the field, the load/save round-trip, the export-request consumption) is well-defined; the picker can be a `<select>`, a tab strip, an icon group, a keyboard shortcut, or a sub-menu in a future export-settings dialog. 100 ships the *capability*; the *surface* lives wherever the broader UI design lands. Until then, a temp control suffices for testing — call it scaffolding, not a feature.

**Why Split's orientation is locked, not free.** LAYOUT.md §3: a vertical divider in 9:16 produces two extremely tall, narrow slots that are nearly unusable for either a map or a video; same for a horizontal divider in 16:9. The orientation lock prevents the user from configuring nonsense layouts. The lock lives in `defaultSplitLayout` (initial value) and `legalSplitSides` (UI affordance constraint); the type system doesn't enforce it (a `SplitLayout` with `video_side: 'left'` and aspect `9_16` is constructible) — `buildExportRequest` and `validate_request` enforce it at the IPC boundary.

**Why `legalSplitSides` returns a tuple, not a Set.** Both ports test on element identity (`.includes(side)` in TS, `.contains(&side)` in Rust); a 2-element tuple is the cleanest shape and the configurator UI iterates over it for swap-toggle rendering. A Set adds API surface without benefit at N=2.

**Why `clampLayout` lives here, not in 110.** Validation logic that the configurator and the export request both consume should live in `lib/layout.ts` next to the types it operates on. 110's drag hooks call `clampLayout` mid-drag to keep the live-edited value valid; 100's `buildExportRequest` could optionally call it as a pre-flight (though doing so would mask configurator bugs — better to validate-and-reject than silently-clamp at the IPC boundary). The placement here means 110 starts with a tested helper.

**Why split-legality enforcement lives in `validate_request`.** The renderer worker doesn't care about Split's orientation lock — `resolve_slots` produces correct math for any `(SplitLayout, AspectRatio)` pair. The lock is a UX rule, not a math rule. It belongs at the IPC boundary's validator: the configurator emits valid values, the validator rejects invalid ones, the renderer never sees an inverse-orientation Split. This keeps the renderer's contract minimal and the UX rule one-place-defined.

**Why the integration matrix is gated behind a sub-feature.** 18 export integration tests, each spawning FFmpeg and the renderer worker, runs in 60–120s on the author's machine. That's too slow for routine `cargo test`, but right for nightly CI or pre-release validation. The existing 9:16-PiP smoke tests run unconditionally and catch obvious breakage; the matrix catches aspect-specific or mode-specific drift that the smoke tests would miss. Same gating pattern as 090's compositing parity test.

**Why we don't add per-aspect default values that differ in shape.** The current `defaultPipLayout` constants per aspect (e.g., `9_16` inset at `(0.65, 0.78, 0.32, 0.18)`, `16_9` inset at `(0.72, 0.68, 0.25, 0.27)`) are LAYOUT.md-flavored picks — different inset proportions for visual balance at each aspect. They're "sensible starters," not normative. 110's configurator lets the user move freely; 100's job is to ship the starters as they are.

**Why the LayoutPreview matrix tests don't include manual screenshots in the PR.** 080's PR included a screenshot (single layout — easy to eyeball). 100's matrix is six cells; six screenshots in a PR description is noise. Confidence comes from the integration tests + the matrix unit tests asserting `viewBox` and rect coords. A spot-check screenshot at one new aspect (4:5 PiP) is fine if the reviewer wants it.

**Why we don't reshape the editor's VideoPreview pane to match `selected_export_aspect`.** That's the WYSIWYG live-preview question (LAYOUT.md §5), and it touches the editor's responsive layout, the `MapView`'s resize ticker, and the `cameraIntent.resolve` viewport semantics. Bigger surface than 100. The LayoutPreview overlay's aspect-fit math handles the visualization correctly today (letterbox / pillarbox emerges from the flex centering); the editor pane stays its current shape, which means the *layout's drawn area* is centered inside it and the surrounding pane shows source-video pixels at full pane size. Acceptable for v1; flagged in 100's open questions.

**Why we ship `defaultPipLayout` as a separate name even though `defaultLayout` is back-compat.** Readability when 110's mode toggle lands. `defaultLayout(aspect)` reads as "the default layout for this aspect," which is true today (PiP is the only default) but would mislead a reader of 110's code. `defaultPipLayout(aspect)` is unambiguous — and `defaultSplitLayout(aspect)` matches the naming. The back-compat re-export of `defaultLayout` is the lowest-friction path to not breaking 050/060/070/080/090 — they all import `defaultLayout` and the name keeps working.

**Why no `defaultLayoutForMode(mode, aspect)` dispatch helper.** A `switch` in the caller (110's mode toggle) is one statement and self-documenting; a dispatch helper adds an indirection that obscures the synthesis at the use site. If a future call site ends up doing the same `switch` more than twice, factor at that point.

**Edge case — a project loaded with `layouts: null` *and* `selected_export_aspect: '4_5'`.** Pre-100 projects don't have `selected_export_aspect`, so this combination is impossible from a real file. If it shows up (manual hand-edit), the load path treats it as post-100 (the field is present), runs the 080 backfill for `layouts.is_none()`, but does *not* re-seed the individual aspect entries. The user gets a 4:5 export at the seeded `aspect_4_5` from the 080-style backfill — correct fallback.

**Edge case — selected aspect is one whose layout entry is null.** `pickLayout` falls back to `defaultLayout(aspect)`. The export still produces correct pixels at the chosen aspect; the user's editor preview just shows the default until they configure. Same fallback semantics 080 established. Tests assert this works (the cold-fallback assertion above is a positive check that the fallback *isn't* hit on fully-seeded projects, not that it doesn't work — the fallback is valid contract).

## Open questions deferred to follow-up tasks

- **Aspect picker UI surface.** A picker, a tab strip, a sub-menu, a shortcut — owned by whichever task ships the broader export-settings UI. 100 ships the data; 110 may bundle the picker in its configurator dialog or leave it for a sibling.
- **Live-preview WYSIWYG** (LAYOUT.md §5). Render the editor's MapView at the `selected_export_aspect`'s map-slot dims; render VideoPreview at the video-slot dims. Bigger redesign than 100.
- **Aspect-specific starter constants for `defaultSplitLayout`.** The current `divider: 0.5` and locked `'top'` / `'left'` are LAYOUT.md-flavored picks. UX iteration in 110 or its successors.
- **Per-aspect `selected_layout_mode`.** Some users might want "this project always exports as Split for 4:5 but PiP for 9:16" — the mode is currently stored *inside* `LayoutConfig`, so this is implicit (whichever mode the aspect's stored layout has). A more explicit per-aspect `mode` field is a 110+ design call.
- **Split-legality enforcement landing point.** If the recommendation above (validator + buildExportRequest) is rejected, alternative: enforce only at configurator (110) and let bad layouts produce ugly-but-correct exports. Pick at acceptance time.
- **Export-format defaults per aspect.** Different platforms prefer different bitrates / encoders at different aspects (e.g., Reels accepts up to 8 Mbps for 9:16 but 5 Mbps for 4:5 feeds). Tied to the configurator's quality knob; out of scope here.
- **`clampLayout` for export-time defense.** Should `buildExportRequest` defensively clamp incoming `LayoutConfig`s, or trust the configurator? Current bias: trust + reject. Revisit if production bug reports show malformed layouts hitting export.

## Doc tie-in

- LAYOUT.md §1 — both layout modes; 100 lands every cell of "PiP × {three aspects}" + "Split × {three aspects}" end-to-end.
- LAYOUT.md §2 — output dimensions per aspect; the integration matrix asserts FFprobe sees the right dims for each aspect.
- LAYOUT.md §3 — Layout × aspect matrix; 100 paves every cell. Split's orientation lock per aspect is codified in `defaultSplitLayout` / `legalSplitSides` / the validator.
- LAYOUT.md §4 — Configuration scope; the per-aspect storage (from 050) is fully populated for fresh projects (from 100), and the "selected aspect" decision now lives in the project too.
- LAYOUT.md §6 — Channels and slot positioning; the matrix tests verify all three channels at all six layouts. The compositing-parity sub-test extends to a non-9:16 aspect.
- 050 — `LayoutConfig`, `ProjectLayouts`, `defaultLayout`, `resolveSlots`, parity fixture. 100 extends the fixture and adds `defaultSplitLayout` / `legalSplitSides` / `clampLayout` to the public API.
- 060 — Channel B integration tests; 100 extends to the matrix.
- 070 — Channel C integration tests; same.
- 080 — `Project::default()` seeded 9:16; 100 expands seeding to all three aspects and adds `selected_export_aspect`. The pre-100 backfill detection rule respects user intent for post-100 saves.
- 090 — Channel A integration tests; 100 extends to the matrix and runs compositing parity at one non-9:16 aspect.
- 110 — Configurator UI consumes `defaultPipLayout`, `defaultSplitLayout`, `legalSplitSides`, and `clampLayout` from this task. 110's swap toggle and mode toggle are the user-facing surfaces of `legalSplitSides` and `defaultSplitLayout` respectively.
- 120 — Render parity verification; the parity harness can sample any (mode × aspect × channel) cell once 100 lands. Until 100, parity is verifiable only at 9:16 PiP.
