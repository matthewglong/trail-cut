# Task 110 — Layout configurator (interactive editing of `LayoutConfig`)

**Step**: Export pipeline (editor surface — the first place a user can *mutate* the layout that the export consumes)
**Estimated effort**: ~2 days (12–18h)
**Status**: pending
**Depends on**: 050 (`LayoutConfig`, `ProjectLayouts`, `resolveSlots`, parity fixture), 080 (`LayoutPreview` read-only overlay; `project.layouts[aspect]` populated and round-trips through save/load), 100 (`defaultPipLayout`, `defaultSplitLayout`, `legalSplitSides`, `clampLayout`; all six (mode × aspect) cells paved end-to-end across all three channels).

## Goal

Ship the interactive layer that turns 080's read-only `LayoutPreview` into a working configurator. After this task:

- A new `<LayoutConfigurator>` component lets the user **drag** the PiP inset (move + resize via corner handles), **drag** the Split divider, **toggle** mode (PiP ↔ Split), **swap** which source is the inset (PiP) or which side has the video (Split), and **adjust** the corner radius (PiP only). All edits emit a new `LayoutConfig` value via an `onChange(next: LayoutConfig)` callback.
- The component is a **pure controlled primitive**: no internal state, no IO, no Tauri imports, no auto-save coupling. The parent passes `layout` + `aspect` and receives `onChange` events. Parents can mount it inline in the editor, in a modal, in a sidebar — wherever the broader UI design lands. Its public API is the load-bearing piece of this task; its placement is intentionally not.
- Snap targets (golden ratio, halves, thirds, edges/corners, divider midpoints) are computed in a pure helper and applied during drag. Snap is on by default; holding `Alt` (Option on macOS) bypasses it for free-form positioning. Snap thresholds are in normalized units, so the snap behavior is identical regardless of container or aspect.
- A thin demo wiring lives in `ProjectView` so the configurator is reachable and tested manually — but this is scaffolding, not the final placement. The current "Show layout" toggle stays; clicking through to "Edit layout" mounts the configurator over the same surface, and clicking out commits the most recent `onChange` value to `project.layouts[aspect]` via the existing auto-save plumbing.

This is the task that makes the layout system *user-controllable*. Before 110, a user gets `defaultPipLayout(aspect)` and exports against that — `selected_export_aspect` (from 100) lets them target a different aspect, but the layout *within* an aspect is whatever 100 seeded. After 110, the user freely positions the inset, picks a mode, swaps which source dominates, sets corner radius. This is where the configurator's social-media-polish use case lands: "map small in the corner, video full-bleed, rounded corners on the inset, just barely overlapping the video subject's negative space."

**The load-bearing invariant — controlled, not stateful.** The configurator is a pure controlled component. The parent owns the `layout` value (it lives in `project.layouts[aspect]` and persists via auto-save); the component renders from props and emits via callback. There is no internal "uncommitted draft" state with a Save button — every drag emits live-but-clamped values, and the parent decides commit semantics (typical wiring: throttle/debounce the auto-save; the layout-to-disk invariant from 080 still holds — what's in the project file is what the export uses). This avoids the entire class of "draft state out of sync with disk" bugs and keeps the component testable without mocking persistence. The pattern matches every other controlled UI primitive in this codebase (the trim handles, the focal-point crosshair, the speed slider).

**The second load-bearing invariant — geometry math is reused, not reimplemented.** `resolveSlots` (050) computes pixel rects from a `LayoutConfig`; `clampLayout` (100) keeps a layout valid mid-edit; `defaultPipLayout` / `defaultSplitLayout` / `legalSplitSides` (100) supply the "synthesize a fresh layout when modes flip" / "constrain swap toggles" rules. The configurator consumes all four; it does not redefine any of them. Drag math is a separate concern (translating pointer events into normalized-rect deltas), but the result of every drag is fed through `clampLayout(next, aspect)` before being emitted via `onChange`. The configurator is "interactive surface around pure helpers," not a parallel layout implementation.

## Files to touch

- New: `src/components/LayoutConfigurator/LayoutConfigurator.tsx` — the main component. Controlled (`layout`, `aspect`, `onChange`); composes the `LayoutPreview` (from 080) as its visual base + interactive overlays for the active layout mode.

- New: `src/components/LayoutConfigurator/usePipDrag.ts` — pure hook for moving and resizing the PiP inset. Returns pointer-event handlers + a "ghost" rect (the in-progress edit, applied via `onChange` on each pointermove). The hook is logic-only; the component decides what handle DOM elements look like and where to bind the handlers.

- New: `src/components/LayoutConfigurator/useSplitDrag.ts` — pure hook for moving the Split divider. Mirrors `usePipDrag`'s shape: pointer handlers + a ghost divider value.

- New: `src/components/LayoutConfigurator/snap.ts` — pure helpers:
  - `pipSnapTargets(aspect): { x: number[], y: number[], w: number[], h: number[] }` — the snap-grid for PiP edits per aspect (halves, thirds, golden-ratio splits, edge anchors).
  - `splitSnapTargets(aspect): number[]` — the snap-grid for Split divider per aspect (`[0.25, 0.333, 0.5, 0.618, 0.667, 0.75]` and the corner adjustments).
  - `snap(value, targets, threshold): number` — given a value and a list of candidate targets, returns the nearest target if within `threshold`; otherwise returns `value` unchanged. Used by both drag hooks.
  - `SNAP_THRESHOLD = 0.015` (normalized units) — empirically chosen so a slow drag at 540×960 container gives a couple-pixel "stick" at each target without making free positioning feel sticky.

- New: `src/components/LayoutConfigurator/ModeToggle.tsx` — small two-state control (PiP / Split). On change, calls a parent-supplied `onModeChange(mode: 'pip' | 'split')`. The parent (`LayoutConfigurator`) synthesizes the new mode's layout via `defaultPipLayout(aspect)` or `defaultSplitLayout(aspect)` and emits `onChange`. Mode flips don't try to preserve geometry — the two modes don't share shape, and a stale carry-over geometry would feel buggy.

- New: `src/components/LayoutConfigurator/SwapToggle.tsx` — small button. PiP: flips `inset_source` between `'video'` and `'map'`. Split: rotates `video_side` to the other legal side per `legalSplitSides(aspect)`. The button's icon / label updates per the active mode (no deep iconography in v1 — text labels are fine; UX iteration is downstream).

- New: `src/components/LayoutConfigurator/CornerRadiusSlider.tsx` — controlled slider. PiP only; hidden when mode is Split. Range `[0, 0.05]` (5% of `min(output.w, output.h)`); step `0.001`. On change, emits a new `LayoutConfig` with `corner_radius` updated.

- New: `src/components/LayoutConfigurator/__tests__/LayoutConfigurator.test.tsx` — vitest + `@testing-library/react` + `@testing-library/user-event`'s `pointer` API. Cases below.

- New: `src/components/LayoutConfigurator/__tests__/snap.test.ts` — pure-function tests for the snap helpers.

- New: `src/components/LayoutConfigurator/__tests__/usePipDrag.test.ts` and `useSplitDrag.test.ts` — hook-level tests using `@testing-library/react`'s `renderHook`. Drag math validated without DOM by feeding synthesized pointer-delta inputs and asserting `onChange` calls.

- Modified: `src/components/LayoutPreview/LayoutPreview.tsx` — accept an optional `mode?: 'preview' | 'configurator'` prop (default `'preview'`). When `'configurator'`, suppress the labels and the dashed stroke styling so the configurator's interactive overlays don't fight visually with the preview's annotations. The configurator passes `mode='configurator'`; existing 080 callers continue to render the labeled preview. Alternative if the prop adds noise: pass `showLabels` and `dashedBackground` flags directly. Prefer the named-mode prop; the two annotation behaviors travel together.

- Modified: `src/components/LayoutPreview/LayoutPreviewToggle.tsx` — extend with an `onEdit?: () => void` prop. When provided, the toggle shows a secondary "Edit" affordance (a small pencil icon button next to the existing toggle, or a long-press gesture — pick one; recommend the secondary button for keyboard accessibility). Clicking "Edit" calls `onEdit`. The parent (`ProjectView`) wires it to mount the configurator. Alternative: ship a separate `<LayoutEditButton>` next to the toggle. Recommend integrating into `LayoutPreviewToggle` to keep related affordances colocated.

- Modified: `src/screens/ProjectView.tsx`:
  - Add a `configuratorOpen: boolean` state.
  - When `configuratorOpen`, render `<LayoutConfigurator layout={...} aspect={selectedAspect} onChange={handleLayoutChange} containerWidth={...} containerHeight={...} />` over the VideoPreview pane (replaces the read-only `LayoutPreview` while open).
  - `handleLayoutChange(next)`: writes `next` into `project.layouts[selectedAspect]` via the same auto-save path used elsewhere. The auto-save's existing 1s debounce is the right granularity — drags emit values at ~60Hz, the debounce coalesces them, the disk file picks up the final value within 1s of the user releasing the pointer.
  - A click outside the configurator (or a "Done" button on the configurator's chrome) sets `configuratorOpen = false`. The auto-save handles persistence; no explicit "Save" / "Cancel" UX since the configurator is controlled-not-draft.
  - **Treat this wiring as scaffolding.** The configurator's permanent home — modal, sidebar, full-screen mode, "design" tab — is a UI design call. 110 demonstrates the wiring pattern; final UX placement is downstream.

- Modified: `src/lib/layout.ts`:
  - **Add (if not in 100)**: `clampLayout(layout, aspect): LayoutConfig` — see 100's "files to touch" for the canonical landing. If 100 deferred it, ship here. Either way the configurator consumes a tested helper from `lib/layout`.
  - **Add**: `synthesizeLayoutForMode(mode, aspect, hint?): LayoutConfig` — a thin dispatch around `defaultPipLayout` / `defaultSplitLayout` so 110's mode toggle has one call site. `hint` is currently unused but reserved for a future "preserve approximate position across mode flips" feature; ignore it in v1.

- Modified: `src/types.ts` — no API change; `LayoutConfig` and helpers re-exported through their existing surface (likely direct imports from `lib/layout`).

- Modified: `docs/export/tasks/README.md` — flip 110 to ⬜→🟡→✅; this file linked.

- Untouched in this task: `src-tauri/src/...` — 110 is frontend-only. The Rust side already handles every `LayoutConfig` value the configurator can emit (after 100). No new IPC, no new validators (split-legality and clamping are 100's; the configurator just emits values that pass them).

## Deliverables

### `LayoutConfigurator` public API (in `src/components/LayoutConfigurator/LayoutConfigurator.tsx`)

```ts
import type { CSSProperties } from 'react';
import type { AspectRatio, LayoutConfig } from '../../lib/layout';

export interface LayoutConfiguratorProps {
  /** Current layout to render and edit. The configurator is controlled —
   *  this prop is the source of truth, and edits emit via `onChange`. */
  layout: LayoutConfig;

  /** Active aspect. Determines output dims and Split's locked orientation. */
  aspect: AspectRatio;

  /** Container size in CSS pixels. Same semantics as LayoutPreview's
   *  containerWidth/containerHeight — the configurator scales the output
   *  frame to fit, preserving aspect; pointer events are unprojected from
   *  CSS pixels back into normalized coordinates for `onChange`. */
  containerWidth: number;
  containerHeight: number;

  /** Called on every edit (drag tick, slider step, swap, mode flip).
   *  The emitted layout is `clampLayout`'d before being passed; the parent
   *  can write directly to `project.layouts[aspect]` without re-validating. */
  onChange: (next: LayoutConfig) => void;

  /** When `true`, the configurator renders its visuals but doesn't accept
   *  pointer input. Useful for "view another user's layout" or "loading"
   *  states. Default `false`. */
  disabled?: boolean;

  /** When `true` (default), Alt-bypass is enabled and snap is on by default.
   *  When `false`, snap is off by default and Alt enables it. Mirrors the
   *  Figma idiom; pick a default once, expose for testing / UX iteration. */
  snapEnabledByDefault?: boolean;

  /** Optional style overrides for the outer container. */
  style?: CSSProperties;
}

export function LayoutConfigurator(props: LayoutConfiguratorProps): JSX.Element;
```

**Why these props and not others**:

- No `onCommit` / `onCancel`: the controlled-not-draft pattern means every emit is the new source of truth. The parent decides debouncing.
- No `mode` / `onModeChange`: mode is part of the `LayoutConfig` discriminator. Mode flips are emitted as full `LayoutConfig` replacements via the standard `onChange`.
- No `corner_radius` / `onCornerRadiusChange`: corner radius is part of the PiP `LayoutConfig`. Slider edits emit a full PiP `LayoutConfig` with the new radius.
- No `selectedExportAspect` / `onAspectChange`: aspect changes are the parent's concern (and 100's `selected_export_aspect` field's responsibility). The configurator edits *one aspect's layout at a time*; switching aspects is handled outside.

### `usePipDrag` hook signature (in `src/components/LayoutConfigurator/usePipDrag.ts`)

```ts
export type PipDragHandle =
  | { kind: 'move' }
  | { kind: 'resize-corner'; corner: 'tl' | 'tr' | 'bl' | 'br' }
  | { kind: 'resize-edge'; edge: 'top' | 'right' | 'bottom' | 'left' };

export interface UsePipDragArgs {
  layout: PipLayout;
  aspect: AspectRatio;
  containerWidth: number;
  containerHeight: number;
  snapEnabled: boolean;
  onChange: (next: PipLayout) => void;
}

export interface UsePipDragHandlers {
  /** Bind to the inset rect's outer surface for translation.
   *  Bind to corner / edge handles with the appropriate `handle` arg. */
  beginDrag: (handle: PipDragHandle, e: PointerEvent) => void;
  /** Whether a drag is currently in flight — used by the component to set
   *  cursor styles, suppress hover effects, etc. */
  isDragging: boolean;
}

export function usePipDrag(args: UsePipDragArgs): UsePipDragHandlers;
```

The hook attaches `pointermove` / `pointerup` listeners to `window` once a drag begins (so the user can drag past the inset's edges without losing the handle), unprojects pointer-pixel deltas to normalized-coordinate deltas using `containerWidth/Height` and `OUTPUT_DIMS[aspect]`, applies snap (when enabled and not Alt-bypassed), clamps via `clampLayout`, and emits via `onChange` on each `pointermove`.

### `useSplitDrag` hook (in `src/components/LayoutConfigurator/useSplitDrag.ts`)

```ts
export interface UseSplitDragArgs {
  layout: SplitLayout;
  aspect: AspectRatio;
  containerWidth: number;
  containerHeight: number;
  snapEnabled: boolean;
  onChange: (next: SplitLayout) => void;
}

export interface UseSplitDragHandlers {
  beginDrag: (e: PointerEvent) => void;
  isDragging: boolean;
}

export function useSplitDrag(args: UseSplitDragArgs): UseSplitDragHandlers;
```

Same pattern: attach window listeners on drag begin, project pointer to normalized divider position, snap, clamp (`clampLayout` keeps divider in `[0.05, 0.95]`), emit. The divider's drag axis is determined by `legalSplitSides(aspect)`: vertical for `16_9`, horizontal otherwise.

### Snap helpers (in `src/components/LayoutConfigurator/snap.ts`)

```ts
export const SNAP_THRESHOLD = 0.015;

export interface PipSnapTargets {
  x: number[];      // candidate inset.x values (e.g., [0, 0.333, 0.5, 0.618, 0.667, 1 - inset.w])
  y: number[];
  w: number[];
  h: number[];
}

export function pipSnapTargets(aspect: AspectRatio, layout: PipLayout): PipSnapTargets;
export function splitSnapTargets(aspect: AspectRatio): number[];
export function snap(value: number, targets: number[], threshold?: number): number;
```

Targets per axis include:
- **Edges**: `0`, `1 - rectExtent` (so the inset can stick to the frame's right/bottom edge accounting for its own width/height).
- **Centers**: `0.5 - rectExtent / 2`.
- **Thirds**: `1/3` and `2/3`, plus `1/3 - rectExtent` and `2/3 - rectExtent`.
- **Golden ratio**: `1 - 1/φ ≈ 0.382` and `1/φ ≈ 0.618`, plus their `- rectExtent` variants.

The variants accounting for the inset's extent let the user snap "inset's right edge to frame's right edge" cleanly, not just "inset's left edge to a fraction." The snap function operates per-axis; corner-handle resizes call `snap` for both axes independently.

### Visual sketch (PiP)

```
┌──────── containerWidth ────────┐
│                                │
│     ┌────── output frame ─────┐│
│     │                         ││
│     │                         ││
│     │      [Map]              ││
│     │      (full bleed)       ││
│     │                         ││
│     │           ◤───◥         ││
│     │           │ ●←┼──── corner-resize handles
│     │           │   │         ││
│     │           ◣───◢         ││
│     │                         ││
│     │ [snap guide line, faint]││
│     └─────────────────────────┘│
│                                │
│  [PiP / Split]  [Swap] [⌒══]   │ ← mode + swap + corner-radius slider
│                                │
└────────────────────────────────┘
```

Visual cues:
- **The inset rect** is rendered with the same SVG overlay 080's `LayoutPreview` produces, plus an interactive transparent fill so pointer events land on the rect's body (move handle).
- **Four corner-resize handles** sit at the inset's corners (small filled circles, ~10×10 CSS pixels, hit area ~16×16). They constrain the resize to "from this corner" — opposite corner stays anchored.
- **Snap guide lines** appear during drag at every snap target the current handle is "near" (within `SNAP_THRESHOLD * 1.5` to telegraph the snap before it lands). Faint lines, ~0.5px stroke, dashed.
- **Chrome controls** (mode toggle, swap, corner-radius slider) live below the SVG in a horizontal row. Layout is responsive: stack vertically when `containerWidth < 320`.
- **Cursor styles**: `move` over the inset body; `nwse-resize` / `nesw-resize` over corner handles; `default` elsewhere. Hand off to native cursor convention.

### Visual sketch (Split, 9:16)

```
┌──────── containerWidth ────────┐
│                                │
│     ┌────── output frame ─────┐│
│     │                         ││
│     │      [Video]            ││
│     │      (top half)         ││
│     │                         ││
│     ├═════════ ═════════════════ ← divider, draggable along its axis
│     │           ●               ↑ pill handle in middle for grab affordance
│     │      [Map]              ││
│     │      (bottom half)      ││
│     │                         ││
│     └─────────────────────────┘│
│                                │
│  [PiP / Split]  [Swap]          │ ← no corner-radius slider (Split has no inset)
│                                │
└────────────────────────────────┘
```

The divider is the only interactive element on the SVG. Swap flips video to the bottom (and map to the top); divider drag adjusts the split point; mode toggle switches to PiP (synthesizing `defaultPipLayout(aspect)`).

## Acceptance criteria

- [ ] `npm run lint`, `npm run build`, `npm run test:run` pass.
- [ ] `cargo build` (in `src-tauri`) is unchanged — 110 is frontend-only and Rust shouldn't notice.
- [ ] **`LayoutConfigurator` renders correctly** across the (mode × aspect) matrix:
  - For each of the six (mode × aspect) cells, the component renders without errors and produces an SVG with `viewBox` matching `OUTPUT_DIMS[aspect]`.
  - PiP cells show four corner handles + a draggable inset body + the corner-radius slider.
  - Split cells show one divider handle + no corner-radius slider.
  - The `disabled` prop suppresses pointer event listeners (no `onChange` fires from any synthesized pointer event).

- [ ] **PiP move drag** (`usePipDrag` test): given a `PipLayout` with `inset.x=0.1, inset.y=0.1`, a `move` drag of `(+50px, +30px)` at a `containerWidth=540, containerHeight=960` container at aspect `9_16` (output 1080×1920) produces an `onChange` with `inset.x ≈ 0.1 + 50/540, inset.y ≈ 0.1 + 30/960`. (The actual test uses tight float comparison and accounts for `clampLayout` behavior.)

- [ ] **PiP corner-resize drag** (`usePipDrag` test): a `resize-corner: 'br'` drag of `(+20px, +10px)` at `containerWidth=540` at aspect `9_16` extends `inset.w` and `inset.h` by `20/540` and `10/960` respectively (top-left corner stays put).

- [ ] **PiP edge-resize drag** (`usePipDrag` test): a `resize-edge: 'right'` drag adjusts only `inset.w`; the inset's `x`, `y`, `h` are unchanged.

- [ ] **Split divider drag** (`useSplitDrag` test): given a `SplitLayout` with `divider=0.5` at aspect `9_16` (horizontal split), a vertical drag of `+30px` at `containerHeight=960` produces `onChange` with `divider ≈ 0.5 + 30/960`. At aspect `16_9` (vertical split), a horizontal drag of `+40px` at `containerWidth=540` produces `divider ≈ 0.5 + 40/540`.

- [ ] **Snap on by default**: a slow drag near a snap target (e.g., divider drag landing within `SNAP_THRESHOLD` of `0.5`) snaps to the target. Same drag with the synthesized event's `altKey: true` does *not* snap.

- [ ] **`snap` helper unit tests** (`snap.test.ts`):
  - `snap(0.495, [0.5], 0.015)` → `0.5`.
  - `snap(0.48, [0.5], 0.015)` → `0.48` (outside threshold).
  - `snap(0.5, [0.333, 0.5, 0.667], 0.015)` → `0.5` (exact match wins over neighbors).
  - `pipSnapTargets('9_16', layout).x` includes `0`, `1 - layout.inset.w`, `0.333`, `0.5`, `0.618`, `0.667`, etc.
  - `splitSnapTargets('16_9')` includes `0.25, 0.333, 0.5, 0.618, 0.667, 0.75`.

- [ ] **Mode toggle synthesizes a fresh layout**: clicking the toggle on a PiP layout emits `defaultSplitLayout(aspect)`; clicking again on the resulting Split emits `defaultPipLayout(aspect)`. State doesn't carry over across the flip; the configurator is controlled, so the parent's `onChange` is the source of truth for the next render.

- [ ] **Swap toggle on PiP**: flips `inset_source` between `'video'` and `'map'`. The corner-radius slider's value is preserved across the flip (corner radius applies to whichever slot is now the inset).

- [ ] **Swap toggle on Split**: rotates `video_side` to the other legal side per `legalSplitSides(aspect)`. At aspect `9_16`: `'top'` ↔ `'bottom'`. At aspect `16_9`: `'left'` ↔ `'right'`. The divider position is preserved.

- [ ] **Corner-radius slider** (PiP only): drags the slider; emits `onChange` with `corner_radius` in `[0, 0.05]`. The slider is hidden / disabled when the active mode is Split.

- [ ] **Clamping at the edges**: dragging a PiP inset's right edge beyond `inset.x + inset.w = 1` snaps to `inset.x + inset.w = 1` (per `clampLayout`). Same for bottom edge / x=0 / y=0. Dragging the Split divider beyond `0.95` clamps to `0.95`; below `0.05` clamps to `0.05`.

- [ ] **Inverse-orientation Split is unreachable**: the swap toggle's options at each aspect are constrained to `legalSplitSides(aspect)`. There is no UI affordance that produces an inverse-orientation Split. The validator (100) catches malformed values from non-UI sources.

- [ ] **Pointer events stay scoped**: clicking outside the configurator's bounds does not fire `onChange`; window-level `pointermove` / `pointerup` listeners are removed on `pointerup` (no listener leaks).

- [ ] **`LayoutPreview` regression check**: 080's tests (read-only mode) continue to pass. The `mode='preview'` default behavior is unchanged.

- [ ] **`ProjectView` integration smoke test**: clicking the "Edit" affordance on the layout-preview toggle mounts the configurator. Drag the inset; verify that within ~1s the project's auto-save fires and the next reload of the project reads back the dragged value. The auto-save mechanism is unchanged from 080; this is a wiring smoke test.

- [ ] **No internal state in `LayoutConfigurator` for the layout itself.** Grep at acceptance time:
  - `grep -nE "useState.*Layout|useReducer.*Layout" src/components/LayoutConfigurator/` returns matches only for ephemeral UI state (e.g., `dragInProgress`, `hoveredHandle`) — never for `layout` / `inset` / `divider` / `corner_radius` / `mode` itself.
  - The component's `onChange` prop is the only path through which the layout value mutates.

- [ ] **No reimplementation of slot math, clamping, or snap logic outside the dedicated helpers.** Grep at acceptance time:
  - `grep -nE "1080|1920|1350|0\\.618|0\\.382|OUTPUT_DIMS" src/components/LayoutConfigurator/` returns matches only in test fixtures and `snap.ts`'s explicitly-named target arrays — never in inline drag math.
  - `grep -nE "clamp|Math\\.min|Math\\.max" src/components/LayoutConfigurator/` returns matches only in pointer-event-to-normalized-coordinate projection (not in layout-shape clamping; that's `clampLayout`).
  - `grep -n "resolveSlots" src/components/LayoutConfigurator/LayoutConfigurator.tsx` returns matches (the configurator does call `resolveSlots` to position handles in pixel space).

- [ ] **Manual smoke test on macOS dev machine**: open a project, click the Layout overlay's "Edit" affordance, drag the PiP inset around freely. Snap to thirds / golden ratio works (you feel the snap). Hold Alt mid-drag — snap disengages. Resize via corners — opposite corner stays anchored. Swap — map and video swap. Toggle to Split — divider appears, can drag, no corner radius UI. Switch aspects (via the temp control from 100) — the configurator re-mounts with the aspect's stored layout; mid-edit aspect changes commit the in-flight drag to the *previous* aspect's layout (the configurator's unmount fires `pointerup`). Save the project, quit, reopen — edits persisted.

- [ ] `docs/export/tasks/README.md` row 110 flipped to ✅, this file linked.

## Implementation notes

**Why a controlled component instead of an uncontrolled one with internal draft state.** A controlled component has one source of truth (`props.layout`); every state in the system can be reconstructed from "what the parent passed." An uncontrolled component with a draft has two sources (the prop and the draft) and the inevitable question: when the parent updates the prop, do we discard the draft, merge, or warn? Every answer is wrong in some user flow. Controlling is simpler, testable without persistence, and matches every other interactive primitive in this codebase.

**Why `onChange` fires on every pointermove, not just on pointerup.** Live preview during drag is the whole point. A user dragging the inset wants to see the underlying video and the inset's new position together — that's only possible if the prop updates as the drag progresses. The auto-save's debounce (already 1s in this app) coalesces the high-frequency emit into one disk write. If `onChange`-on-every-tick proves too chatty for some downstream consumer, that consumer can throttle in its own handler; the configurator emits at maximum fidelity.

**Why we don't preserve geometry across mode flips.** A PiP inset rect at `(0.65, 0.78, 0.32, 0.18)` doesn't translate to a Split divider — they're geometrically incompatible primitives. Trying to "best-effort preserve" produces results that feel arbitrary ("why did Split land at 0.32?"). Synthesizing a fresh `defaultLayoutForMode` each time is honest: "you switched modes; here's the starter for that mode, edit from here." The `hint` parameter on `synthesizeLayoutForMode` is reserved for a future "when flipping PiP→Split, place the divider near where the inset was" feature; deferred until UX feedback says it's wanted.

**Why snap defaults on (not off).** Most users layout-edit infrequently; they want it to feel "good enough" without finesse. Snapping to halves / thirds / golden ratio produces "good enough" composition automatically. Power users who want pixel-perfect control hold Alt — same idiom as Figma, Sketch, Procreate. The opposite default ("off; hold Alt to snap") trains users to expect free positioning, then surprises them when their PiP inset lands at `0.6471`. The Figma idiom is well-established; matching it is the lower-friction choice.

**Why `SNAP_THRESHOLD = 0.015` (1.5% of frame).** At a 540×960 editor pane and a 1080×1920 output, that's ~8.1 pixels of editor space — visible enough that a slow drag clearly "sticks," small enough that free positioning doesn't feel sticky. Empirical from prototyping on a 14" MacBook trackpad. Re-tune if mouse-vs-trackpad feel diverges in user testing.

**Why snap targets include "rectExtent-adjusted" variants.** A user dragging the PiP inset's *position* (the move handle) wants to snap not just the inset's `(x, y)` corner to thirds / golden, but also the inset's *opposite* corner (`x + w`, `y + h`) to the same targets. Snapping `x = 1 - inset.w` lets the inset stick to the right edge cleanly; snapping `x = 0.333 - inset.w / 2` would let it center on the 1/3 line. The variants encode the user's mental model ("center this rect on the golden ratio") rather than the literal coordinate semantics.

**Why corner-radius range is `[0, 0.05]`.** At `0.05` * `min(1080, 1920) = 54` px, the corners are clearly rounded but not so heavy that the inset becomes a blob. Larger radii produce shapes more like ellipses than rounded rectangles; if a future user demands extreme rounding, raise the bound. Slider step `0.001` gives ~1px granularity at 1080×1920 — finer than any user can perceive.

**Why mode toggle is "PiP / Split" and not three+ modes.** v1's settled design (LAYOUT.md §1). Future modes (e.g., picture-in-picture-with-shadow, gradient-fade overlay, animated-transitions-as-modes) are v2+. The toggle is structurally a 2-state control today; expanding it to N states is a follow-up component change.

**Why no progress / loading state in the configurator.** The component's job is interactive editing, not export. The "Exporting…" state (already in `ProjectView`) is mutually exclusive with editing — the configurator can be `disabled={exporting}` if the parent wants to lock edits during an export run. This is a parent-side concern, not the configurator's.

**Why the configurator embeds `LayoutPreview` instead of drawing the slot rects itself.** The read-only preview's SVG is exactly what the configurator wants for the visual base — same slot rects, same aspect-fit math, same pointer-events-none container. Adding an "interactive" mode to `LayoutPreview` (the `mode` prop above) is a small extension; reimplementing the rect rendering inside the configurator would mean two paths for "draw the slot rect from a `LayoutConfig`," which is exactly the duplication the load-bearing invariant forbids.

**Why drag math is in pure hooks, not in the component.** Pure hooks are testable without DOM mounts (`renderHook` works), without rendering, without screen reader concerns. The component's job is "render handles + bind hooks + assemble chrome"; the hooks own "translate pointer events into normalized-coordinate edits." Same pattern as `useTrimDrag` and `useFocalDrag` (existing in `src/components/VideoPreview/`); the drag-hook-as-pure-logic idiom is established in this codebase.

**Why we attach `pointermove` / `pointerup` to `window`, not the SVG.** A user dragging fast can move the pointer outside the SVG's bounds. Listening only on the SVG drops the move events; the user's drag visibly "loses" the inset. Window-level listeners catch every move until the user releases. We attach on `pointerdown`, remove on `pointerup` — no leaks.

**Why no keyboard arrow-key nudge in v1.** Keyboard accessibility for layout editing is real (a11y-conscious users need it) but the right surface is more design than this task. Arrow keys to nudge by 1px? By a snap step? With Shift = bigger steps? Tab between handles? UX iteration; deferred. The configurator's primary surface is pointer; keyboard is a follow-up.

**Why no undo/redo at the configurator level.** The project-level undo system (if/when one lands) is the right layer for this — the configurator is one editor among many, and per-component undo histories don't compose well. Today the project has no app-level undo; the configurator inherits whatever the project has, which is "auto-save then undo via the file system" (i.e., reload the project's last-saved state). A real undo/redo is a separate feature.

**Why we don't constrain inset to fit inside the frame harder than `clampLayout` does.** `clampLayout` keeps `inset.x ∈ [0, 1 - inset.w]`, `inset.y ∈ [0, 1 - inset.h]`, etc. — the inset rect is fully inside the frame. We don't *also* constrain "the inset must be at least 10% of the frame" or similar — that's an aesthetic choice, not a correctness one, and a user who wants a tiny inset should have it. The math survives degenerate small insets (the export filtergraph just produces a tiny inset rect; not visually compelling, but the user asked).

**Why no aspect picker in the configurator's chrome.** 100 placed `selected_export_aspect` on the project; switching aspects is a project-level concern (it changes which `project.layouts[aspect]` the configurator is editing). A picker inside the configurator would conflate "edit *this* layout" with "switch *which* layout I'm editing" — mixed-meaning UI. The picker lives at the same level as the configurator's mount point (in the editor toolbar, in an export-settings dialog, wherever the broader UX places it).

**Why we ship the configurator as a single component with sub-files instead of multiple top-level components.** The configurator is one logical primitive — one `<LayoutConfigurator />` with internal sub-components for the mode toggle, swap toggle, slider. Each sub-component is small and tightly coupled to the configurator's state model. A flat surface area lets the parent mount one component; an exploded surface (`<LayoutModeToggle>` + `<LayoutSwapToggle>` + ...) would force the parent to assemble them and bind their callbacks correctly, which is exactly the mistake a single primitive avoids. The hooks (`usePipDrag`, `useSplitDrag`, `snap`) are the "would-be top-level" exports — pure, testable, reusable; the components are configurator-internal.

**Why ProjectView's wiring is scaffolding, not a feature.** The "Edit" affordance on the toggle, the click-outside-to-close behavior, the auto-save coupling — these are demonstration wiring. The real placement (modal? sidebar tab? "design" sub-route?) is downstream. The configurator's API is the load-bearing piece; if the placement changes, the API stays valid. Marking the wiring as scaffolding in code comments lets a future task re-mount the configurator without touching `LayoutConfigurator.tsx`.

**Edge case — the user starts a drag, then the parent re-renders with a different `layout` prop mid-drag.** Because the component is controlled, the in-flight drag's "ghost" rect resets to the new prop value on the next render. This is correct: the parent has a more authoritative source (e.g., a remote sync just landed). The drag effectively cancels. To prevent this from feeling buggy in normal flows, the configurator's `onChange` emits frequently enough (every pointermove tick) that the parent's prop should be tracking the drag — there's no "behind the prop" state to lose. Edge cases (network sync mid-drag) are rare and acceptably surprising.

**Edge case — disabled state during a drag in flight.** If `disabled` flips to `true` while a drag is in progress, the window-level listeners stop firing edits (the hooks gate on `!disabled`). The drag effectively cancels at the current position. The window listeners are still registered until `pointerup`, but they're inert; no leaks.

**Edge case — pointer capture and touch.** v1 targets pointer events (not touch-specific events), which works for mouse / trackpad / pen / touch in a unified API. The configurator does *not* call `setPointerCapture` — the window-level listeners handle out-of-bounds dragging cleanly without it. `touch-action: none` on the SVG body prevents the page from scrolling during a drag-on-trackpad-with-momentum.

## Open questions deferred to follow-up tasks

- **Permanent UI placement.** Modal, sidebar, "design" tab, full-screen mode — the configurator's mount point is a UX design decision. 110 ships the primitive; the placement lands in the next UI design pass.
- **Aspect picker.** Should it live next to the configurator, in the export-settings dialog (when that exists), in the editor's main toolbar? Tied to the broader UI design.
- **Keyboard accessibility** (arrow-key nudge, Tab between handles, Enter/Space to activate snap targets). v1 targets pointer; a11y is a real follow-up.
- **Snap target customization.** Should users be able to define their own snap targets (e.g., "I always want to snap to 0.4 horizontally")? Niche; deferred.
- **Per-handle visual styling iteration.** Color, hit area, hover affordance — UX iteration after dogfooding.
- **Live update via shared state across multiple configurator instances.** If the editor ever shows two configurators side-by-side (e.g., comparing aspects), they need to reconcile concurrent edits. v1 has one configurator at a time; this is a non-issue today.
- **Per-clip layout overrides** (LAYOUT.md §4 v2+). The configurator today edits the *project*'s per-aspect layout; v2 introduces per-clip overrides that will need a sibling configurator scoped to a clip selection.
- **Animated layout transitions** (LAYOUT.md §4 v2+, paired with per-clip overrides). The configurator's data model is one `LayoutConfig` per aspect; v2's transitions need a sequence with timing curves — a different surface.
- **WYSIWYG live preview** (LAYOUT.md §5). Render the editor's MapView at the active layout's `map_slot` dims, render VideoPreview at the `video_slot` dims, composite both into a single editor pane. The configurator's drag handles already operate in normalized coordinates; the move to a slot-sized preview is a parent-side change that the configurator inherits cleanly.
- **Reset to default / Copy from another aspect / Apply to all aspects.** Convenience flows; out of scope for v1's "edit one aspect" surface. Easy follow-up given the helpers from 100.
- **Multi-aspect simultaneous edit** ("apply this PiP position across 9:16 and 4:5 simultaneously"). Niche convenience; deferred.

## Doc tie-in

- LAYOUT.md §1 — both layout modes; the configurator is the surface that produces values for both.
- LAYOUT.md §3 — Split's locked orientation per aspect; honored via `legalSplitSides` (from 100) constraining the swap toggle's options.
- LAYOUT.md §4 — Configuration scope; the configurator edits the project's per-aspect layout, persisting via auto-save.
- LAYOUT.md §5 — Live preview drift; the configurator's drag math is normalized-coordinate-native, so it inherits any future slot-sized preview redesign cleanly. The drift itself is unchanged by 110.
- LAYOUT.md §9 — "Layout configurator UI design: snap targets, drag affordances, default starting layouts per aspect, swap toggle UI." 110 lands the implementation of this open question.
- 050 — `LayoutConfig`, `LayoutDescriptor`, `resolveSlots`. The configurator emits values that round-trip cleanly through the descriptor's wire shape.
- 080 — `LayoutPreview`. Reused as the configurator's visual base via the new `mode` prop.
- 100 — `defaultPipLayout`, `defaultSplitLayout`, `legalSplitSides`, `clampLayout`, `selected_export_aspect`. The configurator consumes all of these. The configurator does *not* introduce its own clamping or its own default layouts — those are 100's deliverables.
- 120 — Render parity verification. Once the configurator ships, parity tests can be driven against a wider variety of layouts (drag-emitted free-form values, not just the seeded defaults). Until 110, parity is verifiable only against `defaultPipLayout` / `defaultSplitLayout` outputs.
