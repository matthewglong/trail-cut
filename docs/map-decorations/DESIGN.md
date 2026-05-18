# Map Decorations — Design Outline

Handoff doc for a fresh session to pick up the map-decorations redesign.
This is an **outline of locked decisions + open questions**, not an
implementation plan. No code has been written yet.

## Goal

Today the map toolbar exposes a small Waypoints button whose dropdown only
toggles `none | visited | full`. We want to expand what's configurable per
decoration — sizes, colors (including gradients), shapes — and structure
it holistically across all the things drawn on the map.

## The three decoration types

The map draws three distinct decoration types. Each gets its own toolbar
panel. These are deliberately separated; do not merge them.

| Decoration | What it is | Lifecycle |
|---|---|---|
| **Route** | The GPX trace line (full + visited-so-far) | One continuous geometric thing |
| **Waypoints** | Per-clip pins/circles at filming locations | Discrete, indexed, persistent |
| **POV** | The animated playhead dot with pulse | Single, transient, motion-driven |

POV is explicitly **not** a waypoint. Different controls (pulse vs
sequence/numbering, no per-clip identity).

## Toolbar structure (target)

Replace today's single "Waypoints" tri-mode button. Route already exists;
keep it but expand it into a panel. Add POV.

```
[Scope] | [Style] | [Route ▾] | [Waypoints ▾] | [POV ▾] | [Zoom] | [Positioning] | [Follow] | [Bearing]
```

Each `▾` opens a wide dropdown panel below the toolbar. Panel contents
below.

**Why tool-per-decoration (not tool-per-property like a single "Color"
button):** grouping everything for one decoration together matches the
mental model "I want to style my waypoints." Tool-per-property would
distribute one element's controls across many buttons — same antipattern as
per-divider thinking on split layouts. See
`memory/feedback_pane_level_thinking.md`.

## Per-panel contents

Per the nested data model (see `data-model.md`), each panel binds to
its own block on `MapSettings` (`route`, `waypoints`, `pov`).

### Route panel
- **Visibility** — existing tri-mode (`none | visited | full`),
  bound to `route.mode`
- **Color** — solid OR gradient (gradient mapped by trail distance),
  bound to `route.color`
- **Size** — bound to `route.size.full_width`, `route.size.trail_width`

### Waypoints panel
- **Visibility** — existing tri-mode, bound to `waypoints.mode`
- **Color** — solid OR gradient (trail distance), with one-shot
  "Copy gradient from Route" / "Copy gradient to Route" button,
  bound to `waypoints.color`
- **Shape** — new. Gallery: circle, pin, ring, square, diamond,
  numbered-circle. Numbered variant interacts with label-size control.
  Bound to `waypoints.shape`.
- **Size** — bound to `waypoints.size.circle_radius`,
  `waypoints.size.active_radius`, `waypoints.size.stroke_width`,
  `waypoints.size.label_size`

### POV panel
- **Color** — solid only. No gradient, no link to Route/Waypoints.
  Bound to `pov.color`.
- **Pulse** — pulse style controls (steady/throb/sonar — TBD)
- **Size** — bound to `pov.size.*`

## Color model (the central architectural decision)

**Each decoration owns its own color/gradient config. There is NO unified
project palette.**

| Layer | Route | Waypoints | POV |
|---|---|---|---|
| Project default | Solid or gradient (trail distance) | Solid or gradient (trail distance) | Solid |
| Per-clip override | ❌ none (route is continuous) | ❌ none on the clip — see per-waypoint below | ✅ all fields (color + sizes + pulse) |
| Per-waypoint override | — | ✅ solid color, shape (on the `Waypoint` entity) | — |

**Linking is a one-shot copy, not a binding.** The "Copy gradient from/to
Route" button in the Waypoints panel (and vice versa) does an immediate
sync. Editing one later does not propagate to the other. This is
deliberate — explicit intent beats spooky-action-at-a-distance, and it
allows deliberately divergent palettes between route and waypoints.

**Gradient mapping basis: trail distance** (not clip index). Distance is
the line's natural parameter, which makes the route gradient visually
meaningful — color changes smoothly along every meter of the line. When
waypoints share the gradient via the copy button, each waypoint's color
matches the line underneath it at the same distance.

**Per-waypoint color override is solid only, and lives on the
`Waypoint` entity.** A single waypoint is one point on the trail —
nothing to gradient across. Override is "force this one waypoint to be
gold" (e.g. the lunch-break highlight case). The override recolors only
that dot; the route line keeps flowing on its own gradient underneath.
Because the override is per-Waypoint (not per-clip), it works uniformly
for clip-sourced, GPX, and manual waypoints. When the user is in clip
scope and edits the Waypoints color section, the panel looks up the
waypoint whose `clip_id` matches the current clip and edits *that
waypoint's* color directly — there is no `clip.map_overrides` for
waypoint color.

**POV is per-clip overridable for everything.** Color, sizes, and (if
pulse styles ship — see `shapes-pov.md`) pulse style/rate all sit on
`MapOverrides.pov`. A clip on satellite tiles can carry a chunkier
white POV dot; the next clip on default tiles inherits the project
default. This matches existing per-clip POV size override behavior
shipped pre-redesign and extends it to color.

**Rejected alternatives** (do not revisit without strong reason):
- Single shared project palette driving multiple decorations — causes
  spooky action, blocks intentional divergence.
- Per-clip route override — route is one continuous thing, segmenting it
  by clip forces invented boundaries.
- Per-clip waypoint gradient — no second anchor point to gradient across.
- POV participating in the palette — POV is a UI element, not a
  decoration; should contrast the palette so the viewer's eye locks onto
  it.

## Color picker UX (sketch — not finalized)

Inside each decoration's Color section, progressive disclosure:

1. **Swatch row** — existing theme colors from `src/theme/tokens.ts`
   (coral, pollen, chartreuse, azure, etc.). Covers most cases instantly.
2. **Custom** — opens HSL / hex / RGB inputs.
3. **Gradient toggle** (Route + Waypoints only, project scope only) —
   converts the single-color picker into start/end stops, with an "add
   stop" affordance for multi-stop. Preview should show the *applied*
   gradient (e.g. numbered dots along the trail) not just a horizontal
   bar — makes the trail-distance mapping legible.

## Scope behavior

Scope toggle (existing — see `MapToolbar.tsx` `ScopeToggle`) drives project
vs clip mode for the entire toolbar. In clip mode:

- **Route panel**: Color is project-only (read-only with explanation).
  Visibility (`mode`) and Size are per-clip overridable via
  `MapOverrides.route`.
- **Waypoints panel**: Visibility (`mode`) and Size are per-clip
  overridable via `MapOverrides.waypoints`. Color edits the
  waypoint associated with the current clip (looked up via
  `clip_id`) — solid only, no gradient affordance in clip scope.
  Shape edits the same associated waypoint's `shape`. If the current
  clip has no associated waypoint (sticky-delete or no `created_at`),
  the Color and Shape sections show a one-line note pointing the user
  at the WaypointsPanel.
- **POV panel**: fully editable. Color, sizes, and pulse settings are
  per-clip overridable via `MapOverrides.pov`.

The existing override-highlight pattern (accent color on icon when a
clip overrides a field) extends to the new fields via the path-based
`overriddenKeys` set (`data-model.md` §5). Per-waypoint overrides
surface separately — the Waypoints toolbar button lights up when the
current clip's associated waypoint has any per-waypoint override set
(`color` or `shape`).

## Current code anchors

- `src/components/MapToolbar/MapToolbar.tsx` — toolbar source, overflow
  wrap logic, items array. New panels added/replaced here.
- `src/types.ts` lines ~73–135 — `TriMode`, `MapSettings`,
  `DEFAULT_MAP_SETTINGS`, `resolveMapSettings`. New color/shape fields
  added here.
- `src/components/MapView.tsx` — where MapLibre paint properties consume
  `MapSettings`. Will need new color/shape rendering paths.
- `src/theme/tokens.ts` — palette source for the swatch row.

Sizing already follows the canonical-reference-width model — see
`memory/project_map_rendering_spec.md`. New size fields per decoration
panel must follow the same fraction-of-1080-CSS-px convention.

## Resolved decisions (since this doc was first written)

- **Q7 — Data model.** Resolved: **nested both sides**. `MapSettings`
  and `MapOverrides` mirror each other structurally (camera / route /
  waypoints / pov blocks). `MapOverrides` is a hand-curated type, not
  `DeepPartial<MapSettings>`. See `data-model.md` for canonical types.
- **First-class waypoints already shipped (schema v7).** The redesign
  is v7 → v8. `Project.waypoints: Waypoint[]` is the source of truth
  for what the map draws; clips contribute waypoints via the
  clip-sourced lifecycle in `src/lib/waypoints.ts`. Per-waypoint
  overrides (`Waypoint.color`, `Waypoint.shape`) replace what earlier
  drafts called `clip.map_overrides.waypoints.color`.
- **`MapOverrides` surface.** Camera, `map_style`, `route.{mode,size}`,
  `waypoints.{mode,size}`, and `pov.*` (full). Waypoints color and
  shape are NOT on `MapOverrides` — they live on the `Waypoint` entity.
- **POV is per-clip overridable for everything** (color, sizes, pulse).
  Earlier drafts called POV project-only; that decision is reversed.

## Open questions for the next session

1. **Per-panel layout** — wide dropdown vs popover vs slide-out? How
   wide? Three sections (Visibility / Color / Size) stacked vertically or
   in columns?
2. **Gradient editor interior** — exact UX for adding/moving/deleting
   stops, picking each stop's color, previewing the result along the
   trail.
3. **Shape gallery interior** — visual grid? icon row? interaction with
   the numbered-circle variant and the label-size control.
4. **Per-clip override surfacing** — does the same panel open in clip
   mode with greyed-out gradient controls, or is it a different
   affordance? How does the override get cleared back to "use project
   default"?
5. **Pulse controls for POV** — what styles are worth offering
   (steady/throb/sonar/none) and what parameters expose (rate, intensity)?
6. **Defaults** — what color/gradient ships out of the box? Probably a
   sensible single-color default (chartreuse?) with gradient opt-in.

## Related memory references

- `project_map_decorations_model.md` — the locked decisions above, in
  memory form
- `project_map_rendering_spec.md` — perceived-scale-across-aspect rule
  governing how new size fields behave
- `feedback_pane_level_thinking.md` — antipattern this design avoids
