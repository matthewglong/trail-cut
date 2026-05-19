// SDF icon generation for the waypoints symbol layer. Pure functions —
// no DOM, no Node, no Canvas — so the same module is imported by both
// the preview (browser) and the export renderer worker (Node). Each
// shape is hand-rasterized into a Uint8Array of RGBA bytes that MapLibre
// accepts directly via `map.addImage(id, { width, height, data }, { sdf: true })`.
//
// SDF semantics (per MapLibre's icon atlas builder): white pixels are
// "ink" and the alpha channel is "coverage." MapLibre runs a distance-
// transform on the alpha channel at registration time; the `icon-color`
// paint property then tints the ink at draw time, which is the whole
// reason we use SDF — `icon-color` only works on SDF icons. Non-SDF
// icons would lock every waypoint to a single color.
//
// Why hand-rasterized and not OffscreenCanvas / node-canvas:
//
//  - The preview path COULD use OffscreenCanvas, but then the export
//    renderer would need a parallel implementation (no DOM canvas in
//    Node). `node-canvas` is not a project dependency — adding it for
//    six trivial shapes is a poor cost/benefit tradeoff (~80 MB native
//    build, system deps like cairo/pango/giflib).
//
//  - Hand-rasterized shapes give bit-identical pixel data in preview
//    and export by construction — no Canvas-renderer differences (text
//    anti-aliasing, sub-pixel fill rules) to chase down.
//
//  - All six shapes are simple geometric primitives that lower cleanly
//    to nested pixel loops. The pin shape is the only non-trivial one
//    (teardrop = circle + triangle); ~30 lines of arithmetic.
//
// 48×48 px canonical size per `shapes-pov.md` Part 1. MapLibre scales
// icons via `icon-size` at draw time, so the canonical raster size only
// dictates the SDF distance-field resolution (more pixels = sharper at
// extreme zoom). 48 is the size used in MapLibre's own examples.

/** Canonical icon size (px). One value for all shapes so the SDF atlas
 *  builds uniform cells and `icon-size: 1` at the layer level matches
 *  the same visual scale across shapes. */
export const WAYPOINT_ICON_SIZE = 48;

/** The six shape names registered as SDF icons. Mirrors the
 *  `WaypointShape` union in `types.ts`. Listed in the same order as the
 *  Shape gallery UI (Step 8-UI) renders them: rounded shapes first row,
 *  geometric second row, with `numbered-circle` last to keep the
 *  preset-grid grouping intact. */
export const WAYPOINT_SHAPE_NAMES = [
  'circle',
  'ring',
  'pin',
  'square',
  'diamond',
  'numbered-circle',
] as const;

export type WaypointIconName = (typeof WAYPOINT_SHAPE_NAMES)[number];

/** Raw pixel data for one waypoint SDF icon. The shape exactly matches
 *  one of the structural forms `map.addImage()` accepts as its `image`
 *  argument:
 *
 *      map.addImage('waypoint-circle', { width, height, data }, { sdf: true });
 *
 *  `data` is RGBA8 in row-major top-down order — width*height*4 bytes.
 *  Ink pixels are `(255, 255, 255, alpha)`; transparent pixels are all
 *  zeros. Anti-aliased edges use alpha 0..255 against a fully-white RGB. */
export interface WaypointSdfIcon {
  width: number;
  height: number;
  /** RGBA8, top-down, width*height*4 bytes. */
  data: Uint8Array;
}

/** Build the RGBA pixel buffer for a single waypoint shape. Pure
 *  function — same input always produces the same output. Both the
 *  preview (`MapView.tsx`) and the export renderer worker
 *  (`renderer/index.ts`) call this; the returned `{ width, height,
 *  data }` triple is passed verbatim to `map.addImage()` with
 *  `{ sdf: true }`. Identical pixels on both sides is the load-bearing
 *  invariant — drift here means the export silently renders a different
 *  shape than the preview. */
export function buildWaypointSdfIcon(name: WaypointIconName): WaypointSdfIcon {
  const size = WAYPOINT_ICON_SIZE;
  const data = new Uint8Array(size * size * 4);
  switch (name) {
    case 'circle':
    case 'numbered-circle':
      drawFilledCircle(data, size, size / 2, size / 2, 18);
      break;
    case 'ring':
      drawRing(data, size, size / 2, size / 2, 18, 4);
      break;
    case 'pin':
      drawPin(data, size);
      break;
    case 'square':
      drawFilledSquare(data, size, size / 2, size / 2, 16);
      break;
    case 'diamond':
      drawFilledDiamond(data, size, size / 2, size / 2, 22);
      break;
  }
  return { width: size, height: size, data };
}

/** Build all six waypoint icons. Convenience wrapper used by both the
 *  preview's onStyleLoad and the export renderer's setup payload — keeps
 *  the iteration in one place so the two sides can't accidentally
 *  register a different set. */
export function buildAllWaypointSdfIcons(): Array<{
  name: WaypointIconName;
  icon: WaypointSdfIcon;
}> {
  return WAYPOINT_SHAPE_NAMES.map((name) => ({
    name,
    icon: buildWaypointSdfIcon(name),
  }));
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
