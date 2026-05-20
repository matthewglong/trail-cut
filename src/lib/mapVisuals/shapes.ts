// Unified shape-descriptor module for the waypoints + POV decoration layers.
//
// Each shape declares its own rasterizers for a PRIMARY slot (the body of the
// shape, tinted by the primary color) and an optional SECONDARY slot (the
// outline / accent element, tinted by the secondary color). Both slots are
// SDF (Signed Distance Field) icons — bitmaps where the alpha channel
// encodes coverage and MapLibre applies a per-icon `icon-color` tint at draw
// time. The whole reason for SDF is that tint: it's what lets a single
// rasterized white shape paint as any color the user picks, and what lets
// the same atlas serve every gradient sample / per-feature override.
//
// SDF intuition: imagine the rasterizer pours opaque white "ink" into the
// shape; alpha 255 = solid ink, alpha 0 = blank, in-between = anti-aliased
// edge. MapLibre then says "paint this white ink as the requested color"
// at draw time. A two-color shape is just two stacked SDF icons painting on
// the same map position — primary first, secondary on top.
//
// The descriptor model replaces the prior circle-family / symbol-family
// split (which routed `circle` / `ring` / `numbered-circle` to a native
// `circle` layer and the rest to a symbol layer). That split conflated
// "what's the silhouette" with "how is it rendered" — most visibly, picking
// `ring` rendered a solid circle because `ring` was tagged circle-family
// and the SDF ring artwork was never used. Every shape now goes through
// the same two stacked symbol layers (`waypoints-primary` /
// `waypoints-secondary`) and gets uniform fill + stroke + active-state
// behaviour by construction.
//
// Why hand-rasterized and not OffscreenCanvas / node-canvas:
//
//  - The preview path COULD use OffscreenCanvas, but then the export
//    renderer would need a parallel implementation (no DOM canvas in Node).
//    `node-canvas` is not a project dependency — adding it for a handful
//    of geometric primitives is a poor cost/benefit tradeoff (~80 MB
//    native build, system deps like cairo/pango/giflib).
//
//  - Hand-rasterized shapes give bit-identical pixel data in preview and
//    export by construction — no Canvas-renderer differences (text anti-
//    aliasing, sub-pixel fill rules) to chase down.
//
//  - The shapes are simple geometric primitives that lower cleanly to
//    nested pixel loops.
//
// 48×48 px canonical size per `shapes-pov.md` Part 1. MapLibre scales icons
// via `icon-size` at draw time, so the canonical raster size only dictates
// the SDF distance-field resolution (more pixels = sharper at extreme zoom).

import type { WaypointShape } from '../../types';

/** Canonical SDF icon size (px). All shapes rasterize at this size; runtime
 *  scaling happens via the symbol layer's `icon-size` paint property. 48 is
 *  MapLibre's own examples' size and gives plenty of distance-field headroom
 *  at the default waypoint radius (~12 CSS px). */
export const WAYPOINT_ICON_SIZE = 48;

/** Outline thickness used by every shape's secondary (outline) slot, in
 *  canonical 48-px-canvas pixels. The outline scales proportionally with
 *  the rendered icon size — at `icon-size: 0.5` (a typical small marker)
 *  this lands at ~1.25 CSS px on screen, which reads as a clean hairline.
 *
 *  Today the field `mapSettings.waypoints.size.stroke_width` is no longer
 *  applied to waypoint rendering — outline thickness is baked into the SDF
 *  rather than driven by a paint property, because the alternative (re-
 *  rasterizing every shape's outline icon on every settings change) costs
 *  more in complexity than the user-controllable stroke width is worth at
 *  this stage. Reintroducing the knob is straightforward when it's needed:
 *  parameterize this constant and rebuild + re-`addImage` the outline icons
 *  on the change. */
const OUTLINE_THICKNESS = 2.5;

/** Raw pixel data for one SDF icon. Shape matches `map.addImage()`'s `image`
 *  argument verbatim — pass the returned `{ width, height, data }` triple
 *  directly with `{ sdf: true }`. `data` is RGBA8, row-major, top-down,
 *  width*height*4 bytes. Ink pixels are `(255, 255, 255, alpha)`; transparent
 *  pixels are all zeros. Anti-aliased edges use alpha 0..255 against fully-
 *  white RGB. */
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

/** One entry in the shape catalog. Adding a new shape is "write a primary
 *  rasterizer, optionally write a secondary one, append to SHAPES."
 *
 *  `primary` and `secondary` are lazy (called from `buildAllShapeIcons`)
 *  rather than eager so the module's import cost stays tiny — six rasters
 *  × 48² × 4 bytes ≈ 55 KB is small but module-load time matters at HMR. */
export interface ShapeDescriptor {
  /** Identity. Must match a `WaypointShape` union member. SDF icon ids are
   *  formed as `waypoint-${name}-primary` / `waypoint-${name}-secondary`. */
  name: WaypointShape;
  /** Rasterizer for the primary slot (tinted by the primary color at draw
   *  time). Required — every shape has at least a primary silhouette. */
  primary: () => SdfIcon;
  /** Optional rasterizer for the secondary slot (tinted by the secondary
   *  color). When omitted, the registry substitutes a transparent placeholder
   *  so the secondary symbol layer stays valid; UI is expected to hide the
   *  secondary color picker for shapes that opt out. */
  secondary?: () => SdfIcon;
  /** Decoration domains this shape is offered in. */
  domains: readonly ShapeDomain[];
}

/** Transparent placeholder SDF icon. Used as the secondary-slot fill for
 *  shapes that don't declare their own `secondary` rasterizer, so the layer
 *  stack stays uniform: every shape registers BOTH a primary and a secondary
 *  icon, even if the secondary is just empty pixels. The alternative —
 *  per-feature `icon-opacity` routing — adds expression evaluation cost on
 *  every draw and complicates the active-state machinery. */
function transparentIcon(): SdfIcon {
  const size = WAYPOINT_ICON_SIZE;
  return {
    width: size,
    height: size,
    data: new Uint8Array(size * size * 4),
  };
}

/** Build a new RGBA8 buffer of canonical size, run a draw callback against
 *  it, and return the result wrapped in an `SdfIcon`. Cuts boilerplate at
 *  every descriptor site without committing to a particular drawing API. */
function rasterize(draw: (data: Uint8Array, size: number) => void): SdfIcon {
  const size = WAYPOINT_ICON_SIZE;
  const data = new Uint8Array(size * size * 4);
  draw(data, size);
  return { width: size, height: size, data };
}

// ---------------------------------------------------------------------------
// Shape catalog. Each entry follows the same pattern: primary = filled
// silhouette, secondary (when set) = thin outline at the silhouette's edge,
// `OUTLINE_THICKNESS` px wide. Stacking secondary above primary at the same
// position paints the outline over the outermost band of the fill — exactly
// what a "stroke" looks like on a vector shape.
//
// Ring is intentionally one-color: its silhouette already reads as a heavy
// stroke and adding a thin outline on the outer edge would just make the
// ring look slightly thicker (visually indistinguishable from the no-outline
// variant). When a "ring with center dot" variant lands later it'll be a
// distinct shape (e.g. `target`) where the secondary slot is the center dot.

export const SHAPES: Record<WaypointShape, ShapeDescriptor> = {
  circle: {
    name: 'circle',
    primary: () =>
      rasterize((data, size) =>
        drawFilledCircle(data, size, size / 2, size / 2, 18),
      ),
    secondary: () =>
      rasterize((data, size) =>
        drawCircleOutline(data, size, size / 2, size / 2, 18, OUTLINE_THICKNESS),
      ),
    domains: ['waypoint', 'pov'],
  },
  ring: {
    name: 'ring',
    primary: () =>
      rasterize((data, size) =>
        drawRing(data, size, size / 2, size / 2, 18, 4),
      ),
    // One-color shape — see file-level note above the catalog.
    domains: ['waypoint', 'pov'],
  },
  pin: {
    name: 'pin',
    primary: () => rasterize((data, size) => drawPin(data, size)),
    secondary: () =>
      rasterize((data, size) => drawPinOutline(data, size, OUTLINE_THICKNESS)),
    // Pin's needle tip semantic is waypoint-specific ("the tip is at the
    // coordinate"); it doesn't translate to POV, which paints centered.
    domains: ['waypoint'],
  },
  square: {
    name: 'square',
    primary: () =>
      rasterize((data, size) =>
        drawFilledSquare(data, size, size / 2, size / 2, 16),
      ),
    secondary: () =>
      rasterize((data, size) =>
        drawSquareOutline(data, size, size / 2, size / 2, 16, OUTLINE_THICKNESS),
      ),
    domains: ['waypoint', 'pov'],
  },
  diamond: {
    name: 'diamond',
    primary: () =>
      rasterize((data, size) =>
        drawFilledDiamond(data, size, size / 2, size / 2, 22),
      ),
    secondary: () =>
      rasterize((data, size) =>
        drawDiamondOutline(
          data,
          size,
          size / 2,
          size / 2,
          22,
          OUTLINE_THICKNESS,
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
 *  `onStyleLoad`) and the export renderer (`renderer/index.ts`'s
 *  `applySetup`) iterate the same array so the SDF atlas is bit-identical
 *  across the two pipelines. */
export interface ShapeRegistryEntry {
  /** Image id MapLibre stores under. Shape is `waypoint-<shape>-<slot>`. */
  id: string;
  icon: SdfIcon;
  options: { sdf: true };
}

/** Build the full set of SDF icons needed by the waypoints layers — every
 *  shape × both slots. Shapes without a `secondary` rasterizer contribute
 *  a transparent placeholder icon so the secondary symbol layer is always
 *  resolvable.
 *
 *  Returns a fresh array each call (icons are owned `Uint8Array` buffers).
 *  Both sides must register identical entries; drift here means the export
 *  silently renders a different shape than the preview. */
export function buildAllShapeIcons(): ShapeRegistryEntry[] {
  const out: ShapeRegistryEntry[] = [];
  for (const desc of Object.values(SHAPES)) {
    out.push({
      id: `waypoint-${desc.name}-primary`,
      icon: desc.primary(),
      options: { sdf: true },
    });
    out.push({
      id: `waypoint-${desc.name}-secondary`,
      icon: desc.secondary ? desc.secondary() : transparentIcon(),
      options: { sdf: true },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Primitive rasterizers. RGBA8 top-down, ink as (255,255,255,alpha).
// Anti-aliasing uses a "soft edge" alpha ramp over a 1-pixel boundary:
// distance < r-0.5 → fully inside (alpha 255); distance > r+0.5 → fully
// outside (alpha 0); in between → linear ramp. This is the standard
// trick for crisp circular edges without supersampling.

function writePixel(
  data: Uint8Array,
  size: number,
  x: number,
  y: number,
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  // Combine with any existing alpha at this pixel — pin uses two
  // overlapping primitives (circle head + triangle tail) and the seam
  // would show as a darker line without max-blending.
  const prevA = data[i + 3];
  const a = alpha > prevA ? alpha : prevA;
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
  data[i + 3] = a;
}

function softEdgeAlpha(dist: number, radius: number): number {
  // dist < radius - 0.5 → fully inside; dist > radius + 0.5 → outside;
  // linear ramp in between. Returns 0..255.
  const inside = radius - 0.5;
  const outside = radius + 0.5;
  if (dist <= inside) return 255;
  if (dist >= outside) return 0;
  return Math.round((outside - dist) * 255);
}

function drawFilledCircle(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  radius: number,
): void {
  const min = 0;
  const max = size - 1;
  const xLo = Math.max(min, Math.floor(cx - radius - 1));
  const xHi = Math.min(max, Math.ceil(cx + radius + 1));
  const yLo = Math.max(min, Math.floor(cy - radius - 1));
  const yHi = Math.min(max, Math.ceil(cy + radius + 1));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = softEdgeAlpha(d, radius);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

function drawRing(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerRadius: number,
  strokeWidth: number,
): void {
  const innerRadius = outerRadius - strokeWidth;
  const min = 0;
  const max = size - 1;
  const xLo = Math.max(min, Math.floor(cx - outerRadius - 1));
  const xHi = Math.min(max, Math.ceil(cx + outerRadius + 1));
  const yLo = Math.max(min, Math.floor(cy - outerRadius - 1));
  const yHi = Math.min(max, Math.ceil(cy + outerRadius + 1));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const outerA = softEdgeAlpha(d, outerRadius);
      if (outerA === 0) continue;
      // Inverse soft-edge for the inner cutout: pixels with d > inner+0.5
      // are fully inside the ring, pixels with d < inner-0.5 are fully
      // inside the hole (alpha 0), linear ramp between.
      let innerCutout = 255;
      if (d <= innerRadius - 0.5) innerCutout = 0;
      else if (d < innerRadius + 0.5) {
        innerCutout = Math.round((d - (innerRadius - 0.5)) * 255);
      }
      const a = Math.min(outerA, innerCutout);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

/** Thin circular outline — pixels within `thickness` of the outer edge.
 *  Equivalent to a ring with `strokeWidth = thickness`. Wrapper rather than
 *  call-site duplication so the secondary-slot rasterizers all read as
 *  "draw a thin border of the shape." */
function drawCircleOutline(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerRadius: number,
  thickness: number,
): void {
  drawRing(data, size, cx, cy, outerRadius, thickness);
}

function drawFilledSquare(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  halfSide: number,
): void {
  const min = 0;
  const max = size - 1;
  const xLo = Math.max(min, Math.floor(cx - halfSide - 1));
  const xHi = Math.min(max, Math.ceil(cx + halfSide + 1));
  const yLo = Math.max(min, Math.floor(cy - halfSide - 1));
  const yHi = Math.min(max, Math.ceil(cy + halfSide + 1));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      const dy = Math.abs(y + 0.5 - cy);
      // Chebyshev distance from center; soft-edge against halfSide on
      // either axis.
      const ax = softEdgeAxisAlpha(dx, halfSide);
      const ay = softEdgeAxisAlpha(dy, halfSide);
      const a = Math.min(ax, ay);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

function softEdgeAxisAlpha(dist: number, half: number): number {
  const inside = half - 0.5;
  const outside = half + 0.5;
  if (dist <= inside) return 255;
  if (dist >= outside) return 0;
  return Math.round((outside - dist) * 255);
}

/** Thin square outline — pixels inside the outer square AND outside the
 *  inner square. Per-axis soft-edge ramps anti-alias both the outer and
 *  inner edges so the stroke reads as crisp on both sides at any
 *  `icon-size`. */
function drawSquareOutline(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerHalf: number,
  thickness: number,
): void {
  const innerHalf = outerHalf - thickness;
  const min = 0;
  const max = size - 1;
  const xLo = Math.max(min, Math.floor(cx - outerHalf - 1));
  const xHi = Math.min(max, Math.ceil(cx + outerHalf + 1));
  const yLo = Math.max(min, Math.floor(cy - outerHalf - 1));
  const yHi = Math.min(max, Math.ceil(cy + outerHalf + 1));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      const dy = Math.abs(y + 0.5 - cy);
      // Outer square coverage (how much of this pixel is inside the outer
      // boundary). 255 deep inside, 0 well outside, ramped at the edge.
      const outerA = Math.min(
        softEdgeAxisAlpha(dx, outerHalf),
        softEdgeAxisAlpha(dy, outerHalf),
      );
      if (outerA === 0) continue;
      // Inner square coverage. The stroke pixel is "inside outer AND not
      // inside inner" — alpha-subtraction gives us a soft ring with both
      // edges anti-aliased. Clamping at 0 handles the degenerate
      // (innerHalf < 0) case for tiny shapes.
      const innerA = Math.min(
        softEdgeAxisAlpha(dx, innerHalf),
        softEdgeAxisAlpha(dy, innerHalf),
      );
      const a = Math.max(0, outerA - innerA);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

function drawFilledDiamond(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  halfDiag: number,
): void {
  // Diamond = points where |x| + |y| <= halfDiag (rotated square). Same
  // soft-edge treatment, distance metric is the L1 / Manhattan norm.
  const min = 0;
  const max = size - 1;
  const xLo = Math.max(min, Math.floor(cx - halfDiag - 1));
  const xHi = Math.min(max, Math.ceil(cx + halfDiag + 1));
  const yLo = Math.max(min, Math.floor(cy - halfDiag - 1));
  const yHi = Math.min(max, Math.ceil(cy + halfDiag + 1));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      const dy = Math.abs(y + 0.5 - cy);
      const dist = dx + dy;
      // Soft edge in L1 norm; scale the ramp by sqrt(2)/2 so the
      // diagonal anti-aliasing matches the rectangle's per-axis ramp
      // visually (L1 isoline is rotated 45°).
      const a = softEdgeL1Alpha(dist, halfDiag);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

function softEdgeL1Alpha(dist: number, half: number): number {
  // Boundary width chosen as ~0.71 (= sqrt(2)/2) so the perceived edge
  // sharpness matches drawFilledSquare (whose ramp width is 1 px in L∞
  // which projects to ~0.71 px in L1 along the diagonal).
  const HALF_RAMP = 0.71;
  const inside = half - HALF_RAMP;
  const outside = half + HALF_RAMP;
  if (dist <= inside) return 255;
  if (dist >= outside) return 0;
  return Math.round(((outside - dist) / (2 * HALF_RAMP)) * 255);
}

/** Thin diamond outline — alpha-subtract an inner diamond from the outer.
 *  Inner half-diagonal shrinks by `thickness × √2` so the stroke width
 *  measured perpendicular to the diamond's edges (the visually meaningful
 *  width) lands at `thickness` rather than `thickness / √2`. */
function drawDiamondOutline(
  data: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  outerHalfDiag: number,
  thickness: number,
): void {
  // The diamond's edge is at 45°; a stroke of perpendicular width
  // `thickness` corresponds to shrinking the L1 half-diagonal by
  // `thickness × √2`. Otherwise the visible outline reads thinner than
  // the equivalent square outline at the same thickness setting.
  const innerHalfDiag = outerHalfDiag - thickness * Math.SQRT2;
  const min = 0;
  const max = size - 1;
  const xLo = Math.max(min, Math.floor(cx - outerHalfDiag - 1));
  const xHi = Math.min(max, Math.ceil(cx + outerHalfDiag + 1));
  const yLo = Math.max(min, Math.floor(cy - outerHalfDiag - 1));
  const yHi = Math.min(max, Math.ceil(cy + outerHalfDiag + 1));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      const dy = Math.abs(y + 0.5 - cy);
      const dist = dx + dy;
      const outerA = softEdgeL1Alpha(dist, outerHalfDiag);
      if (outerA === 0) continue;
      const innerA = softEdgeL1Alpha(dist, innerHalfDiag);
      const a = Math.max(0, outerA - innerA);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

function drawPin(data: Uint8Array, size: number): void {
  // Teardrop: a circular head centered above the canvas midline plus a
  // triangular tail tapering to a point at the bottom edge. The tip is
  // the marker's coordinate (the rest of the icon hangs above), per
  // shapes-pov.md "the needle tip is at the coordinate."
  //
  // We approximate the classic pin silhouette by:
  //   - Head: filled circle, radius 14, centered at (size/2, size*0.36).
  //   - Neck/tail: an isoceles triangle whose top edge sits inside the
  //     head circle and whose apex is at (size/2, size - 2).
  //
  // The triangle's top edge is wide enough that the two shapes merge
  // into a smooth teardrop with no visible seam thanks to alpha-max
  // blending in writePixel.
  const cx = size / 2;
  const headCy = size * 0.36;
  const headR = 14;
  drawFilledCircle(data, size, cx, headCy, headR);

  // Triangle from a wide base (chord across the head circle, ~10 px
  // below the head's center) down to a single-pixel tip near the bottom.
  const baseY = headCy + headR * 0.45; // chord depth inside the head
  const tipY = size - 2;
  const baseHalfWidth = Math.sqrt(headR * headR - (baseY - headCy) ** 2);
  // Triangle is defined by three vertices: (cx - baseHalfWidth, baseY),
  // (cx + baseHalfWidth, baseY), (cx, tipY). Rasterize via inside-test
  // over the triangle's bounding box.
  const yLo = Math.floor(baseY);
  const yHi = Math.ceil(tipY);
  for (let y = yLo; y <= yHi; y++) {
    // Width at this y by linear interpolation between baseY (full width)
    // and tipY (zero width).
    const t = (y - baseY) / (tipY - baseY);
    if (t < 0 || t > 1) continue;
    const halfWidth = baseHalfWidth * (1 - t);
    const xLo = Math.floor(cx - halfWidth - 1);
    const xHi = Math.ceil(cx + halfWidth + 1);
    for (let x = xLo; x <= xHi; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      // Soft edge against the local triangle half-width — 1 px ramp.
      const a = softEdgeAxisAlpha(dx, halfWidth);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

/** Thin pin outline. Strategy: rasterize the full pin and a slightly-inset
 *  pin into separate buffers, then per-pixel alpha-subtract — the result
 *  is a band along the silhouette. Buffer subtraction handles the
 *  non-convex teardrop shape without the analytic-distance machinery the
 *  convex shapes use. */
function drawPinOutline(
  data: Uint8Array,
  size: number,
  thickness: number,
): void {
  const full = new Uint8Array(size * size * 4);
  drawPin(full, size);

  const inset = new Uint8Array(size * size * 4);
  drawInsetPin(inset, size, thickness);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = Math.max(0, full[i + 3] - inset[i + 3]);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}

/** Inset pin — the same teardrop drawn `inset` pixels smaller in every
 *  direction. Subtracted from a full pin to produce the outline. Kept
 *  separate from `drawPin` rather than parameterized so the canonical pin
 *  silhouette stays anchored to the documented dimensions in `shapes-pov.md`
 *  and the outline-specific arithmetic doesn't leak back into it. */
function drawInsetPin(
  data: Uint8Array,
  size: number,
  inset: number,
): void {
  const cx = size / 2;
  const headCy = size * 0.36;
  const headR = Math.max(0, 14 - inset);
  drawFilledCircle(data, size, cx, headCy, headR);

  const baseY = headCy + headR * 0.45;
  const tipY = size - 2 - inset;
  const baseHalfWidth =
    headR > 0
      ? Math.sqrt(Math.max(0, headR * headR - (baseY - headCy) ** 2))
      : 0;
  const yLo = Math.floor(baseY);
  const yHi = Math.ceil(tipY);
  for (let y = yLo; y <= yHi; y++) {
    const t = (y - baseY) / (tipY - baseY);
    if (t < 0 || t > 1) continue;
    const halfWidth = baseHalfWidth * (1 - t);
    const xLo = Math.floor(cx - halfWidth - 1);
    const xHi = Math.ceil(cx + halfWidth + 1);
    for (let x = xLo; x <= xHi; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      const a = softEdgeAxisAlpha(dx, halfWidth);
      if (a > 0) writePixel(data, size, x, y, a);
    }
  }
}
