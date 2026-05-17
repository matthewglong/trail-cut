# Task 050 — Layout descriptor types in TS + Rust; project-schema migration

**Step**: Export pipeline (data model — what a layout *is*, in code)
**Estimated effort**: 6–8h
**Status**: pending
**Depends on**: nothing — pure types + schema migration. Lands before any concrete-layout work (080), the channel sinks (060/070/090), and the configurator UI (110), all of which consume `LayoutConfig`.

## Goal

Codify LAYOUT.md's data model as concrete TypeScript and Rust types, and migrate the project schema to store one layout per output aspect. After this task:

- `LayoutConfig` is a discriminated union with `PipLayout` and `SplitLayout` variants in both languages, structurally identical, serde-compatible.
- `Project.layouts: ProjectLayouts | null` holds per-aspect (`9_16`, `4_5`, `16_9`) layouts, independently configured.
- A pure helper `resolveSlots(layout, aspect) -> { mapSlot, videoSlot, cornerRadius }` computes the concrete pixel rects from a layout config and an output aspect — used by the frontend (to set the worker's `viewport` and to build the IPC `LayoutDescriptor`) and mirrored in Rust (to position FFmpeg overlays, when 060+ lands).
- The placeholder `Project.exports: Vec<ExportConfig>` and the obsolete `ExportLayout`/`ExportResolution` shapes are removed; v3→v4 migration drops them from existing project bundles.

This is one of LAYOUT.md §9's two open implementation questions ("Concrete TypeScript and Rust types for `LayoutConfig`... and the wire format for the `LayoutDescriptor`... Project-schema migration to add per-aspect layout storage. The existing `ExportConfig.layout: ExportLayout` field in `models.rs` is a placeholder from earlier design and will need restructuring; this is a v3→v4 schema bump."). The other (configurator UI) ships in 110.

**The load-bearing invariant — one resolveSlots, two language ports.** Slot rect math (where the map and video slots sit in the output frame, in pixels) is pure and fully determined by `(LayoutConfig, AspectRatio)`. Both languages need the same math: TS to size the worker's `viewport` and to build the IPC payload, Rust to position FFmpeg overlays. There is no path where one side computes and forwards rects to the other (the wire payload carries both `LayoutConfig` *and* resolved rects so debugging is trivial, but each side computes from `LayoutConfig` independently and asserts equality). The TS implementation is the source of truth; the Rust port is a structural mirror, kept honest by a parity test that runs both with the same inputs and asserts identical outputs. This is the same pattern PLAN.md establishes for `cameraAt` and the `mapVisuals` module.

## Files to touch

- New: `src/lib/layout.ts` — types, output dimensions per aspect, `resolveSlots(layout, aspect)`, `defaultLayout(aspect)` (returns a starter PiP-bottom-right layout used when the user picks an aspect for the first time before configuring).
- New: `src/lib/__tests__/layout.test.ts` — vitest tests: `resolveSlots` table-driven across all (aspect × mode × swap × representative geometry) combinations; corner-radius pixel resolution; default layouts produce non-degenerate slot rects.
- New: `src-tauri/src/export/layout.rs` — Rust mirrors of `LayoutConfig`, `PipLayout`, `SplitLayout`, `ProjectLayouts`, `AspectRatio`; `resolve_slots(layout, aspect) -> SlotResolution` with identical math.
- New: `src-tauri/src/export/__tests___layout/parity.json` (or inline as a `const` in `layout.rs`) — fixture of `(LayoutConfig, AspectRatio, expected SlotResolution)` cases, the same fixture TS's test consumes. Keeps the two ports honest.
- New: `src-tauri/tests/layout_parity.rs` — Rust integration test that loads the fixture and asserts `resolve_slots(...)` matches the expected output. The TS unit test loads the same fixture and asserts the same expected output. Same fixture, same expected, two ports — drift surfaces at test time.
- Modified: `src/types.ts`:
  - **Remove**: `ExportLayout`, `ExportResolution`, `ExportConfig` interfaces.
  - **Remove**: `Project.exports: ExportConfig[]`.
  - **Add**: `Project.layouts?: ProjectLayouts` (re-export from `layout.ts` to keep `types.ts` as the single import surface).
- Modified: `src-tauri/src/models.rs`:
  - **Remove**: `ExportLayout`, `ExportResolution`, `ExportConfig` structs.
  - **Remove**: `Project.exports: Vec<ExportConfig>`.
  - **Add**: `Project.layouts: Option<ProjectLayouts>` (imported from `crate::export::layout`).
  - **Bump**: `CURRENT_SCHEMA_VERSION` from `3` to `4`.
- Modified: `src-tauri/src/commands/project.rs`:
  - **Add**: `migrate_v3_to_v4(raw)` — drops the `exports` array (it's a placeholder; no real data has ever been stored in it via UI), stamps `schema_version = 4`. Layouts default to `None`; user reconfigures via the configurator UI in 110.
  - Extend the `1 => migrate_v1_to_v2 → v2 → v3 → v4` chain in `load_project`.
  - Add a `2 => v2 → v3 → v4`, `3 => v3 → v4`, `4 => deserialize directly` branch.
- Modified: any frontend code referencing `ExportLayout` / `ExportResolution` / `ExportConfig` / `project.exports` — likely none (the export UI is unimplemented; the field is a placeholder). Verify via grep at acceptance time.
- Modified: `docs/export/tasks/README.md` — flip 050 to ✅; link this file.
- Untouched in this task: any IPC plumbing for `render_export`. The `LayoutDescriptor` wire shape is defined here as a TS type, but the Tauri command that consumes it lands in 060/090's full `render_export` surface.

## Deliverables

### TypeScript types (`src/lib/layout.ts`)

```ts
export type AspectRatio = '9_16' | '16_9' | '4_5';

export interface OutputDimensions { w: number; h: number }

/** Output pixel dimensions per aspect, fixed per LAYOUT.md §2. */
export const OUTPUT_DIMS: Record<AspectRatio, OutputDimensions> = {
  '9_16': { w: 1080, h: 1920 },
  '4_5':  { w: 1080, h: 1350 },
  '16_9': { w: 1920, h: 1080 },
};

/** Geometry stored in normalized 0..1 coordinates — survives an aspect change with a sensible default. Resolved to pixels by resolveSlots. */
export interface PipLayout {
  mode: 'pip';
  /** Which source is the inset; the other source is the background. */
  inset_source: 'video' | 'map';
  /** Inset rect, normalized to output frame: (0,0) = top-left, (1,1) = bottom-right of the output. */
  inset: { x: number; y: number; w: number; h: number };
  /** Corner radius in normalized units (fraction of `min(output.w, output.h)`); 0 = sharp. */
  corner_radius: number;
}

export interface SplitLayout {
  mode: 'split';
  /** Side that holds the video. Orientation derives from the aspect: 16:9 → 'left' | 'right'; 9:16 / 4:5 → 'top' | 'bottom'. */
  video_side: 'left' | 'right' | 'top' | 'bottom';
  /** Divider position normalized to the dividing axis (0..1). For 'left'/'right', this is x; for 'top'/'bottom', this is y. */
  divider: number;
}

export type LayoutConfig = PipLayout | SplitLayout;

export interface ProjectLayouts {
  '9_16': LayoutConfig | null;
  '4_5':  LayoutConfig | null;
  '16_9': LayoutConfig | null;
}

export interface PixelRect { x: number; y: number; w: number; h: number }

export interface SlotResolution {
  output: OutputDimensions;          // == OUTPUT_DIMS[aspect]
  map_slot: PixelRect;
  video_slot: PixelRect;
  /** Resolved corner radius in pixels (PiP only; 0 for Split). */
  corner_radius_px: number;
  /** Which slot the corner radius applies to ('video' / 'map' / 'none'). */
  corner_radius_slot: 'video' | 'map' | 'none';
}

/** Pure: identical Rust port asserts byte-equal output via the parity fixture. */
export function resolveSlots(layout: LayoutConfig, aspect: AspectRatio): SlotResolution;

/** Reasonable starting layout per aspect: PiP, video as background, map as bottom-right inset, ~28% scale, 12px corner radius equivalent. */
export function defaultLayout(aspect: AspectRatio): LayoutConfig;
```

### LayoutDescriptor (wire payload, consumed by `render_export` in 060/090)

```ts
export interface LayoutDescriptor {
  aspect: AspectRatio;
  layout: LayoutConfig;             // the user's raw config — round-trips for archival
  resolved: SlotResolution;         // computed by the frontend; Rust verifies by re-running resolveSlots
}
```

The full `render_export` Tauri command shape (defined in PLAN.md §"IPC contract") consumes this; this task ships the type, not the command.

### Rust mirrors (`src-tauri/src/export/layout.rs`)

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AspectRatio {
    #[serde(rename = "9_16")] AspectNineSixteen,
    #[serde(rename = "4_5")] AspectFourFive,
    #[serde(rename = "16_9")] AspectSixteenNine,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OutputDimensions { pub w: u32, pub h: u32 }

pub fn output_dims(aspect: AspectRatio) -> OutputDimensions { /* ... */ }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum LayoutConfig {
    Pip {
        inset_source: PipInsetSource,
        inset: NormalizedRect,
        corner_radius: f64,
    },
    Split {
        video_side: SplitSide,
        divider: f64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipInsetSource { Video, Map }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitSide { Left, Right, Top, Bottom }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct NormalizedRect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectLayouts {
    #[serde(rename = "9_16", skip_serializing_if = "Option::is_none")]
    pub aspect_9_16: Option<LayoutConfig>,
    #[serde(rename = "4_5", skip_serializing_if = "Option::is_none")]
    pub aspect_4_5: Option<LayoutConfig>,
    #[serde(rename = "16_9", skip_serializing_if = "Option::is_none")]
    pub aspect_16_9: Option<LayoutConfig>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct PixelRect { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SlotResolution {
    pub output: OutputDimensions,
    pub map_slot: PixelRect,
    pub video_slot: PixelRect,
    pub corner_radius_px: u32,
    pub corner_radius_slot: CornerRadiusSlot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CornerRadiusSlot { Video, Map, None }

pub fn resolve_slots(layout: &LayoutConfig, aspect: AspectRatio) -> SlotResolution;
pub fn default_layout(aspect: AspectRatio) -> LayoutConfig;
```

### Schema migration (v3 → v4)

`migrate_v3_to_v4(raw: serde_json::Value) -> Result<Project, String>`:

1. Strip the `exports` field if present. The field has been a placeholder; no UI ever wrote it. Drop it silently.
2. Insert `layouts: null`. Existing v3 projects post-migration have `layouts: None` and the user reconfigures via the configurator UI (110).
3. Stamp `schema_version: 4`.
4. Deserialize via `serde_json::from_value::<Project>(raw)`.

The migration chain in `load_project` extends to:

```rust
let project = match version {
    1 => { let v2 = migrate_v1_to_v2_value(raw)?; let v3 = migrate_v2_to_v3_value(v2)?; migrate_v3_to_v4(v3)? }
    2 => { let v3 = migrate_v2_to_v3_value(raw)?; migrate_v3_to_v4(v3)? }
    3 => migrate_v3_to_v4(raw)?,
    4 => serde_json::from_value::<Project>(raw).map_err(|e| format!("Failed to deserialize v4 project: {}", e))?,
    other => return Err(format!("Unsupported schema_version: {}", other)),
};
```

Note: this requires factoring `migrate_v2_to_v3` into a `_value` variant (currently it returns `Project` directly) so v1 projects can chain v1→v2→v3→v4 without re-deserializing twice. Mirror the existing `migrate_v1_to_v2_value` pattern.

## Acceptance criteria

- [ ] `cargo build` (in `src-tauri`) succeeds with the new module wired into `lib.rs`'s `mod export`.
- [ ] `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) is clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] **Layout parity test passes** in both languages:
  - TS: `npm run test:run` includes `src/lib/__tests__/layout.test.ts`. Cases cover all three aspects × both modes × representative geometry (PiP-bottom-right, PiP-top-left, PiP-centered with non-trivial corner radius, Split-50/50, Split-30/70, swap toggles for both modes).
  - Rust: `cargo test --test layout_parity` loads the same fixture and asserts identical `SlotResolution` for each case. Fixture lives in a single file (`src-tauri/tests/fixtures/layout_parity.json`); both tests load it.
- [ ] **Schema migration round-trip test** (`cargo test --lib commands::project`):
  - A synthesized v3 `Project` JSON (with the legacy `exports: [{...}]` populated) deserializes via `load_project` (a temp project bundle), re-serializes via `save_project`, and the result has `schema_version: 4`, no `exports` key, `layouts: null` (or absent + serde-default `None`).
  - A v4 project round-trips losslessly: write `Project { layouts: Some(ProjectLayouts { 9_16: Some(default_layout(NineSixteen)) ... }) }`, save, load, assert equality.
  - Legacy v1 and v2 projects continue to migrate cleanly (existing v1→v2 and v2→v3 tests are extended to migrate all the way to v4).
- [ ] **No remaining references** to the obsolete shapes:
  - `grep -rE "ExportLayout|ExportResolution|ExportConfig" src/ src-tauri/src/` returns nothing.
  - `grep -rE "project\\.exports|Project\\.exports|exports:" src/ src-tauri/src/models.rs` returns nothing.
- [ ] **`resolveSlots` purity contract**: same `(layout, aspect)` → same output across calls (TS test), and the function does not mutate its inputs (TS test passes `Object.freeze(layout)` and asserts no throw).
- [ ] **No reimplementation of geometry math anywhere else.** Grep at acceptance time:
  - `grep -rE "1080.*1920|1920.*1080|1080.*1350" src/ src-tauri/src/` returns matches only in `layout.ts` / `layout.rs` / their tests / fixtures. Output dims are not duplicated elsewhere.
- [ ] `docs/export/tasks/README.md` row 050 flipped to ✅, this file linked.

## Implementation notes

**Why normalized 0..1 geometry instead of pixels.** A user who configures a PiP-bottom-right at 1080×1920 (9:16) and then switches the project to a 4:5 export expects the inset to stay roughly bottom-right at the new aspect, not bunched in the corner because it was pixel-pinned to (760, 1600, 280, 280) which is now outside the 1080×1350 frame. Normalized geometry is the right primitive; the configurator UI in 110 may apply per-aspect overrides on top, but the data model leaves 0..1 in place. Rect normalization treats the frame as `(0,0)..(1,1)` regardless of aspect; `resolveSlots` multiplies by the aspect's pixel dims.

**Corner radius as a normalized fraction of the smaller dim.** Storing `corner_radius` as pixels would make a "12 px" radius look very different at 1080×1350 vs 1920×1080 (12px is much more prominent on the smaller frame). Storing as a fraction of `min(w, h)` produces visually consistent results across aspects. Resolved value (`corner_radius_px`) is computed in `resolveSlots` for downstream filtergraph consumers.

**Why the discriminator key is `mode`, not `kind` or `type`.** "Mode" is the noun LAYOUT.md uses ("layout modes — PiP and Split"). Matching the doc's vocabulary in the wire format means a future reader of `project.json` doesn't have to translate. Both serde and TS handle `mode` as a discriminator cleanly (`#[serde(tag = "mode")]` in Rust; structural discriminated unions in TS).

**Why `'9_16'` and not `'9:16'` as the key.** TypeScript object keys with colons need quoting and break some tooling autocomplete; serde rename to `9_16` keeps Rust idiomatic without a custom adapter; project.json keys with underscores are human-readable. The display layer (settings UI, export dialog) renders `'9:16'` for users — that's a presentation concern.

**Slot resolution math (table form for unambiguous spec).** Both ports must produce these exact pixel rects:

- **PiP** — `inset_source` chooses which slot is the inset. The other slot is the full output frame.
  - Inset slot: `{ x: round(inset.x * out.w), y: round(inset.y * out.h), w: round(inset.w * out.w), h: round(inset.h * out.h) }`.
  - Background slot: `{ x: 0, y: 0, w: out.w, h: out.h }`.
  - `corner_radius_px = round(corner_radius * min(out.w, out.h))`.
  - `corner_radius_slot = inset_source` (only the inset rounds).
- **Split** — divider orientation derives from `video_side`:
  - `'left'` (video) | `'right'` (video): vertical divider. Video slot: `{ x: 0, y: 0, w: round(divider * out.w), h: out.h }` if video on left; mirrored for right. Map slot: the complementary rect.
  - `'top'` | `'bottom'`: horizontal divider. Analogous.
  - `corner_radius_px = 0`, `corner_radius_slot = 'none'`.

`round` is half-away-from-zero (Rust's `f64::round`; TS's `Math.round` for non-negative values is equivalent). Both ports document the rounding choice in a comment so a future reader doesn't replace it with `floor` or `trunc` and silently break parity.

**`defaultLayout(aspect)`.** Use a PiP layout: video as background (`inset_source: 'map'`), map inset bottom-right at 28% width, 16px equivalent corner radius. Concrete values:

- 9:16: `inset = { x: 0.65, y: 0.78, w: 0.32, h: 0.18 }`, `corner_radius = 0.012`.
- 16:9: `inset = { x: 0.72, y: 0.68, w: 0.25, h: 0.27 }`, `corner_radius = 0.012`.
- 4:5: `inset = { x: 0.65, y: 0.74, w: 0.32, h: 0.22 }`, `corner_radius = 0.012`.

These are LAYOUT.md-flavored starting points, not final UX picks; the configurator UI (110) lets the user move the inset freely. Document in a comment that these are starter values, not normative.

**Fixture-driven parity test.** A single JSON fixture at `src-tauri/tests/fixtures/layout_parity.json` lists `[ { layout, aspect, expected } ]`. The TS test loads it via `import * as fs from 'fs'` (vitest runs in Node so this is fine) and the Rust test deserializes it via `serde_json`. Adding a new test case is one PR touching one file; both ports pick it up automatically. This pattern is borrowed from how `cameraIntent`'s tests handle parity-sensitive cases.

**Why drop `exports` outright instead of keeping the wrapper.** The placeholder `ExportConfig { name, aspect_ratio, resolution, layout, codec, quality }` was speculative — it predates the channel design from PLAN.md. v1's actual export UX (per PLAN.md/LAYOUT.md) configures: aspect (one of three), layout (per aspect), and channel selection at export time. The "name a saved export preset" feature it suggests is out of scope for v1. Dropping `exports` clean removes 50+ LOC of dead struct + field plumbing; if presets become a real feature, they'll come back with a different shape (e.g. named `(aspect, channel, quality)` triples) — designed when the UI exists.

**Ordering of the migration chain.** Existing migrations always pass through the full chain — a v1 project → v2 → v3 → v4 even if the user has already opened it in a v2-aware build (because `save_project` always stamps the current version, but a partially-migrated bundle might exist if a save was interrupted; reading is always defensive). This means: refactor `migrate_v2_to_v3(raw) -> Project` into `migrate_v2_to_v3_value(raw) -> Value` + a thin `migrate_v2_to_v3` wrapper that finalizes via serde. Same as `migrate_v1_to_v2`'s existing split.

**Why `LayoutDescriptor` lives in TS (not as a Tauri command shape).** The Tauri command `render_export(... layout: LayoutDescriptor ...)` lands in 060/090. Defining `LayoutDescriptor` here in 050 lets 060/090 just import the type; the command contract is wire-compatible by construction. Rust's pendant is `LayoutDescriptor` in `src-tauri/src/export/layout.rs` (deserializing `serde_json::Value` from the IPC layer) — same fields, serde-renamed identically to the TS shape.

**Frontend code touch radius is small.** `Project.exports` is referenced in `src/types.ts` as a required field. Removing it requires `Project { exports: [] }` initializations to drop the field. Likely callers: `App.tsx`'s "create new project" flow, anywhere a default-Project is fabricated. Audit at acceptance time via grep; remove dead initializations. The configurator UI (110) introduces the field's first real read site for `Project.layouts`.

**Numeric clamping at the type boundary (intentionally absent).** `resolveSlots` does not clamp inset coordinates to `[0, 1]` or divider to `[0, 1]`. The configurator UI (110) is responsible for emitting valid values. This task's tests assert correct math over the valid range; out-of-range inputs produce out-of-range outputs (visible as broken slots), surfacing the bug fast rather than silently masking it. Documenting this contract here means 110 doesn't get to elide its own validation.

**The `LayoutConfig` discriminator and serde.** Rust uses `#[serde(tag = "mode", rename_all = "snake_case")]` on the enum; TS uses a structural discriminator (`type LayoutConfig = PipLayout | SplitLayout` with `mode` as a literal field). Both produce JSON like `{"mode": "pip", "inset_source": "video", ...}`. The serde `rename_all` ensures Rust's `Pip` variant serializes as `"pip"` (TS literal style).

## Open questions deferred to follow-up tasks

- **Per-clip layout-geometry overrides** (LAYOUT.md §4 v2+ feature). The data model leaves room (`Clip.layout_overrides: Option<...>`), but the field is not added in v1. Lands together with animated layout transitions.
- **Configurator UI** (LAYOUT.md §9). Snap targets, drag affordances, swap toggle, default starting layouts surfaced visually — designed and built in 110. 050 ships the data model the UI manipulates.
- **Pixel rounding policy.** Half-away-from-zero is the choice; if subpixel-precision filtergraphs become a concern (FFmpeg's overlay filter accepts integer-only coordinates today), revisit. Out of scope here.
- **"Reset to default" / "Copy from another aspect" UX.** Convenience flows in the configurator. UI concern, 110.
- **Live-preview WYSIWYG drift** (LAYOUT.md §5). The editor's MapView pane currently doesn't render at slot dims; this is a UI redesign topic, not a data-model topic. 050 unblocks it (the data exists) but doesn't address it.

## Doc tie-in

- LAYOUT.md §1 "Layout modes" — `PipLayout` and `SplitLayout` discriminated variants are the data shape behind those primitives.
- LAYOUT.md §2–3 "Output aspects" / "Layout × aspect matrix" — `OUTPUT_DIMS` and `AspectRatio` codify the table; `resolveSlots` enforces the matrix structurally (Split orientation locked by aspect via the `video_side` enum's allowed values per aspect, validated in tests).
- LAYOUT.md §4 "Configuration scope" — `ProjectLayouts` is the per-aspect storage shape sketched there.
- LAYOUT.md §5 "Map slot viewport invariant" — `SlotResolution.map_slot` is the slot dim the worker's viewport is sized to (consumed by the frontend when constructing the `render_export` payload, in 060/090).
- LAYOUT.md §6 "Channels and output formats" — `corner_radius_px` and `corner_radius_slot` feed the alpha-mask filter for PiP corners across all three channels (consumed by 060/070/090).
- PLAN.md §"IPC contract" → "Frontend → Rust" — `LayoutDescriptor` lives in this task's TS module; the `render_export` command consuming it lands in 060/090.
- After 050 lands, every concrete-layout / channel / configurator task has a typed surface to bind to. 080 (first concrete layout) becomes "construct a `LayoutConfig` literal and verify its `SlotResolution`"; 110 becomes "build a UI that emits valid `LayoutConfig` values."
