// Import flow for marker-library images (schema v11; generalized from the
// v10 single custom POV image).
//
// One call = the full pipeline, for ONE OR MANY files:
//   1. multi-select file dialog (PNG/SVG),
//   2. per file: `import_marker_image` — Rust validates (magic bytes, size
//      cap) and copies the ORIGINAL into the bundle's `assets/`,
//   3. per file: `bakeMarkerMaster` — the webview decodes/rasterizes it to
//      the canonical render-asset PNG (≤1024 texels, ICC folded into sRGB —
//      see `lib/markerImageBrowser.ts`),
//   4. per file: `save_marker_icon` — Rust re-validates the bake (PNG
//      parse, texture cap) and writes it atomically; its parsed dims are
//      authoritative.
//
// Returns the `MarkerImageRef[]` of successful imports, deduped by content
// hash against `existingIds` (the current library) AND within the batch —
// re-importing an image the library already holds is a no-op, not a
// duplicate tile. The caller owns the library write. Per-file errors
// accumulate on `error` (joined, human-readable) and never abort the rest
// of the batch; user-cancel resolves to `[]`.

import { useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { MarkerImageRef } from '../types';
import { bakeMarkerMaster } from '../lib/markerImageBrowser';

/** Wire shape of the `import_marker_image` command result. */
interface MarkerImportInfo {
  hash: string;
  kind: 'png' | 'svg';
  source_file: string;
  source_name: string;
  source_abs_path: string;
}

/** Wire shape of the `save_marker_icon` command result. */
interface MarkerIconInfo {
  icon_file: string;
  width: number;
  height: number;
}

export interface UseMarkerImageImport {
  /** Run the dialog → validate/copy → bake → persist pipeline for every
   *  picked file. Resolves to the new refs to append to
   *  `mapSettings.marker_images` (already-present ids are skipped), or `[]`
   *  on user-cancel / all-failed. */
  importImages: (existingIds: readonly string[]) => Promise<MarkerImageRef[]>;
  /** True while picked files are being validated/baked/persisted. */
  importing: boolean;
  /** Last batch's error summary (one line per failed file), human-readable.
   *  Cleared on the next attempt. */
  error: string | null;
}

export function useMarkerImageImport(
  projectDir: string | null | undefined,
): UseMarkerImageImport {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importImages = async (
    existingIds: readonly string[],
  ): Promise<MarkerImageRef[]> => {
    setError(null);
    if (!projectDir) {
      setError('No open project — save the project before adding marker images.');
      return [];
    }
    let selected: string | string[] | null = null;
    try {
      selected = await open({
        multiple: true,
        filters: [{ name: 'Images (PNG, SVG)', extensions: ['png', 'svg'] }],
      });
    } catch {
      return []; // dialog dismissed abnormally — treat as cancel
    }
    const paths = typeof selected === 'string' ? [selected] : selected ?? [];
    if (paths.length === 0) return [];

    setImporting(true);
    const out: MarkerImageRef[] = [];
    const seen = new Set(existingIds);
    const failures: string[] = [];
    try {
      for (const filePath of paths) {
        try {
          const info = await invoke<MarkerImportInfo>('import_marker_image', {
            filePath,
            projectDir,
          });
          if (seen.has(info.hash)) continue; // content-hash dedupe
          const baked = await bakeMarkerMaster(
            convertFileSrc(info.source_abs_path),
            info.kind,
          );
          const icon = await invoke<MarkerIconInfo>('save_marker_icon', {
            projectDir,
            hash: info.hash,
            pngBase64: baked.pngBase64,
          });
          seen.add(info.hash);
          out.push({
            id: info.hash,
            icon_file: icon.icon_file,
            source_file: info.source_file,
            source_name: info.source_name,
            width: icon.width,
            height: icon.height,
          });
        } catch (e) {
          const msg =
            typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
          const name = filePath.split('/').pop() ?? filePath;
          failures.push(`${name}: ${msg}`);
        }
      }
      if (failures.length > 0) setError(failures.join('\n'));
      return out;
    } finally {
      setImporting(false);
    }
  };

  return { importImages, importing, error };
}
