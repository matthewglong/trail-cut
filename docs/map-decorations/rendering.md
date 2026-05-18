# Map Decorations — Rendering Pipeline Architecture

This document covers how the new color/gradient/shape model for Route, Waypoints, and POV gets drawn in MapLibre, with reference to the existing pipeline so every proposed change is grounded in what the code actually does today.

## 1. Current Pipeline — What Exists

### Source and Layer Inventory

The map is initialised from `src/lib/mapVisuals/styleSpec.ts` and sources are added in `MapView.tsx` (lines 211–230) and mirrored exactly in `src-tauri/sidecars/renderer/index.ts` (lines 431–436). Current draw order:

| Source id | Layer id(s) | Type | Notes |
|---|---|---|---|
| `route-full` | `route-full-line` | `line` | Full GPX trace. Visibility toggled by `route_mode === 'full'`. |
| `route-trail` | `route-trail-line` | `line` | Slime trail up to playhead. Visibility toggled by `route_mode === 'visited'`. |
| `waypoints` | `waypoints-circle`, `waypoints-label` | `circle` + `symbol` | One point feature per clip. Feature properties: `{ id, index }`. |
| `live-marker` | `live-marker-pulse`, `live-marker-dot` | `circle` (×2) | Single-point collection at resolved playhead position. |

### How Route Geometry Is Built

`buildFullRouteFeature` in `src/lib/mapVisuals/sources.ts` (lines 43–55) converts `Route.trackpoints` into a GeoJSON `LineString` with no additional properties. The source is registered as:

```js
{ type: 'geojson', data: lineStringFeature }
```

There is no `lineMetrics: true` on either the `route-full` or `route-trail` source anywhere in the current code. This is a critical gap for gradient support — addressed in section 3.

### How Waypoints Are Built

`buildWaypointsCollection` in `sources.ts` creates one `Point` feature
per entry in `project.waypoints: Waypoint[]` (schema v7 made waypoints
first-class — the function takes `waypoints: Waypoint[]`, not `clips`).
Feature properties are currently `{ id: wp.id, index: number, clipId,
label }`. The `index` field drives the 1-based ordinal label via
`waypoints-label`'s `text-field` expression.

For `wall_clock_ms`-anchored waypoints, placement resolves the
wall-clock time against the indexed GPX route and falls back to
`position.fallback_gps` when the time is outside the route or the gap
exceeds `MAX_INTERPOLATION_GAP_MS` (60 seconds). For `fixed`-anchored
waypoints, the literal lat/lng is used directly.

v8 extends each feature's properties with two more:

- `override_color: string | null` — read from `wp.color`.
- `override_shape: string | null` — read from `wp.shape`.

Both are consumed by data-driven paint / layout expressions described
below.

### How the POV Marker Is Implemented

The live marker is **not a DOM overlay**. It is two MapLibre `circle` layers sourced from the `live-marker` GeoJSON source. `live-marker-pulse` is the expanding outer ring; `live-marker-dot` is the small filled dot. Their specs are defined in `styleSpec.ts` (lines 177–204). Per frame, `pulseAt(projectTimeMs, mapSettings)` from `src/lib/mapVisuals/animations.ts` computes `radius` and `opacity`; these scalars are applied via `setPaintProperty` in the rAF loop in `MapView.tsx` (lines 503–518) and equivalently in the per-frame renderer call in `index.ts` (lines 665–672).

Because the live marker is a MapLibre layer, it renders into the WebGL framebuffer and exports natively. No special compositing is needed.

### Paint Property Wiring

Paint values flow through two paths:

**Static paints** — `resolveStaticPaints` in `styleSpec.ts` (lines 255–297) returns arrays of `[layerId, prop, number]` tuples for line widths, stroke widths, and radii. Called once after `style.load` and again on any `mapSettings` or `styleVersion` change. Both `MapView.tsx` (lines 377–388) and the export renderer apply these via `setPaintProperty` loops.

**Per-frame paints** — `buildPerFramePaints` in `paints.ts` returns a `PaintUpdates` object with named fields for the active-clip highlight (`case` expressions on `circle-radius`, `circle-color`, `circle-stroke-color`) and pulse scalars. Applied via `setPaintProperty` each rAF tick in `MapView.tsx` (lines 504–518) and per frame in `index.ts` (lines 665–672).

`PaintUpdates` in `src/lib/mapVisuals/types.ts` and `ResolvedStaticPaints` in `styleSpec.ts` are the two extension points for new paint fields.

### Export Pipeline

The export pipeline at `src-tauri/sidecars/renderer/index.ts` imports `buildStyleSpec`, `buildStaticSourceData`, `buildPerFrameState`, and `resolveStaticPaints` from `src/lib/mapVisuals` — the exact same module `MapView.tsx` uses. The renderer runs MapLibre inside headless Chrome via puppeteer, applies per-frame state via `__applyFrame` (defined in `src-tauri/sidecars/renderer/page/init.ts`), and reads the WebGL framebuffer via `gl.readPixels` synchronously inside MapLibre's `render` event handler. The RGBA bytes are base64-encoded and sent back to the Rust orchestrator. There is no separate server-side rendering path.

The consequence: everything drawn by MapLibre layers is automatically captured at full export resolution. Gradient lines, symbol-layer shapes, animated circle layers — all render identically in preview and export because both run the same MapLibre code against the same data.

---

## 2. Route Gradient Rendering

### `lineMetrics: true` Must Be Added

MapLibre's `line-gradient` paint property requires `lineMetrics: true` on the GeoJSON source. This causes MapLibre to compute per-vertex projected distance metrics at tile load time, which populates the `line-progress` internal attribute. Without it, `line-gradient` silently does nothing — the line renders transparent or with the fallback `line-color`.

**The option is not set anywhere in the current code.** It must be added at source-add time in four places:

- `MapView.tsx` line 213: `map.addSource('route-full', { type: 'geojson', data: emptyLine })` becomes `{ type: 'geojson', data: emptyLine, lineMetrics: true }`.
- `MapView.tsx` line 217: same change for `route-trail`.
- `src-tauri/sidecars/renderer/index.ts` line 432: the `route-full` entry in `staticSources`.
- `src-tauri/sidecars/renderer/index.ts` line 433: the `route-trail` entry.

`lineMetrics: true` cannot be added after `addSource` — it is a source-level option that triggers extra attribute computation during tile loading. It must be present at `addSource` time. A style reload (which drops and re-adds all sources) is the only way to change it later, but that is never needed because gradient mode is always opted into at project creation time.

Adding `lineMetrics: true` to a source that currently uses solid `line-color` is a non-breaking change. The `line-color` paint property still works normally; `line-progress` metrics are computed but unused until a `line-gradient` expression is applied.

### `line-gradient` Expression

Once `lineMetrics: true` is set, switching to gradient replaces the `line-color` paint property with `line-gradient`. They are distinct paint properties — you set one or the other via `setPaintProperty`. A two-stop gradient from chartreuse to coral uses:

```
["interpolate", ["linear"], ["line-progress"], 0, "#bced09", 1, "#ff715b"]
```

`line-progress` runs `0.0 → 1.0` from first to last vertex of the line. For the full-route source, this maps directly to trail distance. Multi-stop gradients add more `fraction, color` pairs; stops must be in ascending order.

### Mercator-Parameterized Fractions

The existing `progressUpTo` function in `src/lib/routeLocation.ts` (lines 268–297) computes a `[0, 1]` fraction for a given wall-clock time, parameterized in Web Mercator projected distance rather than geodesic distance. The comment at lines 248–264 explains why: MapLibre's `line-progress` is computed in projected tile space, and a geodesic-parameterized fraction can disagree with the painted gradient position by tens of pixels at high zoom and mid-latitudes. Using `cumulativeMercatorMeters` (stored on `IndexedRoute`) ensures the stop fractions used for waypoint gradient colors (section 3) agree exactly with what `line-progress` evaluates on the route line.

### Slime-Trail (`route-trail`) Gradient

The `route-trail` source is a dynamically rebuilt `LineString` that grows from the route start to the current playhead position. When `lineMetrics: true` is set on its source, `line-progress` within the trail line runs `0 → 1` within the current slime-trail extent, not across the full route. This means a direct `line-gradient` on the trail would always color it from stop-0 to stop-1 regardless of how much of the route has been covered — which is visually wrong if the trail is supposed to show "you are at the 70% gradient color."

The practical resolution: for the slime trail, apply the gradient as a two-stop expression where both stops bracket the current progress range. Computing the current head's progress (`progressUpTo(trailHeadWallMs, indexedRoute)`) and using it to clamp the stops is possible but requires rebuilding the expression every frame. The simpler approach: render the slime trail as a solid color matching the gradient's color at the current progress fraction. This is a single `setPaintProperty` call per frame rather than an expression rebuild, and it is visually correct at the trail head. A full gradient on the already-visited portion is a deferred enhancement.

---

## 3. Waypoint Gradient Rendering

### Per-Feature `progress` Property

MapLibre circle layers have no `circle-gradient` property. Waypoint
gradient colors must be precomputed per feature and stored as feature
properties, then referenced via a data-driven expression on
`circle-color`.

The property to add is `progress: number` — a `[0, 1]`
Mercator-parameterized fraction computed via
`progressUpTo(wp.position.ms, indexedRoute)` for `wall_clock_ms`-anchored
waypoints. It is added in `buildWaypointsCollection` in `sources.ts`.
The computation happens once per waypoint per call, which already runs
whenever `waypoints`, `route`, or `mapSettings` changes (gated by
`MapView.tsx` `useEffect`).

Updated feature properties:
`{ id, index, clipId, label, progress, override_color, override_shape }`.

For `fixed`-anchored waypoints, or `wall_clock_ms` waypoints whose
time falls outside the indexed route, `progressUpTo` is not callable
with a meaningful timestamp. These waypoints receive `progress: 0` —
they take the gradient's start color. This is a reasonable fallback:
the waypoint's position on the route is unknown, so the start color
is as meaningful as any other choice.

### Gradient Expression on `circle-color`

The `circle-color` paint property supports data-driven expressions. A pure gradient with no active-clip highlight:

```
["interpolate", ["linear"], ["get", "progress"], 0, "#bced09", 1, "#ff715b"]
```

MapLibre evaluates this per feature at paint time. Each waypoint gets its own color from its baked-in `progress` value. The expression is set once via `setPaintProperty` and does not need to be rebuilt per frame unless the gradient stops themselves change.

### Composing with Active-Waypoint Highlight and Per-Waypoint Override

Today, `buildPerFramePaints` in `paints.ts` emits a `case` expression
per frame for `waypointCircleColor` that highlights the active
waypoint in `#4a9eff`. Per `DESIGN.md`, per-waypoint override is
solid-only ("force this one waypoint to be gold") and lives on
`Waypoint.color`, not on `clip.map_overrides`. The composition of all
three sources of color (gradient, per-waypoint override,
active-highlight) into a single `circle-color` expression:

```
["case",
  ["has", "override_color"],                      ["get", "override_color"],
  ["==", ["get", "id"], activeWaypointId],        activeHighlightColor,
  <gradient interpolate expression>
]
```

(Override-vs-active priority is held at override-wins per DESIGN.md
framing — "force this one to be gold" should not be silently lost
when the waypoint becomes the active one. The active-radius bump
still signals "you are here.")

The `override_color` property is baked into the feature by
`buildWaypointsCollection`, reading `wp.color` directly from the
`Waypoint` entity (see `data-model.md` §2a). When `wp.color` is
`undefined`, the property is left off the feature; `["has",
"override_color"]` is the guard.

The active-waypoint id is matched against `id` (waypoint id), not
`clipId` — the active state is "this waypoint is currently passed by
the playhead," not "this waypoint belongs to the active clip."
Fixed-position waypoints participate or not based on
`mapSettings.waypoints.active_mode` (the `'latest_passed'` strategy
covers wall-clock-anchored waypoints only in v1).

```
["case",
  ["has", "override_color"],                      ["get", "override_color"],
  ["==", ["get", "id"], activeWaypointId],        activeHighlightColor,
  ["interpolate", ["linear"], ["get", "progress"], 0, startColor, 1, endColor]
]
```

This expression is rebuilt and pushed via `setPaintProperty` each
frame in `buildPerFramePaints` because `activeWaypointId` changes per
frame. The gradient stops are read from
`mapSettings.waypoints.color.stops` at build time. When mode is solid
(`mapSettings.waypoints.color.mode === 'solid'`), the interpolate arm
degenerates to a constant color expression; MapLibre optimizes
constant expressions internally.

### Waypoint Location vs Route Position

Waypoints are not forced onto the route polyline. `waypointLocation`
resolves the position from the waypoint's `position` discriminant
against the route, which may produce a point slightly off the polyline
due to GPS drift (or wholly elsewhere for `fixed` waypoints). The
`progress` fraction is time-derived for `wall_clock_ms` waypoints —
"how far along the route was the hiker at this wall-clock moment" —
which is consistent with the route line's gradient parameterization.
Waypoints that fall back to embedded GPS coordinates (no timestamp
match) or are `fixed`-anchored get `progress: 0` as discussed above.
This is the right design: the gradient communicates distance traveled,
not physical proximity to the route.

---

## 4. Waypoint Shape Rendering

### Circle and Ring

The existing `waypoints-circle` circle layer handles both. Ring is a circle with `circle-color: 'rgba(0,0,0,0)'` (transparent fill) and `circle-stroke-color` set to the waypoint color. Both shapes are driven by paint properties; no new layer or source changes are required.

### Symbol-Based Shapes: Pin, Diamond, Square, Numbered Circle

Non-circle shapes require a `symbol` layer with `icon-image`
referencing images registered via `map.addImage()`. The recommended
implementation is **one additional `waypoints-symbol` layer** using a
data-driven `icon-image` expression:

```
["get", "iconImage"]
```

where `iconImage` is a feature property set in
`buildWaypointsCollection` as
`'waypoint-' + (wp.shape ?? mapSettings.waypoints.shape)`. Per-waypoint
shape overrides (`Waypoint.shape`, see `data-model.md` §2a) win over
the project default — the property is computed per-feature, so each
waypoint can independently render in its own shape.

A single symbol layer with data-driven `icon-image` is preferred over
separate layers per shape for the following reasons: no per-shape
visibility management is needed, the layer stack does not grow with
the shape count, mixed shapes (one diamond + four circles) render
correctly without per-layer juggling, and feature-count-based
rendering is more efficient than MapLibre checking multiple layers.

For mixed-shape scenes (some waypoints overridden to symbol shapes,
others on the default circle), both `waypoints-circle` and
`waypoints-symbol` layers stay visible simultaneously. Each
waypoint's feature appears in both layers; visibility per layer is
controlled by data-driven filters or by making `circle-opacity` /
`icon-opacity` zero for the inapplicable shape. Practically: a
feature's effective shape is `wp.shape ?? mapSettings.waypoints.shape`;
if that resolves to a circle-family shape (`circle` / `ring` /
`numbered-circle`), the symbol layer's `icon-opacity` for that feature
is 0; otherwise the circle layer's `circle-opacity` is 0.

### SDF Icons Are Required for `icon-color`

MapLibre's `icon-color` paint property only applies to SDF (signed-distance-field) icons. Non-SDF icons are rasterized at registration time and `icon-color` tints are applied via a simple multiply — `icon-color` cannot be made data-driven per feature on non-SDF icons; the tint is uniform across all features using that image.

All custom shape icons must therefore be registered as SDF via `map.addImage(name, data, { sdf: true })`. For programmatically-drawn icons, this means rendering white ink on a transparent background on an offscreen canvas, then passing the `ImageData` with `{ sdf: true }`. MapLibre interprets white pixels as "ink" and the alpha channel as coverage when building the SDF.

With SDF registration, `icon-color` on the `waypoints-symbol` layer accepts the same data-driven expression used for `circle-color` on `waypoints-circle`:

```
["case",
  ["has", "override_color"],            ["get", "override_color"],
  ["==", ["get", "id"], activeClipId],  activeHighlightColor,
  ["interpolate", ["linear"], ["get", "progress"], 0, startColor, 1, endColor]
]
```

MapLibre evaluates `icon-color` per feature for SDF symbol layers. This is confirmed by the MapLibre GL JS style spec — `icon-color` is listed as a data-driven paint property for symbol layers.

### Icon Registration Points

In the preview, `map.addImage()` calls belong in the `onStyleLoad` callback in `MapView.tsx` after the static sources and layers are added. They must be re-registered after a style swap (`setStyle()` clears the image atlas). The existing `onStyleLoad` callback re-runs on style swaps via `styleReadyRef.current = true` and the `setStyleVersion` increment.

In the export renderer, icon images must be passed as a new `staticImages: Array<[name, ImageData, options]>` field in `InitPayload` (in `src-tauri/sidecars/renderer/page/init.ts`). The renderer worker (`index.ts`) would construct these during `applySetup` and include them in the payload passed to `page.evaluate`. The `__init` function would loop over `staticImages` calling `map.addImage()` after layers are added, analogous to the `staticPaints` / `staticLayouts` loops (lines 401–408 of `init.ts`). The image data itself can be constructed in the Node worker using a small canvas implementation (e.g. `node-canvas`) or simply by shipping the pixel buffer as a typed array in the payload.

### Layer Visibility Management

Both `waypoints-circle` and `waypoints-symbol` are layout-visible at
all times — visibility is gated per-feature via opacity expressions,
not per-layer via `setLayoutProperty('visibility', ...)`. This
supports the mixed-shape case where some waypoints (via
`Waypoint.shape` override) use a different shape family than the
project default.

The per-feature effective shape is computed inline in the opacity
expression. Pseudocode:

```
isCircleFamily = ['in',
  ['coalesce', ['get', 'override_shape'], mapSettings.waypoints.shape],
  ['literal', ['circle', 'ring', 'numbered-circle']]
]

// circle layer: opaque when effective shape is circle-family, else 0
circle-opacity: ['case', isCircleFamily, 1, 0]

// symbol layer: opaque when effective shape is symbol-family, else 0
icon-opacity:   ['case', isCircleFamily, 0, 1]
```

Both `circle-opacity` and `icon-opacity` are data-driven; MapLibre
evaluates them per feature. This replaces the older "single shape
project-wide → toggle layer visibility" model with "per-waypoint
effective shape → toggle per-feature opacity." The shipped behavior
when no waypoint has an override is identical: every feature resolves
to the project shape, and one layer is fully opaque while the other
is fully transparent.

The `waypoints-label` layer (numeric text) currently renders on top of `waypoints-circle`. For the `numbered` shape variant, the icon itself could embed the number (removing the need for `waypoints-label` in that mode) or `waypoints-label` can be kept and the symbol's padding set to avoid overlap. The simpler path is to always keep `waypoints-label` visible on top of whichever waypoint layer is active.

---

## 5. POV Pulse Rendering

The pulse is two MapLibre `circle` layers (`live-marker-pulse` and `live-marker-dot`) on the `live-marker` GeoJSON source — confirmed at `styleSpec.ts` lines 177–204. This is not a DOM overlay. The pulse animation is driven by `pulseAt(projectTimeMs, mapSettings)` in `animations.ts`, which is a pure function of project time. The rAF loop in `MapView.tsx` applies `pulseRadius` and `pulseOpacity` via `setPaintProperty` each frame.

**Export behavior**: because the pulse is a MapLibre layer, it renders into the WebGL framebuffer and is captured by `gl.readPixels`. The export produces the correct pulse frame because the renderer calls `maplibregl.setNow(frame.t)` in `__applyFrame` (line 622 of `init.ts`) to freeze the MapLibre clock at the frame's project time, and `pulseAt` takes `projectTimeMs` directly — the clock freeze has no effect since `pulseAt` doesn't read `maplibregl.now()`.

**New pulse styles** require only changes to `pulseAt` and `MapSettings`. The layer setup is unchanged for `steady` (pulse opacity held at 0 — dot only), `throb` (current behavior), and a fast-sonar variant with a shorter period. A multi-ring sonar style would require a second `live-marker-pulse-2` layer driven by `pulseAt(t + PHASE_OFFSET, mapSettings)` — this is additive to the existing stack, with no structural change to the source or layer management pattern.

**POV color**: today `live-marker-pulse` and `live-marker-dot` use
`colors.accent` and `#ffffff` as hardcoded colors in `styleSpec.ts`.
The POV panel's color control changes these via `setPaintProperty`.
These are currently absent from `resolveStaticPaints` (they are not
in the `paints` array at lines 259–295 of `styleSpec.ts`). Adding
them means `mapSettings.pov.color` flows through the same static-paint
path as the existing size fields — both `live-marker-pulse:circle-color`
and `live-marker-dot:circle-stroke-color` read it. The dot fill stays
white; ring and dot stroke share `pov.color` as a single source of
truth.

Because POV is per-clip overridable in v8 (`MapOverrides.pov` carries
`color?: string` and `size?: Partial<PovSize>`), the
`resolveMapSettings`-derived `mapSettings.pov.color` already reflects
any active clip override. The renderer reads the resolved value with
no knowledge of whether it came from the project default or a clip
override — same pattern as every other static paint.

---

## 6. Export Parity Confirmation

The export pipeline imports `src/lib/mapVisuals` directly (line 82 of `renderer/index.ts`). All rendering decisions — layer specs, source data structures, paint expressions, camera math — originate in that shared module. The renderer worker calls `buildPerFrameState` with the same arguments as the preview's rAF loop. There is no secondary rendering implementation.

Specific confirmation per new feature:

**Route gradient**: `line-gradient` is a MapLibre paint property. Once `lineMetrics: true` is on the source and the expression is emitted by `resolveStaticPaints`, the export renderer applies it via `setPaintProperty` in `__applyFrame` through the `frame.paints` array, exactly as it does for existing size properties.

**Waypoint gradient**: `progress` is baked into the `FeatureCollection` by `buildStaticSourceData` (called in `applySetup` in `index.ts` at line 412). The expression is shipped in `frame.paints` per frame. MapLibre on the headless page evaluates it identically to the preview.

**Shape icons**: once `staticImages` is added to `InitPayload` and `__init` registers them, the symbol layer renders in headless Chrome identically to the preview. Both environments run the same MapLibre JS version. SDF atlas, `icon-color` per-feature expressions, and `icon-image` data-driven properties are standard MapLibre features with no headless-specific behavior.

**POV pulse**: already exports correctly — confirmed by existing export pipeline. Color change is additive.

There is no server-side rendering path. No special export handling is needed for any of the new features.

---

## 7. `MapSettings` Structural Changes

The canonical type architecture is **nested both sides** per
`data-model.md`. `MapSettings` is restructured into `camera` / `route`
/ `waypoints` / `pov` blocks; `MapOverrides` is a hand-curated nested
type mirroring that shape. The renderer reads fully-resolved
`MapSettings` (after `resolveMapSettings`) so changes here are
mechanical path rewrites.

For this document's purposes, the relevant nested paths are:

| Renderer reads | Path on resolved `MapSettings` |
|---|---|
| Route color (solid or gradient) | `mapSettings.route.color` (`DecorationColor`) |
| Waypoints color | `mapSettings.waypoints.color` (`DecorationColor`) |
| Waypoint shape | `mapSettings.waypoints.shape` |
| POV color | `mapSettings.pov.color` (plain hex) |
| Route line widths | `mapSettings.route.size.full_width` / `.trail_width` |
| Waypoint sizes | `mapSettings.waypoints.size.*` |
| POV / pulse sizes | `mapSettings.pov.size.*` |

`DecorationColor` is a discriminated union
`{ mode: 'solid', solid: string } | { mode: 'gradient', stops: GradientStop[] }`.
Renderer code branches on `color.mode` and TypeScript narrows
accordingly.

### Per-waypoint color and shape overrides

Reached via `wp.color` and `wp.shape` directly on the `Waypoint`
entity (see `data-model.md` §2a). Both are optional plain values
(hex string and `WaypointShape` respectively). `buildWaypointsCollection`
reads them and bakes them into feature properties `override_color`
and `override_shape`, which feed the data-driven `circle-color` /
`icon-color` / `icon-image` / opacity expressions described in §3
and §4 above.

Because the overrides live on the entity and not on `MapOverrides`,
they apply uniformly across all waypoints regardless of source
(`clip` / `gpx` / `manual`). The renderer does not consult `clips`
or `clip.map_overrides` at all when computing waypoint colors or
shapes; it only sees `waypoints: Waypoint[]`.

Gradient stops remain project-level only — there is no per-waypoint
gradient (a single point has no second anchor to gradient across).
The type system enforces this by typing `Waypoint.color` as
`string | undefined`, not `DecorationColor | undefined`.

### Defaults

In `DEFAULT_MAP_SETTINGS` (and Rust `Default` impls):

- `route.color:     { mode: 'solid', solid: '#bced09' }` (chartreuse)
- `waypoints.color: { mode: 'solid', solid: '#bced09' }`
- `waypoints.shape: 'circle'`
- `pov.color:       '#bced09'`
- `pov.pulse_style: 'throb'` *(if/when pulse styles ship — see `shapes-pov.md`)*

The chartreuse defaults match today's hardcoded look; the migration
seeds them so existing projects render identically.

---

## 8. Extension Points — Specific Changes Needed

### `resolveStaticPaints` in `styleSpec.ts`

The current return type `ResolvedStaticPaints` has `paints: Array<[string, string, number]>` — typed as number-only values. Color strings are not numbers. Options:

1. Add a `colors: Array<[string, string, string]>` bucket and loop over it separately in consumers.
2. Loosen `paints` to `Array<[string, string, unknown]>` — already the shape used in the renderer's wire format (line 665 of `index.ts`), so this aligns the types without introducing a new bucket.

Option 2 is recommended for minimum delta. The consumer apply loops already call `setPaintProperty(layerId, prop, value)` where `setPaintProperty` is typed as accepting `unknown` values in MapLibre's TypeScript API.

New entries in the `paints` array (when `mapSettings.route.color.mode === 'solid'`):
- `['route-full-line', 'line-color', mapSettings.route.color.solid]`
- `['route-trail-line', 'line-color', mapSettings.route.color.solid]`
- `['live-marker-pulse', 'circle-color', mapSettings.pov.color]`
- `['live-marker-dot', 'circle-stroke-color', mapSettings.pov.color]`

When `mapSettings.route.color.mode === 'gradient'`, `line-gradient` is
set instead of `line-color`, using the expression built from
`mapSettings.route.color.stops`.

### `buildPerFramePaints` in `paints.ts`

Currently emits `waypointCircleRadius`, `waypointCircleColor`, `waypointCircleStrokeColor`, `pulseRadius`, `pulseOpacity`. The function signature `(activeClipId, projectTimeMs, mapSettings)` already has everything needed.

Changes:
- `waypointCircleColor` expression gains the gradient interpolation arm and the `override_color` arm as described in section 3.
- Add `waypointIconColor` to `PaintUpdates` — same expression, applied to `waypoints-symbol` layer's `icon-color` property.
- `pulseOpacity` is already computed; no change needed unless `pov_pulse_style` introduces a different animation curve, in which case `pulseAt` is the only change.

### `PaintUpdates` in `types.ts`

Add `waypointIconColor: DataDrivenPropertyValueSpecification<string> | string`.

### `buildWaypointsCollection` in `sources.ts`

Already takes `waypoints: Waypoint[]` and `IndexedRoute | null`. Add
`progress`, `override_color`, and `override_shape` to feature
properties:

For each `wp`, compute `progress` via
`progressUpTo(wp.position.ms, indexedRoute)` when
`wp.position.kind === 'wall_clock_ms'` and `indexedRoute` is non-null.
Default to `0` for `fixed` waypoints, missing route, or anchors
outside the route's covered range. Also read `wp.color` and `wp.shape`
and include as `override_color` / `override_shape` when non-null. Both
are plain values on the entity — no discriminant check needed.

`progressUpTo` is imported into `sources.ts` from `routeLocation.ts`
(`routeLocation.ts` is already imported by `sources.ts` for
`waypointLocation`).

---

## 9. Performance

At typical project clip counts (10–100 waypoints per CLAUDE.md):

**`progress` per waypoint**: `progressUpTo` is a binary search in `O(log N)` on the indexed route's point array, plus a linear interpolation. For a 6000-point GPX file and 50 clips, this is 50 × ~13 operations — immeasurable. Runs only when `buildWaypointsCollection` runs, which is already gated by data-change `useEffect` dependencies.

**Per-frame expression rebuild**: the `case`/`interpolate` expression for `waypointCircleColor` is a small literal JavaScript object. `setPaintProperty` with an expression triggers style evaluation inside MapLibre but no source reload or tile fetch. MapLibre's internal property evaluation is well-optimized at this scale.

**`lineMetrics: true`**: computed once per route load, O(N) in trackpoint count. For a 6000-point route, this adds microseconds to the tile loading path. No per-frame cost.

**SDF icon registration**: `map.addImage()` for 5–6 shapes at `style.load`. Images are 32–48px square, stored in MapLibre's internal glyph atlas. Negligible.

**Symbol layer vs circle layer**: a `symbol` layer with `icon-image` is marginally more expensive than a `circle` layer because symbols require placement computation. With `icon-allow-overlap: true` and `icon-ignore-placement: true`, placement is trivial (no collision detection). At 50 waypoints this is inconsequential.

Nothing in the new rendering machinery approaches a performance concern at expected clip and waypoint counts.

---

## 10. Build Sequence

**Phase 1 — Source and Data Foundation**
- Restructure `MapSettings` to nested blocks per `data-model.md` §2; update `DEFAULT_MAP_SETTINGS`.
- Update Rust models (`models.rs`); add migration to schema v7 (`commands/project.rs`).
- Update all `lib/mapVisuals/*.ts` reads to nested paths.
- Add `lineMetrics: true` to all four `addSource` call sites (two in `MapView.tsx`, two in `renderer/index.ts`).
- Add `progress` and `override_color` feature properties to `buildWaypointsCollection` in `sources.ts`.
- Loosen `ResolvedStaticPaints.paints` to `Array<[string, string, unknown]>` in `styleSpec.ts` and update consumers.

**Phase 2 — Route Gradient**
- In `resolveStaticPaints`, emit `line-color` (solid) or `line-gradient` (gradient) for `route-full-line` based on `mapSettings.route.color.mode`.
- Same for `route-trail-line`, using a per-frame solid color for the slime trail matching the current-progress gradient position.
- Confirm no visual regression with existing solid mode.

**Phase 3 — Waypoint Gradient and Per-Clip Override**
- In `buildPerFramePaints`, update `waypointCircleColor` to the three-arm `case` expression.
- Add `waypointIconColor` to `PaintUpdates` in `types.ts`.
- Add `waypointIconColor` emission to `buildPerFramePaints`.
- Update `MapView.tsx` rAF loop and renderer `paints` array to apply `waypointIconColor` to the `waypoints-symbol` layer (which does not yet exist — will be a no-op until Phase 4 adds it, guarded by `if (map.getLayer(...))` which already wraps the apply loop).

**Phase 4 — Waypoint Shapes**
- Add `WAYPOINTS_SYMBOL_LAYER` spec to `styleSpec.ts`.
- Add `waypoints-symbol` to `onStyleLoad` in `MapView.tsx` and `staticLayers` in `renderer/index.ts`.
- Add SDF icon generation and `map.addImage()` calls to `onStyleLoad` in `MapView.tsx`.
- Add `staticImages` field to `InitPayload` in `page/init.ts` and wire `map.addImage()` loop in `__init`.
- Wire `mapSettings.waypoints.shape` to `setLayoutProperty('visibility', ...)` for `waypoints-circle` vs `waypoints-symbol`.

**Phase 5 — POV Colors and Pulse Styles**
- Add `mapSettings.pov.color` to `resolveStaticPaints` for `live-marker-pulse` and `live-marker-dot`.
- Extend `pulseAt` for `pov.pulse_style` variants (if/when pulse styles ship — see `shapes-pov.md`).
- Update consumers of `pulseAt` to pass the new mode flag from `mapSettings`.

**Phase 6 — Toolbar Panels**
- Build Route, Waypoints, POV panels in `MapToolbar.tsx`.
- The rendering pipeline is fully wired by Phase 5; the panels only need to read and write the new `MapSettings` blocks.

---

## File Reference Summary

| File | What changes |
|---|---|
| `src/types.ts` | New `MapSettings` fields; `DEFAULT_MAP_SETTINGS` additions |
| `src/lib/mapVisuals/styleSpec.ts` | `lineMetrics: true` removed from inline spec (added at call site); `resolveStaticPaints` extended for color values; new `WAYPOINTS_SYMBOL_LAYER` export |
| `src/lib/mapVisuals/sources.ts` | `buildWaypointsCollection` adds `progress` and `override_color` properties |
| `src/lib/mapVisuals/paints.ts` | `buildPerFramePaints` rebuilds color expressions with gradient arms; adds `waypointIconColor` |
| `src/lib/mapVisuals/types.ts` | `PaintUpdates` extended with `waypointIconColor`; `ResolvedStaticPaints.paints` loosened to `unknown` values |
| `src/lib/mapVisuals/animations.ts` | `pulseAt` extended for `pov_pulse_style` |
| `src/components/MapView.tsx` | `addSource` calls gain `lineMetrics: true`; `onStyleLoad` adds symbol layer and registers SDF icons; visibility toggle extended to `waypoints-symbol` |
| `src-tauri/sidecars/renderer/index.ts` | `staticSources` gain `lineMetrics: true`; `staticImages` added to init payload construction |
| `src-tauri/sidecars/renderer/page/init.ts` | `InitPayload` gains `staticImages` field; `__init` loops over it calling `map.addImage()` |
| `src/components/MapToolbar/MapToolbar.tsx` | New Route/Waypoints/POV dropdown panels |

---

*Rendering pipeline architecture only. Panel UX, gradient editor interior, shape gallery interaction, and per-clip override surfacing are open questions in `DESIGN.md`.*
