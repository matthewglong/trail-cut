// Chromium-headless wobble spike.
//
// Loads maplibre-gl-js inside headless Chrome with a satellite raster style,
// drives a slow lateral pan at z=14 over N frames using setNow() + jumpTo()
// for deterministic per-frame state, captures each frame as PNG.
//
// Question this answers: does maplibre-gl-js in Chromium produce wobble-free
// slow pans on raster tiles, the way maplibre-gl-native (current exporter)
// does not?
//
// Usage:
//   cd spike/chromium-renderer
//   npm install        # downloads bundled Chromium (~150 MB, one-time)
//   npm run spike      # writes frames/frame-NNN.png
//
// Then visually inspect the frames as a sequence (Finder Quick Look slideshow,
// or `ffmpeg -framerate 30 -i frames/frame-%03d.png out.mp4 && open out.mp4`).

import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Set NO_PATCH=1 to render WITHOUT the anti-snap monkey-patch (reproduces wobble).
const NO_PATCH = process.env.NO_PATCH === '1';
const FRAMES_DIR = resolve(here, NO_PATCH ? 'frames-nopatch' : 'frames');

const VIEWPORT_W = 540;
const VIEWPORT_H = 960;
const FRAMES = 60;

// Slow lateral pan at z=14 SF: ~0.3 px / frame. Picked deliberately below the
// 1-px-per-frame threshold so the C++ snap quantization would visibly wobble
// here. If Chromium-gl-js produces smooth motion at this rate, the snap path
// isn't engaging the way it does in maplibre-gl-native static mode.
const START_LNG = -122.4194;
const START_LAT = 37.7749;
const LNG_PER_FRAME = 1.6e-5;
const ZOOM = 14;
const PITCH = 0;       // raster-only style typically rejects pitch
const BEARING = 0;

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link href="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.css" rel="stylesheet">
  <style>html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; }</style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js"></script>
  <script>
    const SAT_STYLE = {
      version: 8,
      sources: {
        satellite: {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Esri World Imagery',
          maxzoom: 19
        }
      },
      layers: [{ id: 'satellite-base', type: 'raster', source: 'satellite' }]
    };

    window.map = new maplibregl.Map({
      container: 'map',
      style: SAT_STYLE,
      center: [${START_LNG}, ${START_LAT}],
      zoom: ${ZOOM},
      pitch: ${PITCH},
      bearing: ${BEARING},
      interactive: false,
      fadeDuration: 0,
      attributionControl: false,
    });

    // ──── ANTI-SNAP MONKEY-PATCH ────
    // Raster draw path uses align = !painter.options.moving, which is
    // set from map.isMoving() per render. We cannot override isMoving
    // globally (idle events depend on it), so we wrap painter.render to
    // force options.moving=true at the draw layer only.
    if (!${NO_PATCH}) {
      const _origRender = window.map.painter.render.bind(window.map.painter);
      window.map.painter.render = function(style, options) {
        return _origRender(style, { ...options, moving: true });
      };
    }
    // ──── END PATCH ────

    window.mapReady = new Promise((res) => window.map.once('load', res));

    window.setCamera = (lng, lat) => {
      window._frameDone = false;
      window.map.jumpTo({ center: [lng, lat], zoom: ${ZOOM}, pitch: ${PITCH}, bearing: ${BEARING} });
      // After idle, rAF twice to ensure the post-jump frame has painted
      // before the screenshot is taken. Without this, idle can fire before
      // the new frame's paint commits → screenshot captures previous frame.
      window.map.once('idle', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window._frameDone = true;
        }));
      });
    };
    window.diag = () => ({
      done: !!window._frameDone,
      tilesLoaded: window.map.areTilesLoaded(),
      loaded: window.map.loaded(),
      moving: window.map.isMoving(),
      zooming: window.map.isZooming(),
    });
  </script>
</body>
</html>`;

async function main() {
  console.error('[spike] launching headless Chrome');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 },
    protocolTimeout: 60_000,
  });

  const page = await browser.newPage();
  page.on('console', (msg) => console.error(`[browser ${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[browser error] ${err.message}`));

  console.error('[spike] loading page');
  await page.setContent(HTML, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.mapReady);
  console.error('[spike] map ready');

  for (let i = 0; i < FRAMES; i++) {
    const lng = START_LNG + i * LNG_PER_FRAME;
    await page.evaluate((lng, lat) => window.setCamera(lng, lat), lng, START_LAT);
    try {
      await page.waitForFunction(() => window._frameDone === true, { timeout: 15_000, polling: 50 });
    } catch (e) {
      const diag = await page.evaluate(() => window.diag());
      console.error(`[spike] frame ${i} timeout. diag:`, diag);
      throw e;
    }
    const buf = await page.screenshot({ type: 'png' });
    const out = resolve(FRAMES_DIR, `frame-${String(i).padStart(3, '0')}.png`);
    writeFileSync(out, buf);
    if (i % 10 === 0) console.error(`[spike] wrote frame ${i}/${FRAMES}`);
  }
  console.error(`[spike] done — ${FRAMES} frames in ${FRAMES_DIR}`);

  await browser.close();
}

main().catch((e) => {
  console.error('[spike] failed:', e);
  process.exit(1);
});
