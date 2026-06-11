# Ship Review — Frontend Components (`src/components/`)

**Date:** 2026-06-11
**Scope:** MapToolbar/ (incl. DecorationPanel, ColorSection, GradientEditor, ShapeSection), MapView.tsx, ExportModal/, LayoutConfigurator/, LayoutPreview/, MapPositioningModal/, Timeline/, VideoPreview/, EditToolbar/, WaypointsPanel/, plus the shared primitives they consume (SegmentedPicker, GridPicker, ModePicker, NumberStepper, Dropdown, Toolbar) and `src/theme/tokens.ts`.
**Branch state at review:** `feat/control-panel`, with uncommitted changes (see §8).

---

## 1. Verdict in one paragraph

This is the **strongest subsystem reviewed so far and does not match the "soupy and shallow" diagnosis**. The components are mostly deep in the Ousterhout sense: `ColorSection` is one shared, fully-controlled color editor used by all three decoration panels (no per-panel picker duplication); `LayoutConfigurator`'s drag/snap logic is extracted into pure, heavily-tested modules (`snap.ts`, `usePipDrag.ts`, `useSplitDrag.ts`); `MapView.tsx` is a disciplined contract consumer with an explicit self-policing comment forbidding ad-hoc paint writes. Comments routinely explain *why* (WebKit focus-ring workaround, MapLibre at-rest heuristics, race-avoidance in async effects). The real defects are narrower than "soup": (a) the gradient/solid cache stash-restore protocol is hand-copied five times inside `DecorationPanel.tsx`; (b) the per-frame paint-field→layer/property wiring is duplicated between `MapView.tsx` and the renderer worker with no parity test; (c) the `DecorationPanel` prop surface (19 props, instantiated three times near-identically in `MapToolbar.tsx`) is genuine prop-soup; (d) styling is a four-way mix (tokens / `styles.ts` objects / one CSS module / raw hex literals).

---

## 2. Component depth assessment (deep vs. prop-soup)

### 2.1 Deep components (interface ≪ implementation) — the good list

| Component | Evidence |
|---|---|
| **ColorSection** (`src/components/MapToolbar/ColorSection/ColorSection.tsx`, 538 lines) | One component serves solid-only (POV), solid+gradient (Route/Waypoints project scope), read-only (Route clip scope), and override-pill (per-waypoint) modes through a small optional-prop surface (lines 43–83). The "where does a color edit go" decision is funneled through a single `applyColor` bridge (lines 175–181) — swatch click, hex input, and custom picker all route through it. The internal `SwatchRow` (lines 427–534) is reused for both the solid picker and the gradient STOP COLOR picker with a `testIdPrefix` discriminator. **There is exactly one color picker in the app.** No duplication across Route/Waypoints/POV panels. |
| **GradientEditor** (`ColorSection/GradientEditor.tsx`, 281 lines) | Fully controlled (`stops` in, `onStopsChange` out, lines 39–59); all math (insert-at-largest-gap, min-separation, snap-to-waypoint-ticks, CSS gradient serialization) lives in pure `gradientMath.ts` (268 lines) with its own test file (`__tests__/gradientMath.test.ts`, 278 lines). The cache contract is explicitly documented as *not its concern* (lines 11–13: "The component never reads or writes `color_stops_cache`"). |
| **ShapeSection** (`ShapeSection/ShapeSection.tsx`, 111 lines) | Thin declarative wrapper: owns only the shape definitions (lines 42–73) and the override pill; all gallery chrome delegates to the generic `GridPicker` (header comment, lines 1–15). Exactly what a shallow-by-design adapter should look like. |
| **LayoutConfigurator** (`LayoutConfigurator/LayoutConfigurator.tsx`, 1213 lines) | The file is long but *not* monolithic: it decomposes into ~14 named sub-components (PipChrome 160, SplitChrome 195, ConfiguratorOverlay 223, PipOverlay 239, PipDragReadout 504, EqualMarginTick 620, AspectLabelChip 699, SnapLabelChip 758, SplitOverlay 806, SwapBadge 1050, AspectFitOutline 1104, PaneReadout 1134). All geometry comes from `lib/layout.ts` (`resolveSlots`, `clampLayout`, `synthesizeLayoutForMode` — imports at lines 2–14); all drag/snap state machines live in `usePipDrag.ts` (533 lines, 899-line test) and `useSplitDrag.ts` (439-line test); the snap model in `snap.ts` (483 lines, 533-line test) carries a first-rate design comment (lines 34–53: aspect / position / margins as three independent concerns, "equal-margin matching is the iconic PiP move"). Per-pane readouts honor the pane-level-thinking feedback (PaneReadout at 1134). |
| **LayoutPreview** (`LayoutPreview/LayoutPreview.tsx`, 524 lines) | Header contract (lines 1–11): "Pure / presentational: no state, no IO, no Tauri imports. The slot rect math comes from `resolveSlots` only — the component must not reimplement layout geometry." Three visual modes (preview/configurator/triptych) behind one enum prop (lines 24–31). |
| **ExportModal** (`ExportModal/ExportModal.tsx`, 797 lines) | Clean three-view state machine (`'select' | 'running' | 'done'`, line 48); cell mutations funnel through a single `updateCell` (lines 292–310); job derivation, filename logic, and request building are in `lib/exportFilenames.ts` / `lib/exportRequest.ts`, not the component. Async-race handling is explicit and correct: the output-folder auto-default re-reads `selectionRef` before writing so it can't clobber a user's synchronous folder pick (lines 261–268); the prefill + auto-default merge into one effect with a documented reason (lines 230–234). Persist-once latch via `persistedThisRunRef` (lines 174–175, 215–221). |
| **Timeline / EditToolbar / WaypointsPanel / MapPositioningModal** | All small and proportionate: Timeline.tsx 130 lines, EditToolbar.tsx 177, WaypointsPanel.tsx 267, MapPositioningModal.tsx 188 + TriptychTile.tsx 394. TriptychTile reuses LayoutConfigurator in `chromeless` mode rather than forking it (`LayoutConfigurator.tsx:36` documents the prop's purpose: "so the caller's own control surface … isn't duplicated"). |

### 2.2 Shallow / prop-soup spots

- **`DecorationPanelProps` has 19 props** (`MapToolbar/DecorationPanel/DecorationPanel.tsx:103–145`): decoration, settings, onChange, scope, overriddenKeys, onScopeChange, onClose, routeLoaded, currentClip, waypoints, onWaypointsChange, onOpenWaypointsPanel, triggerRef, currentClipOrdinal, indexedRoute, position, onPositionChange, size, onSizeChange, zIndex, onFocus. `MapToolbar.tsx` instantiates this **three times with near-identical 20-line prop blocks** (lines 351–373 route, 392–414 waypoints, 433–455 pov). Adding one panel capability = editing four places. The window-management props (position/size/zIndex/onFocus/onClose ×3 kinds) and the data props are two distinct concerns flattened into one bag — a `FloatingPanel` shell component plus a per-decoration body would cut the surface roughly in half.
- **`MapToolbarProps` itself is 13 props** (`MapToolbar.tsx:62–94`), mostly pass-through freight for DecorationPanel (currentClip, currentClipOrdinal, waypoints, onWaypointsChange, indexedRoute exist solely to be forwarded). Classic change-amplification conduit: a new panel input threads ProjectView → MapToolbar → DecorationPanel → panel body.
- **`MapViewProps` doc-comments admit dead freight:** `activeClipId` is "unused for highlighting. Kept for parity with the caller's existing wiring" (`MapView.tsx:52–61`, discarded at line 167 via `void activeClipId;`). `GradientEditor.totalDistMeters` is `@deprecated unused` (`GradientEditor.tsx:53–55`) yet still computed and threaded through DecorationPanel (`DecorationPanel.tsx:538,899`) and ColorSection (`ColorSection.tsx:76,110`). Small, but exactly the residue the owner perceives as soup.

---

## 3. Duplication findings

### 3.1 The gradient/solid cache stash-restore protocol — copied 5× (worst offender in scope)

The `color-gradient.md §13` protocol (on solid→gradient: prefer `color_stops_cache`, else seed from current solid; on gradient→solid: stash stops in cache, collapse to first stop's color) is hand-written, with the same shape and the same `'#bced09'` fallback literal, in **five places in one file**:

1. `RoutePanelBody.setColorMode` — `DecorationPanel.tsx:449–486`
2. `WaypointsPanelBody.setColorMode` — `DecorationPanel.tsx:691–724`
3. `WaypointsPanelBody.setSecondaryColorMode` — `DecorationPanel.tsx:730–763` (same protocol, `'#ffffff'` fallback)
4. `RoutePanelBody.onCopyToWaypoints` — `DecorationPanel.tsx:501–530` (copy + conditional stash)
5. `WaypointsPanelBody.onCopyFromRoute` — `DecorationPanel.tsx:767–795` (near-verbatim duplicate of #4 — both write `settings.waypoints`; only the entry point differs)

`#4` and `#5` are the same operation reachable from two panels and are ~90% identical text. The protocol is fragile (the no-leveling-down cache rule, the ≥2-stops guard, the clone discipline via `cloneStops`) and any future change must be replicated five times. A single pure helper in `gradientMath.ts` — e.g. `toggleColorMode(channel: {color, cache}, next, fallback)` and `copyStopsInto(channel, stops)` operating on the `{color, color_stops_cache}` pair — would collapse all five sites and make the protocol testable once. **Severity: medium** (duplication of a subtle protocol, all within one file, currently consistent).

Related: the default-color literal `'#bced09'` (brand chartreuse) is repeated at `DecorationPanel.tsx:455,474,695,711,1230` instead of referencing `palette.chartreuse` from `theme/tokens.ts:38` — a silent palette-swap hazard given tokens.ts explicitly promises "a palette swap stays surgical" (`tokens.ts:2–3`).

### 3.2 Per-frame paint wiring duplicated between preview and export worker

`buildPerFrameState` returns **named** paint fields (`state.paints.waypointPrimaryColor`, `pulseRadius`, …; `src/lib/mapVisuals/types.ts:37–62`). Each consumer then hand-maps names → `(layerId, property)` pairs:

- Preview: `MapView.tsx:661–723` — e.g. `map.setPaintProperty('waypoints-secondary', 'icon-color', state.paints.waypointSecondaryColor)` (684–685), `setLayoutProperty('waypoints-secondary', 'symbol-sort-key', state.paints.waypointPlacementKey)` (688–689).
- Export worker: `src-tauri/sidecars/renderer/index.ts:736–778` — the same ~13-entry table rebuilt as tuples (`['waypoints-secondary', 'symbol-sort-key', state.paints.waypointPlacementKey]` at 778) and shipped to the page, which applies them generically (`page/init.ts:788–796`).

Today the two tables agree (verified line-by-line, including the subtle sortKey-vs-placementKey split between primary and secondary). But the agreement is **by hand, not by construction**, and there is no test asserting parity — `src/lib/mapVisuals/__tests__/perFrame.test.ts` tests the *values* (e.g. sort-key expressions at lines 437, 467, 518, 543), not the *routing*. This is the one residual gap in the otherwise-excellent mapVisuals contract: a new per-frame paint requires editing two files in two languages' build trees, and a mismatch is a silent preview/export divergence — precisely the failure class the contract exists to prevent. Static paints already solved this correctly: `resolveStaticPaints` returns `[layerId, prop, value]` tuples that **both** sides apply blindly (`MapView.tsx:503–528`; `index.ts:737`; `page/init.ts:509–533`). Extending the tuple pattern to per-frame paints (a `perFrameTuples(state)` function in mapVisuals) erases the duplication. **Severity: medium-high** — not a current bug, but a contract hole on the project's most-protected invariant.

### 3.3 Two components named `Dropdown`

- `src/components/Dropdown.tsx` (329 lines) — a value picker (`role="listbox"`, Norton-Commander styling), used by SourceFormatPicker etc.
- `src/components/shared/Dropdown.tsx` — an action menu (label + onClick items), used by ProjectView/HomeScreen.

Different purposes, same name, sibling directories. Confusion cost only. **Severity: low.**

### 3.4 What is NOT duplicated (counter-evidence to the "soup" thesis)

- One color picker (`ColorSection`) for all three decorations and per-waypoint overrides.
- One gradient editor.
- One layout wireframe renderer (`LayoutPreview`) shared by the configurator overlay and the triptych tiles.
- One segmented picker / grid picker / number stepper / mode picker family, used uniformly (e.g. `DecorationPanel.tsx:547,906,917,927,1137,1147`; `EditToolbar.tsx:96,112,142`).
- The override-pill row appears in both ColorSection (`ColorSection.tsx:345–360`) and ShapeSection (`ShapeSection.tsx:83–99`) as ~15 similar lines — borderline, acceptable.

---

## 4. MapView.tsx ↔ mapVisuals contract audit

**No violations found.** Checked every `setPaintProperty` / `setLayoutProperty` in `src/` (grep): all occurrences are in `MapView.tsx` and all apply values produced by the contract module.

- Static paints/layouts/gradients: applied verbatim from `resolveStaticPaints(mapSettings)` tuples (`MapView.tsx:503–528`), with a self-policing comment at 487–497: "If you find yourself reaching for a new `map.setPaintProperty` … add it to `resolveStaticPaints` instead — anything that lives only here is a divergence waiting to happen." The gradient write at 522–525 documents itself as "the ONLY allowed `setPaintProperty(layer, 'line-gradient', …)` site preview-side."
- Per-frame: all values from `buildPerFrameState` (`MapView.tsx:633–641`); only the name→layer routing is local (the §3.2 finding).
- Layer/source specs come from exported constants (`ROUTE_FULL_LAYER`, `WAYPOINTS_PRIMARY_LAYER`, etc. — imports at 16–32), not inline literals.
- SDF shape icons: `buildAllShapeIcons` is pure shared code; both preview (`MapView.tsx:336–346`) and the renderer page bake "a bit-identical atlas — preview/export parity by construction" (comment 323–331). The uncommitted branch work moved `outlineThicknessCanvasPx` from MapView into `mapVisuals/shapes.ts` (visible in `git diff`: a 23-line local function deleted from MapView, now imported at line 22) — actively *strengthening* the contract.
- Camera resolution goes through `resolveIntent` against the canonical 1080p viewport for the selected aspect (`MapView.tsx:454–472, 626–632`), implementing the perceived-scale-invariance rule rather than ad-hoc zoom math.

Engine-level hacks are contained and documented: forcing `isMoving/isZooming/isRotating = () => true` to defeat MapLibre's at-rest snapping/NEAREST-sampling heuristics carries a 20-line comment citing the exact MapLibre source lines (`MapView.tsx:198–218`). The DPR-change re-rasterization listener (`matchMedia` resolution trick, 104–123) handles the dragged-between-monitors case most apps ignore.

Minor: hardcoded initial center San Francisco `[-122.4194, 37.7749]` (`MapView.tsx:192`) — cosmetic only; route fit overrides it.

---

## 5. State ownership and re-render hygiene

### 5.1 Strong points

- **The 60fps path bypasses React entirely.** `lib/livePlayhead.ts` is a module-level mutable ref written from inside `usePlayback`'s rAF tick and read by MapView's render loop (`MapView.tsx:612–619`), with an explicit "Preview-only — the headless export worker computes its own t" note. No per-frame setState anywhere.
- MapView mirrors all per-frame inputs onto refs so the render loop restarts **only** on `timeline` change (`MapView.tsx:129–162, 596–734`); everything else flows through refs with documented one-frame worst-case staleness (comment 129–132).
- State ownership is consistently parent-up with controlled children: panel position/size/stacking live in MapToolbar so they survive close/reopen (`MapToolbar.tsx:219–260`); export selection lives in ProjectView with an explicit persist-on-success contract (`ExportModal.tsx:62–74`); ColorSection/GradientEditor are fully controlled.
- Scope routing is a deep interface: the toolbar always emits a full resolved `MapSettings`; `ProjectView.handleMapToolbarChange` diffs it against project settings via `computeClipOverrides` to produce minimal per-clip override bags, nulling empty bags (`src/screens/ProjectView.tsx:213–225`). Panels don't know about override storage at all (`DecorationPanel.tsx:4–9` documents this: "MapOverrides routing is free").
- VideoPreview uses a callback-ref + ResizeObserver with same-value bailout for container size (`VideoPreview.tsx:70–90`).

### 5.2 Weak points

- **Zero `React.memo` in the entire component tree** (grep: no matches). Every `MapSettings` tick (e.g. a NumberStepper drag in a decoration panel) re-renders ProjectView and its full subtree. Tolerable today because MapView ignores prop churn via refs and the trees are smallish — but it is the standing reason slider drags cost a full ProjectView render each tick.
- **MapToolbar's overflow-mirror design renders every toolbar item twice on every render** (visible bar + hidden measurement mirror, `MapToolbar.tsx:663–671`) and runs a dep-less `useLayoutEffect(recompute)` after **every commit** (608–610). Each mirror item is measured via `offsetWidth` (596) — forced layout reads per commit. The `MirrorContext` mechanism to stop the mirror's DecorationButtons from stealing refs / double-registering document listeners (52–58, 748–752, 782) is clever and correct, but it's a lot of machinery for right-to-left overflow wrap, and any stateful toolbar child must now be mirror-aware — a leaky obligation on future items.
- **Panel drag writes parent state per pointermove**: `DecorationPanel.startDrag` calls `onPositionChange` on every move event (`DecorationPanel.tsx:209–213`), which sets MapToolbar state (`setPositions`, `MapToolbar.tsx:233–237`), re-rendering the whole toolbar (mirror included) per mousemove. Works, but is the kind of thing the missing-memo point amplifies.
- **Dead no-op effect** in ProjectView: `useEffect` whose both branches are comment-only no-ops (`ProjectView.tsx:186–195`) — pure noise, delete it.
- `useWaypointProgress` (`DecorationPanel.tsx:1261–1272`) is named like a hook but calls no hooks and creates a fresh array per render; its own comment admits "Memoized cheaply by referential identity of the inputs" which is false (it isn't memoized at all). Harmless, misleadingly named.
- Escape on any open decoration panel closes **all** open panels (every panel registers its own document keydown listener, `DecorationPanel.tsx:174–187`) — documented as intentional ("dismiss everything") but N listeners for one gesture.

---

## 6. Styling consistency

Four coexisting approaches:

1. **Two-layer token system** — `src/theme/tokens.ts` is genuinely good: raw `brand` palette deliberately unexported, `semantic` aliases (44–76), `palette` for identity colors (35–42), legacy `colors` aliases kept for old call sites with a "new code: use semantic" note (107–125). 21 component files import from theme.
2. **Per-component `styles.ts` inline-object files** — the dominant pattern (MapToolbar, DecorationPanel, ColorSection, Timeline, VideoPreview, EditToolbar each have one).
3. **One CSS module** — `ExportModal/ExportModal.module.css` (736 lines), used by QueueView, ExportGrid, ExportChip, ExportCell, QueueSummary, ConfigExportModal — while **`ExportModal.tsx` itself uses an inline `styles` object** (line 677) in the same directory. The split is within a single feature folder.
4. **Raw hex literals bypassing tokens** — counted per file (grep, excluding tests and the deliberate `swatches.ts`): LayoutPreview 30, SourceFormatConfirmDialog 23, ExportModal.tsx 22, Timeline/styles.ts 12, VideoPreview/styles.ts 11, NumberStepper 11, EditToolbar/styles.ts 11, ModePicker 10, MapToolbar/styles.ts 10. Notable repeats: the non-token orange `#ff6b35` appears in both `MapToolbar.tsx:835` (SCOPE_FILLS.clip) and `Timeline.tsx:104` (hidden-clip eye); icon gray `#c8c8c8` ×4 in MapToolbar (717, 771, 792, 800); LayoutConfigurator defines its own mini-palette (`HANDLE_FILL '#52d6ff'`, `ALIGNMENT_FILL '#ff52d6'`, lines 46–57 — at least documented as a deliberate two-class visual distinction) and LayoutPreview repeats `'#52d6ff'` (`LayoutPreview.tsx:38`).

Net: the token system's "palette swap stays surgical" promise (`tokens.ts:3`) is currently false — a swap would leave dozens of stragglers. **Severity: medium** for the hex bypass + intra-folder CSS-module/inline split; the styles.ts-vs-CSS question itself is taste.

---

## 7. Test coverage

22 test files against 39 non-test component files, and the tests target the hard logic: `DecorationPanel.test.tsx` 1009 lines, `usePipDrag.test.ts` 899, `ExportModal.test.tsx` 742, `ConfigExportModal.test.tsx` 538, `snap.test.ts` 533, `LayoutConfigurator.test.tsx` 465, `useSplitDrag.test.ts` 439, `ColorSection.test.tsx` 420, `gradientMath.test.ts` 278, `GradientEditor.test.tsx` 275. mapVisuals has its own suite (`perFrame.test.ts`, `styleSpec.test.ts`, `animations.test.ts`). The notable hole is the §3.2 routing parity (no test pins MapView's per-frame layer wiring to the worker's).

---

## 8. State of the uncommitted `feat/control-panel` work

Frontend portion of the working tree (per `git diff --stat -- src/`): 8 files, +114/−53.

- **MapView.tsx (−33 net):** deletes the local `outlineThicknessCanvasPx` (with its derivation comment) and imports it from `mapVisuals` instead — contract-strengthening; comment updated to describe the new no-pixels-over-the-wire atlas parity model ("The export renderer runs the SAME function in its own Chrome page (init.ts) with the same outlineThickness + pixelRatio inputs").
- **types.ts (+72/−... ):** adds the `'hdr_pq'` delivery target alongside `'hdr_hlg'` (`types.ts:106–107`, registry entries 145–152) — consistent with the HDR-co-equal constraint.
- **ExportChip.tsx:** `targetToken` now distinguishes `'HLG'` vs `'PQ'` (diff hunk at line 94–101).
- **DecorationPanel.tsx:** `SizeRow` max raised 30→120 px (line 1214 area).
- **In-flight gap:** `ConfigExportModal.tsx:348` still reads `const isHdr = target.id === 'hdr_hlg'` — the new `hdr_pq` row will not get the HDR educational tooltip (line 353–354). Needs `target.id === 'hdr_hlg' || target.id === 'hdr_pq'` (with PQ-appropriate copy) before merge.
- **Untracked debris:** `scratchpad.html`, `map-sampling-explorer.html`, `.spike/` at repo root — spike artifacts that should not ride along into a commit.

The branch is coherent polish moving in the right direction (logic migrating *into* mapVisuals, HDR-PQ added as first-class), not half-finished churn.

---

## 9. Gems (hard-won, preserve in any rewrite)

1. **The mapVisuals consumption discipline in MapView.tsx** — the per-frame loop architecture (refs for inputs, restart only on timeline change, `livePlayheadMs` module ref bypassing React state, apply-with-no-smoothing because "export samples the same function per frame", `MapView.tsx:586–595`), the canonical-viewport camera resolution (454–472, 626–632), and the self-policing contract comment (487–497). This file encodes months of preview/export-parity learning.
2. **MapLibre engine-fight knowledge** — `isMoving/isZooming/isRotating = () => true` with the cited MapLibre internals (raster align rounding in `mercator_transform.ts:677–681`, NEAREST icon sampling in `draw_symbol.ts:365,370`) at `MapView.tsx:198–218`; `lineMetrics: true` must-be-set-at-addSource and the setStyle()-drops-everything re-add path (262–283, 316–331); DPR-change SDF re-rasterization (104–123). All empirically earned; none rediscoverable cheaply.
3. **One ColorSection for every color surface** — the single `applyColor` routing bridge (`ColorSection.tsx:175–181`) and the visibility-rule matrix in the header (23–29) mean the decoration-independence model (Route/Waypoints/POV own configs, copy-button linking) is enforced by composition, not by three divergent pickers.
4. **The snap model in `LayoutConfigurator/snap.ts`** — aspect/position/margins as three orthogonal concerns, golden-ratio + thirds anchors, equal-margin pair-equality diagonals (header comment lines 34–53), 533 lines of tests. Plus the distinct alignment-vs-affordance color classes documented at `LayoutConfigurator.tsx:52–56`.
5. **Scope/override routing via diffing** — toolbar emits resolved settings; `computeClipOverrides` diffs to minimal override bags; empty bags nulled (`ProjectView.tsx:213–225`); panels stay override-agnostic (`DecorationPanel.tsx:4–9`); override-state surfaced as per-leaf accent rollups (`MapToolbar.tsx:129–164`).
6. **ExportModal's async-race correctness** — ref-read-before-write to avoid clobbering a faster folder pick (`ExportModal.tsx:261–268`), merged prefill/auto-default effect with the race documented (230–234), persist-once latch honoring "cancelled but partially done" runs (211–221).
7. **The two-layer token system design** (`tokens.ts:1–5, 30–42`) — unexported raw palette, semantic aliases, identity-color escape hatch. The *design* is right even though enforcement is leaky (§6).

## 10. Questionable decisions (with severity)

| # | Finding | Location | Severity |
|---|---|---|---|
| Q1 | Per-frame paint name→layer wiring duplicated between preview and export worker; no parity test; static paints already solved this with tuples | `MapView.tsx:661–723` vs `src-tauri/sidecars/renderer/index.ts:736–778` | **medium-high** |
| Q2 | Gradient/solid cache stash-restore protocol hand-copied 5× (incl. two near-verbatim copy-stops functions) with repeated `'#bced09'` literal | `DecorationPanel.tsx:449–486, 501–530, 691–724, 730–763, 767–795` | **medium** |
| Q3 | DecorationPanel 19-prop surface; MapToolbar repeats the 20-line instantiation 3×; window-management and data concerns flattened together | `DecorationPanel.tsx:103–145`; `MapToolbar.tsx:351–455` | **medium** |
| Q4 | Token bypass: dozens of raw hex literals (incl. cross-file repeats `#ff6b35`, `#52d6ff`) defeat the palette-swap promise; CSS module vs inline styles split *inside* the ExportModal folder | §6 counts; `tokens.ts:3`; `ExportModal.tsx:677` vs `ExportModal.module.css` | **medium** |
| Q5 | Overflow-mirror toolbar: double-render of all items + dep-less per-commit layout-read effect + MirrorContext obligation on stateful children | `MapToolbar.tsx:43–58, 563–621, 663–671` | **medium-low** |
| Q6 | No `React.memo` anywhere; settings drags re-render full ProjectView subtree; panel drag writes parent state per pointermove | grep (no matches); `DecorationPanel.tsx:209–213` | **low-medium** |
| Q7 | Branch gap: `hdr_pq` added to types/chip but ConfigExportModal HDR tooltip still HLG-only | `ConfigExportModal.tsx:348–354` | **low** (WIP branch) |
| Q8 | Dead freight: `activeClipId` prop kept-for-parity, deprecated `totalDistMeters` still threaded, no-op scope effect, misnamed non-hook `useWaypointProgress` | `MapView.tsx:52–61,167`; `GradientEditor.tsx:53–55`; `ProjectView.tsx:186–195`; `DecorationPanel.tsx:1261` | **low** |
| Q9 | Two components named `Dropdown` with different semantics | `components/Dropdown.tsx` vs `components/shared/Dropdown.tsx` | **low** |

---

## 11. Fresh-start recommendation

**Keep with cleanup — do not rewrite this layer.** The expensive knowledge here (MapLibre engine workarounds, parity loop architecture, snap model, race-hardened export flow) is embedded in working, tested code, and the structural problems are local and mechanical: extract the stash/restore protocol into `gradientMath.ts` (Q2), move per-frame paint routing into a mapVisuals tuple function consumed by both sides (Q1 — this also closes the last contract hole), split DecorationPanel into FloatingPanel shell + body (Q3), and run a token sweep (Q4). A rewrite would re-risk every empirically-earned MapLibre behavior in §9.2 for no architectural gain — the architecture is already the one a fresh start would aim for.
