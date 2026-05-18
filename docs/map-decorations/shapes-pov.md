# Waypoints Shape Gallery + POV Pulse Styles

Design spec for Open Q #3 (shape gallery) and Open Q #5 (pulse styles) from `DESIGN.md`.

---

## Part 1 — Waypoints Shape Gallery

### Current implementation baseline

The waypoint layer is a single MapLibre **circle layer** (`waypoints-circle`) backed by a GeoJSON FeatureCollection. Per-frame, `buildPerFramePaints` in `/Users/personal/Documents/trail-cut/src/lib/mapVisuals/paints.ts` pushes three data-driven `case` expressions via `setPaintProperty`: `circle-radius`, `circle-color`, and `circle-stroke-color`. The active clip gets a larger radius (`mapSettings.waypoints.size.active_radius`) and a blue tint (`#4a9eff`); all other clips get the default accent color (`#bced09`). A second symbol layer (`waypoints-label`) sits on top with `text-field: ['+', ['get', 'index'], 1]` — 1-based ordinals rendered via Noto Sans Bold in white.

The label is always on, centered over the circle. There is no concept of a "shape" today — the only variation is circle vs nothing.

---

### The six shapes

#### Circle (default)

```
    ●
  (   )
    ●
```

Filled disc with white stroke ring. Exactly what's implemented today. No change to the rendering path.

MapLibre layer: single `circle` layer. `circle-color` = waypoint color. `circle-stroke-width` = `mapSettings.waypoints.size.stroke_width × 1080`. Color application is total — the entire fill is the solid or gradient-mapped color, the stroke is always white. Gradient works naturally because each waypoint feature is a distinct point that gets its own color value at construction time.

Label placement: centered on circle. Text is white, readable against any fill. Numbers always shown when the label layer is visible.

---

#### Pin

```
    ▲
   /|\
  / | \
 /__|__\
    |
    ·
```

Classic teardrop with a pointed bottom. The "head" of the pin sits above the coordinate, the needle tip is at the coordinate. This is the mental model most users associate with "place on map."

MapLibre layer: **symbol layer** with a custom `icon-image` injected as an SVG sprite. Circle layers cannot produce teardrops. The sprite is generated at startup by calling `map.addImage('waypoint-pin', ...)` with an HTMLCanvasElement or an ImageData buffer drawn via the Canvas 2D API. One image per color is impractical; instead, use a **template image** with a single alpha-channel mask and recolor it at the feature level using MapLibre's `icon-color` paint property, which requires the image to be declared as `sdf: true` (signed-distance-field). SDF icons support per-feature colorization via `icon-color` data-driven expressions.

The pin head is the colored region; the needle is also colored but narrower. White stroke around the perimeter of the head is achieved with `icon-halo-color: white` and `icon-halo-width`.

Color application: the `icon-color` expression replaces the per-frame `circle-color` case expression. Same data-driven pattern: `['case', ['==', ['get', 'id'], activeClipId], ACTIVE_COLOR, projectColor]`. Gradient is resolved at FeatureCollection build time — each feature's color is pre-computed and stored as a `color` property, and the `icon-color` expression reads `['get', 'color']` with the active-state case wrapping it.

Active treatment: the active pin gets the standard blue tint. Additionally, `icon-size` can pulse slightly (1.0 → 1.15) to emphasize it, mirroring the radius bump the circle shape gets.

Label: for pins, the number goes **inside the pin head**, not below the shape. The pin head is large enough to contain a single or double digit at `mapSettings.waypoints.size.label_size`. This replaces the separate `waypoints-label` symbol layer for pin mode — the number is baked into the sprite template as a text draw call. An alternative is to keep the symbol label layer with `text-offset` adjusted upward to sit inside the head region; this is simpler to implement but harder to align precisely across zoom levels. The sprite-baked approach is higher quality but requires re-rasterizing the sprite when label size changes. Recommendation: keep the symbol label layer and offset it into the head with `text-offset: [0, -0.6]` (empirically tuned) — no sprite changes needed when the user adjusts label size.

---

#### Ring

```
    ○
  (   )
    ○
```

Hollow circle — stroke only, no fill. Lighter visual weight than the filled circle. Good for "I was here but don't want to crowd the map."

MapLibre layer: `circle` layer with `circle-color: rgba(0,0,0,0)` (transparent fill) and `circle-stroke-color` = waypoint color. `circle-stroke-width` carries the full visual weight, so it should be thicker than the default stroke — roughly 2–3× `mapSettings.waypoints.size.stroke_width`.

Color application: the color goes entirely on the stroke, not the fill. For gradient mapping, the stroke color is data-driven by distance just as the fill color would be for circle/pin. The per-frame case expression moves to `circle-stroke-color` instead of `circle-color`. Active state: stroke color switches to blue, and stroke width bumps to the active size. No radius bump needed — size is already expressed through stroke weight.

Label: centered in the hollow. White text inside a transparent ring has low contrast against light map tiles. Add a `text-halo-color: rgba(0,0,0,0.55)` / `text-halo-width: 1.5` to the label layer to ensure legibility. This is a per-shape label layer paint override.

---

#### Square

```
  +-----+
  |     |
  |     |
  +-----+
```

Axis-aligned filled square. Adds angular contrast to a map that otherwise has only circular waypoints and curved route lines. Slightly more editorial/structured feeling.

MapLibre layer: MapLibre's circle layer cannot render squares. Options: (a) SDF sprite — same approach as pin, simpler shape. (b) `fill` layer with a fixed polygon per point — impractical since fill layers expect a Polygon source, not Point. (c) Use a symbol layer with a built-in MapLibre icon. MapLibre ships no built-in square icon.

Recommended: **SDF sprite**. A square SDF is trivially generated in a Canvas: fill a rect, leave a border of transparent pixels as padding, call `map.addImage('waypoint-square', data, { sdf: true })`. `icon-color` and `icon-halo-color` then work exactly as described for pin. `icon-rotate` can be controlled via `icon-rotation-alignment: 'map'` if rotation-locked behavior is desired, but for squares "map-aligned" is natural.

Color application: identical to pin — `icon-color` carries the fill, `icon-halo-color` carries the white perimeter stroke.

Active treatment: `icon-size` bump (same as pin). Color switch to blue.

Label: centered. Visually cleaner than circle because the flat sides frame the number. Works at all digit counts.

---

#### Diamond

```
     *
    / \
   /   \
   \   /
    \ /
     *
```

Square rotated 45 degrees. The visual sharpness of the points makes it distinctive at small sizes. Common in cartographic convention for survey markers and summits.

MapLibre layer: SDF sprite, identical mechanism to square. Two options: (a) generate a rotated-rect SDF, or (b) take the square SDF and apply `icon-rotate: 45` in the layer's layout. Option (b) is trivially free — reuse the square sprite and add `'icon-rotate': 45` to the layout spec. Because the sprite is square-shaped, a 45-degree rotation fits perfectly inside the same bounding box.

Color application: identical to square.

Label: number sits in the center of the diamond. At small sizes the number clips against the narrow horizontal extent of the diamond. Recommend reducing the label display size slightly (about 0.85× `mapSettings.waypoints.size.label_size`) for diamond mode, handled by a per-shape label layout override.

---

#### Numbered-circle

```
    ●
  ( 7 )
    ●
```

The circle shape with the number made more prominent — the number is the point. Visually identical to the current default, but the label is styled as a larger, bolder, more centered presence. The circle is deliberately slightly larger than the base circle to give the number breathing room.

This is not a new rendering approach; it's a configuration preset that locks `circle` shape, bumps `mapSettings.waypoints.size.label_size` to a larger fraction (e.g. 0.018 instead of 0.014), and hides the stroke to let the colored disc read as a badge. The shape gallery swatch shows this distinction clearly.

The interaction between this variant and `mapSettings.waypoints.size.label_size` is straightforward: unlike the other shapes, numbered-circle uses the label as its primary visual identity. The label size slider in the Size section should default to a larger value when this shape is selected, but the user can still override it freely. No other shape should suppress the label — all shapes show the ordinal number unless the user sets label size to zero.

---

### Do non-numbered shapes show labels?

Yes, all shapes show labels by default. The label (1-based index) is always there — the distinction of "numbered-circle" is purely that the number is more visually dominant. This matches the current implementation where `waypoints-label` is always rendered on top of `waypoints-circle`. The user can reduce `mapSettings.waypoints.size.label_size` to zero to suppress labels across all shapes.

---

### Color and gradient across shapes

The gradient-mapping mechanic from `DESIGN.md` is the same regardless
of shape: at `buildStaticSourceData` time, each feature in the
FeatureCollection gets a `progress` property (Mercator fraction) and
optional `override_color` / `override_shape` properties baked in. The
per-frame case expression then composes `override_color` (per-waypoint),
active-highlight, and the gradient interpolate arm — see `rendering.md`
§3.

For circle and ring, this color flows into `circle-color` /
`circle-stroke-color` — MapLibre evaluates the expression per feature.
For pin, square, and diamond (SDF sprites), the same color flows into
`icon-color` — also per-feature, same expression pattern. The
per-feature effective shape (`wp.shape ?? mapSettings.waypoints.shape`)
routes each waypoint to the right layer via the opacity expressions
in `rendering.md` §4.

The gradient computation is entirely in the FeatureCollection
builder; the layer rendering path doesn't need to know it's a
gradient. Per-waypoint color overrides skip the gradient lookup
entirely and use the entity's literal `color` value.

---

### Shape gallery UI

Layout: a **2×3 grid** of shape swatches, 6 cells total, inside the Waypoints panel's Shape section. Each swatch is a small rendered preview of the shape in the current project color, approximately 36×36 px. The selected shape has a highlighted border (accent/chartreuse outline). Hovering shows the shape name as a tooltip below the cell.

```
  ┌─────────────────────────────────┐
  │  SHAPE                          │
  │  ┌───────┐ ┌───────┐ ┌───────┐  │
  │  │   ●   │ │   ▲   │ │   ○   │  │
  │  │circle │ │  pin  │ │ ring  │  │
  │  └───────┘ └───────┘ └───────┘  │
  │  ┌───────┐ ┌───────┐ ┌───────┐  │
  │  │  ■    │ │   ◆   │ │  ⑦   │  │
  │  │square │ │diamond│ │ num.  │  │
  │  └───────┘ └───────┘ └───────┘  │
  └─────────────────────────────────┘
```

The swatches are small live-rendered MapLibre canvas snapshots — impractical. Instead, they are SVG thumbnails drawn inline in the panel component. Each SVG uses the resolved current project color (or, in clip scope, the *associated waypoint*'s override color if set — looked up via `clip_id`). When the user changes the waypoint color, the swatches re-render immediately because they read from `mapSettings` and the associated `Waypoint`.

Grid vs row: 2×3 grid is better than a 6-item row. A single row at reasonable swatch size would be ~280 px wide, which is tight against the panel's content column. The 2×3 grid fits in ~200 px and groups shapes naturally (circle/pin/ring are the "rounded" row, square/diamond/numbered are the "geometric" row — not a strictly enforced taxonomy, but visually coherent).

---

### Active / selected waypoint treatment

Today `mapSettings.waypoints.size.active_radius` bumps the radius of the active clip's circle. With multiple shapes, a single radius-bump mechanism does not generalize — a ring has no fill to expand meaningfully, a pin is sized by its sprite.

Recommendation: **always apply a separate ring halo around the active waypoint regardless of base shape**, and let the base shape's own active treatment be minimal.

The halo is an additional circle layer (`waypoints-active-halo`) sitting below the main waypoints layer. It has `circle-color: transparent`, `circle-stroke-color: white` (or accent), and `circle-radius` driven by a data-driven expression that is 0 for non-active features and `mapSettings.waypoints.size.active_radius × 1080` for the active feature. Because its radius is 0 for non-active features, it is invisible for them — no separate source or layer-toggle needed.

```
        white ring
       ╭──────────╮
      ╱            ╲
     │    ●  or ▲   │   ← base shape in its normal style
      ╲            ╱
       ╰──────────╯
```

This works uniformly across all shapes: circles, rings, pins (the halo sits behind the sprite), squares, and diamonds all get the same visual treatment. The user does not need a per-shape "active style" configuration — the halo is always the active signal.

The existing `mapSettings.waypoints.size.active_radius` field is repurposed as the halo's outer radius. The per-frame `case` expression that currently sets `circle-radius` on the base circle layer moves to the new halo layer instead, and the base circle layer gets a fixed radius (no per-frame bump). This simplifies `buildPerFramePaints`.

---

## Part 2 — POV Pulse Styles

### Current implementation baseline

The POV (live marker) is two stacked circle layers, both sourced from `live-marker`:

- `live-marker-dot` — inner solid dot. `circle-color: white`, `circle-stroke-color: accent`, static size from `mapSettings.pov.size.dot_radius` and `mapSettings.pov.size.dot_stroke_width`. Never touched per-frame except via `resolveStaticPaints`.

- `live-marker-pulse` — outer ring. `circle-color: accent`, `circle-opacity: 0.55`, per-frame `circle-radius` and `circle-opacity` driven by `pulseAt(projectTimeMs, mapSettings)` in `/Users/personal/Documents/trail-cut/src/lib/mapVisuals/animations.ts`.

`pulseAt` is a pure function of project-time. It uses a 1600ms period with cubic ease-out: radius grows from `mapSettings.pov.size.pulse_start_radius × 1080` to `mapSettings.pov.size.pulse_end_radius × 1080` while opacity fades from 0.55 → 0. This is exactly the **Sonar** style described below — a radiating ring.

The entire pulse is driven by project-time, not wall-clock time, so pausing the video freezes the pulse mid-cycle. The export renderer samples the same function, so export frames are pixel-identical to preview frames at the same project-time.

The design doc (DESIGN.md) confirms POV color is **solid only**. The two layers use `colors.accent` (chartreuse) as their color today — hardcoded in `styleSpec.ts` as `TRAIL_COLOR` and directly on the layer specs. Adding a user-configurable POV color means routing `mapSettings.pov.color` through `resolveStaticPaints` and replacing the hardcoded color in `LIVE_MARKER_PULSE_LAYER` and `LIVE_MARKER_DOT_LAYER` with `setPaintProperty` calls. The color is not gradient-linked to Route or Waypoints — it should contrast them to anchor the viewer's eye. See DESIGN.md: "POV is a UI element, not a decoration; should contrast the palette."

---

### Four pulse style options

#### 1. Steady — no pulse

```
    ●     t=0
    ●     t=500
    ●     t=1600
```

Just the solid dot. The outer ring layer is hidden (`circle-opacity: 0`). No per-frame radius/opacity updates needed — the layer can be set to `visibility: none` and skipped in the per-frame loop. The dot is always full opacity.

Parameters exposed: none. Steady has no animation to tune.

When to use: keeps the map clean for a static export frame, or when the user wants a minimal cinematic look without any UI-like animation.

---

#### 2. Throb — opacity oscillation in place

```
    ◉     t=0       full opacity
    ◎     t=400     partial opacity
    ·     t=800     near-transparent
    ◎     t=1200    partial opacity
    ◉     t=1600    full opacity
```

The dot itself pulses in opacity. The outer ring layer stays hidden. The dot's `circle-opacity` oscillates between a minimum (e.g. 0.35) and 1.0 via a sine wave (not ease-out — a sine gives a symmetric throb that feels organic). The radius does not change.

Parameters exposed: **Rate** (slow 2.4s / medium 1.6s / fast 0.8s period). Intensity (min opacity) is optional — default min of 0.35 gives a clear throb without disappearing entirely.

Implementation: `pulseAt` is extended with a style discriminator, or a new `throbAt(t, settings)` pure function is added alongside it. `throbAt` returns a single `dotOpacity: number`. The per-frame loop checks `mapSettings.pov.pulse_style` and calls the appropriate function.

---

#### 3. Sonar — radiating ring (current default)

```
    ●○      t=0       ring at start radius
    ● ○     t=400     ring partway out, fading
    ●   ·   t=800     ring nearly at end radius, nearly invisible
    ●       t=1600    ring resets, new cycle
```

This is exactly what `pulseAt` implements today — cubic ease-out growth on the ring, simultaneous opacity fade from 0.55 → 0. The dot stays solid and static; only the ring animates.

Parameters exposed: **Rate** (period in ms — slow/medium/fast preset, or a continuous slider). The start/end radius range is already configurable via `mapSettings.pov.size.pulse_start_radius` / `mapSettings.pov.size.pulse_end_radius` — these become the Size section's controls for sonar mode.

The existing `pulseAt` function handles this entirely. No new animation code needed. The "Rate" control maps to `PULSE_PERIOD_MS` becoming a per-settings field rather than a module-level constant.

---

#### 4. Heartbeat — double pulse

```
    ●○      t=0       first ring starts
    ● ○     t=200     first ring partway out
    ●○·     t=350     second ring starts (offset by ~350ms)
    ●  ○·   t=500     both rings out, first fading faster
    ●    ·  t=800     both rings near end, fading out
    ●       t=1200    both gone, pause before reset
    ●       t=1600    cycle restarts
```

Two rings fire in quick succession — a double beat — then pause before repeating. The "pair of ripples" reads as a heartbeat or sonar ping. This adds visual interest for outdoor adventure content where the live-location pulse is part of the story.

Parameters exposed: **Rate** (the full cycle period, slow/medium/fast). The inter-beat gap (the offset between the two rings) is fixed at ~30–40% of the period — not user-configurable. Two parameters exposed to the user for a double-pulse is already one too many.

Implementation: `heartbeatAt(t, settings)` pure function. Returns two `{ radius, opacity }` pairs. The per-frame loop calls `setPaintProperty` on two separate ring layers — `live-marker-pulse-a` and `live-marker-pulse-b`. Both layers exist in `styleSpec.ts` and are seeded at style.load; they're just hidden in non-heartbeat modes.

This is the recommended 4th option over alternatives like "twin pulse" (two rings that fire simultaneously — visually dull, same as a single ring with more opacity) or "morse" (irregular timing — too clever, hard to control).

---

### Parameter recommendations

Minimum viable parameter set per style:

| Style | Exposed parameter | Notes |
|---|---|---|
| Steady | none | — |
| Throb | Rate (3 presets: slow/medium/fast) | Intensity at a fixed default |
| Sonar | Rate (3 presets) | Ring range comes from the Size section |
| Heartbeat | Rate (3 presets) | Gap ratio is fixed |

Rate as 3 presets (slow ~2.4s / medium 1.6s / fast 0.8s) rather than a free slider. A free slider for timing is surprisingly hard to use — users don't think in milliseconds, and the difference between 1400ms and 1600ms is imperceptible. Three labeled options covering "meditative," "standard hiking," and "vigorous/running" tempos is immediately meaningful.

Do not expose: intensity of the sonar ring's starting opacity (currently 0.55 — users never ask to change this), minimum throb opacity (0.35 is universally correct), or the inter-beat gap in heartbeat.

---

### Pulse color

The pulse color (ring and dot) matches the base POV color. There is no separate "pulse ring color." The dot is always white with the POV color as its stroke; the ring is always the POV color at partial opacity. This matches the current hardcoded `colors.accent` behavior — the color is a single source of truth.

The rationale: splitting the ring color from the dot color creates a four-field system (dot fill, dot stroke, ring color, ring opacity) where two fields track each other most of the time. The constraint that ring color = POV color is the right default because the ring reads as an emanation from the dot, not a separate decoration. If a user wants the ring in a different color they are doing something unusual enough that it belongs in a future "advanced" panel expansion.

Confirmed: pulse color is **configured once** in the POV panel's Color section. Both the dot stroke and the ring take that color. The dot's white fill is fixed.

---

### Previewing pulse in the panel

The pulse must animate to be intelligible. A static swatch showing a frozen ring tells the user nothing about whether it throbs, sonar-pulses, or double-beats.

Recommendation: a **live mini-preview** rendered as a small HTML `<canvas>` element (approximately 56×56 px) inside the style-picker dropdown. The canvas runs its own `requestAnimationFrame` loop driven by `wall-clock time` (not project-time — this is a UI preview, not an export-accurate preview). The same `pulseAt` / `throbAt` / `heartbeatAt` pure functions are called with `Date.now()` as input.

```
  ┌──────────────────────────────────────────────┐
  │  PULSE STYLE                                 │
  │                                              │
  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐     │
  │  │ [56] │  │ [56] │  │ [56] │  │ [56] │     │
  │  │      │  │      │  │      │  │      │     │
  │  │steady│  │throb │  │sonar │  │hbeat │     │
  │  └──────┘  └──────┘  └──────┘  └──────┘     │
  │                                              │
  │  RATE     [slow] [medium] [fast]             │
  └──────────────────────────────────────────────┘
```

Each cell is a small `<canvas>` that runs independently. The selected style has an accent border. Hovering is not needed — the labels below each cell are sufficient.

Why a canvas per cell rather than one canvas showing the selected style only: the user needs to compare styles before selecting. A single preview that changes on hover is too transient. Four small animated canvases in a row give an immediate side-by-side comparison. The canvases are small enough (56 px, ~4 layers each) that four running simultaneously is a negligible CPU load inside an already-open panel.

The wall-clock-driven preview loop runs only while the panel is open. When the panel closes, `cancelAnimationFrame` is called. This is a standard pattern for panels with live previews — no global state, no memory leak.

The mini-canvas for heartbeat must render two rings simultaneously so the double-beat character is visible even in a 56 px square. At that size the ring travel distance is only about 20 CSS px, which is enough to read the pattern clearly.

---

### Data model additions

Per `data-model.md` (canonical), `MapSettings` is nested by
decoration. Fields land inside the relevant block:

```
mapSettings.pov.color:       string                         // hex; default colors.accent
mapSettings.pov.pulse_style: 'steady' | 'throb' | 'sonar' | 'heartbeat'   // see scope note
mapSettings.pov.pulse_rate:  'slow' | 'medium' | 'fast'                   // see scope note

mapSettings.waypoints.shape: 'circle' | 'pin' | 'ring' | 'square' | 'diamond' | 'numbered-circle'
```

**Per-waypoint shape override.** `Waypoint.shape?: WaypointShape` on
the `Waypoint` entity overrides the project default for that
waypoint. This is per-Waypoint (Convention B in `data-model.md` §10),
not per-clip — it works uniformly for clip-sourced, GPX, and manual
waypoints. The clip-scope UI for "edit this clip's waypoint shape"
looks up the waypoint via `clip_id` and edits its `shape` field
directly. Mixed-shape scenes (one diamond among four circles) are
fully supported; see `rendering.md` §4 for the per-feature opacity
expressions that route each waypoint to the appropriate layer.

**Per-clip POV overrides.** `MapOverrides.pov` carries the full POV
override packet — `color`, all `size` fields, and (if shipped — see
scope note) `pulse_style` / `pulse_rate`. A clip on satellite tiles
can carry a chunkier white POV dot; the next clip on default tiles
inherits the project default. This replaces the earlier
"POV is project-only" design.

> **Scope note:** the four-style pulse roster (incl. heartbeat) and
> the `pulse_rate` enum are this document's proposal. `DESIGN.md`
> lists "steady/throb/sonar — TBD" as the canonical set; expanding
> to four styles is recommended pending sign-off. If only three ship,
> drop the `'heartbeat'` arm from the union and skip the
> `live-marker-pulse-b` layer work. If pulse styles are deferred
> entirely from the initial map-decorations PR, leave `pov.pulse_style`
> and `pov.pulse_rate` off `MapSettings` for now; `pulseAt` continues
> to behave as it does today (sonar-equivalent).

The pulse period constants previously hardcoded as `PULSE_PERIOD_MS = 1600` in `animations.ts` become a lookup:

```
const RATE_MS = { slow: 2400, medium: 1600, fast: 800 }
```

`pulseAt` is extended to accept the resolved period from `MapSettings` rather than the module constant. The existing test suite must update its `PULSE_PERIOD_MS` import to use the `medium` rate value (1600ms) to maintain backward compatibility.

---

### Rendering path for new shapes (implementation note for the build phase)

The shape field gates which layers are used and which per-frame functions are called. The architecture is:

- **circle / ring / numbered-circle**: existing `waypoints-circle` + `waypoints-label` layers. No new layer additions. Paint expressions change: ring uses `circle-color: transparent`, `circle-stroke-color: color expression`.

- **pin / square / diamond**: new `waypoints-symbol` symbol layer added at style.load alongside the existing circle layer. The circle layer is hidden (`visibility: none`) when a symbol shape is active. The symbol layer uses SDF sprites added via `map.addImage`. The `waypoints-label` layer remains but its `text-offset` is adjusted per shape.

- **waypoints-active-halo**: new circle layer added unconditionally at style.load. Data-driven `circle-radius` is 0 for non-active features, `mapSettings.waypoints.size.active_radius × 1080` for the active feature. This replaces the current per-frame radius bump on the base circle layer.

- **live-marker-pulse-b**: a second pulse-ring layer used only by the `heartbeat` style. Added unconditionally at `style.load` and shares the `live-marker` source; visibility is toggled via `setLayoutProperty` based on `mapSettings.pov.pulse_style === 'heartbeat'`. (Earlier drafts of this doc described two contradictory approaches — "added only when heartbeat" vs "always seeded, visibility-toggled." The visibility-toggled approach is correct: it avoids style-load timing issues when the user switches styles mid-session.)

The style.load handler in `MapView.tsx` (lines 195–246) is where new layers are added. The `resolveStaticPaints` function in `styleSpec.ts` must grow entries for the new layers. `buildPerFramePaints` in `paints.ts` routes to the correct animation function based on `mapSettings.pov.pulse_style`.

---

*Document covers Open Q #3 and #5 from `DESIGN.md`. Remaining open questions (#1, #2, #4, #6, #7) are out of scope for this slice.*
