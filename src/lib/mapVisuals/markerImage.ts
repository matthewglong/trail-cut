// Marker-library images — user-uploaded PNG/SVGs selectable as the POV
// marker (`MapSettings.pov.marker = { kind: 'image', image_id }`) and as
// waypoint markers (`waypoints.marker_image_id` / `Waypoint.marker_image_id`),
// all drawn from the shared `MapSettings.marker_images` library.
//
// Unlike the shape presets (single-color SDF icons tinted at draw time,
// see shapes.ts), a user image is a full-color bitmap: it registers with
// `sdf: false` and MapLibre draws its pixels verbatim — `icon-color` does
// not apply. What it SHARES with the shape pipeline is the registration
// contract: both preview and the export renderer derive each texture from
// the same baked master asset through the pure functions here, register it
// under the same id (`marker-image-<library id>`), and size it through
// `resolveStaticPaints` — parity by shared derivation, no pixel buffers
// crossing the wire.
//
// Asset model (bake once, consume twice): at import time the frontend
// rasterizes/normalizes the upload into a bundle-local PNG master —
// `assets/marker-icon-<hash>.png` (legacy v10 uploads keep their
// `pov-icon-<hash>` names) — capped at MAX_MASTER_TEXELS on the longest
// side. SVG is rasterized by the webview at import (the only place a real
// SVG renderer exists in the stack — the sidecar deliberately has no
// canvas/DOM, see shapes.ts's node-canvas rejection); PNG re-encodes
// through the same canvas so ICC profiles are folded into sRGB and both
// consumers decode identical bytes. Preview (browser decode) and the
// export sidecar (pngjs decode) then resample that ONE master through
// `resampleRgba` below.
//
// Sizing denomination follows the reference-space model: the marker's
// LONGEST side displays at `size_fraction × PAINT_REFERENCE_WIDTH` CSS px
// (× the consuming surface's `surfaceScale`) — POV uses
// `pov.size.image_size`; waypoints display images at the shape diameter,
// `2 × waypoints.size.circle_radius`. The texture registers at an integer
// `pixelRatio` k so its natural display size is
// MARKER_IMAGE_CANONICAL_SIZE CSS px on the longest side, and
// `resolveStaticPaints` emits `icon-size = displayCss /
// MARKER_IMAGE_CANONICAL_SIZE` — the same bridge shape the shape icons use
// with SHAPE_CANONICAL_RADIUS.

/** Prefix of the MapLibre image id every library image registers under
 *  (both surfaces): `marker-image-<library entry id>`. */
export const MARKER_IMAGE_ICON_PREFIX = 'marker-image-';

/** The MapLibre image id for a library entry, on both surfaces. */
export function markerImageIconId(imageId: string): string {
  return `${MARKER_IMAGE_ICON_PREFIX}${imageId}`;
}

/** Natural display size (CSS px) of a registered texture's LONGEST side.
 *  `icon-size = target_css_longest / MARKER_IMAGE_CANONICAL_SIZE` at draw
 *  time. 128 matches WAYPOINT_ICON_SIZE so the registration density math
 *  (k = texels per 128-css tile) shares the shape atlas's 1024-texel /
 *  pixelRatio-8 budget in the native binding. */
export const MARKER_IMAGE_CANONICAL_SIZE = 128;

/** The native binding's addImage hard cap is 1024 texels per side
 *  (node_map.cpp; see NATIVE_ADDIMAGE_MAX_PIXEL_RATIO in nativeBackend.ts).
 *  Registration pixelRatio k is clamped so 128·k ≤ 1024, and the baked
 *  master is capped to the same bound at import — a master past 1024 could
 *  never be uploaded anyway. */
export const MARKER_IMAGE_MAX_PIXEL_RATIO = 8;
export const MAX_MASTER_TEXELS =
  MARKER_IMAGE_CANONICAL_SIZE * MARKER_IMAGE_MAX_PIXEL_RATIO; // 1024

/** Raw straight-alpha RGBA8 bitmap, row-major top-down — the shape
 *  `map.addImage` consumes on both engines (GL JS takes it verbatim; the
 *  node binding premultiplies internally on upload, same as GL JS's
 *  texture path — both expect UNASSOCIATED alpha in). */
export interface RgbaBitmap {
  width: number;
  height: number;
  /** width*height*4 bytes, straight (non-premultiplied) alpha. */
  data: Uint8Array;
}

/** One `map.addImage(...)`-ready entry for a library image. Mirrors
 *  `ShapeRegistryEntry` in shapes.ts, with `sdf: false` — full-color
 *  bitmaps must not go through the SDF tint shader. */
export interface MarkerImageRegistryEntry {
  /** `marker-image-<library entry id>` (see `markerImageIconId`). */
  id: string;
  icon: RgbaBitmap;
  options: { sdf: false; pixelRatio: number };
}

/** MapLibre image id of the transparent RASTER (non-SDF) placeholder.
 *  The `waypoints-image` symbol layer resolves shape-marked features'
 *  icon-image to this id — mirror of shapes.ts's TRANSPARENT_SDF_ICON_ID,
 *  for the non-SDF side of the layer-homogeneity rule (MapLibre refuses to
 *  mix SDF and non-SDF icons in one layer). */
export const TRANSPARENT_RASTER_ICON_ID = 'marker-transparent-raster';

/** addImage-ready 1×1 transparent non-SDF placeholder (see
 *  `TRANSPARENT_RASTER_ICON_ID`). 1×1 is enough: it never draws visible
 *  pixels, and unlike the SDF placeholder it shares no atlas-slot layout
 *  with sibling icons. */
export function transparentRasterEntry(): MarkerImageRegistryEntry {
  return {
    id: TRANSPARENT_RASTER_ICON_ID,
    icon: { width: 1, height: 1, data: new Uint8Array(4) },
    options: { sdf: false, pixelRatio: 1 },
  };
}

/** Pick the integer registration pixelRatio k (texels per
 *  MARKER_IMAGE_CANONICAL_SIZE-css-px tile on the longest side) for a
 *  target display size on a surface:
 *
 *    k = ceil(displayCssLongest × surfacePixelRatio / 128)
 *
 *  i.e. the smallest k whose texture (128·k texels) covers the marker's
 *  framebuffer footprint — icon-size ≤ ~1 texel per framebuffer pixel, so
 *  the draw is a mild minification (crisp) rather than a magnification
 *  (soft). Clamped to [1, 8] for the native 1024-texel cap, and to the
 *  master's own density (upsampling the master past its resolution buys
 *  texels but no detail). */
export function markerImagePixelRatio(
  displayCssLongest: number,
  surfacePixelRatio: number,
  masterLongestTexels: number,
): number {
  const wanted = Math.ceil(
    (displayCssLongest * surfacePixelRatio) / MARKER_IMAGE_CANONICAL_SIZE,
  );
  const masterCap = Math.ceil(masterLongestTexels / MARKER_IMAGE_CANONICAL_SIZE);
  const cap = Math.min(MARKER_IMAGE_MAX_PIXEL_RATIO, Math.max(1, masterCap));
  return Math.min(cap, Math.max(1, wanted));
}

/** Build the addImage-ready icon for one library image from its decoded
 *  master bitmap.
 *
 *  - `imageId` — the library entry's id; the returned entry registers as
 *    `marker-image-<imageId>`.
 *  - `displayCssLongest` — the marker's target longest side in the
 *    consuming surface's CSS px, e.g. `pov.size.image_size ×
 *    PAINT_REFERENCE_WIDTH × surfaceScale` (use the LARGEST size any use
 *    of the image can request so the one registration covers them all).
 *  - `surfacePixelRatio` — framebuffer pixels per CSS px on that surface
 *    (preview: window.devicePixelRatio; export: payload.pixelRatio, which
 *    carries the SSAA factor).
 *
 *  Both surfaces call this with the same master; each gets a texture
 *  density matched to its own framebuffer while the natural CSS size (and
 *  therefore the `icon-size` emitted by resolveStaticPaints) is identical
 *  — the same invariance-under-pixelRatio contract `buildAllShapeIcons`
 *  documents. */
export function buildMarkerImageIcon(
  imageId: string,
  master: RgbaBitmap,
  displayCssLongest: number,
  surfacePixelRatio: number,
): MarkerImageRegistryEntry {
  if (master.width <= 0 || master.height <= 0) {
    throw new Error(
      `Marker image master has degenerate dims ${master.width}x${master.height}`,
    );
  }
  if (master.data.length !== master.width * master.height * 4) {
    throw new Error(
      `Marker image master byte length ${master.data.length} does not match ` +
        `${master.width}x${master.height}*4`,
    );
  }
  const longest = Math.max(master.width, master.height);
  const k = markerImagePixelRatio(displayCssLongest, surfacePixelRatio, longest);
  const targetLongest = MARKER_IMAGE_CANONICAL_SIZE * k;
  // Aspect-preserving target dims; the short side rounds to ≥1 texel.
  const scale = targetLongest / longest;
  const targetW = Math.max(1, Math.round(master.width * scale));
  const targetH = Math.max(1, Math.round(master.height * scale));
  const icon =
    targetW === master.width && targetH === master.height
      ? master
      : resampleRgba(master, targetW, targetH);
  return {
    id: markerImageIconId(imageId),
    icon,
    options: { sdf: false, pixelRatio: k },
  };
}

/** Resample a straight-alpha RGBA bitmap to `dstW × dstH`.
 *
 *  Pure and deterministic (shared by preview and the export sidecar — this
 *  function IS the parity guarantee, so it must not delegate to a
 *  platform canvas). Color channels are averaged PREMULTIPLIED and
 *  unpremultiplied on write: averaging straight RGB across a transparent
 *  edge would bleed the hidden RGB of zero-alpha pixels into the rim —
 *  the classic dark-fringe artifact.
 *
 *  Filter choice per direction:
 *  - Downscale (dst < src): exact area average (box) — every source texel
 *    contributes proportionally to its coverage, no aliasing.
 *  - Upscale: bilinear — smooth interpolation; area sampling upscaled
 *    would produce nearest-neighbor blocks.
 *  The image's aspect is preserved by the caller, so both axes always
 *  resample in the same direction. */
export function resampleRgba(
  src: RgbaBitmap,
  dstW: number,
  dstH: number,
): RgbaBitmap {
  const down = dstW < src.width || dstH < src.height;
  return down ? areaResample(src, dstW, dstH) : bilinearResample(src, dstW, dstH);
}

function areaResample(src: RgbaBitmap, dstW: number, dstH: number): RgbaBitmap {
  const out = new Uint8Array(dstW * dstH * 4);
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let oy = 0; oy < dstH; oy++) {
    const y0 = oy * sy;
    const y1 = y0 + sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(src.height, Math.ceil(y1));
    for (let ox = 0; ox < dstW; ox++) {
      const x0 = ox * sx;
      const x1 = x0 + sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(src.width, Math.ceil(x1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let y = iy0; y < iy1; y++) {
        // Fractional row coverage at the box edges.
        const cy = Math.min(y + 1, y1) - Math.max(y, y0);
        const row = y * src.width;
        for (let x = ix0; x < ix1; x++) {
          const cx = Math.min(x + 1, x1) - Math.max(x, x0);
          const w = cx * cy;
          const i = (row + x) * 4;
          const alpha = src.data[i + 3];
          // Premultiplied accumulation (straight-alpha input).
          r += src.data[i] * alpha * w;
          g += src.data[i + 1] * alpha * w;
          b += src.data[i + 2] * alpha * w;
          a += alpha * w;
          area += w;
        }
      }
      const o = (oy * dstW + ox) * 4;
      const outA = a / area;
      if (outA > 0) {
        // Unpremultiply back to straight alpha for addImage.
        out[o] = clampByte(r / a);
        out[o + 1] = clampByte(g / a);
        out[o + 2] = clampByte(b / a);
        out[o + 3] = clampByte(outA);
      }
      // outA === 0 → all four channels stay 0 (transparent black).
    }
  }
  return { width: dstW, height: dstH, data: out };
}

function bilinearResample(
  src: RgbaBitmap,
  dstW: number,
  dstH: number,
): RgbaBitmap {
  const out = new Uint8Array(dstW * dstH * 4);
  // Pixel-center mapping: dst center (ox+0.5) lands at src coordinate
  // (ox+0.5)·scale, sampled from the 2×2 neighborhood around it.
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let oy = 0; oy < dstH; oy++) {
    const fy = (oy + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = Math.min(1, Math.max(0, fy - y0));
    for (let ox = 0; ox < dstW; ox++) {
      const fx = (ox + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = Math.min(1, Math.max(0, fx - x0));
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const a00 = src.data[i00 + 3];
      const a10 = src.data[i10 + 3];
      const a01 = src.data[i01 + 3];
      const a11 = src.data[i11 + 3];
      const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      const o = (oy * dstW + ox) * 4;
      if (a > 0) {
        // Premultiplied interpolation, unpremultiplied write — same
        // rationale as areaResample.
        const r =
          src.data[i00] * a00 * w00 +
          src.data[i10] * a10 * w10 +
          src.data[i01] * a01 * w01 +
          src.data[i11] * a11 * w11;
        const g =
          src.data[i00 + 1] * a00 * w00 +
          src.data[i10 + 1] * a10 * w10 +
          src.data[i01 + 1] * a01 * w01 +
          src.data[i11 + 1] * a11 * w11;
        const b =
          src.data[i00 + 2] * a00 * w00 +
          src.data[i10 + 2] * a10 * w10 +
          src.data[i01 + 2] * a01 * w01 +
          src.data[i11 + 2] * a11 * w11;
        out[o] = clampByte(r / a);
        out[o + 1] = clampByte(g / a);
        out[o + 2] = clampByte(b / a);
        out[o + 3] = clampByte(a);
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

function clampByte(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}
