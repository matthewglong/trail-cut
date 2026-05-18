# Map Decorations — Implementation Plan

Single sequenced plan for the map-decorations redesign. Synthesizes
`DESIGN.md`, `data-model.md`, `rendering.md`, `color-gradient.md`,
`shapes-pov.md`, and `panel-ux.md` into one ordered build sequence.
Reads top-down; each step is independently testable and leaves the app
in a working state.

## Headline choices

1. **Schema bump**: v7 → v8. v7 was the first-class-waypoints
   shipment (`Project.waypoints: Waypoint[]`) and is the starting
   point. v8 adds the nested-MapSettings restructure, per-Waypoint
   color/shape, and the restored per-clip POV overrides.

2. **Per-Waypoint vs per-clip override split.** Color and shape live
   on the `Waypoint` entity (`Waypoint.color`, `Waypoint.shape`) and
   apply uniformly to clip-sourced, GPX, and manual waypoints.
   Visibility (`mode`), sizes, camera, `map_style`, and the **full**
   POV block live on `clip.map_overrides`. Route color is project-only
   (one continuous geometry).

3. **`MapOverrides` is hand-curated, nested, no narrowed subtypes
   needed.** No `SolidColorOnly` Rust enum — `MapOverrides.waypoints`
   has no `color` field, so there is nothing to narrow.

4. **Picker library**: `react-colorful` (~2.8 KB gzipped, zero deps,
   pure DOM/CSS — no canvas issues in WKWebView, headless via BEM
   classes, good built-in a11y). Pin `react-colorful@^5.7.0`.

5. **Gradient editor**: build it ourselves on top of `react-colorful`'s
   `HexColorPicker`. No off-the-shelf gradient lib survives the
   "trail-distance mapping + snap-to-waypoint + dark monospace
   aesthetic" filter.

6. **Gradient parameter**: `[0,1]` fraction along the route, mapped to
   MapLibre's native `line-progress`. The existing
   `progressUpTo(wallMs, indexedRoute)` in `routeLocation.ts:268`
   already produces this Mercator-aligned fraction.

7. **Cross-platform**: pure webview path. No NSColorPanel bridge.

8. **Default colors**: chartreuse everywhere (matches today's
   `colors.accent` hardcoded look — users see no visual change after
   migration). The "three distinct decoration defaults" idea raised
   in `color-gradient.md` §2 is set aside for now; can be reintroduced
   as a follow-up that doesn't affect the data model.

## Data model deltas (canonical in `data-model.md`)

### `MapSettings` restructure

Flat → nested by decoration:

```
mapSettings.camera.*       (was: flat zoom, bearing_*, follow_playhead, map_style)
mapSettings.route.mode     (was: route_mode)
mapSettings.route.color    (NEW — DecorationColor: solid OR gradient)
mapSettings.route.size.*   (was: overlay_route_*_width)
mapSettings.waypoints.mode (was: waypoints_mode)
mapSettings.waypoints.color (NEW — DecorationColor)
mapSettings.waypoints.shape (NEW — WaypointShape)
mapSettings.waypoints.size.* (was: overlay_waypoint_*)
mapSettings.waypoints.label_mode (was: label_mode)
mapSettings.waypoints.active_mode (was: active_waypoint_mode)
mapSettings.pov.color      (NEW — plain hex)
mapSettings.pov.size.*     (was: overlay_live_marker_*, overlay_pulse_*)
```

### `Waypoint` additions (per-entity)

Two optional fields on the `Waypoint` type:

```ts
Waypoint.color?: string         // solid hex; wins over project default
Waypoint.shape?: WaypointShape  // wins over project default
```

### `MapOverrides` (hand-curated, nested)

```ts
interface MapOverrides {
  camera?: Partial<CameraSettings>;
  map_style?: MapStyleId;
  route?: { mode?: TriMode; size?: Partial<RouteSize> };
  waypoints?: {
    mode?: TriMode;
    size?: Partial<WaypointsSize>;
    label_mode?: WaypointLabelMode;
    active_mode?: ActiveWaypointMode;
    // color and shape intentionally absent — per-Waypoint, not per-clip
  };
  pov?: Partial<PovSettings>;  // full POV override packet
}
```

### Default colors

```ts
route.color:     { mode: 'solid', solid: colors.accent }  // #bced09
waypoints.color: { mode: 'solid', solid: colors.accent }
pov.color:       colors.accent
waypoints.shape: 'circle'
```

### Migration v7 → v8

`migrate_v7_to_v8_value` in `commands/project.rs` does
`serde_json::Value` surgery. Most projects have `map_settings: null`
and migrate as no-ops. The worst-case migration lifts the ~17 flat
fields into 4 nested blocks (per `data-model.md` §8 table). Every
v7 flat override key has a v8 home — POV overrides are NOT dropped
(they survive into `pov.size.*`).

`Project.waypoints` is already populated in v7 and migrates as a
no-op — the new optional fields (`Waypoint.color`, `Waypoint.shape`)
default to `None` via serde and render identically to v7.

## Rendering plumbing (canonical in `rendering.md`)

### Route line — solid + gradient

Two source-level changes at `addSource` sites for `route-full` and
`route-trail` (preview + export — four total call sites):

```ts
map.addSource('route-full',  { type: 'geojson', data: emptyLine, lineMetrics: true });
map.addSource('route-trail', { type: 'geojson', data: emptyLine, lineMetrics: true });
```

`lineMetrics: true` is required for `line-gradient` and must be set at
`addSource` time. `setStyle()` drops sources, so the `onStyleLoad`
re-add path covers both.

`resolveStaticPaints` returns a third bucket for gradients:

```ts
interface ResolvedStaticPaints {
  paints:    Array<[layerId, prop, unknown]>;   // loosened from number
  layouts:   Array<[layerId, prop, unknown]>;
  gradients: Array<[layerId, ExpressionSpecification | null]>;
}
```

In solid mode: emit `[layer, 'line-color', color]` and clear
`line-gradient` to null. In gradient mode: build
`['interpolate', ['linear'], ['line-progress'], 0, ...]` from
`mapSettings.route.color.stops` and push to gradients; do not set
`line-color`. The two paint properties are mutually exclusive.

### Waypoint color — per-feature progress + override

`buildWaypointsCollection` in `sources.ts` reads each `Waypoint`
directly (no `clips` parameter) and bakes per-feature properties:

```ts
properties: {
  id: wp.id,
  index,
  clipId: wp.clip_id ?? null,
  label: wp.label,
  progress: wp.position.kind === 'wall_clock_ms' && indexedRoute
    ? progressUpTo(wp.position.ms, indexedRoute)
    : 0,
  override_color: wp.color ?? null,
  override_shape: wp.shape ?? null,
}
```

`buildPerFramePaints` builds the `circle-color` paint as a three-arm
case expression:

```
['case',
  ['!=', ['get', 'override_color'], null],  ['get', 'override_color'],
  ['==', ['get', 'id'], activeWaypointId],  ACTIVE_WAYPOINT_COLOR,
  <gradient interpolate OR solid base>
]
```

Override wins → active-highlight → gradient/solid base. Override-wins
matches the design framing ("force this one to be gold should not be
silently lost"); the active-radius bump still signals "you are here."

`activeWaypointId` matches against the Waypoint's `id`, not against
`clipId` — first-class waypoints have their own identity. The active
waypoint is determined by `mapSettings.waypoints.active_mode` (v1
ships `'latest_passed'`).

### Waypoint shape — per-feature

`waypoints-circle` and `waypoints-symbol` both stay layout-visible.
Per-feature opacity expressions route each waypoint to the correct
layer based on its effective shape (`wp.shape ?? mapSettings.waypoints.shape`):

```
isCircleFamily = ['in',
  ['coalesce', ['get', 'override_shape'], mapSettings.waypoints.shape],
  ['literal', ['circle', 'ring', 'numbered-circle']]
]
circle-opacity: ['case', isCircleFamily, 1, 0]
icon-opacity:   ['case', isCircleFamily, 0, 1]
```

`waypoints-symbol` uses `icon-image: ['concat', 'waypoint-',
['coalesce', ['get', 'override_shape'], mapSettings.waypoints.shape]]`
or equivalent. SDF icons (pin / square / diamond) are registered at
style.load via `map.addImage(..., { sdf: true })`; the same set is
shipped to the export renderer in `staticImages` on the InitPayload.

### POV — solid wiring with per-clip override

Two new entries in `resolveStaticPaints` paints bucket using
`mapSettings.pov.color` as the single color source (the dot fill stays
white; ring and dot stroke share `pov.color`):

```
['live-marker-dot',   'circle-stroke-color', mapSettings.pov.color],
['live-marker-pulse', 'circle-color',        mapSettings.pov.color],
```

Because `mapSettings.pov.color` is resolved through
`resolveMapSettings(defaults, clip.map_overrides)`, any per-clip
override is already reflected — the renderer reads the resolved value
with no awareness of override vs default.

## Picker UX (canonical in `panel-ux.md` and `color-gradient.md`)

### Per-decoration panel layout

Each `▾` toolbar button opens a panel below the bar, portal-anchored
to the trigger's `getBoundingClientRect()` and recomputed on the same
ResizeObserver the overflow-wrap already uses. **Panel widths**: Route
360px, Waypoints 400px (the Copy button needs breathing room), POV
360px. Section labels use the existing `groupLabel` typographic tone.

Section order in each panel:
- **Route**:    Visibility / Color / Size
- **Waypoints**: Visibility / Color / Shape / Size
- **POV**:      Color / Pulse / Size

### Color section — progressive disclosure

**Layer 1 — swatches.** Seven 22×22 tiles: coral, pollen, chartreuse,
azure, granite, white, "CU" (custom). Inline 6-char hex input on the
right.

**Layer 2 — custom picker.** Tapping the CU tile expands a HEX/HSL/RGB
tab strip and a `react-colorful` picker.

**Layer 3 — gradient editor.** Only on Route and Waypoints, only in
project scope. Entered via a `[Solid] [Gradient]` segmented toggle
above the swatch row. Disabled with tooltip when no GPX loaded.

### Gradient editor

Per `color-gradient.md` §7: gradient bar (18px) with waypoint snap
ticks, stop rail (26px) with 14×14 handles, click-to-add stops on
the bar, drag-to-snap to waypoint Mercator fractions within 6px,
floating tooltip showing distance during drag, min separation 0.005,
max 8 stops, endpoints (fraction 0 and 1) color-editable but
position-locked. Trail preview SVG below (S-curve with dots at
waypoint fractions).

### Copy gradient

In the gradient editor's action row, only when the source decoration
has gradient mode on with ≥2 stops:

- **Route panel**: `[Copy → Waypoints]`
- **Waypoints panel**: `[← Copy from Route]`

Deep-copies the stop array; flips target's mode to gradient if needed.
Border + label flash chartreuse, "Copied ✓" for 500ms.

### Clip-scope behavior

| Panel | Clip-scope behavior |
|---|---|
| Route | Visibility + Size editable per clip. Color section read-only with "Switch to Project scope →" button. |
| Waypoints | Visibility + Size editable per clip (via `MapOverrides.waypoints`). Color and Shape edit the **associated Waypoint** (looked up by `clip_id`). Gradient toggle absent (per-Waypoint is solid-only). |
| POV | Fully editable per clip (color + size + pulse via `MapOverrides.pov`). |

If the current clip has no associated waypoint (sticky-delete or no
`created_at`), the Waypoints Color and Shape sections collapse to a
note pointing at the WaypointsPanel modal.

### Override-highlight rollup

Decoration toolbar buttons light up their accent if any of their
group's fields are overridden:

- **Route / POV**: `[...overriddenKeys].some(p => p.startsWith('route.'))` etc.
- **Waypoints**: same path-prefix check PLUS a per-Waypoint check on
  `Waypoint.color` / `Waypoint.shape` (associated waypoint in clip
  scope; any waypoint in project scope) — see `data-model.md` §5a.

## File touch surface

| File | What changes |
|---|---|
| `src/types.ts` | Restructured `MapSettings` (nested camera/route/waypoints/pov), new hand-curated `MapOverrides` (with `pov`, without `waypoints.color`/`shape`), `DecorationColor`/`SolidColor`/`GradientStop`, updated `DEFAULT_MAP_SETTINGS`, ~14-line `resolveMapSettings`. Extend `Waypoint` with `color?: string` and `shape?: WaypointShape`. |
| `src-tauri/src/models.rs` | Restructured `MapSettings` with `CameraSettings`/`RouteSettings`/`WaypointsSettings`/`PovSettings` sub-structs; `DecorationColor` as `#[serde(tag="mode")]` enum; nested `MapOverrides` with `PovOverrides`. No `SolidColorOnly`. Per-field `#[serde(default)]`. Extend `Waypoint` with optional `color` and `shape`. |
| `src-tauri/src/commands/project.rs` | `migrate_v7_to_v8_value`; `CURRENT_SCHEMA_VERSION` bump to 8; migration tests per `data-model.md` §8; thread the v7→v8 arm onto every existing version-match chain. |
| `src/lib/mapVisuals/styleSpec.ts` | Widen `ResolvedStaticPaints.paints` to `unknown`; new `gradients` bucket; extend `resolveStaticPaints` for route color/gradient + POV color; nested-path reads. |
| `src/lib/mapVisuals/paints.ts` | Replace `DEFAULT_WAYPOINT_COLOR` literal with dynamic expression builder; three-arm case for `circle-color` (and `icon-color` for the symbol layer); per-feature opacity expressions for layer routing. |
| `src/lib/mapVisuals/sources.ts` | `buildWaypointsCollection` adds `progress`, `override_color`, `override_shape` from `Waypoint` fields. |
| `src/lib/mapVisuals/perFrame.ts` | Nested-path reads. |
| `src/lib/mapVisuals/animations.ts` | `pulseAt` reads `mapSettings.pov.size.pulse_start_radius` / `pulse_end_radius`. |
| `src/components/MapView.tsx` | `lineMetrics: true` on both route sources; apply `resolved.gradients`; register SDF icons in `onStyleLoad`. |
| `src/screens/ProjectView.tsx` | Replace flat `Object.keys` diff with `computeClipOverrides` from `data-model.md` §4; `overriddenKeys` becomes `Set<OverridePath>` from `leafPaths(map_overrides)`. |
| `src/components/MapToolbar/MapToolbar.tsx` | Replace single Waypoints `ModePicker` with three new `▾` panel triggers (Route/Waypoints/POV); `overrideColor` accepts `OverridePath` strings; decoration-button rollup via `startsWith`; Waypoints button additionally checks per-Waypoint overrides. |
| `src/components/MapToolbar/DecorationPanel/` *(new)* | Panel shell with portal anchoring + section layout. |
| `src/components/MapToolbar/ColorSection/` *(new)* | Swatch row + custom picker + (conditional) gradient editor. Routes "color set" calls to either `onChange(mapSettings)` (project), to `onClipOverride(clip.map_overrides)` (POV in clip scope), or to `onWaypointChange(wp.id, { color })` (Waypoints in clip scope). |
| `src/components/MapToolbar/GradientEditor/` *(new)* | Gradient bar + stop rail + drag/snap + trail preview SVG. |
| `src/components/MapToolbar/ShapeSection/` *(new)* | Shape gallery (project scope edits `mapSettings.waypoints.shape`; clip scope edits associated Waypoint's `shape`). |
| `src-tauri/sidecars/renderer/index.ts` | `lineMetrics: true` on `route-full`/`route-trail` static sources; `staticImages` payload field for SDF icons. |
| `src-tauri/sidecars/renderer/page/init.ts` | `InitPayload` gains `staticImages: Array<[name, ImageData, options]>`; `__init` loops over them calling `map.addImage()` after layers are added. |
| `package.json` | `react-colorful@^5.7.0`. |

## Build sequence

Eight steps, each independently testable. Ship the data model and
solid-color rendering first so we have a working slice before any
picker UI exists.

**Step 1 — Types + defaults + Rust v7→v8 migration.** Restructure
`MapSettings` into nested blocks per `data-model.md` §2. Add new
types (`DecorationColor`, `SolidColor`, `GradientStop`, `WaypointShape`).
Add `Waypoint.color` and `Waypoint.shape` optional fields. Update
`DEFAULT_MAP_SETTINGS`. Write `migrate_v7_to_v8_value` + the four
migration tests from `data-model.md` §8. Verify v7 `project.json`
files (both `map_settings: null` and full flat) load and resolve
correctly, including POV size overrides surviving the migration.
Rewrite nested-path reads in `lib/mapVisuals/*.ts`. **Acceptance:**
existing projects load with no visual change.

**Step 2 — Solid-color plumbing, no UI.** Wire
`mapSettings.route.color`, `mapSettings.waypoints.color`, and
`mapSettings.pov.color` through `resolveStaticPaints` to
`setPaintProperty`. Wire `Waypoint.color` through
`buildWaypointsCollection` as the `override_color` feature property
and into the three-arm `circle-color` case expression. Hardcode
non-default values in `DEFAULT_MAP_SETTINGS` and a couple of
`Waypoint.color` values in test fixtures to visually verify the
pipeline. Revert to chartreuse defaults at end. **Acceptance:**
setting a `Waypoint.color` in JSON paints that one dot in the chosen
color; setting `mapSettings.route.color.solid` repaints the line.

**Step 3 — Route gradient rendering.** Add `lineMetrics: true` to
all four `addSource` sites. Build the `line-gradient` interpolate
expression in `resolveStaticPaints` from `mapSettings.route.color.stops`.
Temporarily set `route.color: { mode: 'gradient', stops: [...] }` in
defaults to verify both full and trail layers paint correctly. Verify
mode-swap clears `line-gradient: null` cleanly. **Acceptance:**
switching `route.color.mode` between `solid` and `gradient` flips the
rendered line correctly without artifacts.

**Step 4 — Waypoint gradient sampling.** Add `progress` to feature
properties; build the three-arm `case` expression in
`buildPerFramePaints` reading `wp.color` from the entity (not from
clips). Replace the flat `Object.keys` diff in `handleMapToolbarChange`
with `computeClipOverrides` from `data-model.md` §4. Replace
`overriddenKeys` derivation with `leafPaths` from §5. **Acceptance:**
gradient mode on waypoints paints each dot at its trail-distance
fraction; a `Waypoint.color` override visually overrides the
gradient for that single dot.

**Step 5 — POV color end-to-end with per-clip override.** Wire
`mapSettings.pov.color` through `resolveStaticPaints` for
`live-marker-pulse` and `live-marker-dot`. Remove hardcoded
`colors.accent` from `styleSpec.ts` layer specs (or leave as
fallback). Wire `MapOverrides.pov` through `resolveMapSettings`.
Test: setting `clip.map_overrides.pov.color` repaints the POV dot
during that clip and reverts at the next clip. **Acceptance:** POV
color survives per-clip overrides; cross-style swap retains correct
color.

**Step 6 — UI: swatch-row picker, all three panels.** Replace
toolbar's Waypoints `ModePicker` with three new `▾` panel triggers
(Route, Waypoints, POV). Build the panel shell + swatch row + custom
picker. No gradient editor yet — solid mode only end-to-end. POV is
fully working at this step (color + size editable per clip).
Waypoints color in clip scope edits the associated Waypoint. Route
color in clip scope is read-only with switch-to-project. **Acceptance:**
all three panels open and edit; per-clip POV overrides round-trip
through `MapOverrides.pov`; per-Waypoint color overrides round-trip
through `Waypoint.color`.

**Step 7 — UI: gradient editor + Copy button.** Build the gradient
bar, stop rail, drag/snap, trail preview SVG. Wire Copy buttons.
Validate `GradientStop` invariants in the picker and defensively in
`resolveMapSettings`. Cross-style test (default ↔ satellite ↔ 3D) to
confirm sources re-add with `lineMetrics: true`. **Acceptance:**
gradient editing is end-to-end; switching map style preserves
gradient rendering.

**Step 8 — Shape gallery + SDF icons.** Add `WAYPOINTS_SYMBOL_LAYER`
spec to `styleSpec.ts`. Generate SDF icons (circle / pin / ring /
square / diamond / numbered-circle) via offscreen canvas. Register
via `map.addImage(..., { sdf: true })` in `MapView.tsx` `onStyleLoad`.
Add `staticImages` field to `InitPayload`; thread through
`renderer/index.ts` `applySetup`. Wire per-feature opacity expressions
to route waypoints to the right layer. Build the Shape gallery UI
(2×3 grid) in the Waypoints panel — project scope edits
`mapSettings.waypoints.shape`; clip scope edits the associated
Waypoint's `shape`. **Acceptance:** mixed-shape scenes render
correctly (e.g. one diamond among four circles); shape edits survive
per-clip context.

## Open questions before Step 5

1. **Active-waypoint highlight color.** Today `#4a9eff` (fixed blue)
   hardcoded in `paints.ts:19`. Options: (a) keep the blue, (b)
   derive from `mapSettings.pov.color` (so the active waypoint
   inherits POV's per-clip override automatically), (c) drop the
   color highlight entirely and rely on the larger active radius.
   **Recommend: (b)** per `color-gradient.md` §13 — the active
   waypoint is the "now" point, same semantic as POV, and (b)
   automatically respects clip POV overrides.

2. **Active-waypoint highlight implementation.** The three-arm case
   expression on `circle-color` works for circles/rings but doesn't
   generalize to symbol shapes (you'd need a parallel `icon-color`
   expression and a coordinated radius/size bump). `shapes-pov.md`
   §"Active treatment" proposes a separate `waypoints-active-halo`
   circle layer with data-driven `circle-radius` (0 for non-active,
   `active_radius × 1080` for active) and a fixed white stroke,
   uniformly across all shapes. **Recommend: halo layer** for
   robustness across shape variants; ship it in Step 4 or Step 8.

3. **Pulse styles in scope?** `shapes-pov.md` Part 2 proposes 4
   styles (steady / throb / sonar / heartbeat) + a `pulse_rate` enum.
   `data-model.md` §2 currently does not include `pulse_style` or
   `pulse_rate` on `PovSettings` (canonical behavior is today's
   sonar-equivalent). **Options**: (a) defer pulse styles entirely
   from this PR — POV panel's Pulse section shows steady/throb/sonar
   as a future-feature placeholder; (b) ship sonar-only with the
   Pulse section absent; (c) commit to the 4-style roster and add
   `pov.pulse_style` / `pov.pulse_rate` to `MapSettings` +
   `MapOverrides` in Step 1. **Recommend: (a)** for the first ship;
   the POV per-clip override capability is the real new behavior
   here, and adding pulse styles is independently valuable later.

4. **Endpoint stops draggable position or pinned?** UX agent's mockup
   shows endpoints draggable in color but locked at fractions 0 and
   1. This keeps the gradient covering the whole route by definition.
   **Recommend: pinned endpoints** per `color-gradient.md` §7b.

If any of these warrant pushback, raise them before Step 5.

## Out of scope

- **Style-variant defaults** (per-map-style decoration tweaks at
  project level — "satellite uses thicker lines"). Parked as a future
  enhancement. Doesn't affect any decision in this plan.
- **Per-clip route color**. Rejected by design — route is one
  continuous geometry; per-clip color would force invented boundaries.
- **Per-clip route shape / gradient** — same.
- **Per-Waypoint size / label-mode / active-mode overrides**. Could
  follow Convention B (`data-model.md` §10) later if needed; not in
  v8.
- **Color grading, audio settings, compass / scale bar decorations**.
  Phase 4 territory; this redesign does not preclude them.
