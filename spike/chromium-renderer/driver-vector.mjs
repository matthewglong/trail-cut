// Chromium-headless wobble spike — VECTOR EXTENSION.
//
// Sister of driver.mjs. Same camera path, same patch, but exercises the full
// visual surface TrailCut actually exports:
//   - OpenFreeMap "liberty" vector basemap (matches src/lib/mapVisuals/styleSpec.ts)
//   - GeoJSON route line (LineString with curvature, so edges sample sub-pixel)
//   - Waypoint circle markers
//   - Live-marker pulse with per-frame setPaintProperty (radius + opacity)
//
// Question this answers: does the anti-snap monkey-patch keep the patched path
// shimmer-free across SDF text labels, line edges, circle markers, and animated
// paint properties — or does it introduce shimmer on the vector visual surface?
//
// Usage:
//   cd spike/chromium-renderer
//   npm run spike:vector              # patched → frames-vector/
//   NO_PATCH=1 npm run spike:vector   # no patch → frames-vector-nopatch/

import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const NO_PATCH = process.env.NO_PATCH === '1';
const FRAMES_DIR = resolve(here, NO_PATCH ? 'frames-vector-nopatch' : 'frames-vector');

const VIEWPORT_W = 540;
const VIEWPORT_H = 960;
const FRAMES = 60;

// Mirror driver.mjs camera params exactly.
const START_LNG = -122.4194;
const START_LAT = 37.7749;
const LNG_PER_FRAME = 1.6e-5;
const ZOOM = 14;
const PITCH = 0;
const BEARING = 0;

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

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
    const FRAMES = ${FRAMES};
    const START_LNG = ${START_LNG};
    const START_LAT = ${START_LAT};
    const LNG_PER_FRAME = ${LNG_PER_FRAME};

    window.map = new maplibregl.Map({
      container: 'map',
      style: ${JSON.stringify(STYLE_URL)},
      center: [START_LNG, START_LAT],
      zoom: ${ZOOM},
      pitch: ${PITCH},
      bearing: ${BEARING},
      interactive: false,
      fadeDuration: 0,
      attributionControl: false,
    });

    // ──── ANTI-SNAP MONKEY-PATCH ──── (identical to driver.mjs)
    if (!${NO_PATCH}) {
      const _origRender = window.map.painter.render.bind(window.map.painter);
      window.map.painter.render = function(style, options) {
        return _origRender(style, { ...options, moving: true });
      };
    }
    // ──── END PATCH ────

    // Build a synthetic route along the camera pan path. Use a sin-wave in
    // lat so the line carries diagonal/curved edges → anti-aliased pixels
    // sub-sample, which is exactly where shimmer manifests.
    function buildRoute() {
      const N = 50;
      const totalLngSpan = LNG_PER_FRAME * FRAMES;
      const lngStart = START_LNG - 0.0015;
      const lngEnd   = START_LNG + totalLngSpan + 0.0015;
      const coords = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const lng = lngStart + t * (lngEnd - lngStart);
        const lat = START_LAT + Math.sin(t * Math.PI * 4) * 0.0008;
        coords.push([lng, lat]);
      }
      return coords;
    }

    window.mapReady = new Promise((res) => {
      window.map.once('load', () => {
        const route = buildRoute();
        window._route = route;

        // Route line — bright, thick, easy to spot edge shimmer against
        // the OpenFreeMap basemap.
        window.map.addSource('route', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: route },
          },
        });
        window.map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#ff2d2d',
            'line-width': 6,
            'line-opacity': 0.95,
          },
        });

        // 5 waypoint markers spread along the route.
        const waypointIdx = [4, 14, 24, 34, 44];
        window.map.addSource('waypoints', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: waypointIdx.map((i) => ({
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: route[i] },
            })),
          },
        });
        window.map.addLayer({
          id: 'waypoint-markers',
          type: 'circle',
          source: 'waypoints',
          paint: {
            'circle-radius': 8,
            'circle-color': '#ffd400',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#1a1a1a',
          },
        });

        // Live "current position" marker — one circle whose radius and
        // opacity are recomputed per frame inside setCamera().
        // Anchor near the middle of the camera pan so it stays in frame.
        const pulseLng = START_LNG + (LNG_PER_FRAME * FRAMES) * 0.5;
        // Find route lat at that lng by linear interpolation of nearest pts.
        let pulseLat = START_LAT;
        for (let i = 0; i < route.length - 1; i++) {
          if (route[i][0] <= pulseLng && route[i + 1][0] >= pulseLng) {
            const f = (pulseLng - route[i][0]) / (route[i + 1][0] - route[i][0]);
            pulseLat = route[i][1] + f * (route[i + 1][1] - route[i][1]);
            break;
          }
        }
        window.map.addSource('pulse', {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [pulseLng, pulseLat] },
          },
        });
        window.map.addLayer({
          id: 'pulse-marker',
          type: 'circle',
          source: 'pulse',
          paint: {
            'circle-radius': 10,
            'circle-color': '#00e5ff',
            'circle-opacity': 0.7,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#003a44',
          },
        });

        res();
      });
    });

    // setCamera now also drives the pulse animation deterministically from
    // the frame index (pure function of i — required by spec).
    window.setCamera = (lng, lat, frameIdx) => {
      const phase = frameIdx * 0.2;
      const radius  = 10 + Math.sin(phase) * 5;          // 5–15 px
      const opacity = 0.55 + Math.sin(phase) * 0.4;       // 0.15–0.95
      window.map.setPaintProperty('pulse-marker', 'circle-radius', radius);
      window.map.setPaintProperty('pulse-marker', 'circle-opacity', opacity);

      window._frameDone = false;
      window.map.jumpTo({ center: [lng, lat], zoom: ${ZOOM}, pitch: ${PITCH}, bearing: ${BEARING} });
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
      styleLoaded: window.map.isStyleLoaded(),
    });
  </script>
</body>
</html>`;

async function main() {
  console.error(`[spike-vector] launching headless Chrome (NO_PATCH=${NO_PATCH})`);
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

  console.error('[spike-vector] loading page');
  await page.setContent(HTML, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.mapReady);
  console.error('[spike-vector] map + overlays ready');

  for (let i = 0; i < FRAMES; i++) {
    const lng = START_LNG + i * LNG_PER_FRAME;
    await page.evaluate((lng, lat, idx) => window.setCamera(lng, lat, idx), lng, START_LAT, i);
    try {
      await page.waitForFunction(() => window._frameDone === true, { timeout: 30_000, polling: 50 });
    } catch (e) {
      const diag = await page.evaluate(() => window.diag());
      console.error(`[spike-vector] frame ${i} timeout. diag:`, diag);
      throw e;
    }
    const buf = await page.screenshot({ type: 'png' });
    const out = resolve(FRAMES_DIR, `frame-${String(i).padStart(3, '0')}.png`);
    writeFileSync(out, buf);
    if (i % 10 === 0) console.error(`[spike-vector] wrote frame ${i}/${FRAMES}`);
  }
  console.error(`[spike-vector] done — ${FRAMES} frames in ${FRAMES_DIR}`);

  await browser.close();
}

main().catch((e) => {
  console.error('[spike-vector] failed:', e);
  process.exit(1);
});
