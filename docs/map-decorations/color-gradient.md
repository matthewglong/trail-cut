# Color + Gradient Editor UX
Map Decorations — Color Section Interior

Covers Open Questions #2 and #6 from DESIGN.md. Decisions made here are final within this slice; revisit only with strong new information.

---

## 1. Codebase Findings

### Current color state

All three decorations share one color today. Sources: `src/lib/mapVisuals/styleSpec.ts` lines 30–31 and `src/lib/mapVisuals/paints.ts` lines 19–21.

| Layer | Property | Value | Token |
|---|---|---|---|
| route-full-line | line-color | #bced09 | colors.accent (chartreuse) |
| route-trail-line | line-color | #bced09 | colors.accent |
| waypoints-circle (inactive) | circle-color | #bced09 | colors.accent |
| waypoints-circle (active clip) | circle-color | #4a9eff | magic literal, not in palette |
| waypoints-circle | circle-stroke-color | rgba(255,255,255,0.85) | inline literal |
| live-marker-pulse | circle-color | #bced09 | colors.accent |
| live-marker-dot | circle-color | #ffffff | inline literal |
| live-marker-dot | circle-stroke-color | #bced09 | colors.accent |

Route, inactive waypoints, and POV pulse are visually indistinguishable. The active-waypoint highlight (#4a9eff) is a magic literal outside the token system; it needs to migrate into the per-decoration color config once that model lands.

### No existing color picker

`MapToolbar.tsx` contains only `ModePicker` (segmented choice) and `NumberStepper`. There is no shared color-picker component to build on. The swatch row, custom picker, and gradient editor are net-new across all three panels.

### Gradient stop fraction space — critical implementation detail

MapLibre's `line-gradient` paint property and the slime-trail's `line-progress` data attribute are both parameterized in **Web Mercator projected length**, not geodesic distance.

`progressUpTo()` in `src/lib/routeLocation.ts` line 268 uses `IndexedRoute.cumulativeMercatorMeters` because geodesic fractions disagree with `line-progress` by tens of pixels at high zoom / high latitude (see lines 55–62 of that file for the derivation and an empirical measurement at zoom 20, lat 37.7°).

Consequence for gradient stop storage: stop fractions in the data model must be **Web Mercator fractions (0–1)**, not geodesic fractions. The distance label shown to the user ("2.1 km") is derived from `cumulativeDistMeters` at the nearest trackpoint — display-only. The stored fraction must come directly from the drag pixel position:

    fraction = dragX / barWidth

Converting the display label back to a fraction for storage would introduce error. The geodesic display label at a given fraction is:

    distKm ≈ (route.totalDistMeters / 1000) * fraction

This linear approximation is accurate enough for a UI label at any practical trail length.

---

## 2. Defaults Recommendation

Three distinct defaults, one per decoration. Goal: immediate visual hierarchy before the user touches anything.

| Decoration | Default | Hex | Token |
|---|---|---|---|
| Route | chartreuse | #bced09 | brand.chartreuse (= colors.accent) |
| Waypoints | pollen | #f9cb40 | brand.pollen (= colors.accent2) |
| POV | coral | #ff715b | brand.coral (= colors.accentWarm) |

**Route keeps chartreuse.** It is the established primary accent across the codebase, has proven contrast on both liberty and satellite tiles, and is what users have already seen. No reason to change it.

**Waypoints move to pollen.** Warm amber is immediately distinct from chartreuse on the warm/cool axis. At small circle sizes it reads well on light map tiles and satellite. The token `colors.accent2` already exists for secondary accents — pollen is the natural assignment. It reads as "placed history," not "live action."

**POV moves to coral.** Coral is the highest-energy color in the palette. The POV marker is the only animated element on the map; giving it the most visually "hot" color correctly signals "this is where action is happening now." The three-decoration hierarchy becomes: chartreuse (trail) → pollen (history) → coral (now).

**Active-clip waypoint highlight.** The magic literal `#4a9eff` in `paints.ts` (the blue that highlights the current clip's waypoint) should default to the project's `mapSettings.pov.color`. An active waypoint is the waypoint at the current moment — it should carry the same "live" color as the POV marker. This also removes a hardcoded literal from outside the token system.

---

## 3. Color Section Layout — Structural Decision

**Decision: stacked single-column, inline expansion. No popover. No tabs.**

The wireframes at `docs/map-decorations/wireframes.html` explore three Route layouts (A: stacked inline, B: two-column popover, C: stacked + inline trail preview) and three Waypoints layouts. The recommendation adopts Route Option C's structure for both Route and Waypoints.

**Why not popover (Route Option B):** the gradient editor is the most consequential action in the Color section. A popover adds a second floating surface, partially covers the map the user is trying to style, and visually disconnects the editor from the panel it belongs to. The panel is already a dropdown; nesting another floating surface is unnecessary.

**Why not tabs (Waypoints Option C):** hiding the Color section behind a tab click means the user cannot inspect their gradient configuration without navigating away. Color is the primary reason most users open these panels — it must be visible immediately.

**Panel widths:** ~360px for Route and POV. ~400px for Waypoints (the Copy button row needs the extra width to avoid wrapping at common toolbar widths).

**Color section vertical stack — gradient mode, project scope:**

```
  [ Solid ] [ Gradient ]                  ← mode toggle (absent in POV, absent in clip scope)
  ┌──────────────────────────────────┐    ← gradient bar (18px)
  └──────────────────────────────────┘
  ◉──────────◎──────────────────────◉    ← stop rail with handles
  0 m     4.6 km               12.4 km    ← distance axis
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  STOP COLOR (stop 2)
  [■][■][■][■][■][■][░]    # BCED09      ← swatch row + hex
  [+ Stop]       [← Copy from Route]     ← action row
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  TRAIL PREVIEW               12.4 km    ← schematic SVG preview
  ①─────②──────③──────────④──────⑤      ←  path + waypoint dots
```

**Color section vertical stack — solid mode, project scope:**

```
  [ Solid ] [ Gradient ]
  [■][■][■][■][■][■][░]    # F9CB40      ← swatch row + hex
  [custom picker, if custom tile selected]
```

The switch between solid and gradient modes is a smooth height animation (~180ms ease-in-out). The panel expands or contracts without jump.

---

## 4. Level 1 — Swatch Row

Seven tiles in a single flex row: six named swatches plus one custom tile.

**Swatch order, left to right:**

    coral     pollen     chartreuse     azure     granite     white     [custom]
    #ff715b   #f9cb40    #bced09        #2f52e0   #4c5b5c     #e6ecec

Tile dimensions: 22×22px. Border-radius: 3px (`radii.base`). Default border: 1px solid `semantic.border`. Selected indicator: 1.5px solid `semantic.accent` (chartreuse) outline, 1px offset outside the tile border.

**The custom tile** uses a conic-gradient fill (coral → pollen → chartreuse → azure → coral) as background, with a dashed border. It is always the rightmost tile. When a custom color is active (user has edited a hex value or adjusted HSL/RGB inputs), the custom tile receives the selection outline, and a 10px circular inset dot in the custom color is rendered centered over the conic background as a preview.

**Hex input** sits inline to the right of the swatch row, same vertical baseline. It always shows the current active color as a 6-char uppercase hex string. A `#` character is a fixed dim prefix rendered outside the editable text area (matching the wireframe `hex::before` pattern). Width: 92px. Font: JetBrains Mono 11px. Editing the hex field sets the custom tile as the active selection.

```
  ┌────────────────────────────────────────────────────────────┐
  │ COLOR                                                      │
  │                                                            │
  │  [ Solid ] [ Gradient ]                                    │
  │                                                            │
  │  [■] [■] [■] [■] [■] [■] [░]    # F9CB40                 │
  │   CO  PO  CH  AZ  GR  WH  CU                              │
  └────────────────────────────────────────────────────────────┘

  PO (pollen) has the chartreuse outline. All other swatches have no
  outline. Labels below tiles are not rendered; shown here for reference.
  Each tile shows a tooltip on hover, e.g. "Pollen — #F9CB40".
```

---

## 5. Level 2 — Custom Picker

Clicking the custom tile expands a picker block **inline below the swatch row**. No popover, no modal. Clicking the custom tile again collapses it. Clicking a named swatch while the picker is open collapses the picker and applies the swatch color.

The picker shows one of three input modes, selectable via a 3-segment mini-toggle at the top: **HEX | HSL | RGB**. Default mode on first open: HEX.

```
  ┌────────────────────────────────────────────────────────────┐
  │  [ HEX ] [ HSL ] [ RGB ]                          ●       │
  │                                               (preview)    │
  │  HEX mode:                                                 │
  │  # [  F 9 C B 4 0                ]                        │
  │                                                            │
  │  HSL mode:                                                 │
  │  H  [─────────●────────]  203    (0–359, wraps)           │
  │  S  [──────────────●───]   83 %  (0–100)                  │
  │  L  [────────────●─────]   60 %  (0–100)                  │
  │                                                            │
  │  RGB mode:                                                 │
  │  R  [───────────────●──]  249    (0–255)                  │
  │  G  [──────────────●───]  203    (0–255)                  │
  │  B  [●──────────────────]   64   (0–255)                  │
  └────────────────────────────────────────────────────────────┘
```

The 10px preview dot (right side of the mode toggle row) shows the current color in real time as any field is adjusted. Mode switching converts values without rounding loss.

**Hex input and swatch-row hex are the same value.** Editing either one updates the other. When the custom picker is collapsed, the swatch row hex input remains the quick-edit surface for all swatches (named or custom).

**In gradient mode** (when a stop is selected), the custom picker appears below the distance axis and edits the selected stop's color, not the project solid color. Structurally identical.

---

## 6. Gradient Toggle

A two-segment picker at the top of the Color section in project scope for Route and Waypoints:

    [ Solid ] [ Gradient ]

Same visual style as the existing `TriMode` control: 1px border, `semantic.surfaceDeep` background, active segment gets `semantic.surfacePressed` background + `semantic.fg` text. Width ~160px.

**Availability:**
- Route panel, project scope: both segments active.
- Waypoints panel, project scope: both segments active.
- POV panel: toggle absent entirely in every scope. POV is solid-only
  by architectural decision (DESIGN.md §Color model). POV color is
  per-clip overridable in v8, but only as a single solid value.
- Waypoints panel, clip scope: toggle absent. Per-waypoint overrides
  are solid-only — see §10.
- Route panel, clip scope: toggle absent. Route color is project-only.
- Route or Waypoints, project scope, no GPX loaded: GRADIENT segment is present but disabled (opacity 0.4, `not-allowed` cursor, tooltip "Import a GPX route to enable gradients"). Not hidden — the feature must be discoverable.

**Stops are draggable along the distance axis, not fixed at percentages.** The point of trail-distance mapping is that the user can say "this color transition happens right at the ridge at 4.6 km." Percentage-fixed stops would obscure the trail geography the feature exists to express. The editor stores Web Mercator fractions (0–1), displays them as distances, and allows free dragging.

---

## 7. Gradient Editor Interior

The gradient editor replaces the swatch row when mode is GRADIENT. Five sub-components stack top to bottom inside the Color section body.

### a. Gradient bar

An 18px-tall rounded-rectangle strip spanning the panel content width. Background is a live `linear-gradient` computed from the current stop array. Updated synchronously on every stop position or color change.

Faint 1px vertical tick marks on the bar surface mark each waypoint's Mercator fraction position, giving the user snap targets that correspond to meaningful trail locations. Tick color: `semantic.fgFaint` (#34403f).

The bar accepts **pointer events for adding stops**: clicking anywhere on the bar that is not over an existing stop handle inserts a new stop at that x-fraction (see Section 7c).

### b. Stop rail

A transparent strip, same width as the gradient bar, 26px tall, immediately below the bar with zero gap. Stop handles sit at the vertical boundary between bar and rail.

**Stop handle geometry:**
- 14×14px circle.
- Fill: the stop's color.
- Border: 1.5px solid rgba(255,255,255,0.9).
- Selected: 1.5px solid `semantic.accent` (chartreuse) outline, 1px outside the border.
- Positioned: `left: {fraction * 100}%`, `transform: translateX(-50%)`.

**Endpoint stops (fraction 0 and fraction 1):**
- Color editable (click to select, opens the stop color picker).
- Position locked. No drag cursor. No delete affordance.
- No letter label. Position communicates their identity.

**Mid-stops (0 < fraction < 1):**
- Freely draggable horizontally. `cursor: ew-resize` on hover.
- On hover: a 12px `×` button appears 4px above the top of the handle circle, centered horizontally. Clicking deletes the stop.
- Dragging: snaps to the nearest waypoint's Mercator fraction when within 6px of a snap target. The corresponding waypoint tick on the bar highlights in `semantic.accentTint` when snap is active.
- Drag tooltip: a floating label (e.g. "4.6 km") appears 8px above the handle during drag, disappears on release.
- Stops re-sort on release if dragged past another mid-stop.
- On drop, round the fraction to 4 decimal places.

**Stop count constraints:**
- Minimum 2 (the two endpoints cannot be deleted).
- Maximum 8 total. At maximum, + Stop button is disabled with tooltip "Maximum 8 stops." The bar click-to-add is also disabled at maximum (`cursor: default` over the bar).
- Minimum separation: 0.005 fraction between any two stops. A stop dragged closer than 0.005 to a neighbor snaps to `neighbor.fraction ± 0.005`.

### c. Adding stops

Clicking anywhere on the gradient bar (not on an existing handle) inserts a new stop at that x-fraction. The new stop's color is sRGB-interpolated from the two bounding stops at that fraction. The new stop is immediately selected; the stop color picker expands with the interpolated color pre-filled.

The + Stop button inserts at the midpoint of the largest fractional gap (keyboard-accessible path).

### d. Stop color picker

When a stop is selected, a faint-bordered sub-block appears immediately below the distance axis. Content is the same swatch row + hex input + custom picker from Sections 4–5, operating on the selected stop's color. A section label "STOP COLOR" (9.5px monospace uppercase, `semantic.fgMuted`) appears top-left.

Deselecting a stop (clicking the gradient bar background, or clicking the same handle a second time) collapses the stop color picker. The Color section holds a fixed minimum height regardless of picker visibility to prevent layout jumps.

### e. Action row

```
  [+ Stop]                              [Copy → Waypoints]  ← Route panel
  [+ Stop]                              [← Copy from Route] ← Waypoints panel
```

### Full gradient editor ASCII mockup

```
  COLOR
  ─────────────────────────────────────────────────────────
  [ Solid ] [ Gradient ]

  ┌─────────────────────────────────────────────────────┐   gradient bar
  │ ░░░░░▒▒▒▒▓▓▓▓▓▓▓▓████████████████████████████████ │
  └─────────────────────────────────────────────────────┘
  ◉────────────────────◎───────────────────────────────◉   stop rail
  A                    2*                               B   (* = selected)
  0 m               4.6 km                         12.4 km  distance axis
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  STOP COLOR (stop 2)
  [■][■][■][■][■][■][░]    # BCED09
   CO  PO  CH  AZ  GR  WH  CU
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  [+ Stop]                           [← Copy from Route]
```

`◉` = endpoint (position locked). `◎` = selected mid-stop. Waypoint snap ticks on the bar not shown for clarity.

---

## 8. Gradient Preview — Inline Schematic Trail

**Decision: inline schematic SVG trail, not the live map.**

Two options considered:

1. **Live map update only.** MapLibre `line-gradient` and `circle-color` can be updated per stop drag via `setPaintProperty`. The actual map tile responds in real time.

2. **Inline schematic SVG.** A small diagram inside the editor shows a stylized trail with the gradient as its stroke color, and numbered dots at each waypoint's true fractional distance position.

**Recommendation: inline schematic (Option 2).** The live map still updates — `setPaintProperty` is cheap and the map should respond synchronously to every stop change. But the map is physically distant from the panel and partially occluded by the open toolbar dropdown. The schematic lives directly below the action row, adjacent to the stop rail: the connection between "I dragged this stop" and "this is where the color shift moved on the trail" is immediate and spatial. The schematic also makes the trail-distance concept legible in a single glance — dots at uneven intervals show that clips 1–2 were filmed near the trailhead while clip 5 was filmed far along the ridge.

The live map is the secondary confirmation. The schematic is the primary feedback loop.

### Schematic structure

A `div.preview` block below the action row. Contains:

**Header row** (9px monospace, `semantic.fgDim`): "TRAIL PREVIEW" at left, total trail distance at right. If < 1 km: meters ("840 m"). If ≥ 1 km: one decimal km ("12.4 km").

**SVG body** (28px tall, full content width):
- A `<path>` as a fixed decorative S-curve (static cubic bezier — not GPS-derived). Stroke uses a `<linearGradient>` whose `<stop>` elements directly mirror the editor's stop array. Updated on every stop change by patching the gradient element in place.
- One `<circle>` per waypoint. `cx = fraction * svgWidth` where fraction is the waypoint's Mercator progress along the route (computed from `IndexedRoute.cumulativeMercatorMeters`). `cy` follows the S-curve at that parameter. Fill: the gradient color linearly interpolated at the waypoint's fraction (same interpolation as the click-to-add stop color). Radius: 3.5px. Stroke: 1px `semantic.bg` dark halo.
- For the Waypoints panel with `numbered-circle` shape active: each circle contains its 1-based clip ordinal in white 7px text. For Route panel or all other shapes: no text.

**When no GPX route is loaded:** preview block is absent (gradient mode is also disabled in this state).

**When one clip:** one dot at fraction 0.

**Update cadence:** synchronous on every stop change. O(N) SVG attribute mutations where N = number of waypoints (typically 5–40). No debounce required.

### Preview ASCII mockup

```
  ┌──────────────────────────────────────────────────────┐
  │ TRAIL PREVIEW                              12.4 km   │
  │                                                      │
  │   ①─────②──────③───────────────④────────────⑤      │
  │                                                      │
  └──────────────────────────────────────────────────────┘
```

Numbered circles are waypoints at actual fractional distances along the route. The path stroke color uses the live `linearGradient`. Clips 1–2 are close to the trailhead; clips 3–5 spread across the back half. Each dot's fill interpolates the gradient at that waypoint's fraction.

---

## 9. Copy Button — Waypoints Panel

### Placement

In the Waypoints panel, action row, right-aligned:

    [+ Stop]                           [← Copy from Route]

In the Route panel, action row, right-aligned:

    [+ Stop]                           [Copy → Waypoints]

The `←` and `→` characters are text (not lucide icons), matching the wireframe's `btn--arrow-left` / `btn--arrow` pattern. Button style: `btn--ghost` (transparent background, `semantic.border` border, `semantic.fgMuted` text).

### Visibility rules

**"Copy from Route" in Waypoints panel:**
- Shown when Route is in gradient mode with at least 2 stops.
- Hidden when Route is in solid mode. There is nothing useful to copy.

**"Copy → Waypoints" in Route panel:**
- Shown whenever Route is in gradient mode.
- If Waypoints is currently in solid mode, pressing the button switches Waypoints to gradient mode before populating the stops. This is the one case where the copy button effects a mode switch on the target decoration.

### What the copy does

A deep copy of the source stop array. Fractions and color strings are duplicated. The two stop arrays are immediately independent — editing Route's stops later does not propagate to Waypoints (no live binding). This is deliberate; see DESIGN.md §Color model.

If the copy switches Waypoints from solid to gradient mode, the prior solid color is preserved in `color_stops_cache` per §13 so toggling back to solid restores it.

### Feedback on press

No toast.

On press: the button border and text transition to `semantic.accent` (chartreuse), and the label changes to "Copied ✓" for 500ms, then fades back to default ghost style over 200ms. No layout shift — the button holds its dimensions. If an icon is used, swap from `ArrowLeft` (or `ArrowRight`) to `Check` during the 500ms window.

---

## 10. Clip Mode

In clip scope, each decoration's Color section behaves differently
because each has a different override model. Mapping by decoration:

### Waypoints — edits the *associated waypoint*

In clip scope, the Waypoints Color section does NOT edit
`clip.map_overrides` (there is no `waypoints.color` field on
`MapOverrides` in v8 — see `data-model.md` §2). Instead it edits the
**`Waypoint` entity whose `clip_id` matches the current clip**:

```ts
const associatedWaypoint = waypoints.find(w => w.clip_id === currentClip.id);
```

UI behavior:

- SOLID | GRADIENT toggle is absent (per-waypoint override is
  solid-only).
- Gradient editor (bar, stops, axis, stop color picker, action row,
  preview) is absent.
- Copy buttons are absent.
- Remaining: **swatch row + inline hex input only**.

**Override vs inherited:**

When `associatedWaypoint.color === undefined` (inheriting from project
default — solid color or gradient sample at that waypoint's
fractional progress):
- No swatch has the chartreuse outline.
- The swatch row renders at 80% opacity as a subtle "inherited"
  signal.
- Clicking any swatch sets `associatedWaypoint.color` and restores
  full opacity.

When `associatedWaypoint.color` is set:
- The matching swatch (or custom tile) has the chartreuse outline.
- An override pill at the top of the Color section reads "Waypoint
  *N* · override" where *N* is the waypoint's 1-based ordinal (same
  number rendered on the map). Coral-bordered, matching the
  `.override` wireframe pattern.
- A "Reset to project" ghost button sits right-aligned in the pill
  row. Pressing it deletes `associatedWaypoint.color` and returns to
  inherited state.

**No associated waypoint case.** When the current clip has no waypoint
with matching `clip_id` (sticky-delete from the WaypointsPanel, or no
`created_at`), the Color section shows a single muted line:

```
This clip has no associated waypoint.
Add one from the Waypoints panel, or edit existing waypoints there.
```

The "Waypoints panel" text is a button that opens the existing
`src/components/WaypointsPanel/` modal.

### Route — color is read-only

The Color section in clip scope shows the project color in a
read-only state. Swatch row at opacity 0.42, `pointer-events: none`.
A "PROJECT" text label (9px mono, `semantic.fgDim`) appears top-right,
matching the wireframe's `.dim__tag` pattern. Route visibility and
size remain editable per clip (they live on
`MapOverrides.route.{mode,size}`).

### POV — fully editable

The POV Color section in clip scope works exactly like project scope:
swatch row, hex input, custom picker, all live. Selecting a swatch
sets `clip.map_overrides.pov.color` directly (POV is per-clip
overridable for every field in v8 — see `data-model.md` §2). When set,
the override pill behavior matches Waypoints: pill at the top of the
section, "Reset to project" clears the override.

POV gradient toggle remains absent in every scope — POV is solid
only, project-wide.

---

## 11. Edge Cases

### No GPX route loaded

Gradient mode is unavailable. The SOLID | GRADIENT toggle is present but GRADIENT is disabled (opacity 0.4, `not-allowed` cursor, hover tooltip "Import a GPX route to enable gradients"). Not hidden — discoverability matters. The trail preview block is absent. The gradient bar has no snap ticks.

### Toggle gradient OFF (GRADIENT → SOLID)

The stop array is preserved, not destroyed. It moves to `gradient_stops_hidden` in the decoration's color config (see Section 13). The gradient editor disappears. The solid color swatch row reappears showing the last active solid color. The map immediately reverts to solid color rendering.

### Toggle gradient ON, first time

When `gradient_stops_hidden` is empty (gradient never previously used): initialize with two endpoint stops, both set to the current solid color. The gradient bar renders as a solid block. The trail preview shows a monochrome path. The user must edit a stop color or add a mid-stop to produce a visible gradient. No contrasting second color is auto-selected — this avoids presuming color preferences.

A subtle hint is not needed here: the stop handles at A and B are clearly visible, the + Stop button is prominent, and the action of editing a stop color is immediately obvious.

### Toggle gradient ON, restoring hidden stops

When `gradient_stops_hidden` is non-empty: restore those stops as the active stop array. The editor opens showing the previously configured gradient. Prior work is preserved across all solid/gradient mode switches.

### No waypoints

The trail preview renders the path only, with no dot circles. The gradient bar and stops function normally. The snap ticks are absent (nothing to snap to).

### Degenerate route (zero total distance)

If `indexedRoute.totalMercatorMeters === 0`, treat gradient mode as unavailable (same behavior as no GPX loaded). This cannot occur with a valid GPX file but is a necessary guard.

### Stop collision on drag

A mid-stop dragged to within 0.005 fraction of another stop snaps to `neighbor.fraction + 0.005` (or `- 0.005` if dragging left). No two stops can share a fraction.

### Copy with no gradient on Route

"Copy from Route" in Waypoints is hidden when Route is in solid mode. In a stale state where it is somehow shown but Route has an empty stop array, the operation is a no-op. Do not switch Waypoints to gradient mode.

### One clip only

One dot appears in the trail preview at the route start (fraction 0). Gradient bar and stop controls function normally. Snap ticks show one tick at fraction 0.

---

## 12. Input Validation Rules

### Hex input

| Scenario | Behavior |
|---|---|
| 3-char input `FAB` or `#FAB` | Expand to `FFAABB`. Apply on blur or Enter. |
| 6-char without `#` | Prepend `#`, parse, apply. |
| 6-char typed (6th valid hex char) | Apply immediately without waiting for blur. |
| Paste of valid 6-char hex | Apply immediately on paste event. |
| Paste of 3-char hex | Expand and apply. |
| Invalid characters typed | Allow while typing. Reject on blur. |
| Invalid on blur | Revert to previous valid value. Flash 1px red border for 400ms. |
| Empty field on blur | Revert to previous valid value. |
| Leading/trailing whitespace | Strip before parsing. |

The `#` prefix is a fixed visual prefix element, not editable text. The field value is always the 6-char portion only.

### HSL steppers

| Field | Range | Overflow behavior |
|---|---|---|
| H (hue) | Integer 0–359 | Wraps: 360 → 0, −1 → 359 |
| S (saturation) | Integer 0–100 % | Clamps to [0, 100] |
| L (lightness) | Integer 0–100 % | Clamps to [0, 100] |

Mouse/touch drag up or down: ±1 per pixel. Hold Shift: ±10 per pixel. Uses `NumberStepper` behavior from the existing codebase. Live update on every tick (hex display, gradient bar, preview SVG all update synchronously). Free-text in the number field: applied on blur; invalid text reverts to previous value on blur.

### RGB steppers

| Field | Range | Overflow behavior |
|---|---|---|
| R, G, B | Integer 0–255 | Clamps to [0, 255] |

Drag ±1/px, Shift for ±10/px. Live update on every tick. Applied on blur.

### Gradient stop fraction

Not user-typed. Derived from drag pixel position. The only validation is the collision guard (minimum 0.005 separation between any two stops) enforced on drop. Fraction is stored as a 4-decimal-place float.

---

## 13. Data Model

**Canonical types live in `data-model.md`.** This section lists only
the shapes this document depends on, so the gradient editor UX is
self-contained.

**`GradientStop`** (per `data-model.md` §2):
- `fraction`: float [0, 1]. Web Mercator line-progress fraction (not
  geodesic). See §1 above.
- `color`: 6-char lowercase hex string, e.g. `"#bced09"`.

**`DecorationColor`** is a discriminated union:
- `{ mode: 'solid', solid: string }`
- `{ mode: 'gradient', stops: GradientStop[] }`

Project-scope `MapSettings` carries:
- `mapSettings.route.color: DecorationColor`
- `mapSettings.waypoints.color: DecorationColor`
- `mapSettings.pov.color: string` (solid only — no discriminated union)

**Per-waypoint color override** lives at `Waypoint.color: string |
undefined` (a plain hex string on the entity — see `data-model.md`
§2a). This replaces the earlier `clip.map_overrides.waypoints.color`
model — under first-class waypoints (schema v7), overrides are
per-Waypoint, not per-clip. Gradient overrides are blocked at the
type level (`Waypoint.color` is `string`, not `DecorationColor`).

**Per-clip POV color override** lives at `clip.map_overrides.pov.color:
string | undefined`. POV color is solid only in every scope (project
and clip).

### `gradient_stops_hidden` — preserve-on-mode-switch

When the user toggles GRADIENT → SOLID, the current stop array must
survive so toggling back restores it. Because `DecorationColor` is a
discriminated union, the union itself cannot carry a "hidden stops"
field — the user is in the `solid` arm with no `stops` slot.

**Resolution:** the preserved stops live in a separate `MapSettings`
sibling field, not inside `DecorationColor`. For example
`mapSettings.route.color_stops_cache: GradientStop[] | null` alongside
`mapSettings.route.color: DecorationColor`. The cache is populated on
GRADIENT → SOLID transition and consumed on SOLID → GRADIENT. It is
never read by the renderer.

The exact field name and placement is an implementation detail — flag
it for `data-model.md` once we ship Step 6 of `IMPLEMENTATION-PLAN.md`
(gradient editor). The conceptual point: the cache is a UI affordance,
not part of the resolved color value the renderer sees.

### Active-waypoint highlight

The magic literal `#4a9eff` in `paints.ts` line 19 (active-waypoint
highlight) should migrate to a `MapSettings` field rather than stay
hardcoded. The recommended default is `mapSettings.pov.color` (matching
§2 above — the active waypoint is the "now" point, same semantic as
POV). The exact field placement (a separate `waypoints.active_color`,
or just resolving to `pov.color` at render time) is an implementation
detail to settle alongside the cache-stops field above.

Because POV color is now per-clip overridable, deriving the
active-waypoint highlight from `mapSettings.pov.color` automatically
respects clip overrides — the active highlight follows the POV color
into clip overrides without any extra wiring.

---

## Related Files

- `/Users/personal/Documents/trail-cut/src/lib/mapVisuals/styleSpec.ts` — current line colors at lines 30–31; `ROUTE_FULL_LAYER` and `ROUTE_TRAIL_LAYER` paint specs to receive `mapSettings.route.color` driven values.
- `/Users/personal/Documents/trail-cut/src/lib/mapVisuals/paints.ts` — current waypoint and POV defaults at lines 19–21; magic literal `#4a9eff` at line 19 to migrate to `waypoints_active_color`.
- `/Users/personal/Documents/trail-cut/src/theme/tokens.ts` — `brand` object at lines 7–24; swatch order derives directly from named brand colors.
- `/Users/personal/Documents/trail-cut/src/lib/routeLocation.ts` — `progressUpTo()` at line 268; `IndexedRoute.cumulativeMercatorMeters` at line 55; source of the Web Mercator fraction space that gradient stop fractions must inhabit.
- `/Users/personal/Documents/trail-cut/src/types.ts` — `MapSettings` (restructured to nested blocks per `data-model.md`); `DEFAULT_MAP_SETTINGS`; new types `DecorationColor`, `SolidColor`, `GradientStop`. The per-decoration `color` fields land at `route.color`, `waypoints.color`, `pov.color`.
- `/Users/personal/Documents/trail-cut/src/components/MapToolbar/MapToolbar.tsx` — Route item at lines 160–177 and Waypoints item at lines 178–194 become dropdown panel triggers.
- `/Users/personal/Documents/trail-cut/docs/map-decorations/wireframes.html` — visual reference; Route Option C, Waypoints Option A, and POV Option A establish the structural baseline this doc extends.
