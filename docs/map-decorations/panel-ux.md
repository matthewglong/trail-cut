# Map Decorations — Panel UX Design
### Open Questions #1 and #4: Panel Layout, Dropdown UX, and Per-Clip Override Surfacing

---

## 1. Existing Toolbar — Observed Constraints

### Current items array (MapToolbar.tsx:143–277)

Seven items in declared order:

```
[Style] | [Route] | [Waypoints] | [Zoom] | [Positioning] | [Follow] | [Bearing]
```

The overflow system (`recompute` at `MapToolbar.tsx:284`) is well-engineered: it measures each item's footprint against the available bar width and wraps the tail into a float row (`overflowRow`, `styles.ts:132`) that is `position:absolute; top:100%; right:0`. That overlay row is acceptable as a safety valve but becomes a problem if it is the default state on a medium-width map pane.

### Approximate item footprints at default font size

| Item | Approx width |
|------|-------------|
| Style (icon + badge) | ~76px |
| Route (icon + badge) | ~68px |
| Waypoints (icon + badge) | ~68px |
| Zoom (icon + stepper) | ~90px |
| Positioning (icon button) | ~32px |
| Follow (icon + pill) | ~100px |
| Bearing (icon + pill + stepper) | ~140px |

Total content: ~574px. Add separators (~10 of them at ~12px each including margins from `styles.ts:17–21`): ~694px. The map pane shares horizontal space with the video preview and clip info columns; at a typical 3-pane layout the map pane sits between 460–560px wide. The toolbar already wraps routinely — Bearing and sometimes Follow land in the overflow row on any map pane narrower than full-window.

Adding three new decoration buttons before thinking about it would put the total well past 800px and make the overflow row the permanent default state on most map widths.

---

## 2. The Overflow Problem — and the Solution

The core insight is that today's Route and Waypoints items are thin because they expose one control each (a three-way `ModePicker`). Visibility is the one control that fits inline in the bar. But Visibility is also entirely appropriate to live inside the panel alongside Color, Size, and Shape — there is no reason it must live inline.

**The fix: remove Route and Waypoints as inline `ModePicker` nodes. Replace them with panel-launcher buttons. Add POV as a third panel-launcher button.**

A panel-launcher button is icon-only (24–32px wide) with an optional override-dot badge. Compare that to the current `ModePicker` nodes (~68px each with icon + badge). Net math:

| Change | Delta |
|--------|-------|
| Remove Route ModePicker inline | −68px |
| Remove Waypoints ModePicker inline | −68px |
| Add Route panel button | +32px |
| Replace Waypoints ModePicker with panel button | (was 68, now 32) | −36px |
| Add POV panel button | +32px |

Net: approximately −108px. The bar gets lighter. Overflow should no longer be the normal state at medium map widths. The overflow system remains as a safety net for very narrow windows but stops being load-bearing.

### Target items array order

```
[Scope] | [Style] | [Route ▾] | [Waypoints ▾] | [POV ▾] | [Zoom] | [Positioning] | [Follow] | [Bearing]
```

This matches DESIGN.md's target layout. Route / Waypoints / POV form a decoration cluster. Zoom / Positioning / Follow / Bearing remain the camera-behavior group.

---

## 3. Panel Shape Decision — Anchored Floating Popover

Three candidates considered:

**A. Floating popover anchored below the button.** Opens below its trigger, absolutely positioned, overlays the map. Width unconstrained by the bar. One panel open at a time. Click outside or press Escape closes it.

**B. Slide-out side panel.** A drawer replacing or overlaying the right edge of the map pane. Wide canvas but consumes real estate, interrupts the "tweak and see" feedback loop, and feels heavy for what are essentially property inspector controls.

**C. Tabbed mega-panel.** A single wide panel with Route / Waypoints / POV tabs pinned to the toolbar. Collapses the per-decoration button model into one place, which contradicts the design brief's explicit tool-per-decoration requirement. Also makes the scope toggle's impact ambiguous when switching tabs.

**Recommendation: Option A — floating popover anchored below the button.**

Rationale anchored in the codebase:

- The existing `Dropdown` component (`src/components/shared/Dropdown.tsx:15–32`) already defines the shell: `position:absolute; top:100%; right:0; background bgSurface; border borderStrong; borderRadius 6px; z-index 100`. The decoration panels are a wider, structurally richer Dropdown.
- `MapView.tsx:373–388` confirms that any `mapSettings` change triggers `resolveStaticPaints` → `setPaintProperty` within the same React commit cycle. The map updates live while the panel is open. This makes the "see the change immediately" affordance work for free — the popover staying open on top of the live map is a feature, not a problem.
- The Positioning button already uses the "button → modal" pattern. Panel launchers follow the same established mental model with a lighter-weight surface.
- At most one panel open at a time prevents overlapping panels and keeps z-stacking simple.

### Panel sizing

**Width: 280px.** The swatch row needs 7–8 swatches at ~28px each with 4px gaps: 7×28 + 6×4 = 220px minimum; 280px gives comfortable breathing room. NumberStepper controls are ~90px wide; with an 80px label column, 280px leaves ~100px of control space — workable. The gradient stop editor needs ~220px minimum; 280px is comfortable.

**Max-height: ~480px** with `overflow-y: auto` as a safety valve. In practice the Waypoints panel (4 sections: Visibility, Color, Shape, Size) should land around 400–420px.

**Anchor:** `top: 100%; left: 0` relative to the button wrapper — panel opens flush with the button's left edge and hangs below the bar. If the button is near the right edge of the bar and 280px would overflow the window, shift to `right: 0` instead. That boundary check is a one-time measurement at render time, or CSS `min(left: 0, right: -8px)` with a `transform` approach.

**Z-index: 200** — above the overflow row (z-index 5) and MapLibre's controls (defaults ~2).

---

## 4. Panel Interior Layout

Each panel follows a consistent vertical structure: a panel title row, an optional scope banner (in clip mode), then one or more sections. Sections are stacked vertically with a 1px `semantic.border` rule between them. No tabs.

**Section header pattern:**

```
SECTION LABEL               [● overridden]  [× clear]
──────────────────────────────────────────────────────
```

The section label is `typeScale.eyebrow` (10.5px), `semantic.fgDim`, uppercase with 0.06em letter-spacing — consistent with existing section headers in the codebase's edit panels. The `[● overridden]` indicator and `[× clear]` button are conditionally rendered; see Section 6.

---

## 5. Panel Layouts — ASCII Mockups

### 5a. Route Panel (project scope)

```
┌──────────────────────────────────────────────────┐
│  ROUTE                                           │
├──────────────────────────────────────────────────┤
│  VISIBILITY                                      │
│  ┌────────┐ ┌───────────┐ ┌────────┐            │
│  │  None  │ │  Visited  │ │  Full  │            │
│  └────────┘ └───────────┘ └────────┘            │
├──────────────────────────────────────────────────┤
│  COLOR                                           │
│  ● Solid   ○ Gradient                            │
│                                                  │
│  [■] [■] [■] [■] [■] [■] [■]   ← swatch row    │
│  [Custom…]                                       │
├──────────────────────────────────────────────────┤
│  SIZE                                            │
│  Full line width    [───────]  [ 4.3 ↑↓] px     │
│  Trail line width   [───────]  [ 5.9 ↑↓] px     │
└──────────────────────────────────────────────────┘
```

Size values display as `field × 1080` (i.e. physical CSS-px at the 1080 canonical width). This gives users legible pixel counts (4.3px, 5.9px) rather than opaque fractions (0.004, 0.0055). Conversion is `displayValue = storedFraction × 1080`; incoming `onChange` divides by 1080 before storing.

### 5b. Waypoints Panel (project scope)

```
┌──────────────────────────────────────────────────┐
│  WAYPOINTS                                       │
├──────────────────────────────────────────────────┤
│  VISIBILITY                                      │
│  ┌────────┐ ┌───────────┐ ┌────────┐            │
│  │  None  │ │  Visited  │ │  Full  │            │
│  └────────┘ └───────────┘ └────────┘            │
├──────────────────────────────────────────────────┤
│  COLOR                                           │
│  ● Solid   ○ Gradient                            │
│                                                  │
│  [■] [■] [■] [■] [■] [■] [■]                   │
│  [Custom…]                                       │
│                                                  │
│  [⇄ Copy gradient from Route]                    │
├──────────────────────────────────────────────────┤
│  SHAPE                                           │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │
│  │  ○   │ │  ◎   │ │  ◈   │ │  ◆   │ │  ①   │  │
│  │circle│ │ ring │ │square│ │diamo │ │ num  │  │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘  │
├──────────────────────────────────────────────────┤
│  SIZE                                            │
│  Radius           [───────]  [16.2 ↑↓] px       │
│  Active radius    [───────]  [20.5 ↑↓] px       │
│  Stroke           [───────]  [ 3.2 ↑↓] px       │
│  Label size       [───────]  [15.1 ↑↓] px  ¹    │
└──────────────────────────────────────────────────┘
  ¹ Label size row only rendered when shape = numbered
```

The Shape gallery uses 5 items rendered as 52×52px touch targets with a centered icon and a label below. The selected shape gets a `semantic.accentTint` background fill and a `semantic.accent` border, matching the existing `segmentedBtnActive` pattern at `styles.ts:103`. Label size is conditionally rendered — only when the numbered-circle shape is selected. This avoids surfacing a control that has no effect for other shapes and prevents confusion about what "label size" means.

### 5c. POV Panel (project scope)

```
┌──────────────────────────────────────────────────┐
│  POV                                             │
├──────────────────────────────────────────────────┤
│  COLOR  (solid only)                             │
│  [■] [■] [■] [■] [■] [■] [■]                   │
│  [Custom…]                                       │
├──────────────────────────────────────────────────┤
│  PULSE                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │  Steady  │ │  Throb   │ │  Sonar   │         │
│  └──────────┘ └──────────┘ └──────────┘         │
├──────────────────────────────────────────────────┤
│  SIZE                                            │
│  Dot radius       [───────]  [14.0 ↑↓] px       │
│  Dot stroke       [───────]  [ 4.3 ↑↓] px       │
│  Pulse start r    [───────]  [13.0 ↑↓] px       │
│  Pulse end r      [───────]  [35.6 ↑↓] px       │
└──────────────────────────────────────────────────┘
```

POV has no Visibility section — the dot is always present when a clip is active and a route is loaded. A three-way mode toggle would only add "none" as a meaningful option (the user can just not look at the dot), and "visited" has no meaning for a single animated point.

---

## 6. Per-Clip Override Surfacing (Open Q #4)

This is the central UX problem. The panel must do three things:
1. Signal unambiguously that clip scope is active and controls what
   the user is editing.
2. Surface exactly the subset of controls that support clip overrides
   under the v8 model:
   - **Camera**: zoom, bearing, follow_playhead, map_style
   - **Route**: visibility (`mode`) and size — color is project-only
   - **Waypoints**: visibility (`mode`) and size — color and shape
     edit the *associated Waypoint* (looked up by `clip_id`), not
     `clip.map_overrides`
   - **POV**: all fields (color, sizes, pulse)
3. Provide a clear, discoverable path to remove a clip override and
   revert to the project default (per-clip overrides) or clear a
   per-waypoint override (per-Waypoint overrides).

### 6a. Scope banner — the anchor signal

When `scope === 'clip'`, every panel gains a persistent inline banner immediately below the panel title. This is not a tooltip; it occupies layout space and stays visible while the panel is open.

```
┌──────────────────────────────────────────────────┐
│  WAYPOINTS                                       │
│  ┌────────────────────────────────────────────┐  │
│  │ ◫  Clip 3 overrides  ·  ← switch to proj  │  │  ← warmTint bg, accentWarm text
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│  …
```

Background: `semantic.warmTint` (`rgba(255,113,91,0.08)`). Text: `semantic.accentWarm` (`#ff715b`). The `◫` icon is the same scope icon family used in `ScopeToggle`. "Switch to proj" is an inline text action (no border, underline on hover) that calls `onScopeChange('project')`.

This re-uses the orange color family already established by the clip-scope tab (`scopeTabClip` at `styles.ts:49` uses `colors.accent` = `#ff6b35`) and the `barTintClip` background (`#532e21`). The visual connection is immediate — orange means "you are in clip mode."

### 6b. Section-level override indicator and clear button

Within a section, any field carrying a clip override shows two additions in the section header:

- A filled dot (7px, `semantic.accent` chartreuse) with the word "overridden" at `typeScale.meta` (11px), `semantic.fgMuted`. This is the same signal the toolbar icons use via `overrideColor` at `MapToolbar.tsx:85`.
- A `× clear` text button at the far right of the header row, visible only when at least one field in that section is overridden. At rest: `semantic.fgDim`. On hover: `semantic.accentWarm`.

```
  COLOR   [● overridden]                [× clear]
  ─────────────────────────────────────────────────
  (solid-only mode; no gradient row shown)

  [■] [■] [▣] [■] [■] [■] [■]   ← [▣] = active swatch
  [Custom…]
```

The `[▣]` swatch shows the currently overridden color with an accent border. All other swatches are clickable and immediately update the clip's `map_overrides`.

### 6c. Gradient affordance removal in clip scope (Waypoints only)

In project scope, the Waypoints Color section opens with
`● Solid / ○ Gradient` radio pair. In clip scope for Waypoints, that
radio pair is not shown — not greyed out, not disabled, simply
absent. The section opens directly to the swatch row, editing the
*associated Waypoint*'s `color` field (looked up by `clip_id`). Below
the swatches, a single caption line:

```
  Per-waypoint overrides are solid-color only.
  Switch to Project scope to edit gradients.
```

Rendered at `typeScale.meta` (11px), `semantic.fgDim`. No interactive
element in the caption — the banner at the top already provides the
"switch to project" action. Hiding rather than greying the gradient
control is intentional: a greyed control implies "this exists but is
blocked." Hiding says "this concept does not apply here." The caption
provides the explanation. Users who want gradient control switch
scope via the banner.

**No associated waypoint case.** If the current clip has no waypoint
with matching `clip_id` (sticky-delete from the WaypointsPanel, or no
`created_at`), the Waypoints Color and Shape sections show a one-line
note in place of the controls:

```
  This clip has no associated waypoint.
  [Open Waypoints panel]
```

The button opens the existing `src/components/WaypointsPanel/`
modal for manual waypoint editing.

POV in clip scope has no gradient toggle either (POV is solid-only in
every scope), but the Color section IS editable — see §7.

### 6d. Clearing overrides — three levels

**Level 1 — Per-section `× clear` (primary affordance).** Appears in
the section header row when that section contains overridden fields.
Clicking it clears the overrides belonging to that section. The
target depends on the section type:

- **Per-clip override sections** (Route Visibility/Size, Waypoints
  Visibility/Size, Camera, POV Color/Size): removes the relevant leaf
  keys from `clip.map_overrides`. For example, the POV Size section's
  `× clear` deletes `map_overrides.pov.size.*`; if `map_overrides.pov`
  then has no remaining keys, the empty `pov` block is also dropped.
- **Per-Waypoint override sections** (Waypoints Color, Waypoints
  Shape in clip scope): deletes `color` or `shape` on the *associated
  Waypoint* (looked up by `clip_id`). Does NOT touch
  `clip.map_overrides`.

Other sections' overrides survive in both cases.

**Level 2 — Per-panel `× Clear all` (secondary affordance).** A text
button at the bottom of the panel, rendered only when the decoration
has any overrides active. The target depends on the decoration:

- **Route panel** clears `map_overrides.route.*` (per-clip overrides
  for visibility and size).
- **Waypoints panel** clears `map_overrides.waypoints.*` AND the
  associated Waypoint's `color` / `shape` (the latter only when the
  associated waypoint exists). Label changes from "Clear all clip
  overrides" to "Clear all overrides for this clip's waypoint" when
  per-Waypoint overrides exist.
- **POV panel** clears `map_overrides.pov.*` entirely.

Placed at the bottom so it does not draw the eye before the user
understands what is shown above it.

**Level 3 — Global clip override clear.** Not in the panel — belongs
in the clip info column or a clip context menu. Out of scope here.

Per-section clear is the right granularity: low risk (scoped to one
group of related fields), co-located with the thing being cleared,
and unambiguous in what it does. The mixing of per-clip and
per-Waypoint targets within the same affordance is intentional — the
user thinks of "this section's overrides" as a unit; the storage
mechanism is an implementation detail surfaced via the override pill
text ("Clip 03 · override" vs "Waypoint 7 · override").

### 6e. Waypoints panel in clip scope — full mockup

```
┌──────────────────────────────────────────────────┐
│  WAYPOINTS                                       │
│  ┌────────────────────────────────────────────┐  │
│  │ ◫  Clip 3 overrides  ·  ← switch to proj  │  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│  VISIBILITY  [● overridden]           [× clear]  │
│  ┌────────┐ ┌───────────┐ ┌────────┐            │
│  │  None  │ │  Visited  │ │  Full  │            │
│  └────────┘ └───────────┘ └────────┘            │
│  (per-clip — lives on map_overrides.waypoints.mode)
├──────────────────────────────────────────────────┤
│  COLOR  [● Wp 3 override]             [× clear]  │
│  Per-waypoint overrides are solid-color only.    │
│  Switch to Project scope to edit gradients.      │
│                                                  │
│  [■] [■] [▣] [■] [■] [■] [■]                   │
│  [Custom…]                                       │
│  (edits the Waypoint whose clip_id === this clip)│
├──────────────────────────────────────────────────┤
│  SHAPE  [● Wp 3 override]             [× clear]  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │
│  │  ●   │ │  ◎   │ │  ◈   │ │  ◆   │ │  ①   │  │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘  │
│  (also edits the associated Waypoint's shape)    │
├──────────────────────────────────────────────────┤
│  SIZE                                            │
│  (per-clip — lives on map_overrides.waypoints.size.*)
├──────────────────────────────────────────────────┤
│  [× Clear all overrides for this clip's waypoint]│
└──────────────────────────────────────────────────┘
```

The override pill for Color and Shape reads "Wp *N* · override" where
*N* is the associated waypoint's 1-based ordinal — distinguishing
per-Waypoint overrides from per-clip ones, which read "Clip *N* ·
override" (e.g. on the Visibility section).

If the current clip has no associated waypoint, the Color and Shape
sections collapse to a single-line note with an "Open Waypoints panel"
button (see §6c).

---

## 7. Section-level Read-only — Route Color in Clip Scope

Under v8 there are no fully-read-only panels in clip scope. Every
panel is at least partially editable:

- **Route panel**: Visibility (`mode`) and Size are per-clip
  overridable. Color is project-only — the Color section opens
  read-only with a "Switch to Project scope →" affordance (see
  below).
- **Waypoints panel**: Visibility and Size are per-clip overridable.
  Color and Shape edit the *associated Waypoint* (per-Waypoint, not
  per-clip) — see §6.
- **POV panel**: every section is editable in clip scope (color,
  size, pulse). Earlier drafts called POV read-only in clip scope;
  that decision is reversed in v8.

The only read-only section across all three panels in clip scope is
**Route → Color**. It renders as:

```
┌──────────────────────────────────────────────────┐
│  COLOR                              [PROJECT]    │
│  (swatches greyed at opacity 0.42; pointer-events: none)
│  [■] [■] [▣] [■] [■] [■] [■]                   │
│                                                  │
│  Route color is set project-wide.                │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │     Switch to Project scope →            │   │  ← full-width secondary button
│  └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

The "Switch to Project scope" element here is a full-width secondary
button (not a text link) because it is the only actionable thing in
the read-only section — it deserves visual weight. Clicking it calls
`onScopeChange('project')` and keeps the panel open, landing the
user directly on the Route panel in project mode. From "I want to
edit the Route color" to editing it is exactly two clicks: open
panel, click "Switch to Project scope."

The notice text is `typeScale.body` (13.5px), `semantic.fgMuted`. It
teaches the user why, not just what — route is one continuous thing
across the whole project; per-clip route color would force invented
segment boundaries.

Visibility and Size in the Route panel remain fully interactive in
clip scope. There is no panel-level scope banner outside of clip
mode; the persistent banner from §6a is shared across all three
panels and explains the scope context once.

---

## 8. Override Highlight on the Toolbar Button Itself

Under the nested `MapOverrides` model (see `data-model.md` §5),
`overriddenKeys` is `Set<OverridePath>` where `OverridePath` is a
dotted path like `'pov.color'` or `'route.size.full_width'`.
`overrideColor` updates to test `overriddenKeys?.has(path)` for a
single `OverridePath`. Panel-launcher buttons check whether any path
in that decoration's domain is overridden:

```
const decorationOverrideColor = (prefix: 'route' | 'waypoints' | 'pov' | 'camera'): string | undefined =>
  [...(overriddenKeys ?? [])].some(p => p.startsWith(`${prefix}.`))
    ? colors.accent
    : undefined;
```

Each button passes its decoration's prefix:
- **Route** checks `'route.'` (covers `route.mode` and all
  `route.size.*`).
- **Waypoints** checks `'waypoints.'` (covers `waypoints.mode`,
  `waypoints.label_mode`, `waypoints.active_mode`, all
  `waypoints.size.*` — but NOT color or shape, which live on the
  Waypoint entity).
- **POV** checks `'pov.'` (covers `pov.color` and all `pov.size.*`).

### 8a. Waypoints button: per-Waypoint override rollup

Per-Waypoint overrides (`Waypoint.color`, `Waypoint.shape`) are not
in `overriddenKeys`. The Waypoints button additionally checks them
via the per-entity rule from `data-model.md` §5a:

```
// In clip scope: the waypoint associated with the current clip
const associated = waypoints.find(w => w.clip_id === currentClip?.id);
const waypointHasOverride =
  associated?.color !== undefined ||
  associated?.shape !== undefined;

// In project scope: any waypoint has any override
const anyWaypointOverride =
  waypoints.some(w => w.color !== undefined || w.shape !== undefined);

// Button glows if either path-based or per-Waypoint check trips
const waypointsButtonOverride =
  decorationOverrideColor('waypoints') !== undefined ||
  (scope === 'clip' ? waypointHasOverride : anyWaypointOverride);
```

This is a render-time computation, not a stored set — keeps
`overriddenKeys` purely about `MapOverrides` and avoids cross-axis
contamination.

The button's icon receives this color as its `color` prop — same as how the existing `groupLabel` spans receive `overrideColor(field) ?? styles.groupLabel.color` at `MapToolbar.tsx:197`.

When the panel is open, the button receives an "active" visual treatment independent of override state: icon color shifts to `semantic.fg` (full brightness) from the default `#c8c8c8`. A subtle background fill (`semantic.accentTint`) under the button further signals the open state. This is implemented as a `isOpen` prop on the button component, toggled by `openPanel === 'waypoints'` etc.

---

## 9. Panel Open/Close Mechanics

**One panel open at a time.** Opening Panel B while Panel A is open closes A first. State: `openPanel: 'route' | 'waypoints' | 'pov' | null` in `MapToolbar`'s local `useState`. This does not propagate to the parent — panel open/close is pure UI state.

**Click outside to close.** A `useEffect` attaches a `mousedown` listener to `document` when a panel is open; if the click target is neither the panel nor the trigger button, set `openPanel(null)`. This is the standard pattern; the existing `Dropdown` in `src/components/shared/Dropdown.tsx` does not implement it (it relies on parent state), but the decoration panels need it since they are always mounted beneath a button that is always in the DOM.

**Escape to close.** A `keydown` listener on `document` for `Escape` closes the open panel and returns focus to the trigger button. `useRef` on the trigger button enables `triggerRef.current?.focus()`.

**Toggle.** Clicking the trigger button again while the panel is open closes it (`setOpenPanel(null)`). This is the standard icon-button-toggle pattern.

---

## 10. Implementation Map — Changes to MapToolbar.tsx

No code is specified here (this is a design document), but the structural changes are precise:

**New local state:** `const [openPanel, setOpenPanel] = useState<'route' | 'waypoints' | 'pov' | null>(null)`

**New component: `DecorationButton`**
- Props: `id`, `icon`, `label`, `isOpen`, `overrideColor`, `onClick`
- Renders a 28×28px icon button with an optional override-dot badge (4px chartreuse circle, positioned `top-right` on the icon) and an `isOpen` active background
- The `label` is a tooltip via `title` attribute; it is not rendered inline (saving bar width)
- Lives in `MapToolbar.tsx` as a local component alongside `ItemWrapper` and `ScopeToggle`

**New component: `DecorationPanel`**
- Props: `decoration: 'route' | 'waypoints' | 'pov'`, `settings`, `onChange`, `scope`, `overriddenKeys`, `onScopeChange`, `onClose`
- Renders the floating panel with the appropriate sections
- Positioned via a wrapper div that is a `position: relative` container — the panel itself is `position: absolute; top: 100%; left: 0; width: 280px; z-index: 200`
- Should live in its own file: `src/components/MapToolbar/DecorationPanel.tsx`

**Modified items array:**
- `route` item: node becomes `<DecorationButton id="route" ... />` wrapping `<DecorationPanel decoration="route" ... />` (rendered conditionally when `openPanel === 'route'`)
- `waypoints` item: same pattern
- New `pov` item inserted after `waypoints`, same pattern
- No other items change

**`overrideColor` usage on buttons:** each `DecorationButton` receives the result of `decorationOverrideColor(id)` where `id` is the prefix (`'route'`, `'waypoints'`, etc.). No `decorationFields` constant is needed — the `startsWith` check is the source of truth.

The overflow measurement loop (`recompute`, the mirror) requires no changes — `DecorationButton` nodes are ~32px wide, well below the current `ModePicker` nodes they replace. The mirror measures them correctly because the panel is conditionally rendered inside the button wrapper only when open, and when closed (in the mirror) the button is the same ~32px it is in the bar.

---

## 11. Summary Recommendation

**Panel shape:** floating anchored popover, 280px wide, opens below the trigger button, at most one open at a time. Consistent with the existing `Dropdown` pattern. Map remains live and reactive during panel interaction.

**Toolbar footprint:** net approximately −108px by converting Route and Waypoints from inline `ModePicker` nodes to panel-launcher buttons and adding POV as a similarly-sized button. Overflow wrapping becomes less common, not more.

**Scope signal:** a persistent inline banner in every panel when `scope === 'clip'`, using the orange warm-family color already established by `barTintClip` and `scopeTabClip`. One-click "switch to proj" action in the banner.

**Gradient in clip scope:** hidden, not greyed. Replaced by a two-sentence caption. The banner provides the action to reach gradient editing.

**Override clearing:** per-section `× clear` is the primary affordance — visible only when that section has overrides, scoped to that section's keys, co-located with the thing being cleared. Per-panel `× Clear all` is secondary. Both are text buttons, low visual weight, conditionally rendered.

**Read-only sections (Route Color in clip scope only):** the section renders greyed with a full-width "Switch to Project scope" button. POV and Waypoints panels are fully editable in clip scope (POV per-clip, Waypoints color/shape per-Waypoint with `clip_id` lookup).

**Override highlight on buttons:** `decorationOverrideColor(prefix)` helper extends the existing `overrideColor` pattern to a path-prefix check against `Set<OverridePath>`. Decoration buttons glow chartreuse when any path in their domain (e.g. `'pov.*'`) is overridden. The Waypoints button additionally checks per-Waypoint overrides on the associated waypoint (in clip scope) or any waypoint (in project scope) — see §8a.

---

Key files referenced:
- `/Users/personal/Documents/trail-cut/src/components/MapToolbar/MapToolbar.tsx` — items array, `overrideColor`, `ScopeToggle`, overflow system
- `/Users/personal/Documents/trail-cut/src/components/MapToolbar/styles.ts` — `barTintClip`, `scopeTabClip`, `overflowRow`, `segmentedBtnActive`
- `/Users/personal/Documents/trail-cut/src/components/shared/Dropdown.tsx` — existing panel shell pattern
- `/Users/personal/Documents/trail-cut/src/types.ts:79–141` — `MapSettings` fields, `MapOverrides`, `resolveMapSettings`
- `/Users/personal/Documents/trail-cut/src/components/MapView.tsx:373–388` — `resolveStaticPaints` effect (confirms live map feedback during panel editing)
- `/Users/personal/Documents/trail-cut/src/theme/tokens.ts` — `semantic.warmTint`, `semantic.accentWarm`, `semantic.accent`, `typeScale`
- `/Users/personal/Documents/trail-cut/docs/map-decorations/DESIGN.md` — locked decisions this document resolves
