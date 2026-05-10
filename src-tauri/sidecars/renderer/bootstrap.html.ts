// Builds the HTML document the worker hands to page.setContent() at boot.
// The bundled page-init bundle (page/init.ts → dist/page-init.bundle.js) is
// inlined into a single <script> tag; maplibre-gl-js's CSS is inlined
// likewise. No external network fetches happen during page boot — every
// resource the page needs is in this single document, which lets us keep
// page boot deterministic and offline-safe.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the path to the bundled page-init script relative to where this
 *  worker binary runs. Both this module and dist/page-init.bundle.js live
 *  inside the renderer sidecar — at dev-build time that's the
 *  source tree's dist/, at production-build time it's the bundled sidecar's
 *  resource directory. The same relative resolution holds in both cases. */
function pageInitBundlePath(): string {
  // __dirname from the bundled CJS worker resolves to the dist/ dir at
  // runtime. The page bundle sits next to the worker bundle.
  return join(__dirname, 'page-init.bundle.js');
}

/** maplibre-gl-js's stylesheet path inside node_modules. We inline its
 *  contents at HTML-construction time so the page has the needed CSS for
 *  attribution/popup elements maplibre may inject (we disable attribution
 *  but a missing stylesheet still produces console noise). */
function maplibreCssPath(): string {
  // From the worker bundle's dist/, walk up to repo root via ../../../../
  // and into node_modules. dev: dist is at sidecars/renderer/dist/;
  // production sidecar layout will be the same relative shape.
  return join(__dirname, '..', '..', '..', '..', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.css');
}

let cachedHtml: string | null = null;

export function buildBootstrapHtml(): string {
  if (cachedHtml !== null) return cachedHtml;
  const pageInitJs = readFileSync(pageInitBundlePath(), 'utf8');
  let css = '';
  try {
    css = readFileSync(maplibreCssPath(), 'utf8');
  } catch {
    // Stylesheet missing isn't fatal — the renderer doesn't display any of
    // the UI elements maplibre-gl ships CSS for. Worth a stderr breadcrumb
    // since a missing CSS file usually means a broken sidecar bundle.
    process.stderr.write('[renderer] maplibre-gl.css not found; continuing without it\n');
  }

  // Single inline document: no <head> network fetches, no external scripts.
  // Body is sized to 100% so the #map container's explicit pixel size from
  // __init governs the WebGL framebuffer size.
  cachedHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; }
  #map { width: 100%; height: 100%; }
  ${css}
</style>
</head>
<body>
<div id="map"></div>
<script>
${pageInitJs}
</script>
</body>
</html>
`;
  return cachedHtml;
}
