# Task 080 — First concrete layout (9:16 PiP-bottom-right baseline)

**Step**: Export pipeline (data-on-disk and editor surface — first place a layout actually lives in a project bundle)
**Estimated effort**: 6–8h
**Status**: pending
**Depends on**: 050 (`LayoutConfig`, `ProjectLayouts`, `defaultLayout`, `resolveSlots`). 060 / 070 / 090 do not block this task; they each consume `project.layouts` via `pickLayout` (which falls back to `defaultLayout` when the field is `None`), so 080 is strictly a forward step from "fallback every time" to "real stored layout once."

## Goal

Promote `defaultLayout('9_16')` from "TS-only fallback used at export time" to "concrete `LayoutConfig` value that lives in every new project bundle and is visible in the editor before export." After this task:

- New projects ship with `project.layouts = { '9_16': defaultLayout('9_16'), '4_5': null, '16_9': null }` written to `project.json` on first save. Existing v4 projects continue to load with `layouts: None` and lazy-init that field on first save (no migration bump — the field is `Option`, the change is in *production* of new projects, not in *consumption* of old ones).
- A new read-only **layout preview overlay** sits above the `VideoPreview` pane, drawing the configured 9:16 layout's slot rects (map outline, video outline, corner-radius arc on the inset). Toggleable via a "Show layout" button in the preview's existing collapsible toolbar; persists per-project via the existing auto-save plumbing.
- 060's "Export map-only (.mov)" button and 070's "Export video-only (.mov)" button stop relying on `pickLayout`'s `defaultLayout` fallback for new projects — `project.layouts['9_16']` is populated and is what they read. (`pickLayout` keeps the fallback for defensive correctness; 080's tests verify the fallback path is *cold* on freshly-created projects.)
- Acceptance includes a screenshot in the task PR showing the overlay rendered at 9:16 PiP-bottom-right, so a future reader can see what "first concrete layout" looks like without reading code.

This is the bridge task between 050 (types and pure helpers in code) and 110 (configurator UI that mutates layouts). Without 080, the layout system has *no editor presence* — a user opens a project and sees no indication that an export will compose map + video at specific slot rects. With 080, the layout exists in the file, exists on screen, and is the data the configurator UI in 110 will mutate. 090 (Channel A composite) consumes the same `project.layouts['9_16']` for its overlay-onto-map filtergraph.

**The load-bearing invariant — if it's in the project on disk, it's what the export uses.** Today, every export rebuilds `defaultLayout('9_16')` at call time via `pickLayout`'s fallback. That works exactly until a user expects "what I saw in the editor" to be "what I got in the export," and the only way to honor that expectation is for the editor and the export to read the *same stored value*. 080 makes the project bundle the source of truth: the editor reads `project.layouts[aspect]`, the export reads `project.layouts[aspect]`, the configurator (110) writes `project.layouts[aspect]`. The fallback in `pickLayout` survives as a safety net for projects created before 080, but the production path no longer touches it for fresh projects. This is also what unblocks 090: a composite export needs an unambiguous layout, and "the one in the file" is the only correct answer.

## Files to touch

- Modified: `src-tauri/src/models.rs` — replace `Project::default()`'s `layouts: None` with a populated `ProjectLayouts { aspect_9_16: Some(default_layout(AspectRatio::NineSixteen)), aspect_4_5: None, aspect_16_9: None }`. Add a unit test confirming the default Project's `layouts` are non-`None` and the 9:16 entry resolves to a non-degenerate slot rect via `resolve_slots`. The 4:5 / 16:9 entries stay `None`; they're seeded the first time the user picks those aspects in the configurator (110), not at project creation. This keeps `defaultLayout` from imposing aesthetic decisions on aspects the user may not even use.

- Modified: `src-tauri/src/commands/project.rs` — `load_project`'s v4 deserialize path is unchanged at the deserialize call (the field already round-trips), but **add a backfill step**: after a successful v4 deserialize, if `project.layouts.is_none()`, set it to the seeded shape. This handles projects created between 050's landing and 080's — the field was deserializable but null, and 080 brings them up to "9:16 seeded" the next time they're saved. Backfill is silent (no migration bump — the schema didn't change, only the data).

- Modified: `src/hooks/useAutoSave.ts` — when the auto-save constructs the `Project` object before invoking `save_project`, it currently passes `layouts: project.layouts`. After 080, fresh projects loaded into the frontend already have `layouts` populated by Rust's backfill; the auto-save just round-trips the field. **Add a defensive backfill** at the construction site too — if `project.layouts` is missing or `null`, seed it with `{ '9_16': defaultLayout('9_16'), '4_5': null, '16_9': null }` before saving. The defensive write makes the frontend tolerate a Rust-side miss and ensures the file on disk always carries the field. Pure, no observable behavior change for new projects — only matters for hand-edited or legacy bundles.

- Modified: `src/types.ts` — `Project.layouts` is currently `ProjectLayouts | undefined`. Tighten to `ProjectLayouts` (always present after backfill) and update the few existing usages. The Rust side guarantees population on load; the TS side tightens the type to match. (`ProjectLayouts` itself remains a record with `LayoutConfig | null` per aspect — only the *outer* field tightens.)

- New: `src/components/LayoutPreview/LayoutPreview.tsx` — read-only overlay component. Props:
  ```ts
  interface LayoutPreviewProps {
    layout: LayoutConfig;
    aspect: AspectRatio;
    /** Container size in CSS pixels (the VideoPreview pane). The component
     *  scales output dims to fit this box, preserving aspect. */
    containerWidth: number;
    containerHeight: number;
  }
  ```
  Renders an absolutely-positioned `<svg>` matching `OUTPUT_DIMS[aspect]` aspect ratio, with two `<rect>` elements (map slot, video slot) outlined; the inset rect uses `rx`/`ry` for the corner radius (resolved via `resolveSlots`). Labels — "Map" centered in the map slot, "Video" centered in the video slot — use `<text>` with a translucent backdrop. Pointer events disabled (`pointer-events: none`) so the overlay doesn't steal clicks from the underlying video.

- New: `src/components/LayoutPreview/LayoutPreviewToggle.tsx` — small button that lives inside the `VideoPreview` pane's existing collapsible toolbar (or the top-right of the pane if the toolbar is the wrong fit; pick whichever has space without crowding existing controls). State persisted via the existing auto-save mechanism — add `project.ui_state?.layoutPreviewVisible: boolean` (or wire it through the existing transient editor-state surface; pick the lower-friction path). On toggle, the overlay shows/hides; default off (the user is editing video, not laying out, until they explicitly want to see the layout).

- New: `src/components/LayoutPreview/__tests__/LayoutPreview.test.tsx` — vitest + @testing-library/react. Cases:
  - 9:16 PiP-bottom-right (`defaultLayout('9_16')`): two rects render, the inset's bounding box matches `resolveSlots(...).map_slot` scaled into the container, the corner radius is non-zero (rounded-rect SVG path).
  - 16:9 PiP-bottom-right (`defaultLayout('16_9')`): the container's aspect-fit math produces letterbox/pillarbox correctly — overlay's drawn area sits in the centered aspect-correct region, not stretched to fill the container.
  - Split layout (synthesized; no default for 080 but the component must render it for forward-compat): two rects share an edge, no corner radius arc.
  - Pointer events: the overlay has `pointer-events: none`; `userEvent.click` at overlay coordinates fires the underlying element's handler.

- Modified: `src/screens/ProjectView.tsx` — render `<LayoutPreview ... />` absolutely-positioned over the `VideoPreview` pane when the toggle is on. Read the layout via `project.layouts['9_16']` (with the existing `pickLayout` fallback as a safety net). Wire the toggle state to the auto-save round-trip.

- Modified: `src/lib/__tests__/exportRequest.test.ts` — add a test asserting that a freshly-loaded project (mock `load_project` response with seeded `layouts`) produces an export request whose `layout.layout` is the seeded value — *not* `defaultLayout(...)` from a fallback. Differentiates with a non-trivial mutation: the test mock returns a layout where `inset.x = 0.5` (different from `defaultLayout`'s 0.65); the request must round-trip *that* value, proving the path is "stored, not regenerated."

- Modified: `src-tauri/tests/project_load_save_roundtrip.rs` (or wherever the load/save test fixture lives — confirm at acceptance time, create if missing) — add a case: a v4 project saved with a populated `layouts` round-trips byte-equal; a v4 project saved with `layouts: null` loads back with `layouts` populated by the backfill (the disk file remains `null`-valued unless re-saved; the in-memory `Project` is populated).

- Modified: `docs/export/tasks/README.md` — flip 080 to ⬜→🟡→✅ as it lands; link this file.

- Untouched in this task: the configurator UI (110) — 080 ships read-only visualization only. Drag handles, snap targets, swap toggles, and corner-radius sliders all wait for 110. 4:5 and 16:9 layouts (100) — those aspects stay at `null` until the user explicitly picks them; the layout preview is gated to "9:16 only" for now, with a "Configure other aspects via the layout configurator (coming in a later release)" tooltip on the toggle when other aspects might be wanted. Live-preview WYSIWYG drift (LAYOUT.md §5) — the editor's `MapView` pane still renders at pane size, not at the slot dims. 080 *visualizes* the slot rects via the overlay; resolving the WYSIWYG drift (rendering MapView at slot dims) is a follow-up task that depends on the slot-aware preview design landing first.

## Deliverables

### `Project::default()` change (in `src-tauri/src/models.rs`)

```rust
impl Default for Project {
    fn default() -> Self {
        Project {
            schema_version: CURRENT_SCHEMA_VERSION,
            version: 1,
            name: String::new(),
            thumbnail: None,
            clips: Vec::new(),
            route: None,
            // Seed 9:16 with the baseline PiP-bottom-right layout. 4:5 and
            // 16:9 stay None — they get seeded by the configurator UI (110)
            // when the user first picks those aspects, so we don't impose
            // aesthetic decisions on aspects the user may not use.
            layouts: Some(ProjectLayouts {
                aspect_9_16: Some(default_layout(AspectRatio::NineSixteen)),
                aspect_4_5: None,
                aspect_16_9: None,
            }),
            map_settings: None,
            transition_feel: None,
            start_camera: None,
            default_entry_transition: None,
        }
    }
}
```

### `load_project` backfill (in `src-tauri/src/commands/project.rs`)

After the v4 deserialize, before returning:

```rust
let mut project: Project = serde_json::from_value(raw)
    .map_err(|e| format!("Failed to deserialize v4 project: {}", e))?;

// 080 backfill: pre-080 v4 projects have `layouts: None`. Bring them up to
// the seeded shape on read. Disk is unchanged until the next save_project.
// New projects (Project::default()) already carry the seed; this branch is
// strictly for projects created between 050 and 080 landing.
if project.layouts.is_none() {
    project.layouts = Some(ProjectLayouts {
        aspect_9_16: Some(default_layout(AspectRatio::NineSixteen)),
        aspect_4_5: None,
        aspect_16_9: None,
    });
}
```

The backfill is read-time only. `save_project` writes whatever's in memory; the disk file picks up the seeded layout on the next save (auto-save fires within 1s of any project mutation, so the gap is small in practice).

### `LayoutPreview` component (in `src/components/LayoutPreview/LayoutPreview.tsx`)

The overlay's SVG layout (sketch — `aspect = '9_16'`, `containerWidth = 540`, `containerHeight = 960` — i.e. the editor's preview pane):

```
┌────────────── containerWidth ──────────────┐
│  ┌── aspect-fit drawing area (1080×1920) ──┐
│  │                                         │
│  │             [Map] (full bleed)          │
│  │                                         │
│  │                                         │
│  │             ┌───────────────┐           │
│  │             │   [Video]     │           │
│  │             │   (inset)     │           │
│  │             └───────────────┘           │
│  │                                         │
│  └─────────────────────────────────────────┘
└─────────────────────────────────────────────┘
```

Wait — `defaultLayout('9_16')` is `inset_source: 'map'`, so the *map* is the inset and the *video* is the full bleed. Reverse the labels in the actual implementation (map small, video full). The sketch above is an example for the swapped variant; the test fixtures cover both.

Rendering details:
- The `<svg>` element's `viewBox` is `0 0 {output.w} {output.h}` — drawing in output-pixel coordinates lets the slot rect numbers from `resolveSlots` map directly to SVG coordinates with no extra math.
- Container fitting: a wrapping `<div>` uses `display: flex; align-items: center; justify-content: center` with the SVG sized via `width: min(containerWidth, containerHeight * aspectW / aspectH)` and `height` computed accordingly. Letterbox / pillarbox emerges from the flex centering when the container's aspect doesn't match the layout's aspect.
- Stroke: `1.5px` equivalent at output scale (so it's `1.5 / scaleFactor` in viewBox units to keep a constant on-screen stroke width). Color: a lightly-saturated cyan (`#52d6ff`) at 0.9 opacity for both rects; the Background slot uses a dashed stroke (4 4) to disambiguate from the inset's solid stroke.
- Corner radius: `rx={corner_radius_px}, ry={corner_radius_px}` on the inset's `<rect>`. The background slot has zero radius.
- Labels: `<text>` element centered in each rect, font-size `48px` at output scale, `fill: #52d6ff`, with a `<rect>` backdrop at 0.4 opacity for legibility against busy video frames.
- `pointer-events: none` on the SVG so the overlay never blocks clicks.
- A small `<title>` element with the layout's mode + aspect for debugging via DOM inspection.

The component is pure / presentational — no state, no side effects, no Tauri imports.

### `LayoutPreviewToggle` (in `src/components/LayoutPreview/LayoutPreviewToggle.tsx`)

Tiny button, lives next to the existing controls in `VideoPreview`'s toolbar (or top-right of the pane). Two states: "Show layout" / "Hide layout." On toggle, calls a callback the parent (`ProjectView`) wires into the auto-save'd UI state.

State persistence:
- The simplest place to store this is the same `Project` shape that auto-saves. The schema already has room for a `ui_state` field; add `Project.ui_state?: { layoutPreviewVisible?: boolean }` if it doesn't exist, or wire it through whatever transient-editor-state surface already lives in `useProject` / `useAutoSave`.
- Default off. Most users editing clips don't want a permanent overlay; users who configure the layout toggle it on, see what's there, and toggle it off.
- The toggle's persistence is *not* the load-bearing piece of 080 — if storing in the project bundle adds friction to existing schema flows, fall back to a localStorage-keyed-by-project-id approach. Prefer the project-bundle storage if it's a clean fit.

### `Project.ui_state` field (optional, scoped to this task — confirm scope before adding)

If the existing project model has nowhere natural for "is the layout overlay on," 080 introduces a small UI-state pocket:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectUiState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_preview_visible: Option<bool>,
}

// In Project:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub ui_state: Option<ProjectUiState>,
```

No schema bump (additive `Option` field). Future UI toggles — show route, show waypoints, show timeline rule overlay — extend this struct.

If the team prefers not to embed UI state in the project bundle (a defensible position — it bloats the file with non-creative-content state), drop this field and use localStorage keyed by `project.path`. The toggle UX is identical from the user's POV.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] **`Project::default()` test**: `Project::default().layouts.is_some()` and `layouts.as_ref().unwrap().aspect_9_16.is_some()`. The seeded layout `resolve_slots`'s output matches `defaultLayout('9_16')`'s expected slot rects (sanity check that the seed survives the round-trip — 050's parity test already covers TS↔Rust agreement on `resolve_slots`, so this is a thin guard).
- [ ] **`load_project` backfill test**: a v4 `project.json` written with `"layouts": null` loads with `project.layouts.is_some()`. A v4 `project.json` written with a populated `layouts` round-trips byte-equal (no overwrite). The disk file with `"layouts": null` remains `null` until the next save (verified by stat'ing mtime + reading raw JSON post-load).
- [ ] **`useAutoSave` defensive backfill** (`src/hooks/__tests__/useAutoSave.test.ts` if it exists; create if missing): a Project loaded with `layouts: undefined` is saved with a populated `layouts`. An already-populated `layouts` round-trips unchanged.
- [ ] **`exportRequest` round-trip test**: a project whose `layouts['9_16'].inset.x = 0.5` (mutated from default's 0.65) produces an export request with `layout.layout.inset.x = 0.5` — proves the export reads the stored value, not the fallback.
- [ ] **`LayoutPreview` component tests** (`src/components/LayoutPreview/__tests__/LayoutPreview.test.tsx`):
  - 9:16 PiP-bottom-right: two rects render at the slot rects from `resolveSlots`. The inset's `rx`/`ry` is non-zero. The "Map" / "Video" labels are centered in the correct rects given `inset_source: 'map'`.
  - 16:9 with a 540×960 container: the SVG is centered horizontally with letterboxing (16:9 doesn't fit the 9:16-ish container).
  - Split layout (synthesized): two rects share an edge, neither has a corner radius.
  - `pointer-events: none` is set on the overlay; a `userEvent.click` at the same screen coordinates as a hidden underlying button fires the button's handler.
- [ ] **Manual smoke test on macOS dev machine**: open a fresh project, click "Show layout" in the VideoPreview toolbar. The 9:16 layout overlay appears: small map outline at bottom-right, video outline filling the rest. Toggle off. Save. Quit the app. Reopen the project. The toggle state and the layout itself persist (or the toggle resets to off if persistence was scoped to localStorage; in either case, the layout itself persists on disk).
- [ ] **No regressions in 060's button or 070's button**: clicking "Export map-only (.mov)" or "Export video-only (.mov)" on a fresh project produces the same output as before — the only change is that `pickLayout`'s fallback is no longer hit (verified by adding a one-shot `console.warn('pickLayout fell back to default')` instrumentation in the fallback path during the test, asserting it isn't called).
- [ ] **No reimplementation of slot math in `LayoutPreview`**: grep at acceptance time:
  - `grep -nE "1080|1920|1350|OUTPUT_DIMS" src/components/LayoutPreview/` returns matches only in test fixtures, not in the component source. The component reads dims via `resolveSlots` only.
- [ ] **PR includes a screenshot** of the overlay rendered on a real project at 9:16 PiP-bottom-right. The screenshot lives in the PR description, not committed to the repo (no docs/assets bloat).
- [ ] `docs/export/tasks/README.md` row 080 flipped to ✅, this file linked.

## Implementation notes

**Why seed 9:16 only, not all three aspects.** A user who never exports at 4:5 has no reason to carry a 4:5 layout in their project file — it's noise. The configurator UI (110) seeds an aspect's layout the moment the user picks that aspect, which is the right point for "I care about this aspect now." 080's job is to land the *first* aspect, the one the export flow already targets by default. Picking 9:16 specifically follows PLAN.md's framing of TrailCut as primarily a vertical-social-video tool (Stories / Reels / TikTok / Shorts), all of which are 9:16.

**Why not run the editor's `MapView` at the configured map slot dims yet.** That's the WYSIWYG fix for LAYOUT.md §5's known live-preview drift. It's a real follow-up task (likely 100-tier or its own ticket), but it touches the editor's resize/responsive layout, the `MapView`'s `resize` ticker, and the `cameraIntent.resolve` viewport semantics — bigger surface than 080's "show the layout in an overlay" scope. 080 makes the layout *visible* without changing where the map renders. The overlay is a UI primitive that the WYSIWYG fix builds on later (the slot rect numbers from `resolveSlots` are exactly what a slot-sized MapView needs).

**Why not let `pickLayout`'s fallback handle freshly-created projects forever.** The fallback is a safety net for a class of bugs that should not happen in production: a project bundle with a missing or malformed `layouts` field. Falling back means the export *works*, which is the right behavior at the IPC boundary. But editors and configurators need a real value to display and mutate — `null` is not editable. Seeding on creation gives every downstream consumer a real value to work with from frame one. The fallback survives so that a corrupt or hand-edited bundle doesn't brick the export.

**Why a separate "Show layout" toggle rather than always-on overlay.** A user editing a clip's trim or focal point doesn't want chrome on top of the video — that's noise. A user laying out a composite *does* want chrome. The toggle is cheap (one button, one state bit), and it keeps the editor's default state clean. The configurator UI (110) replaces the toggle with the configurator dialog itself, which has the overlay inherently visible.

**Why store the toggle in the project bundle (or localStorage) rather than in-memory only.** A user who opens a project, toggles the overlay on to inspect the layout, edits a clip, saves, quits — and reopens the same project an hour later — should not have to re-toggle. State that survives across sessions is the right default for editor preferences. The project-bundle path is preferred because it travels with the project (a user collaborating on a `.trailcut` bundle gets the same view); the localStorage fallback works if project-bundle storage is awkward to wire.

**Why the overlay component is in `src/components/LayoutPreview/` not `src/components/VideoPreview/`.** It's a layout-system primitive, not a video-preview primitive. Future consumers — the configurator UI (110), the parity-verification harness (120) — render it without the video. Co-locating with `VideoPreview` would couple it to the video's lifecycle.

**Why the SVG `viewBox` uses output-pixel coordinates.** `resolveSlots` returns `PixelRect`s in output pixels (1080×1920 for 9:16). The cleanest mapping is to set the SVG's `viewBox` to those same coordinates — the slot rect numbers map 1:1 onto SVG coordinates. The CSS-pixel scaling happens at the SVG element's `width`/`height` attributes, not in the rect math. Keeping the math in output-pixel space means the overlay's correctness has nothing to do with the container's CSS pixels — easier to reason about, easier to test.

**Why labels use a translucent rect backdrop.** Hiking video frames are often busy (sky, terrain, water — high-contrast in unpredictable directions). A label without backdrop drowns in clutter half the time. A 0.4-opacity rect behind the text is the cheapest legibility fix; matches conventions in screenshot-annotation tools.

**Backfill writes vs reads.** The Rust-side backfill on `load_project` populates the in-memory `Project`. The disk file isn't touched until `save_project` runs (which happens on the next auto-save). This is intentional — touching disk on a read is a side-effect that tests and tooling may not expect. The auto-save's debounced 1s window covers the gap in practice; a user who opens a project and immediately closes it without editing leaves the disk as-is, which is correct.

**Why the schema version doesn't bump for this.** Schema bumps happen when the *shape* of `Project` changes incompatibly (a field added with a default; a field removed; a field's type narrowed). 080 doesn't change `Project`'s shape — `layouts: Option<ProjectLayouts>` is the same shape it was after 050. What changes is the *production* of new projects (always seeded) and the *post-deserialize backfill* (read-time-only normalization). Both are pure data-population concerns at a layer above the schema. Bumping the schema would imply a migration, which here is a no-op.

**The fallback in `pickLayout` is a contract, not a mistake.** The configurator UI (110) and 090 (composite) both consume `project.layouts[aspect]`. When that's `null` (a user hasn't configured 16:9, say, but tries to export at 16:9), the export needs *some* answer. `pickLayout`'s fallback to `defaultLayout(aspect)` is that answer — it's correct behavior. 080 doesn't remove the fallback; 080 ensures the *common path* (9:16 fresh project) doesn't depend on it. The fallback's tests stay; new tests cover the seeded path.

**Why `defaultLayout` is the seed, not a synthesized "first run" layout.** `defaultLayout(aspect)` is what `pickLayout` already falls back to. Using the same function for seeding means there's exactly one definition of "what does a starter 9:16 layout look like" — a single source of truth for an aesthetic choice that the configurator UI (110) might iterate on. If the project lead later decides the starter should be 30% width instead of 28%, that change is one constant in `defaultLayout`; it propagates to seeded new projects, the `pickLayout` fallback, and any documentation that imports the function.

**Edge case — a v4 project with `layouts: { '9_16': null, '4_5': null, '16_9': null }`.** An existing project that has the field but with all three aspects null. The Rust backfill above only triggers when `project.layouts.is_none()`, not when individual aspect entries are null. That's intentional: the user may have explicitly cleared their 9:16 layout via a future configurator action ("Reset to default" → "no, I really want this empty"). 080's seed is a "first contact" feature, not a "reset to default any time" feature. If a future task wants the latter, it adds a separate "Reset to default" command in the configurator UI.

**Migration test fixtures.** The v3→v4 migration test from 050 should already cover "v3 project with no layouts → v4 project with `layouts: null`." Add a sibling test: "v4 project with `layouts: null` → after `load_project`, in-memory `project.layouts.is_some()`; after save, disk has the seeded layout." Both tests live in `src-tauri/tests/` and run as part of `cargo test`.

**Forward-compat for 4:5 and 16:9 layout previews.** The `LayoutPreview` component takes `aspect` as a prop and is forward-compatible with all three aspects. The toggle in 080 always shows the 9:16 layout (the only one seeded) — but a future task that adds an aspect picker in the editor swaps the prop value to `'4_5'` / `'16_9'` and the same component renders the right preview. No re-implementation needed downstream.

## Open questions deferred to follow-up tasks

- **Configurator UI** (110). Drag handles on the inset, snap targets, swap toggle, corner-radius slider, divider drag for Split mode. 080 ships read-only; 110 ships read-write.
- **Aspect picker** in the editor toolbar. Today the export buttons are hard-coded to 9:16; a picker that switches the editor's aspect (and the layout preview's aspect) is a 100-tier feature. Until then, the layout preview shows 9:16 only.
- **WYSIWYG live preview** (LAYOUT.md §5). Render the editor's MapView at the layout's `map_slot` dims, render the VideoPreview at the layout's `video_slot` dims, composite both into a single editor pane that matches what the export will produce. Bigger redesign than 080; the layout preview overlay is the visual primitive that fix builds on.
- **Per-clip layout-geometry overrides** (LAYOUT.md §4 v2+). The data model leaves room (`Clip.layout_overrides: Option<...>`); 080 doesn't add the field. Animated layout transitions are the same v2+ feature.
- **Default starter values per aspect.** The current `defaultLayout` constants (PiP, map inset bottom-right, ~28% width, 0.012 corner radius) are LAYOUT.md-flavored picks, not validated by user research. The configurator UI (110) is the right place to iterate; 080 ships the existing constants as the seed.
- **Toggle state's storage location.** Project-bundle vs localStorage was settled at acceptance time; if it lands in the project bundle and a future "shareable project bundle" feature wants to strip UI state on export-share, that's a 130-tier (or its own task) cleanup pass.
- **4:5 and 16:9 seed.** Deferred to the configurator UI (110) — those aspects seed when the user picks them. A "Seed all aspects upfront" alternative was considered and rejected; carrying layouts the user never uses pollutes the project file.

## Doc tie-in

- LAYOUT.md §1 — PiP layout mode is the seed; Split is forward-compatible in `LayoutPreview` but not seeded.
- LAYOUT.md §2 — `OUTPUT_DIMS['9_16']` is the dimension `LayoutPreview`'s SVG renders into; the component reads via `resolveSlots`.
- LAYOUT.md §3 — Layout × aspect matrix; 080 occupies one cell (9:16 PiP). Other cells fill in via 100 / 110.
- LAYOUT.md §4 — Configuration scope; `ProjectLayouts` is the per-aspect storage shape, 080 puts the first concrete value in it.
- LAYOUT.md §5 — Map slot viewport invariant; 080 *visualizes* the map slot's rect, doesn't yet render the editor's map at slot dims (that's the WYSIWYG follow-up).
- LAYOUT.md §6 — Channels and slot positioning; the 9:16 PiP-bottom-right inset is what 060's masked positional export draws around, what 070's video-only export pads around, and what 090's composite will overlay onto.
- 050 — `LayoutConfig`, `ProjectLayouts`, `defaultLayout`, `resolveSlots`. 080 is the first place these types live in real data on disk and on screen.
- 060 — Channel B's filter math depends on `corner_radius_slot` and `map_slot`; 080's seed is what produces those values for a fresh project (no more `pickLayout` fallback in the common path).
- 070 — Channel C's filter math depends on `video_slot`; same story.
- 090 — Channel A composite reads `project.layouts['9_16']`; 080 unblocks 090 by ensuring the field is populated.
- 110 — Configurator UI replaces 080's read-only overlay with interactive handles; the data model and the `LayoutPreview` component are the surface 110 builds on.
