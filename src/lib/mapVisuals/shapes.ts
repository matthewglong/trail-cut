// Unified shape-descriptor module for the waypoints + POV decoration layers.
//
// Each shape declares its own rasterizers for a PRIMARY slot (the body of the
// shape, tinted by the primary color) and an optional SECONDARY slot (the
// outline / accent element, tinted by the secondary color). Both slots are
// SDF (Signed Distance Field) icons — bitmaps where the alpha channel
// encodes signed distance from the shape boundary, and MapLibre applies a
// per-icon `icon-color` tint at draw time. The whole reason for SDF is that
// tint: it's what lets a single rasterized white shape paint as any color
// the user picks, and what lets the same atlas serve every gradient sample
// / per-feature override.
//
// SDF encoding convention (matches MapLibre's `symbol_sdf.fragment.glsl`):
//
//   alpha = clamp(round(255 * (0.75 + signed_dist_inside_px / SDF_PX)), 0, 255)
//
// where `signed_dist_inside_px` is positive INSIDE the shape, negative OUTSIDE,
// in canvas pixels, and `SDF_PX = 8` is the distance-encoding extent on
// either side of the boundary. With this convention:
//
//   alpha = 191 at the boundary (signed_dist = 0) — matches the shader's
//     `inner_edge = (256-64)/256 = 0.75`.
//   alpha = 255 at 2 px inside (and beyond).
//   alpha =   0 at 6 px outside (and beyond).
//
// MapLibre's shader then runs `smoothstep(0.75 - gamma, 0.75 + gamma, alpha)`
// at draw time, where `gamma` shrinks with icon-size. A true SDF produces
// crisp anti-aliased edges at ANY icon-size because smoothstep gets a
// well-behaved linear gradient through the boundary value 0.75. A coverage-
// encoded alpha (255 inside, 0 outside, a 1-px ramp at the boundary) gets
// the wrong slope through 0.75 and the smoothstep produces visible faceting
// at small icon-size — that was the source of the previous "grainy circle"
// problem.
//
// Why hand-rasterized and not OffscreenCanvas / node-canvas:
//
//  - The preview path COULD use OffscreenCanvas, but then the export
//    renderer would need a parallel implementation (no DOM canvas in Node).
//    `node-canvas` is not a project dependency — adding it for a handful
//    of geometric primitives is a poor cost/benefit tradeoff (~80 MB
//    native build, system deps like cairo/pango/giflib).
//
//  - Hand-rasterized shapes give pure, deterministic pixel data — no
//    Canvas-renderer differences (text anti-aliasing, sub-pixel fill
//    rules) to chase down. Preview and export each rasterize at their own
//    pixelRatio (window.devicePixelRatio vs payload.pixelRatio); when both
//    sides pass the same pixelRatio to `addImage`'s options, MapLibre
//    normalizes the two textures to the same CSS-px natural size, so the
//    rendered appearance matches even though the texel counts differ.
//
//  - The shapes are simple geometric primitives with analytical signed
//    distance functions (circle: r - dist; square: half - L∞; diamond:
//    (half - L1) / √2; ring band: half_stroke - |r - mid_radius|).

import type { WaypointShape } from '../../types';

/** Canonical SDF canvas size, in CSS-pixel-equivalent units (the icon's
 *  *natural display size* — what MapLibre renders at when `icon-size = 1`
 *  on a 1:1 framebuffer). The actual texture is `WAYPOINT_ICON_SIZE *
 *  pixelRatio` texels on each side. 128 leaves headroom for the pin's
 *  tall silhouette (tip near the bottom, head at the top) without
 *  clipping the outside SDF fringe. */
export const WAYPOINT_ICON_SIZE = 128;

/** SDF distance-encoding extent, in TEXTURE pixels on either side of the
 *  boundary. Matches MapLibre's `symbol_sdf.fragment.glsl` `#define SDF_PX
 *  8.0` — alpha 0 at +6 texels outside, alpha 191 at the boundary, alpha
 *  255 at -2 texels inside.
 *
 *  Note this is texels, NOT CSS pixels. At pixelRatio=2 the ramp covers
 *  4 CSS px on each side of the boundary but with 8 texels of alpha
 *  precision — twice the gradient resolution per CSS pixel, which is
 *  what makes the higher pixelRatio actually produce a crisper edge
 *  through MapLibre's smoothstep AA. */
const SDF_PX = 8;

/** Canonical primary-shape radius in CSS-pixel-equivalent units. Every
 *  primary rasterizer draws into an envelope sized off this constant
 *  (circle r = SHAPE_CANONICAL_RADIUS, ring outer = SHAPE_CANONICAL_RADIUS,
 *  square halfSide and diamond halfDiag scaled proportionally), then the
 *  rasterizer scales the result by `pixelRatio` at write time.
 *
 *  `icon-size = (target_radius_css / SHAPE_CANONICAL_RADIUS)` at draw time —
 *  the bridge between the user-facing `waypoints.size.circle_radius ×
 *  PAINT_REFERENCE_WIDTH` value (CSS px) and MapLibre's `icon-size`
 *  multiplier. Invariant under pixelRatio: a higher-pixelRatio atlas has a
 *  larger texture but the same CSS-px natural size, so the same icon-size
 *  multiplier produces the same display size. Imported by `styleSpec.ts`
 *  and `paints.ts`. */
export const SHAPE_CANONICAL_RADIUS = 48;

// Per-shape canonical dimensions (CSS-px-equivalent units), all derived
// from SHAPE_CANONICAL_RADIUS so the relative sizing across shapes (square
// slightly smaller than circle, diamond slightly larger to compensate for
// its diagonal silhouette) stays pinned no matter what canvas pixelRatio
// the module is set to. The rasterizer multiplies these by pixelRatio at
// write time.
const RING_STROKE = SHAPE_CANONICAL_RADIUS * (4 / 18); // ~10.67
const SQUARE_HALF_SIDE = SHAPE_CANONICAL_RADIUS * (16 / 18); // ~42.67
const DIAMOND_HALF_DIAG = SHAPE_CANONICAL_RADIUS * (22 / 18); // ~58.67

/** Default outline thickness (canvas px) used when `buildAllShapeIcons` is
 *  called without an override. Picked so the default-settings outline lands
 *  at a sensible appearance for the centered shapes (circle / square /
 *  diamond) when no explicit thickness is supplied. Real production paths
 *  (MapView's preview re-register and the export renderer's page-side build)
 *  compute thickness from the user setting via `outlineThicknessCanvasPx`
 *  and pass it in explicitly. */
export const DEFAULT_OUTLINE_THICKNESS = (SHAPE_CANONICAL_RADIUS * 2.5) / 18; // ~6.67

/** Canvas-space outline thickness (in SDF/texel-canonical px) for the
 *  user-facing `stroke_width` and `circle_radius` settings. Shared by the
 *  preview (`MapView`) and the export renderer (page-side in `init.ts`) so
 *  both bake the same outline band into the SDF atlas — preview/export parity
 *  by construction. Derivation:
 *
 *    rendered_outline_css_px = stroke_width × PAINT_REFERENCE_WIDTH
 *    icon_size               = (circle_radius × PAINT_REFERENCE_WIDTH)
 *                                 / SHAPE_CANONICAL_RADIUS
 *    canvas_thickness        = rendered_outline_css_px / icon_size
 *                            = (stroke_width / circle_radius)
 *                                 × SHAPE_CANONICAL_RADIUS
 *
 *  The dependency on `circle_radius` is why callers that cache the atlas must
 *  re-rasterize when EITHER setting changes — `icon-size` scales the SDF
 *  wholesale at draw time, so to keep the on-screen outline at the
 *  user-requested fixed CSS width regardless of the dot's radius, the
 *  baked-in canvas thickness has to compensate inversely. */
export function outlineThicknessCanvasPx(
  strokeWidth: number,
  circleRadius: number,
): number {
  if (circleRadius <= 0) return 0;
  return (strokeWidth / circleRadius) * SHAPE_CANONICAL_RADIUS;
}

/** Raw pixel data for one SDF icon. Shape matches `map.addImage()`'s `image`
 *  argument verbatim — pass the returned `{ width, height, data }` triple
 *  directly with `{ sdf: true }`. `data` is RGBA8, row-major, top-down,
 *  width*height*4 bytes. Ink pixels are `(255, 255, 255, alpha)` where
 *  alpha is the SDF-encoded distance value; transparent pixels are all
 *  zeros. */
export interface SdfIcon {
  width: number;
  height: number;
  /** RGBA8, top-down, width*height*4 bytes. */
  data: Uint8Array;
}

/** Pickers this descriptor appears in. Most shapes serve both domains; POV-
 *  specific or waypoint-specific shapes can opt out by listing only the
 *  domain they belong to. */
export type ShapeDomain = 'waypoint' | 'pov';

/** Build-time inputs piped into every shape rasterizer. Keeping this as a
 *  single struct (rather than positional args) means future per-shape knobs
 *  — corner radius, inner-dot ratio, etc. — can land on the struct without
 *  fanning out every descriptor's signature. */
export interface ShapeBuildOptions {
  /** Outline thickness in CSS-pixel-equivalent units (same scale as
   *  `SHAPE_CANONICAL_RADIUS`), applied to every shape that has a secondary
   *  outline slot (circle, pin, square, diamond). One-color shapes (ring)
   *  ignore this. The rasterizer scales this by `pixelRatio` when writing
   *  to the texture. */
  outlineThickness: number;
  /** Texture pixels per CSS pixel for the rasterized SDF atlas. Drives
   *  both the canvas size (`WAYPOINT_ICON_SIZE * pixelRatio` per side) and
   *  the in-canvas geometry scaling. Must be reported to MapLibre via
   *  `addImage(..., { pixelRatio })` so the icon's natural display size
   *  stays at `WAYPOINT_ICON_SIZE × WAYPOINT_ICON_SIZE` CSS pixels — the
   *  `icon-size` formula in `paints.ts` is invariant under pixelRatio.
   *
   *  Pick this to match (or exceed) the framebuffer DPR the icon will be
   *  drawn into: preview uses `window.devicePixelRatio`; export uses
   *  `payload.pixelRatio`. Higher pixelRatio = denser SDF texture = more
   *  alpha precision through the smoothstep AA window = visibly sharper
   *  edges next to the underlying map tiles. */
  pixelRatio: number;
}

/** One entry in the shape catalog. Adding a new shape is "write a primary
 *  rasterizer, optionally write a secondary one, append to SHAPES." */
export interface ShapeDescriptor {
  /** Identity. Must match a `WaypointShape` union member. SDF icon ids are
   *  formed as `waypoint-${name}-primary` / `waypoint-${name}-secondary`. */
  name: WaypointShape;
  /** Rasterizer for the primary slot (tinted by the primary color at draw
   *  time). Required — every shape has at least a primary silhouette. */
  primary: (opts: ShapeBuildOptions) => SdfIcon;
  /** Optional rasterizer for the secondary slot (tinted by the secondary
   *  color). When omitted, the registry substitutes a transparent placeholder
   *  so the secondary symbol layer stays valid; UI is expected to hide the
   *  secondary color picker for shapes that opt out. */
  secondary?: (opts: ShapeBuildOptions) => SdfIcon;
  /** Decoration domains this shape is offered in. */
  domains: readonly ShapeDomain[];
}

/** Transparent placeholder SDF icon. Used as the secondary-slot fill for
 *  shapes that don't declare their own `secondary` rasterizer, so the layer
 *  stack stays uniform: every shape registers BOTH a primary and a secondary
 *  icon, even if the secondary is just empty pixels (encoded as "infinitely
 *  outside" via alpha 0). Size tracks `pixelRatio` so its texel dimensions
 *  match the rest of the atlas; MapLibre's atlas packer is happier with a
 *  consistent footprint per slot. */
function transparentIcon(pixelRatio: number): SdfIcon {
  const size = WAYPOINT_ICON_SIZE * pixelRatio;
  return {
    width: size,
    height: size,
    data: new Uint8Array(size * size * 4),
  };
}

/** Encode a signed-distance value (TEXTURE pixels, positive inside) into
 *  the SDF alpha channel expected by MapLibre's `symbol_sdf.fragment.glsl`:
 *
 *    alpha = round(clamp(255 * (0.75 + d / SDF_PX), 0, 255))
 *
 *  Boundary (d=0) → alpha 191. Two texels inside (d=+2) → alpha 255. Six
 *  texels outside (d=-6) → alpha 0. The shader does a smoothstep around
 *  alpha 0.75, so this linear distance ramp gives crisp AA at any
 *  runtime icon-size. Distance is in *texels* (not CSS px) because that's
 *  what MapLibre's shader expects in its 8.0 constant. */
function sdfAlpha(signedDistInsideTexels: number): number {
  const v = 0.75 + signedDistInsideTexels / SDF_PX;
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return Math.round(v * 255);
}

/** Run a per-pixel SDF function over a bounding box and write the encoded
 *  alpha values into the data buffer. The bbox is in TEXTURE coordinates
 *  and is expected to cover the shape's silhouette plus an SDF_PX-wide
 *  outside fringe (where alpha transitions from 191 down to 0); pixels
 *  outside the bbox stay at the buffer's initial zero (= "infinitely
 *  outside"). The SDF function operates in texel space — callers that
 *  define geometry in CSS-equivalent units must scale by `pixelRatio`
 *  before invoking. */
function rasterizeSdf(
  data: Uint8Array,
  size: number,
  bbox: { xLo: number; xHi: number; yLo: number; yHi: number },
  sdf: (px: number, py: number) => number,
): void {
  const xLo = Math.max(0, Math.floor(bbox.xLo));
  const xHi = Math.min(size - 1, Math.ceil(bbox.xHi));
  const yLo = Math.max(0, Math.floor(bbox.yLo));
  const yHi = Math.min(size - 1, Math.ceil(bbox.yHi));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const a = sdfAlpha(sdf(px, py));
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

/** Build a new RGBA8 buffer sized for the requested `pixelRatio`, run a
 *  draw callback against it, and return the result wrapped in an
 *  `SdfIcon`. The callback receives the texel size of the buffer so its
 *  geometry can scale with pixelRatio (canvas dimensions, shape radius,
 *  outline thickness all multiply by `pixelRatio`). */
function rasterize(
  pixelRatio: number,
  draw: (data: Uint8Array, size: number) => void,
): SdfIcon {
  const size = WAYPOINT_ICON_SIZE * pixelRatio;
  const data = new Uint8Array(size * size * 4);
  draw(data, size);
  return { width: size, height: size, data };
}

function writePixel(
  data: Uint8Array,
  size: number,
  x: number,
  y: number,
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  // Take the max of the existing alpha and the new value. For SDF
  // encoding, a higher alpha means closer to / further inside the shape,
  // so max-compositing is the right operator when multiple primitives
  // overlap (e.g., pin head + tail share the head's lower arc region).
  const prevA = data[i + 3];
  const a = alpha > prevA ? alpha : prevA;
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
  data[i + 3] = a;
}

/** Compute the outline-band SDF from the primary shape's SDF.
 *
 *  The outline is a band of width `thickness` on the INSIDE of the primary
 *  boundary (so it overlays the primary fill's outermost rim — exactly
 *  what a "stroke" looks like at a vector shape's boundary). Given the
 *  primary's signed-inside SDF `d`:
 *
 *    sdf_outline = min(d, thickness - d)
 *
 *  - d < 0:           outside primary, outside outline → returns d.
 *  - 0 ≤ d ≤ thick:   inside outline band → min of distance to either
 *                     band edge (both positive).
 *  - d > thickness:   deep inside primary, outside outline (past the
 *                     inner band edge) → returns `thickness - d` (negative).
 */
function outlineSdfFrom(primarySdf: number, thickness: number): number {
  const other = thickness - primarySdf;
  return primarySdf < other ? primarySdf : other;
}

// ---------------------------------------------------------------------------
// Shape catalog. Each entry follows the same pattern: primary = filled
// silhouette, secondary (when set) = thin outline at the silhouette's edge
// at the build-time `outlineThickness` (CSS-px-equivalent, scaled by
// pixelRatio at rasterize time). Stacking secondary
// above primary at the same position paints the outline over the outermost
// band of the fill — exactly what a "stroke" looks like on a vector shape.
//
// Ring is intentionally one-color: its silhouette already reads as a heavy
// stroke and adding a thin outline on the outer edge would just make the
// ring look slightly thicker. When a "ring with center dot" variant lands
// later it'll be a distinct shape (e.g. `target`) where the secondary slot
// is the center dot.

export const SHAPES: Record<WaypointShape, ShapeDescriptor> = {
  circle: {
    name: 'circle',
    primary: ({ pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawFilledCircle(data, size, size / 2, size / 2, SHAPE_CANONICAL_RADIUS * pixelRatio),
      ),
    secondary: ({ outlineThickness, pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawCircleOutline(
          data,
          size,
          size / 2,
          size / 2,
          SHAPE_CANONICAL_RADIUS * pixelRatio,
          outlineThickness * pixelRatio,
        ),
      ),
    domains: ['waypoint', 'pov'],
  },
  ring: {
    name: 'ring',
    primary: ({ pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawRing(
          data,
          size,
          size / 2,
          size / 2,
          SHAPE_CANONICAL_RADIUS * pixelRatio,
          RING_STROKE * pixelRatio,
        ),
      ),
    // One-color shape — see file-level note above the catalog.
    domains: ['waypoint', 'pov'],
  },
  pin: {
    name: 'pin',
    primary: ({ pixelRatio }) =>
      rasterize(pixelRatio, (data, size) => drawPin(data, size)),
    secondary: ({ outlineThickness, pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawPinOutline(data, size, outlineThickness * pixelRatio),
      ),
    // Pin's needle tip semantic is waypoint-specific ("the tip is at the
    // coordinate"); it doesn't translate to POV, which paints centered.
    domains: ['waypoint'],
  },
  square: {
    name: 'square',
    primary: ({ pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawFilledSquare(data, size, size / 2, size / 2, SQUARE_HALF_SIDE * pixelRatio),
      ),
    secondary: ({ outlineThickness, pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawSquareOutline(
          data,
          size,
          size / 2,
          size / 2,
          SQUARE_HALF_SIDE * pixelRatio,
          outlineThickness * pixelRatio,
        ),
      ),
    domains: ['waypoint', 'pov'],
  },
  diamond: {
    name: 'diamond',
    primary: ({ pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawFilledDiamond(data, size, size / 2, size / 2, DIAMOND_HALF_DIAG * pixelRatio),
      ),
    secondary: ({ outlineThickness, pixelRatio }) =>
      rasterize(pixelRatio, (data, size) =>
        drawDiamondOutline(
          data,
          size,
          size / 2,
          size / 2,
          DIAMOND_HALF_DIAG * pixelRatio,
          outlineThickness * pixelRatio,
        ),
      ),
    domains: ['waypoint', 'pov'],
  },
};

/** All shape names in catalog order. Convenience for tests / pickers that
 *  want a stable iteration order. */
export const WAYPOINT_SHAPE_NAMES = Object.keys(SHAPES) as WaypointShape[];

/** Filter the catalog to one domain. UI pickers consume this to populate
 *  their gallery — POV's picker doesn't show `pin`, waypoint's picker shows
 *  everything declared with `'waypoint'` in `domains`. */
export function shapesFor(domain: ShapeDomain): ShapeDescriptor[] {
  return Object.values(SHAPES).filter((d) => d.domains.includes(domain));
}

/** Resolve a shape name to its descriptor, or null when the name doesn't
 *  exist in the catalog. Callers should fall back to `SHAPES.circle` so
 *  legacy / unknown names (e.g. a v8 project that saved `'numbered-circle'`)
 *  render visibly instead of as a MapLibre missing-image placeholder. */
export function getShape(name: string): ShapeDescriptor | null {
  return (SHAPES as Record<string, ShapeDescriptor>)[name] ?? null;
}

/** True when the shape's secondary slot paints something. Drives the UI's
 *  secondary-color picker visibility — hiding it for one-color shapes
 *  prevents the "I changed this color but nothing happened" footgun. */
export function shapeHasSecondary(name: string): boolean {
  return getShape(name)?.secondary !== undefined;
}

/** One `map.addImage(...)`-ready entry. Both the preview (`MapView.tsx`'s
 *  `onStyleLoad`) and the export renderer iterate the same array so the
 *  SDF atlas matches across the two pipelines. The `options.pixelRatio`
 *  field tells MapLibre "this texture is N texels per CSS pixel" — without
 *  it, MapLibre would treat the icon as 1:1 and upscale on retina /
 *  high-pixelRatio exports, producing visibly grainy edges next to the
 *  natively-rendered map tiles. */
export interface ShapeRegistryEntry {
  /** Image id MapLibre stores under. Shape is `waypoint-<shape>-<slot>`. */
  id: string;
  icon: SdfIcon;
  options: { sdf: true; pixelRatio: number };
}

/** Build the full set of SDF icons needed by the waypoints layers — every
 *  shape × both slots — at the requested outline thickness (CSS-px units)
 *  and pixelRatio (texels per CSS pixel for the rasterized atlas). Shapes
 *  without a `secondary` rasterizer contribute a transparent placeholder
 *  icon so the secondary symbol layer is always resolvable.
 *
 *  Returns a fresh array each call (icons are owned `Uint8Array` buffers).
 *  Preview and export rasterize at their own pixelRatio (window.devicePixel
 *  Ratio vs payload.pixelRatio); MapLibre's `addImage` then normalizes both
 *  to the same CSS-px natural size via the matching `options.pixelRatio`,
 *  so the rendered display size matches on both sides while each side gets
 *  a texture density appropriate to its framebuffer. */
export function buildAllShapeIcons(
  opts: ShapeBuildOptions = {
    outlineThickness: DEFAULT_OUTLINE_THICKNESS,
    pixelRatio: 1,
  },
): ShapeRegistryEntry[] {
  const out: ShapeRegistryEntry[] = [];
  for (const desc of Object.values(SHAPES)) {
    out.push({
      id: `waypoint-${desc.name}-primary`,
      icon: desc.primary(opts),
      options: { sdf: true, pixelRatio: opts.pixelRatio },
    });
    out.push({
      id: `waypoint-${desc.name}-secondary`,
      icon: desc.secondary
        ? desc.secondary(opts)
        : transparentIcon(opts.pixelRatio),
      options: { sdf: true, pixelRatio: opts.pixelRatio },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SDF rasterizers. Each primary uses the shape's analytical signed-inside
// distance function; each secondary derives the outline-band SDF from the
// primary via `outlineSdfFrom(primary_sdf, thickness)`.

function drawFilledCircle(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  radius: number,
): void {
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - radius - SDF_PX,
      xHi: cx + radius + SDF_PX,
      yLo: cy - radius - SDF_PX,
      yHi: cy + radius + SDF_PX,
    },
    (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      return radius - Math.sqrt(dx * dx + dy * dy);
    },
  );
}

function drawCircleOutline(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerRadius: number,
  thickness: number,
): void {
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - outerRadius - SDF_PX,
      xHi: cx + outerRadius + SDF_PX,
      yLo: cy - outerRadius - SDF_PX,
      yHi: cy + outerRadius + SDF_PX,
    },
    (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      const primary = outerRadius - Math.sqrt(dx * dx + dy * dy);
      return outlineSdfFrom(primary, thickness);
    },
  );
}

/** Ring is a one-color band centered around an outer-radius silhouette,
 *  with stroke thickness baked into the geometry (not the user-facing
 *  outline thickness). The signed-inside distance to the band is computed
 *  via the band's mid-radius and half-stroke: a pixel is inside the band
 *  iff |r - midRadius| ≤ halfStroke; the SDF is `halfStroke - |r - midRadius|`. */
function drawRing(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerRadius: number,
  strokeWidth: number,
): void {
  const midRadius = outerRadius - strokeWidth / 2;
  const halfStroke = strokeWidth / 2;
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - outerRadius - SDF_PX,
      xHi: cx + outerRadius + SDF_PX,
      yLo: cy - outerRadius - SDF_PX,
      yHi: cy + outerRadius + SDF_PX,
    },
    (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      return halfStroke - Math.abs(r - midRadius);
    },
  );
}

/** Axis-aligned filled square. SDF is L∞ distance to the boundary:
 *  signedDistInside = halfSide - max(|dx|, |dy|). */
function drawFilledSquare(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  halfSide: number,
): void {
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - halfSide - SDF_PX,
      xHi: cx + halfSide + SDF_PX,
      yLo: cy - halfSide - SDF_PX,
      yHi: cy + halfSide + SDF_PX,
    },
    (px, py) => {
      const dx = Math.abs(px - cx);
      const dy = Math.abs(py - cy);
      return halfSide - (dx > dy ? dx : dy);
    },
  );
}

/** Axis-aligned square outline. The L∞ SDF for the square interior is
 *  `halfSide - max(|dx|, |dy|)`; `outlineSdfFrom` derives the band SDF.
 *
 *  Note: the L∞ "distance" is the perpendicular distance to the nearest
 *  axis-aligned side, NOT the Euclidean distance to the nearest boundary
 *  point — at the corners these diverge (perpendicular to a corner is
 *  along the diagonal). MapLibre's smoothstep AA reads any monotone
 *  function as an edge, so this gives the right boundary-AA behavior;
 *  what would go wrong at corners is the outline-thickness measured
 *  along the diagonal, which can read slightly off perpendicular. For
 *  rectilinear primitives in practice this is invisible. */
function drawSquareOutline(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerHalf: number,
  thickness: number,
): void {
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - outerHalf - SDF_PX,
      xHi: cx + outerHalf + SDF_PX,
      yLo: cy - outerHalf - SDF_PX,
      yHi: cy + outerHalf + SDF_PX,
    },
    (px, py) => {
      const dx = Math.abs(px - cx);
      const dy = Math.abs(py - cy);
      const primary = outerHalf - (dx > dy ? dx : dy);
      return outlineSdfFrom(primary, thickness);
    },
  );
}

/** Axis-aligned filled diamond (rotated square). The diamond's interior is
 *  |dx| + |dy| ≤ halfDiag; the perpendicular distance from an interior
 *  point to the nearest edge is `(halfDiag - |dx| - |dy|) / √2` because
 *  the edges are at 45° to the axes. */
function drawFilledDiamond(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  halfDiag: number,
): void {
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - halfDiag - SDF_PX,
      xHi: cx + halfDiag + SDF_PX,
      yLo: cy - halfDiag - SDF_PX,
      yHi: cy + halfDiag + SDF_PX,
    },
    (px, py) => {
      const dx = Math.abs(px - cx);
      const dy = Math.abs(py - cy);
      return (halfDiag - dx - dy) / Math.SQRT2;
    },
  );
}

function drawDiamondOutline(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerHalfDiag: number,
  thickness: number,
): void {
  rasterizeSdf(
    data,
    size,
    {
      xLo: cx - outerHalfDiag - SDF_PX,
      xHi: cx + outerHalfDiag + SDF_PX,
      yLo: cy - outerHalfDiag - SDF_PX,
      yHi: cy + outerHalfDiag + SDF_PX,
    },
    (px, py) => {
      const dx = Math.abs(px - cx);
      const dy = Math.abs(py - cy);
      const primary = (outerHalfDiag - dx - dy) / Math.SQRT2;
      return outlineSdfFrom(primary, thickness);
    },
  );
}

// ---------------------------------------------------------------------------
// Pin — teardrop shape with the tip near the bottom of the canvas. With
// `icon-anchor: 'bottom'` on the symbol layer (data-driven, set per-shape
// in `resolveStaticPaints`), the bottom-center of the canvas — i.e. the
// tip — lands on the GPS coordinate. Other shapes use `icon-anchor:
// 'center'`, so the pin gets its own anchor and is free to fill the full
// canvas vertically rather than being squeezed into the top half.
//
// Geometry (all ratios of the canvas `size`, so they scale automatically
// with `pixelRatio`):
//
//   - Head: circle near the top of the canvas. Head radius is sized
//     comparably to SHAPE_CANONICAL_RADIUS (in CSS-px-equivalent units)
//     so the user-facing `stroke_width` setting — which is calibrated
//     against SHAPE_CANONICAL_RADIUS — produces an outline whose visual
//     weight on the pin matches the other shapes. Head center sits inset
//     from the canvas top to leave room for the outline at the default
//     stroke width.
//
//   - Tip: at (size/2, size - 0.5) — the bottom-center pixel. With
//     `icon-anchor: 'bottom'` this lands exactly on the geographic point.
//     The very-bottom-row SDF clipping (no canvas pixels below the tip
//     means no "outside" SDF for the bottom 0.5 px) trades a tiny amount
//     of tip sharpness for pixel-perfect anchoring; at typical icon-size
//     ~0.34 the effect is sub-pixel.
//
//   - Tail: two straight lines TANGENT to the head circle, converging at
//     the tip. Tangent geometry — not arbitrary triangle edges — is what
//     makes the head→tail transition C1-continuous (no visible kink at
//     the head-tail junction).
//
// SDF strategy: the pin's OUTER boundary is the head arc above the tangent
// line plus the two tangent segments (L→T, T→R). Distance to that
// boundary is `min(arcDist, leftSegDist, rightSegDist)`; sign is positive
// when the point lies inside the head disk OR inside the tail triangle
// (L, T, R). We deliberately do NOT use `max(headSdf, tailTriangleSdf)`
// — that formulation has the right SIGN at every point but the wrong
// MAGNITUDE on the head-circle arc that lies INSIDE the tail triangle:
// at those interior points `headSdf = 0` so `max(0, tailTriangleSdf)` =
// `tailTriangleSdf`, which is small near the tangent points. The
// outline-band derivation `min(d, thickness - d)` then paints a visible
// secondary-color arc along the (interior) head boundary near each
// tangent point. The proper-distance formulation below has no such
// internal seam.

const PIN_HEAD_RADIUS_RATIO = 42 / 128;
/** Pin head center y on the SDF canvas. Inset from the canvas top by ~8 px
 *  so the outline at default `stroke_width` doesn't clip the top edge. */
const PIN_HEAD_CENTER_Y_RATIO = 50 / 128;
/** Pin tip y on the SDF canvas. Bottom-edge centered (half a pixel inset)
 *  so `icon-anchor: 'bottom'` lands the tip exactly on the geographic
 *  point with sub-pixel error. */
const PIN_TIP_Y_RATIO = 127.5 / 128;

interface PinGeometry {
  cx: number;
  headCy: number;
  headR: number;
  tipY: number;
  tangentY: number;
  /** Half-width of the tail at the tangent touch line. Also equals
   *  R·sin α — the tail tapers linearly from this width at `tangentY` to
   *  0 at `tipY`. */
  tangentHalfWidth: number;
  /** cos α = headR / D where D = tipY − headCy. Cached because the
   *  arc-vs-vertex test in `pinSdf` is in the per-pixel inner loop. */
  cosA: number;
}

function pinGeometry(size: number): PinGeometry {
  const cx = size / 2;
  const headCy = size * PIN_HEAD_CENTER_Y_RATIO;
  const tipY = size * PIN_TIP_Y_RATIO;
  const headR = size * PIN_HEAD_RADIUS_RATIO;
  const D = tipY - headCy;
  if (D <= headR) {
    // Degenerate — collapse to a circle. cosA = 1 makes the arc test
    // accept every angle (`dy/dc < 1` for all non-radial-down rays),
    // and tangentHalfWidth = 0 means the tangent endpoints collapse to
    // a single point at (cx, headCy + headR).
    return {
      cx,
      headCy,
      headR,
      tipY,
      tangentY: headCy + headR,
      tangentHalfWidth: 0,
      cosA: 1,
    };
  }
  const cosA = headR / D;
  const sinA = Math.sqrt(1 - cosA * cosA);
  return {
    cx,
    headCy,
    headR,
    tipY,
    tangentY: headCy + headR * cosA,
    tangentHalfWidth: headR * sinA,
    cosA,
  };
}

/** Unsigned distance from a point to a line segment. */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Signed-inside SDF for the pin (head disk ∪ tail triangle). Outer
 *  boundary = head arc above `tangentY` ∪ left tangent segment (L→T) ∪
 *  right tangent segment (T→R). Unsigned distance is the `min` over the
 *  three pieces; sign is positive when the point is inside the head disk
 *  OR inside the tail triangle (L, R, T). See the long-form comment above
 *  for why a proper distance is needed instead of `max(headSdf, tailSdf)`. */
function pinSdf(px: number, py: number, g: PinGeometry): number {
  const dx = px - g.cx;
  const dy = py - g.headCy;
  const dc = Math.sqrt(dx * dx + dy * dy);
  const Lx = g.cx - g.tangentHalfWidth;
  const Ly = g.tangentY;
  const Rx = g.cx + g.tangentHalfWidth;
  const Ry = g.tangentY;
  const Tx = g.cx;
  const Ty = g.tipY;

  // Distance to the head arc (the part of the head circle with y <
  // tangentY). For a query point with `dc > 0`, the closest point on the
  // FULL circle has y = headCy + headR · (dy/dc); it's on the arc iff
  // `dy/dc < cosA`. Otherwise the nearest arc point is one of the two
  // endpoints (L or R), whichever is closer.
  let arcDist: number;
  if (dc > 0 && dy / dc < g.cosA) {
    arcDist = Math.abs(dc - g.headR);
  } else {
    const dxL = px - Lx;
    const dyL = py - Ly;
    const dxR = px - Rx;
    const dyR = py - Ry;
    const distL = Math.sqrt(dxL * dxL + dyL * dyL);
    const distR = Math.sqrt(dxR * dxR + dyR * dyR);
    arcDist = distL < distR ? distL : distR;
  }

  // Distance to the two tangent segments. `distToSegment` handles the
  // endpoint cases (L, T, R) so we don't have to special-case the tip.
  const leftDist = distToSegment(px, py, Lx, Ly, Tx, Ty);
  const rightDist = distToSegment(px, py, Tx, Ty, Rx, Ry);

  let unsignedDist = arcDist;
  if (leftDist < unsignedDist) unsignedDist = leftDist;
  if (rightDist < unsignedDist) unsignedDist = rightDist;

  // Inside-test: inside head disk OR inside tail triangle (linear taper
  // from `tangentHalfWidth` at `tangentY` down to zero at `tipY`).
  const insideHead = dc < g.headR;
  let insideTail = false;
  if (!insideHead && py >= g.tangentY && py <= g.tipY) {
    const tailSpan = g.tipY - g.tangentY;
    if (tailSpan > 0) {
      const t = (g.tipY - py) / tailSpan;
      const halfWidth = g.tangentHalfWidth * t;
      insideTail = Math.abs(px - g.cx) <= halfWidth;
    }
  }
  return insideHead || insideTail ? unsignedDist : -unsignedDist;
}

function drawPin(data: Uint8Array, size: number): void {
  const g = pinGeometry(size);
  rasterizeSdf(
    data,
    size,
    {
      xLo: g.cx - g.tangentHalfWidth - SDF_PX,
      xHi: g.cx + g.tangentHalfWidth + SDF_PX,
      yLo: g.headCy - g.headR - SDF_PX,
      yHi: g.tipY + SDF_PX,
    },
    (px, py) => pinSdf(px, py, g),
  );
}

function drawPinOutline(
  data: Uint8Array,
  size: number,
  thickness: number,
): void {
  const g = pinGeometry(size);
  rasterizeSdf(
    data,
    size,
    {
      xLo: g.cx - g.tangentHalfWidth - SDF_PX,
      xHi: g.cx + g.tangentHalfWidth + SDF_PX,
      yLo: g.headCy - g.headR - SDF_PX,
      yHi: g.tipY + SDF_PX,
    },
    (px, py) => outlineSdfFrom(pinSdf(px, py, g), thickness),
  );
}
