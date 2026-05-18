# Map Decorations — Data Model

**Status:** canonical. This document resolves Open Question #7 from
`DESIGN.md`. Other docs in this folder (`IMPLEMENTATION-PLAN.md`,
`rendering.md`, `color-gradient.md`, `shapes-pov.md`, `panel-ux.md`)
defer to the types defined here.

**Decision:** `MapSettings` and `MapOverrides` are both **nested** by
decoration block, with the same structural shape on both sides.
`MapOverrides` is a hand-curated type listing only the leaves clips
are allowed to override. Resolve is a short, explicit block-level
merge — not a generic recursive deep merge.

**Schema bump.** This redesign targets **schema v8**. Schema v7 already
shipped (first-class waypoints — `Project.waypoints: Waypoint[]`
decoupled from clips, with the sticky-delete contract in
`src/lib/waypoints.ts`). v8 layers the nested-MapSettings restructure,
per-Waypoint color/shape, and per-clip POV overrides on top.

**Per-waypoint vs per-clip overrides.** The redesign splits override
storage by intent:

- **Per-waypoint** (lives on `Waypoint`): `color` (solid hex), `shape`.
  Works uniformly for clip-sourced, GPX, and manual waypoints.
- **Per-clip** (lives on `clip.map_overrides`): visibility (`mode`)
  and `size` blocks for route and waypoints; full POV block; camera
  and `map_style`. Things that genuinely vary per-clip-context.
- **Project-only** (lives on `mapSettings`, no override): route color,
  waypoints color/shape **defaults** (per-waypoint values win when
  set).

---

## 1. Why nested both sides

The existing flat model (`MapOverrides = Partial<MapSettings>`) holds
together only because every field is a primitive scalar. The redesign
breaks two of its preconditions at once:

1. Gradient stops are arrays — strict-equality diff (`a !== b`) lies on
   every render.
2. The design forbids per-clip overrides on some fields (route color,
   waypoints color, waypoints shape). `Partial<MapSettings>` cheerfully
   allows them — the type system stops encoding the design rules.

A hand-curated `MapOverrides` fixes both. Once `MapOverrides` is a
separate type, the structural question becomes: keep `MapSettings` flat
or nest both sides? Nesting both sides wins on three counts:

- **Structural consistency.** The override mirrors the settings shape
  exactly — the override is "just the leaves that diverge."
- **Discriminated unions read cleanly.** Renderer code reads
  `mapSettings.waypoints.color.mode === 'gradient'` with proper
  narrowing, not three parallel `*_mode` / `*_solid` / `*_stops` fields.
- **Future scaling.** New decoration types (compass, scale bar, photo
  waypoints, color grading) cost one block each, not N prefixed flat
  fields growing into one namespace.

The remaining engineering cost — a one-time `serde_json::Value`
migration and a mechanical consumer rewrite inside
`src/lib/mapVisuals/` — is bounded and follows established patterns in
the codebase.

---

## 2. TypeScript types

```ts
// ---------- shared decoration value types ----------

export type SolidColor    = { mode: 'solid';    solid: string };
export type GradientColor = { mode: 'gradient'; stops: GradientStop[] };
export type DecorationColor = SolidColor | GradientColor;

export interface GradientStop {
  /** Web Mercator line-progress fraction in [0, 1]. See
   *  `color-gradient.md` §1 for why Mercator, not geodesic. */
  fraction: number;
  /** CSS color string (hex or rgb()). */
  color: string;
}

export type WaypointShape =
  | 'circle' | 'ring' | 'pin' | 'square' | 'diamond' | 'numbered-circle';

// ---------- per-block setting types ----------

export interface CameraSettings {
  follow_playhead: boolean;
  map_style:       MapStyleId;
  zoom:            number;
  bearing_mode:    BearingMode;
  bearing_degrees: number;
  bearing_stops:   number;
}

export interface RouteSize {
  full_width:  number; // fraction of PAINT_REFERENCE_WIDTH (1080 CSS px)
  trail_width: number;
}

export interface WaypointsSize {
  circle_radius: number;
  active_radius: number;
  stroke_width:  number;
  label_size:    number;
}

export interface PovSize {
  pulse_radius:       number;
  dot_radius:         number;
  dot_stroke_width:   number;
  pulse_start_radius: number;
  pulse_end_radius:   number;
}

export interface RouteSettings {
  mode:  TriMode;
  color: DecorationColor;
  size:  RouteSize;
}

export interface WaypointsSettings {
  mode:  TriMode;
  color: DecorationColor;
  shape: WaypointShape;
  size:  WaypointsSize;
  /** Render mode for waypoint labels. See `WaypointLabelMode` in types.ts. */
  label_mode: WaypointLabelMode;
  /** Active-waypoint highlight strategy. See `ActiveWaypointMode`. */
  active_mode: ActiveWaypointMode;
}

export interface PovSettings {
  /** Solid only — POV does not participate in the palette. */
  color: string;
  size:  PovSize;
}

// ---------- top-level types ----------

export interface MapSettings {
  camera:    CameraSettings;
  route:     RouteSettings;
  waypoints: WaypointsSettings;
  pov:       PovSettings;
}

// MapOverrides is NOT DeepPartial<MapSettings>. It is hand-curated to
// list exactly the leaves clips are permitted to override.
export interface MapOverrides {
  camera?: Partial<CameraSettings>;
  map_style?: MapStyleId;

  // Route is project-only for color. Visibility and size are per-clip
  // overridable.
  route?: {
    mode?: TriMode;
    size?: Partial<RouteSize>;
  };

  // Waypoints: visibility and size only. Color and shape live on the
  // `Waypoint` entity (see §2a) — per-waypoint, not per-clip.
  waypoints?: {
    mode?:        TriMode;
    size?:        Partial<WaypointsSize>;
    label_mode?:  WaypointLabelMode;
    active_mode?: ActiveWaypointMode;
  };

  // POV is fully overridable per clip — color, all sizes, pulse style.
  // A clip on satellite tiles can carry a chunkier white POV dot; the
  // next clip on default tiles inherits the project default.
  pov?: Partial<PovSettings>;
}
```

### 2a. Per-entity Waypoint additions

First-class waypoints (schema v7) already exist as
`Project.waypoints: Waypoint[]`. v8 extends the `Waypoint` type with
two optional override fields:

```ts
export interface Waypoint {
  id:       string;
  position: WaypointPosition;
  label:    string;
  source:   'clip' | 'gpx' | 'manual';
  clip_id?: string;

  // NEW in v8 — per-waypoint overrides that win over the project default.
  /** Solid hex (e.g. "#bced09"). When set, this waypoint renders in
   *  this color regardless of the project's waypoints.color mode
   *  (solid OR gradient). Use case: "force this one waypoint to be
   *  gold." Gradient overrides are not supported per-waypoint — a
   *  single point has no second anchor to gradient across. */
  color?: string;

  /** When set, this waypoint renders in this shape regardless of the
   *  project's waypoints.shape default. Use case: "this summit
   *  waypoint should be a diamond." */
  shape?: WaypointShape;
}
```

The clip-scope UI for "edit this clip's waypoint color/shape" looks up
the waypoint via `waypoints.find(w => w.clip_id === currentClip.id)`
and edits its `color` / `shape` field directly. Clip-sourced,
GPX-sourced, and manual waypoints are all editable the same way; the
WaypointsPanel modal (already shipped at
`src/components/WaypointsPanel/`) provides the non-clip path for
manual/GPX waypoints whose `clip_id` is absent.

---

## 3. `resolveMapSettings`

```ts
export function resolveMapSettings(
  defaults: MapSettings,
  overrides: MapOverrides | null | undefined,
): MapSettings {
  if (!overrides) return defaults;
  return {
    camera: { ...defaults.camera, ...overrides.camera },
    route: {
      ...defaults.route,
      ...overrides.route,
      size: { ...defaults.route.size, ...overrides.route?.size },
    },
    waypoints: {
      ...defaults.waypoints,
      ...overrides.waypoints,
      size: { ...defaults.waypoints.size, ...overrides.waypoints?.size },
    },
    pov: {
      ...defaults.pov,
      ...overrides.pov,
      size: { ...defaults.pov.size, ...overrides.pov?.size },
    },
  };
}
```

Fourteen lines. One shallow spread per block, plus one extra for each
nested `size` sub-block. No recursion. POV mirrors the route /
waypoints pattern because POV is per-clip overridable for every field.

Per-Waypoint overrides do NOT flow through `resolveMapSettings` — they
are read at render time directly from each `Waypoint` and applied as
feature properties on the waypoint FeatureCollection (see
`rendering.md` §3).

Adding a new override (say, `waypoints.label_size` as a clip-level
override) costs one line on `MapOverrides` and zero changes to
`resolveMapSettings` — `...overrides.waypoints` already spreads it. The
explicit nested `size` spread already handles size leaves.

---

## 4. `computeClipOverrides` — diff settings → override

When the user edits in clip scope, the toolbar produces a fully
populated `MapSettings`; we diff against the project defaults to
produce a sparse `MapOverrides`. The current generic `Object.keys`
diff in `ProjectView.tsx` is replaced with an explicit block-level
comparison:

```ts
function computeClipOverrides(
  next: MapSettings,
  project: MapSettings,
): MapOverrides {
  const out: MapOverrides = {};

  // --- camera ---
  const camera: Partial<CameraSettings> = {};
  for (const key of CAMERA_KEYS) {
    if (next.camera[key] !== project.camera[key]) {
      (camera as any)[key] = next.camera[key];
    }
  }
  if (Object.keys(camera).length) out.camera = camera;

  // --- map_style ---
  if (next.camera.map_style !== project.camera.map_style) {
    // (map_style lives on CameraSettings in v8; if it moves, this line
    // moves with it. See §2.)
  }

  // --- route ---
  const route: NonNullable<MapOverrides['route']> = {};
  if (next.route.mode !== project.route.mode) route.mode = next.route.mode;
  const routeSize = diffPartial(next.route.size, project.route.size);
  if (routeSize) route.size = routeSize;
  if (Object.keys(route).length) out.route = route;

  // --- waypoints (no color, no shape — those live on Waypoint) ---
  const wp: NonNullable<MapOverrides['waypoints']> = {};
  if (next.waypoints.mode !== project.waypoints.mode) wp.mode = next.waypoints.mode;
  if (next.waypoints.label_mode !== project.waypoints.label_mode) wp.label_mode = next.waypoints.label_mode;
  if (next.waypoints.active_mode !== project.waypoints.active_mode) wp.active_mode = next.waypoints.active_mode;
  const wpSize = diffPartial(next.waypoints.size, project.waypoints.size);
  if (wpSize) wp.size = wpSize;
  if (Object.keys(wp).length) out.waypoints = wp;

  // --- pov (fully overridable; color is a plain hex string) ---
  const pov: Partial<PovSettings> = {};
  if (next.pov.color !== project.pov.color) pov.color = next.pov.color;
  const povSize = diffPartial(next.pov.size, project.pov.size);
  if (povSize) pov.size = povSize;
  // If/when pulse_style and pulse_rate ship per shapes-pov.md, they
  // follow the same one-line-per-leaf pattern here.
  if (Object.keys(pov).length) out.pov = pov;

  return out;
}
```

`diffPartial` is a 5-line helper that returns `Partial<T>` of changed
scalar keys, or `null` if nothing changed. Defined once and reused for
each `size` sub-block. This replaces the current
`{ ...next } filter !== mapSettings[key]` block in
`ProjectView.tsx:180–183`.

The function is mechanical and exhaustive. Adding a new overridable
leaf is one `if` line per leaf — visibly. There is no "did I remember
to add this field to the diff?" failure mode, because every leaf is
listed.

---

## 5. Override-highlight: `overriddenKeys`

The toolbar uses `overriddenKeys.has('waypoints_mode')` etc. today.
Under nested, the override object is `{ waypoints: { color: ... } }`
and `Object.keys` only yields top-level block names. The
override-highlight needs leaf-path enumeration:

```ts
type OverridePath =
  | `camera.${keyof CameraSettings}`
  | 'map_style'
  | 'route.mode' | `route.size.${keyof RouteSize}`
  | 'waypoints.mode' | 'waypoints.label_mode' | 'waypoints.active_mode'
  | `waypoints.size.${keyof WaypointsSize}`
  | 'pov.color' | `pov.size.${keyof PovSize}`;

function leafPaths(overrides: MapOverrides): Set<OverridePath> {
  const out = new Set<OverridePath>();
  if (overrides.camera) {
    for (const k of Object.keys(overrides.camera) as (keyof CameraSettings)[]) {
      out.add(`camera.${k}` as OverridePath);
    }
  }
  if (overrides.map_style !== undefined) out.add('map_style');
  if (overrides.route?.mode !== undefined) out.add('route.mode');
  if (overrides.route?.size) {
    for (const k of Object.keys(overrides.route.size) as (keyof RouteSize)[]) {
      out.add(`route.size.${k}` as OverridePath);
    }
  }
  if (overrides.waypoints) {
    if (overrides.waypoints.mode !== undefined)        out.add('waypoints.mode');
    if (overrides.waypoints.label_mode !== undefined)  out.add('waypoints.label_mode');
    if (overrides.waypoints.active_mode !== undefined) out.add('waypoints.active_mode');
    if (overrides.waypoints.size) {
      for (const k of Object.keys(overrides.waypoints.size) as (keyof WaypointsSize)[]) {
        out.add(`waypoints.size.${k}` as OverridePath);
      }
    }
  }
  if (overrides.pov) {
    if (overrides.pov.color !== undefined) out.add('pov.color');
    if (overrides.pov.size) {
      for (const k of Object.keys(overrides.pov.size) as (keyof PovSize)[]) {
        out.add(`pov.size.${k}` as OverridePath);
      }
    }
  }
  return out;
}
```

Toolbar usage shifts from `overriddenKeys.has('waypoints_mode')` to
`overriddenKeys.has('waypoints.mode')`. Each panel section knows the
set of paths it owns (e.g. the Waypoints Size section owns
`waypoints.size.circle_radius`, etc.; the POV Color section owns
`pov.color`).

For decoration-button override-highlight rollup (lighting up the
Route / Waypoints / POV `▾` button when any field in its domain is
overridden), each button passes its prefix:
`[...overriddenKeys].some(p => p.startsWith('pov.'))`.

### 5a. Per-waypoint override highlight

Per-waypoint overrides (`Waypoint.color`, `Waypoint.shape`) are NOT
in `overriddenKeys` — they live on the entity, not on
`clip.map_overrides`. The Waypoints toolbar button still surfaces
them: in clip scope, the button glows accent when the *waypoint
associated with the current clip* (looked up by `clip_id`) has any
per-waypoint override set.

```ts
const currentWaypoint = waypoints.find(w => w.clip_id === currentClip.id);
const waypointHasOverride =
  currentWaypoint?.color !== undefined ||
  currentWaypoint?.shape !== undefined;
```

In project scope, the button surfaces "any waypoint has an override":
`waypoints.some(w => w.color !== undefined || w.shape !== undefined)`.
This signals that the project view is not fully canonical — some
waypoints are styled individually.

---

## 6. Rust types

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradientStop {
    pub fraction: f64,
    pub color:    String,
}

// Tagged enum: { "mode": "solid", "solid": "#..." }
//          or  { "mode": "gradient", "stops": [...] }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DecorationColor {
    Solid    { solid: String },
    Gradient { stops: Vec<GradientStop> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraSettings { /* same fields, snake_case */ }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteSettings {
    #[serde(default)] pub mode:  String,        // TriMode
    #[serde(default)] pub color: DecorationColor,
    #[serde(default)] pub size:  RouteSize,
}

// WaypointsSettings, PovSettings: analogous. PovSettings.color is a
// plain `String` (hex), not a `DecorationColor` — POV is solid only.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MapSettings {
    #[serde(default)] pub camera:    CameraSettings,
    #[serde(default)] pub route:     RouteSettings,
    #[serde(default)] pub waypoints: WaypointsSettings,
    #[serde(default)] pub pov:       PovSettings,
}

// Overrides — mirrors MapSettings with Options everywhere.
// Note: WaypointsOverrides has neither color nor shape (those live on
// the Waypoint entity). PovOverrides mirrors PovSettings fully.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct MapOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<CameraOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waypoints: Option<WaypointsOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pov: Option<PovOverrides>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaypointsOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<WaypointsSizeOverrides>,
    // color and shape intentionally absent — per-waypoint, not per-clip.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PovOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<PovSizeOverrides>,
    // If pulse_style / pulse_rate ship per shapes-pov.md, add here.
}

// Waypoint entity — v8 adds two optional override fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Waypoint {
    pub id:       String,
    pub position: WaypointPosition,
    #[serde(default)] pub label: String,
    pub source:   String,             // 'clip' | 'gpx' | 'manual'
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_id:  Option<String>,

    // NEW in v8.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,        // hex
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,        // WaypointShape
}
```

No `SolidColorOnly` enum is needed in v8 — `MapOverrides` no longer
holds any color field that needs narrowing. POV color is a plain hex
string in both `PovSettings` and `PovOverrides`. Waypoint color
override is a plain hex string on the `Waypoint` entity.

---

## 7. Disk format

A clip override on disk (camera, route mode, POV color override —
note: no waypoint color, which lives on the Waypoint instead):

```json
{
  "id": "clip-2",
  "map_overrides": {
    "camera": { "zoom": 16.5 },
    "map_style": "satellite",
    "route": { "size": { "full_width": 0.0055 } },
    "pov": {
      "color": "#ffffff",
      "size": { "dot_radius": 0.016 }
    }
  }
}
```

A waypoint with a per-waypoint color + shape override on disk:

```json
{
  "id": "wp-3",
  "position": { "kind": "wall_clock_ms", "ms": 1715000000000 },
  "label": "Lunch break",
  "source": "clip",
  "clip_id": "clip-2",
  "color": "#ff715b",
  "shape": "diamond"
}
```

A project's full `map_settings`:

```json
{
  "map_settings": {
    "camera": {
      "follow_playhead": true,
      "map_style": "default",
      "zoom": 14.0,
      "bearing_mode": "fixed",
      "bearing_degrees": 0,
      "bearing_stops": 3
    },
    "route": {
      "mode": "full",
      "color": { "mode": "solid", "solid": "#bced09" },
      "size": { "full_width": 0.004, "trail_width": 0.0055 }
    },
    "waypoints": {
      "mode": "full",
      "color": { "mode": "solid", "solid": "#bced09" },
      "shape": "circle",
      "size": {
        "circle_radius": 0.015,
        "active_radius": 0.019,
        "stroke_width":  0.003,
        "label_size":    0.014
      },
      "label_mode": "numbered",
      "active_mode": "latest_passed"
    },
    "pov": {
      "color": "#bced09",
      "size": {
        "pulse_radius":       0.012,
        "dot_radius":         0.013,
        "dot_stroke_width":   0.004,
        "pulse_start_radius": 0.012,
        "pulse_end_radius":   0.033
      }
    }
  }
}
```

The override shape mirrors the settings shape exactly; the only
difference is that override sub-objects are sparse.

---

## 8. Migration

`map_settings` (project-level) and `map_overrides` (per clip) both
change shape. Schema bumps from v7 → v8
(`CURRENT_SCHEMA_VERSION = 8`). v7 was the first-class-waypoints
shipment and is the starting point — `Project.waypoints: Waypoint[]`
already exists in v7 bundles.

### Strategy

Follow the established pattern in `src-tauri/src/commands/project.rs`:
add `migrate_v7_to_v8_value` doing `serde_json::Value` surgery on the
project tree, then thread it through the `load_project` version match
arm and append it to every earlier-version migration chain. `save_project`
stamps `CURRENT_SCHEMA_VERSION` on every write.

### `map_settings` restructure (v7 flat → v8 nested)

Most projects have `"map_settings": null` and migrate as no-ops. For
projects with a non-null v7 flat shape:

```rust
fn migrate_map_settings_to_v8(ms: &mut serde_json::Map<String, Value>) {
    // --- camera block ---
    let camera = take_keys(ms, &[
        "follow_playhead", "map_style", "zoom",
        "bearing_mode", "bearing_degrees", "bearing_stops",
    ]);
    ms.insert("camera".into(), json!(camera));

    // --- route block ---
    let route_mode  = ms.remove("route_mode").unwrap_or(json!("full"));
    let full_width  = ms.remove("overlay_route_full_width").unwrap_or(json!(0.004));
    let trail_width = ms.remove("overlay_route_trail_width").unwrap_or(json!(0.0055));
    ms.insert("route".into(), json!({
        "mode": route_mode,
        "color": { "mode": "solid", "solid": "#bced09" },
        "size":  { "full_width": full_width, "trail_width": trail_width }
    }));

    // --- waypoints block ---
    // Lifts overlay_waypoint_* + label_mode + active_waypoint_mode.
    // No `color` or `shape` here — those default to chartreuse / circle
    // at the project level; per-waypoint overrides live on Waypoint.

    // --- pov block ---
    // Lifts overlay_live_marker_* and overlay_pulse_* into pov.size.*
    // and seeds pov.color with chartreuse.
}
```

The migrated color defaults (`#bced09`) match `colors.accent` exactly —
the user sees no visual change after migration.

### `map_overrides` restructure (v7 flat → v8 nested)

For each clip, lift flat keys into nested blocks. Every v7 flat
override key has a v8 home — nothing is dropped, because POV is
per-clip overridable in v8:

| v7 flat override key                    | v8 nested location              |
|-----------------------------------------|---------------------------------|
| `route_mode`                            | `route.mode`                    |
| `waypoints_mode`                        | `waypoints.mode`                |
| `map_style`                             | `map_style` (stays top-level)   |
| `zoom`, `bearing_*`, `follow_playhead`  | under `camera.*`                |
| `overlay_route_full_width`              | `route.size.full_width`         |
| `overlay_route_trail_width`             | `route.size.trail_width`        |
| `overlay_waypoint_circle_radius`        | `waypoints.size.circle_radius`  |
| `overlay_waypoint_active_radius`        | `waypoints.size.active_radius`  |
| `overlay_waypoint_stroke_width`         | `waypoints.size.stroke_width`   |
| `overlay_waypoint_label_size`           | `waypoints.size.label_size`     |
| `label_mode`                            | `waypoints.label_mode`          |
| `active_waypoint_mode`                  | `waypoints.active_mode`         |
| `overlay_live_marker_pulse_radius`      | `pov.size.pulse_radius`         |
| `overlay_live_marker_dot_radius`        | `pov.size.dot_radius`           |
| `overlay_live_marker_dot_stroke_width`  | `pov.size.dot_stroke_width`     |
| `overlay_pulse_start_radius`            | `pov.size.pulse_start_radius`   |
| `overlay_pulse_end_radius`              | `pov.size.pulse_end_radius`     |

There is no per-clip waypoint color override to migrate — v7 didn't
have a meaningful one (color was hardcoded `colors.accent`). v8
introduces per-waypoint color via `Waypoint.color`, which loads on
migrated `Waypoint` entries as `None` and renders identically to v7
(falls through to project default).

### `waypoints` migration

`Project.waypoints` is already populated in v7. v8 adds two optional
fields (`color`, `shape`) that default to `None` via serde and require
no JSON surgery. Existing waypoint entries load unchanged; the new
fields are absent from the JSON and the renderer falls through to the
project default for color and shape — visually identical to v7.

### Migration tests

Four synthetic-JSON round-trip tests in `commands/project.rs`:

1. `map_settings: null` → no-op, post-load fields populated by serde
   defaults to match `DEFAULT_MAP_SETTINGS`.
2. Full v7 flat `map_settings` → lifted into nested blocks with correct
   values; color blocks seeded with chartreuse defaults.
3. Clip with v7 `map_overrides: { "overlay_waypoint_circle_radius": 0.02 }`
   → post-migration becomes
   `{ "waypoints": { "size": { "circle_radius": 0.02 } } }`, and
   `resolveMapSettings` applies it correctly.
4. Clip with v7 `map_overrides: { "overlay_live_marker_pulse_radius": 0.018 }`
   → post-migration becomes
   `{ "pov": { "size": { "pulse_radius": 0.018 } } }`. (POV overrides
   are preserved in v8, not dropped.)

### Serde defaults as safety net

Every block-level struct (`CameraSettings`, `RouteSettings`,
`WaypointsSettings`, `PovSettings`, each `*Size` struct, `Waypoint`)
carries `#[serde(default)]` per field. Partially-migrated files,
hand-edited bundles, and forward-compatibility (a future field added
to `WaypointsSize`) all load cleanly without further migration.

---

## 9. Consumer rewrite

All reads in `src/lib/mapVisuals/*.ts` move from flat field names to
nested paths. This module is the single source of truth for
MapSettings-derived rendering state — both preview (`MapView.tsx` via
`useEffect`) and export (`src-tauri/sidecars/renderer/index.ts`) read
through it, so the rewrite is contained to one module's worth of files:

| File | Old read | New read |
|---|---|---|
| `styleSpec.ts` | `mapSettings.overlay_route_full_width` | `mapSettings.route.size.full_width` |
| `styleSpec.ts` | `mapSettings.overlay_waypoint_circle_radius` | `mapSettings.waypoints.size.circle_radius` |
| `paints.ts` | (new — see `rendering.md`) | `mapSettings.waypoints.color` |
| `animations.ts` | `mapSettings.overlay_pulse_start_radius` | `mapSettings.pov.size.pulse_start_radius` |
| `sources.ts` | (new) | `mapSettings.route.color` / `mapSettings.waypoints.color` |
| `sources.ts` | (new) | `wp.color` / `wp.shape` for per-waypoint overrides baked into feature properties |

`ProjectView.tsx` updates `overriddenKeys` to use `leafPaths()` from §5;
`MapToolbar.tsx` updates `overrideColor` lookups to use path strings.

`cameraIntent.ts` at line 904 (the per-clip resolve in timeline
compilation) calls the same `resolveMapSettings` and reads from the
same fully-resolved `MapSettings` — its consumer sites change paths
the same way.

Per-waypoint overrides do not flow through `resolveMapSettings` and do
not appear in `overriddenKeys`. `buildWaypointsCollection` in
`sources.ts` reads `wp.color` and `wp.shape` directly and bakes them
into the GeoJSON feature properties (`override_color`,
`override_shape`) consumed by the data-driven `circle-color` /
`icon-color` / `icon-image` expressions described in `rendering.md`.

---

## 10. What this convention establishes

This document defines two complementary conventions for TrailCut.

**Convention A — "project default + per-clip override" packets.** For
state that varies by clip-context (camera, map style, decoration
visibility, sizes, full POV). Future packets that need this pattern
(likely candidates: color grading in Phase 4, audio settings) should
follow it:

1. A complete `XSettings` type at the project level.
2. A hand-curated `XOverrides` type at the clip level, nested to mirror
   `XSettings` exactly, with `?` on every leaf.
3. A short `resolveXSettings(defaults, overrides): XSettings` of
   one shallow spread per block plus one extra per nested sub-block.
4. A `leafPaths(overrides): Set<XOverridePath>` for override-highlight.
5. A `computeXOverrides(next, project): XOverrides` for the diff
   direction.

**Convention B — "project default + per-entity override" fields.** For
state that varies by entity identity rather than clip context — where
each object in a project-owned list (`Project.waypoints`, future:
photo POIs, regions) can carry its own optional override of certain
project defaults. The pattern:

1. The project carries `mapSettings.X.field` (a non-optional default).
2. The entity carries `entity.field?: T` (optional override).
3. The renderer resolves per-feature as `entity.field ?? mapSettings.X.field`,
   baking the result into a GeoJSON feature property.
4. Override-highlight is derived from the entities, not from
   `MapOverrides` paths (see §5a).

Per-Waypoint `color` and `shape` are the first instance of Convention
B. Future per-entity overrides (e.g. per-waypoint label-mode override,
per-photo-POI color) should follow the same pattern.

The existing `ClipEntryTransition` shape (sparse `?`-fields used both
as project defaults and clip overrides) is a separate convention that
predates these two. It works but is not the recommended pattern for
new work.

---

## Implementation touchpoints

- `src/types.ts` — restructured `MapSettings`, hand-curated
  `MapOverrides`, `DEFAULT_MAP_SETTINGS`, `resolveMapSettings`, all
  block-level types. Extend `Waypoint` with `color?: string` and
  `shape?: WaypointShape`.
- `src-tauri/src/models.rs` — restructured `MapSettings`,
  `MapOverrides` (with `pov`, without waypoint color/shape),
  `DecorationColor`, `GradientStop`, all sub-structs, `impl Default
  for MapSettings`. Extend `Waypoint` with optional `color` and
  `shape`.
- `src-tauri/src/commands/project.rs` — `migrate_v7_to_v8_value`,
  version match arm appended to every existing migration chain,
  `CURRENT_SCHEMA_VERSION` bump to 8.
- `src/screens/ProjectView.tsx` — `overriddenKeys` derivation via
  `leafPaths`; `handleMapToolbarChange` calls `computeClipOverrides`.
- `src/lib/mapVisuals/*.ts` — read sites update to nested paths;
  `buildWaypointsCollection` reads per-waypoint `color` / `shape`.
- `src/components/MapToolbar/MapToolbar.tsx` — `overrideColor` accepts
  path strings; decoration-button rollup via `startsWith('pov.')` etc.
  Waypoints button additionally checks per-waypoint overrides on the
  associated waypoint (or any waypoint in project scope).
