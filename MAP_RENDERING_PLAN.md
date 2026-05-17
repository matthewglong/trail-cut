# Map Rendering — Plan

Status: ready to implement. Math is settled; remaining work is execution.

## Product-owner spec (load-bearing)

> Video exports must preserve consistent perceived scale across both aspect ratios and output resolutions. For the same route and export settings, changing from 16:9 to 9:16, or from 1080p to 4K, should not change the apparent zoom level of the map or the apparent size/thickness of trails, markers, POIs, labels, and other overlays. Aspect ratio changes should only change the shape and amount of visible map area. Resolution changes should only change pixel density and sharpness. The export pipeline should therefore separate logical viewport scale from raster output size, using a canonical camera/world scale that is independent of the final pixel dimensions.

Two anchors derived from this:

- **Aspect change** → same scale (m/CSS-px), same overlay CSS-px size. Visible *area* differs because canvas shapes differ.
- **Resolution change** → same scale, same overlay CSS-px size, only `pixelRatio` (framebuffer density) changes.

## Background

TrailCut renders MapLibre maps in two surfaces:

1. **Project-view preview** — `src/components/MapView.tsx`. Interactive map shown to the user while they edit clips. Aspect changes drive a per-aspect "canonical" CSS width that `mapSettings.zoom` is interpreted against.
2. **Export renderer (sidecar)** — `src-tauri/sidecars/renderer/page/init.ts` plus the worker in `src-tauri/sidecars/renderer/index.ts`. Headless Chromium + MapLibre, one frame at a time, pixels read back via `gl.readPixels`.

Both surfaces share the per-frame paint sizing in `src/lib/mapVisuals/` and the layout math in `src/lib/layout.ts` (mirrored in Rust at `src-tauri/src/export/layout.rs`).

## The two bugs we're fixing

### Bug 1: sub-1 pixelRatio for small map slots

Current viewport derivation (`canonicalMapViewport` at `src/lib/layout.ts:90`, mirrored at `src-tauri/src/export/layout.rs:87`):

```ts
cssW       = canonicalMapCssWidth(aspect)   // 1080 for 9_16/4_5, 1920 for 16_9
pixelRatio = mapSlotW / cssW
cssH       = round(mapSlotH / pixelRatio)
```

Pins `cssW` to a per-aspect constant and lets `pixelRatio` absorb whatever shape the slot is. For full-frame slots at 1080p this is fine — `pixelRatio = 1`. For small PiP map-as-inset slots it produces sub-1 `pixelRatio`:

- Fixture case `pip_9_16_p720_map_inset` (real): aspect=9_16, slot=230×230 → `cssW=1080, pixelRatio≈0.213, cssH=1080`.
- MapLibre lays out the world (collision boxes, label placement, tile selection) in a 1080×1080 CSS virtual viewport, then rasterizes into 230×230. The sub-1 regime is barely-tested in MapLibre and produces label snap glitches, dasharray artifacts, and wrong tile-zoom selection.

`pixelRatio` is doing two jobs — output density AND "compress everything to fit a smaller framebuffer." That overload is the conceptual bug.

### Bug 2: overlay CSS-px size varies by aspect

Paint sizes today (`src/lib/mapVisuals/styleSpec.ts:45-57`, applied in `resolveStaticPaints` at `:275`):

```ts
paint = fraction × cssViewport.w   // renderer
paint = fraction × paneCssWidth    // preview
```

Concrete: `routeTrailLineWidth = 0.01`. At 9_16 1080p (`cssViewport.w = 1080`) the trail is 10.8 CSS px. At 16_9 1080p (`cssViewport.w = 1920`) the trail is 19.2 CSS px — nearly **2× thicker**. Violates the product spec directly: aspect change should not alter overlay thickness.

## The lever model

Pick a single canonical resolution: 1080p (the existing reference). Then for any (slot pixel dims, export resolution):

```
multiplier  = outputDims(aspect, exportRes).w / outputDims(aspect, '1080p').w
cssW        = round(mapSlotW / multiplier)
cssH        = round(mapSlotH / multiplier)
pixelRatio  = multiplier
```

Properties:

- **`cssViewport` aspect = slot aspect.** No "render-then-crop". MapLibre paints into the slot shape directly.
- **At fixed `pixelRatio`, fixed MapLibre zoom Z gives fixed meters-per-CSS-pixel.** Same Z across exports = same scale.
- **`pixelRatio ∈ {1, 4/3, 2}` always.** Crisp at 1080p, fractional but well-defined at 1440p, sharper at 2160p. No sub-1 regime ever (Decision 1).
- **Resolution change** only shifts `pixelRatio`. cssViewport identical. Scale identical. Overlay CSS-px identical.

### Paint sizes as fixed CSS-px constants

Separately: paints stop tracking `cssViewport.w`. Introduce a single `PAINT_REFERENCE_WIDTH = 1080` constant; paint values become `fraction × PAINT_REFERENCE_WIDTH`. Trail is 10.8 CSS px **everywhere** — every aspect, every resolution, every slot shape.

Combined with the lever model above, the product-owner spec falls out:

| Aspect | Resolution | cssW | cssH | pixelRatio | Trail CSS px |
|---|---|---|---|---|---|
| 9:16 | 1080p full-frame | 1080 | 1920 | 1 | 10.8 |
| 16:9 | 1080p full-frame | 1920 | 1080 | 1 | 10.8 |
| 16:9 | 2160p full-frame | 1920 | 1080 | 2 | 10.8 |
| 16:9 | 1080p PiP inset 480×270 | 480 | 270 | 1 | 10.8 |

Same scale (same Z → same m/CSS-px), same overlay thickness everywhere. Aspect / resolution / slot-shape only change the *amount* of map area visible.

## Decisions (settled — do not relitigate)

1. **No sub-1080p rendering.** 720p deliverables go through 1080p render + FFmpeg downsample. Guarantees `multiplier ≥ 1`.
2. **1440p stays.** `multiplier = 4/3` at 1440p, `pixelRatio ≈ 1.333`. Math is exact for all three full-frame aspects (16:9 → 2560×1440 / 1.333 = 1920×1080 exactly; same for 9:16 and 4:5). Inset rounding stays sub-pixel. MapLibre handles fractional pixelRatio (Windows displays run at 1.5 all the time).
3. **Per-clip camera state is one number.** `mapSettings.zoom` is a single MapLibre Z value per clip; the same number applies to every aspect/layout/resolution export of that clip. No per-aspect or per-layout zoom override. The author dials Z once in the preview; the system applies it everywhere. There is no "re-author zoom for PiP."
4. **No migration of stored projects.** TrailCut is pre-1.0; no shipped projects. The plan ships and any existing local projects render under the new model.
5. **Preview keeps today's compensation.** See next section — this is the one place the prior draft of this plan got wrong.

## Preview behavior

Today's preview (`src/components/MapView.tsx:530-532`):

```ts
displayZoom = state.camera.zoom + Math.log2(mapSubregionCssWidth / canonicalMapCssWidth(aspect))
```

This compensation makes preview-pane reshape feel like a uniform scale: same world visible, same trail-in-meters, just rendered at a different physical size in the UI. At `paneCssWidth = canonicalMapCssWidth(aspect)` the preview matches the 1080p export of that aspect exactly (WYSIWYG).

**Keep this compensation.** It's what supports clip authoring — the user dials Z in the preview and trusts the export will match.

For paints under the new model, change the preview's anchor:

```ts
// Preview paint formula
paint_preview = fraction × PAINT_REFERENCE_WIDTH × (paneCssWidth / canonicalMapCssWidth(aspect))
```

This composes correctly with the zoom compensation:

- Reshape preview → paint scales with pane width, compensated zoom keeps framing constant, **trail-in-meters stays constant**. Same "uniform scale" feel as today.
- Aspect switch in preview at the same pane width → paint at `pane = canonical(aspect)` is exactly `fraction × PAINT_REFERENCE_WIDTH = 10.8 CSS px` regardless of aspect. **No more 10.8 → 19.2 doubling on aspect switch.**
- Preview at `pane = canonical(aspect)` → trail = 10.8 CSS px. Matches the 1080p export of that aspect exactly. **WYSIWYG preserved.**

The renderer worker uses the bare constant (no compensation):

```ts
// Export paint formula
paint_export = fraction × PAINT_REFERENCE_WIDTH
```

## What changes in the code

### 1. `src/lib/layout.ts` — `canonicalMapViewport` (line 90)

Rewrite to take an `outputRes` argument:

```ts
export function canonicalMapViewport(
  aspect: AspectRatio,
  mapSlotW: number,
  mapSlotH: number,
  outputRes: OutputResolution,
): CanonicalMapViewport {
  const multiplier = outputDims(aspect, outputRes).w / outputDims(aspect, '1080p').w;
  const cssW = Math.round(mapSlotW / multiplier);
  const cssH = Math.round(mapSlotH / multiplier);
  return { cssW, cssH, pixelRatio: multiplier };
}
```

`canonicalMapCssWidth` (line 60) is no longer used by viewport derivation. **Keep it as-is** — the preview's `log2(pane/canonical)` compensation still consumes it. It's no longer "the cssW the renderer lays out at"; it's now "the CSS width at which `mapSettings.zoom` is calibrated in the preview UI."

### 2. `src-tauri/src/export/layout.rs` — `canonical_map_viewport` (line 87)

Mirror the TS change. Add `OutputResolution` parameter. Update unit tests; the existing tests at lines 556-637 are calibrated to the old `cssW = canonical` invariant — replace them with the new invariants (see Test Strategy).

### 3. `src/lib/mapVisuals/styleSpec.ts` — add `PAINT_REFERENCE_WIDTH`

```ts
export const PAINT_REFERENCE_WIDTH = 1080;
```

Update `resolveStaticPaints` (`:275-318`): take no argument (or take it and ignore for now); compute `paint = fraction × PAINT_REFERENCE_WIDTH`.

### 4. `src/lib/mapVisuals/paints.ts` — `buildPerFramePaints`

Drop the `mapRegionCssWidth` parameter. Compute `defaultRadius` / `activeRadius` against `PAINT_REFERENCE_WIDTH`. Update `pulseAt` similarly in `src/lib/mapVisuals/animations.ts` (it takes a width arg today).

### 5. `src/components/MapView.tsx` — preview paint with reshape factor

Keep the `log2(paneCssWidth / canonicalMapCssWidth(aspect))` zoom compensation at `:385` and `:530-532` — unchanged.

For paints, replace the `resolveStaticPaints(paneCssWidth)` call (`:411`) with a preview-specific resolver that multiplies by `(paneCssWidth / canonicalMapCssWidth(aspect))`. Concretely: add a `resolveStaticPaintsForPreview(paneCssWidth, aspect)` helper in styleSpec.ts that returns the same shape but with the reshape factor baked in, and call it here. Same change for the per-frame paint call site at `:516-525`.

### 6. `src-tauri/sidecars/renderer/index.ts` — bare constant for paints

Line 461: `const staticPaintResolution = resolveStaticPaints(payload.cssViewport.w)` → call the new (parameter-less or constant-anchored) resolver.

Line 632: `payload.cssViewport.w` passed to `buildPerFrameState` for paint sizing → no longer needed; the per-frame builder uses the constant internally.

The pad/crop logic at `page/init.ts:526+` was a guard for sub-1 pixelRatio fractional framebuffer mismatches. With `pixelRatio ∈ {1, 4/3, 2}` and integer cssDims (verified by parity test), the actual and expected framebuffers match within ≤1 px. Keep the guard; treat its warning as a real bug signal.

### 7. `src-tauri/src/export/mod.rs` — thread resolution into setup payload

`build_setup_payload` (`:464`) currently calls `canonical_map_viewport(aspect, fb.w, fb.h)`. Add the resolution argument: `canonical_map_viewport(aspect, fb.w, fb.h, req.layout.resolution)`. The resolution is already on the request (`req.layout.resolution`); just plumb it through.

### 8. `src-tauri/tests/fixtures/layout_parity.json`

The `expected_canonical_map_viewport` entries are calibrated to the old math. Regenerate after the TS + Rust changes are in. Both the TS test (`src/lib/__tests__/layout.test.ts`) and Rust test (`src-tauri/tests/layout_parity.rs`) consume this fixture.

The fixture cases need an `output_resolution` field per case so the new `canonical_map_viewport` signature has all required inputs. Default existing cases to `"1080p"`; add a handful of 720p / 1440p / 2160p cases.

### 9. Golden frames

`src-tauri/tests/fixtures/golden-frames/` will all be invalidated. Plan:

1. Land §1-8 first. Don't try to intermediate-regenerate goldens.
2. Run `golden_frame_regenerate` once at the end.
3. Spot-check the regenerated frames: trail/waypoint thickness consistent across slots, no sub-1 glitches.

## Test strategy

### New invariants (write BEFORE touching `layout.ts`)

`src/lib/__tests__/layout.test.ts`:

> For any `(aspect, mapSlotW, mapSlotH)` and any `OutputResolution`:
> - `pixelRatio === outputDims(aspect, res).w / outputDims(aspect, '1080p').w` exactly.
> - `Math.abs(cssW * pixelRatio - mapSlotW) < 1` (rounding drift bound).
> - `Math.abs(cssH * pixelRatio - mapSlotH) < 1`.
> - `cssW / cssH ≈ mapSlotW / mapSlotH` (within ≤1 px aspect drift).
> - `pixelRatio >= 1` for all `OutputResolution` values the app exposes.

The existing test at `:437` ("9_16: pixelRatio scales with resolution but cssViewport does not") asserts the OLD invariant and must be replaced.

The existing test at `:456` ("PiP map-inset on 16:9 720p produces pixelRatio < 1 with sensible cssH") asserts BROKEN behavior. Delete; replace with `pixelRatio >= 1` assertion.

Mirror in Rust.

### Paint invariants

`src/lib/mapVisuals/__tests__/styleSpec.test.ts`:

> `resolveStaticPaints()` returns the same trail width / circle radius / etc. regardless of input.
> Concretely: `routeTrailLineWidth` is always `0.01 × PAINT_REFERENCE_WIDTH = 10.8`.

`src/lib/mapVisuals/__tests__/perFrame.test.ts`:

> `buildPerFramePaints` returns radii independent of any width input.

### Preview-paint invariant

New test in `src/components/__tests__/MapView.test.tsx` (or pure-function test if the helper is extracted):

> `resolveStaticPaintsForPreview(canonicalMapCssWidth(aspect), aspect)` returns the same trail width as the export-side `resolveStaticPaints()` — verifies the WYSIWYG property at canonical pane size.

## What this plan does NOT change

- Style spec contents (which layers exist, colors, opacities, fill-extrusion meters).
- Animation orchestration (per-frame source/paint updates, camera pan logic).
- Tile fetching, `transformRequest`, the `trailcut://` protocol cache.
- The painter patches in `page/init.ts` (forcing `moving = true` etc.) — all that infrastructure stays.
- Project bundle format. No `project.json` schema change.
- `canonicalMapCssWidth` itself — it remains the reference for the preview's zoom compensation, just no longer the renderer's cssW.

## Implementation order

Tasks are tracked in the harness task list (TaskList). Suggested order:

1. **Plan example fix** — this doc is already corrected; only the historical "1920×3413" example is gone. ✓
2. **TS lever model** — rewrite `canonicalMapViewport`; update TS layout tests (assert new invariants, delete the two stale tests).
3. **Rust lever model** — mirror in `layout.rs`; update Rust unit tests.
4. **Parity fixture** — add `output_resolution` field; regenerate `expected_canonical_map_viewport` values; add 720p/1440p/2160p cases.
5. **Paint refactor** — add `PAINT_REFERENCE_WIDTH`; update `resolveStaticPaints`, `buildPerFramePaints`, `pulseAt`. Update their tests.
6. **Renderer worker** — drop `cssViewport.w` from paint call sites; use the constant.
7. **Preview** — keep zoom compensation; add `resolveStaticPaintsForPreview`; wire it into `MapView.tsx`.
8. **Orchestrator** — thread `OutputResolution` into `build_setup_payload`.
9. **Golden frames** — regenerate; spot-check.

Land as one PR. The math is interconnected; intermediate golden regenerations would burn a day chasing inconsistent states.

## Settled-but-worth-remembering decisions

- Goal 1 of the original draft ("Geographic zoom appears consistent") = the product-owner spec quoted at the top of this doc. "Same scale, varying visible area" is the chosen reading.
- The original draft's Decision 2 ("preview is aspect-agnostic, renders at container dims with literal Z") was wrong — it would have killed WYSIWYG authoring. Replaced by §"Preview behavior" above.
- The original draft's worked example (1920×3413, pixelRatio ≈ 0.211) was arithmetically impossible. The real failure mode is small PiP map insets like `pip_9_16_p720_map_inset` (slot 230×230, pixelRatio ≈ 0.213). This doc uses the real case.
