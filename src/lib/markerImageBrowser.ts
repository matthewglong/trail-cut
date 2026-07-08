// Browser-side half of the marker-image library pipeline: everything that needs
// a real image decoder / SVG renderer / canvas, which only exists in the
// webview. The pure math (resampling, registration density, icon-size
// bridge) lives in `mapVisuals/markerImage.ts` and is shared with the export
// sidecar; THIS module is preview/import-only and must never be imported by
// the sidecar bundle.
//
// Two jobs:
//
//  - `bakeMarkerMaster` (import time, once per upload): decode the original
//    upload and re-encode it as the canonical render-asset PNG — longest
//    side capped at MAX_MASTER_TEXELS (the export renderer's addImage
//    texture cap). Decoding through the canvas folds ICC profiles into
//    sRGB and rasterizes SVG with the platform's real SVG engine; the
//    resulting PNG is what BOTH the preview and the export sidecar consume,
//    so the two can never diverge on color management or SVG fidelity.
//
//  - `loadMarkerMasterRgba` (preview render time): decode the baked PNG back
//    to straight-alpha RGBA for `buildMarkerImageIcon` → `map.addImage`.

import {
  MAX_MASTER_TEXELS,
  type RgbaBitmap,
} from './mapVisuals/markerImage';

/** Decoded bake result, ready for the `save_marker_icon` command. */
export interface BakedMarkerMaster {
  /** Base64 (standard alphabet) of the PNG bytes. */
  pngBase64: string;
  width: number;
  height: number;
}

/** Fetch a bundle asset through the Tauri asset protocol and hand back its
 *  bytes. Split out for testability; callers pass `convertFileSrc(absPath)`. */
async function fetchBytes(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load marker image asset (${res.status}) from ${url}`);
  }
  return res.blob();
}

/** Decode any supported source (baked PNG, original PNG, or SVG) to an
 *  element the canvas can draw, with its intrinsic pixel dims resolved.
 *
 *  SVG needs the `HTMLImageElement` path: `createImageBitmap(svgBlob)` is
 *  unsupported or size-ambiguous across engines, while `<img src=blobURL>`
 *  uses the full platform SVG renderer. Dimension resolution for SVGs
 *  without absolute width/height falls back to the viewBox aspect at
 *  MAX_MASTER_TEXELS on the longest side — "make it as sharp as the
 *  renderer can ever consume". */
async function decodeToDrawable(
  blob: Blob,
  kind: 'png' | 'svg',
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (kind === 'png') {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  }
  // SVG: object-URL + HTMLImageElement.
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('SVG failed to decode in the webview'));
      el.src = url;
    });
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) {
      // No intrinsic size (viewBox-only SVG). Recover the aspect from the
      // viewBox and rasterize at the maximum useful density.
      const text = await blob.text();
      const vb = /viewBox\s*=\s*["']\s*([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/.exec(
        text,
      );
      const vbW = vb ? Math.abs(parseFloat(vb[3])) : 1;
      const vbH = vb ? Math.abs(parseFloat(vb[4])) : 1;
      const aspect = vbW > 0 && vbH > 0 ? vbW / vbH : 1;
      if (aspect >= 1) {
        w = MAX_MASTER_TEXELS;
        h = Math.max(1, Math.round(MAX_MASTER_TEXELS / aspect));
      } else {
        h = MAX_MASTER_TEXELS;
        w = Math.max(1, Math.round(MAX_MASTER_TEXELS * aspect));
      }
    }
    return { source: img, width: w, height: h };
  } finally {
    // The Image holds its own decode; the object URL can be revoked once
    // the promise settles (drawImage below re-rasterizes from the element).
    // NOTE: revoke AFTER load — revoking before onload races the fetch.
    URL.revokeObjectURL(url);
  }
}

function drawToCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D canvas context unavailable for POV image bake');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return { canvas, ctx };
}

/** Bake an imported original (PNG or SVG, already copied into the bundle by
 *  `import_pov_image`) into the canonical render-asset PNG: decoded via the
 *  platform engine, downscaled to ≤ MAX_MASTER_TEXELS on the longest side
 *  (aspect preserved), re-encoded as a plain 8-bit sRGB PNG. */
export async function bakeMarkerMaster(
  assetUrl: string,
  kind: 'png' | 'svg',
): Promise<BakedMarkerMaster> {
  const blob = await fetchBytes(assetUrl);
  const { source, width, height } = await decodeToDrawable(blob, kind);
  if (!width || !height) {
    throw new Error('POV image decoded with zero dimensions');
  }
  const longest = Math.max(width, height);
  const scale = Math.min(1, MAX_MASTER_TEXELS / longest);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const { canvas } = drawToCanvas(source, outW, outH);
  const pngBlob: Blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) =>
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
            'image/png',
          ),
        );
  const buf = new Uint8Array(await pngBlob.arrayBuffer());
  return { pngBase64: bytesToBase64(buf), width: outW, height: outH };
}

/** Decode the baked render-asset PNG to straight-alpha RGBA at its natural
 *  size — the master bitmap `buildMarkerImageIcon` resamples per registration. */
export async function loadMarkerMasterRgba(assetUrl: string): Promise<RgbaBitmap> {
  const blob = await fetchBytes(assetUrl);
  const bitmap = await createImageBitmap(blob);
  const { ctx } = drawToCanvas(bitmap, bitmap.width, bitmap.height);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    width: bitmap.width,
    height: bitmap.height,
    data: new Uint8Array(imageData.data.buffer.slice(0)),
  };
}

/** Chunked btoa — String.fromCharCode(...bigArray) blows the arg limit on
 *  large PNGs. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
