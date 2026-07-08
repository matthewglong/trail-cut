// GL JS halo group-composite parity harness — browser entry.
//
// The maplibre-gl twin of the native A/B driver (.spike/halo-composite/
// render-halo-ab.js). Runs the SAME fixture (.spike/halo-composite/
// halo-fixture.js, reused verbatim through esbuild) in the real webview
// renderer and measures halo self-overlap coverage, so the preview's
// group-opacity semantics can be proven identical to the export's.
//
// Exposes window.HALO.run(mode, opts) → { report, png } where:
//   mode 'baseline' — the shipping artifact: raw (un-remapped) halo opacities,
//                     NO group composite. Reproduces the darkening so the
//                     fixture is proven to still exercise the bug.
//   mode 'over'     — the production path: mapVisuals' remapped in-FBO
//                     opacities (already in resolution.paints) + the
//                     resolution.haloComposites config via setGroupComposite.
//
// Coverage recovery is identical to the native driver: flat #404040 (=64)
// background, solid halo #00d4ff, so for any halo-only pixel
//   a = (pix_B − 64) / (255 − 64)
// on the blue channel. Screen sample points come from maplibre's own
// map.project() (the honest on-screen location of each lng/lat) rather than
// the native driver's hand-rolled mercator — same fixture meters, same
// coverage math.
import maplibregl from 'maplibre-gl';
import { buildFixture, m } from '@fixture';
import * as MV from '@mapvisuals';

const WIDTH = 1600;
const HEIGHT = 900;

function stats(values) {
  const v = values.filter((x) => !Number.isNaN(x));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return {
    n: v.length,
    mean: +mean.toFixed(4),
    sd: +sd.toFixed(4),
    min: +Math.min(...v).toFixed(4),
    max: +Math.max(...v).toFixed(4),
  };
}

/** Read the map's drawing buffer into a top-left-origin RGBA byte array via a
 *  2D canvas (drawImage flips the WebGL bottom-left buffer to top-left, the
 *  same orientation the native driver's PNG used). */
function readPixels(map) {
  const glCanvas = map.getCanvas();
  const c2d = document.createElement('canvas');
  c2d.width = WIDTH;
  c2d.height = HEIGHT;
  const ctx = c2d.getContext('2d');
  ctx.drawImage(glCanvas, 0, 0, WIDTH, HEIGHT);
  return { data: ctx.getImageData(0, 0, WIDTH, HEIGHT).data, png: c2d.toDataURL('image/png') };
}

function coverageAt(data, map, mx, my) {
  const p = map.project(m(mx, my));
  const xi = Math.round(p.x), yi = Math.round(p.y);
  if (xi < 0 || yi < 0 || xi >= WIDTH || yi >= HEIGHT) return NaN;
  const o = (yi * WIDTH + xi) * 4;
  return (data[o + 2] - 64) / (255 - 64);
}

/** The measurement sections, ported point-for-point from render-halo-ab.js.
 *  All sample coordinates are in the fixture's local meters. */
function measure(data, map) {
  const cov = (mx, my) => coverageAt(data, map, mx, my);

  // Control: radial profile across segment A at its midpoint. A runs
  // (-340,-110)→(-180,-60): direction (160,50)/167.6, normal (-50,160)/167.6.
  const mid = [-260, -85];
  const nrm = [-50 / 167.63, 160 / 167.63];
  const profile = [];
  for (let d = -30; d <= 30; d += 1) {
    profile.push(+cov(mid[0] + nrm[0] * d, mid[1] + nrm[1] * d).toFixed(4));
  }
  // Single-coat reference: the halo plateau just outside the route line core,
  // sampled 2.4..4 m on both sides of segment A.
  const plateau = stats(
    [2.4, 2.8, 3.2, 3.6, 4, -2.4, -2.8, -3.2, -3.6, -4].map((d) =>
      cov(mid[0] + nrm[0] * d, mid[1] + nrm[1] * d),
    ),
  );
  // Overlap uniformity: the band midline between C's legs (y = −3 m), x∈[20,230]
  // every 2 m, EXCLUDING x∈[105,135] where segment D adds a third coat.
  const overlap = stats(
    Array.from({ length: 106 }, (_, i) => 20 + i * 2)
      .filter((x) => x < 105 || x > 135)
      .map((x) => cov(x, -3)),
  );
  // Jitter sunbursts: two strips 8 m off B's centerline.
  const jitter = stats(
    Array.from({ length: 282 }, (_, i) => {
      const x = -175 + (i % 141);
      const y = -60 + (i < 141 ? 8 : -8);
      return cov(x, y);
    }),
  );
  // X crossings (D at x=120 crossing C's legs at y=0 and y=−6).
  const xcross = stats(
    [[116, 4], [124, 4], [116, -10], [124, -10]].map(([mx, my]) => cov(mx, my)),
  );

  return { plateau, overlap, jitter, xcross, profile };
}

/** Recover the raw (pre-remap) halo opacities from mapVisuals' remapped
 *  in-FBO values + the composite opacity g, inverting haloGroupPolicy:
 *    outer = outerIn · g ;  core = coreIn === 0 ? 0 : 1 − (1−g)/(1−outer)
 *  These reproduce the shipping direct-blend artifact for the baseline gate. */
function rawHaloOpacities(outerIn, coreIn, g) {
  const outer = outerIn * g;
  const core = coreIn === 0 ? 0 : 1 - (1 - g) / (1 - outer);
  return { outer, core };
}

async function idle(map) {
  await new Promise((resolve) => map.once('idle', resolve));
  // A second RAF settles any post-idle repaint (gradient/group composite).
  map.redraw();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

window.HALO = {
  async probeAccumulation() {
    const fixture = buildFixture({ falloff: 0.7 });
    const container = document.getElementById('map');
    container.style.width = WIDTH + 'px';
    container.style.height = HEIGHT + 'px';
    const map = new maplibregl.Map({
      container, style: fixture.style, center: fixture.camera.center, zoom: fixture.camera.zoom,
      bearing: 0, pitch: 0, interactive: false, fadeDuration: 0, attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false },
    });
    await new Promise((r) => map.once('load', r));
    for (const [id, spec] of fixture.sources) map.addSource(id, spec);
    for (const layer of fixture.layers) map.addLayer(layer);
    for (const [l, p, v] of fixture.paints) map.setPaintProperty(l, p, v);
    for (const [l, p, v] of fixture.layouts) map.setLayoutProperty(l, p, v);
    map.setGroupComposite([{ layers: ['route-full-halo'], opacity: 1 }]); // solo outer, opacity 0.557 in-FBO
    await new Promise((r) => map.once('idle', r));
    const read = () => { const { data } = readPixels(map); return coverageAt(data, map, -260, -82.5); };
    const out = {};
    map.redraw(); out.render1 = +read().toFixed(4);
    map.redraw(); out.render2 = +read().toFixed(4);
    map.redraw(); map.redraw(); out.render4 = +read().toFixed(4);
    map.remove(); container.innerHTML = '';
    return out;
  },
  capability: {
    namespace: maplibregl.groupComposite === true,
    method: null, // filled per-map below
  },
  async run(mode, opts = {}) {
    const fixture = buildFixture(opts);
    // haloComposites lives on the resolver's return, not on the (older)
    // fixture object — recompute from the SAME mapSettings.
    const resolution = MV.resolveStaticPaints(fixture.mapSettings);
    const routeGroup = resolution.haloComposites.find((grp) =>
      grp.layers.includes('route-full-halo'),
    );

    const container = document.getElementById('map');
    container.style.width = WIDTH + 'px';
    container.style.height = HEIGHT + 'px';

    const map = new maplibregl.Map({
      container,
      style: fixture.style,
      center: fixture.camera.center,
      zoom: fixture.camera.zoom,
      bearing: 0,
      pitch: 0,
      interactive: false,
      fadeDuration: 0,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false },
    });
    window.HALO.capability.method = typeof map.setGroupComposite === 'function';

    await new Promise((resolve) => map.once('load', resolve));

    for (const [id, spec] of fixture.sources) map.addSource(id, spec);
    for (const layer of fixture.layers) map.addLayer(layer);
    for (const [l, p, v] of fixture.paints) map.setPaintProperty(l, p, v);
    for (const [l, p, v] of fixture.layouts) map.setLayoutProperty(l, p, v);
    for (const [l, v] of fixture.gradients) map.setPaintProperty(l, 'line-gradient', v);

    // fixture.paints carry mapVisuals' REMAPPED in-FBO opacities (the resolver
    // bakes haloGroupPolicy in). That is exactly the 'over' path.
    const outerIn = fixture.paints.find(([l, p]) => l === 'route-full-halo' && p === 'line-opacity')[2];
    const coreIn = fixture.paints.find(([l, p]) => l === 'route-full-halo-core' && p === 'line-opacity')[2];

    if (mode === 'diag-fbo') {
      // Recovered coverage == raw FBO alpha (composite opacity 1).
      const layers = opts.soloOuter ? ['route-full-halo'] : routeGroup.layers;
      map.setGroupComposite([{ layers, opacity: 1 }]);
    } else if (mode === 'diag-direct') {
      // Same remapped in-FBO opacities, drawn straight to the main FB, NO
      // composite — the direct blend of outerIn & coreIn.
    } else if (mode === 'baseline') {
      const { outer, core } = rawHaloOpacities(outerIn, coreIn, routeGroup.opacity);
      map.setPaintProperty('route-full-halo', 'line-opacity', outer);
      map.setPaintProperty('route-full-halo-core', 'line-opacity', core);
      // no setGroupComposite → shipping direct-blend artifact
    } else if (mode === 'over') {
      if (maplibregl.groupComposite !== true || typeof map.setGroupComposite !== 'function') {
        throw new Error('FATAL: patched maplibre-gl lacks the groupComposite capability');
      }
      map.setGroupComposite([routeGroup]);
    } else {
      throw new Error('unknown mode ' + mode);
    }

    map.jumpTo({ center: fixture.camera.center, zoom: fixture.camera.zoom, bearing: 0, pitch: 0 });
    await idle(map);

    const { data, png } = readPixels(map);
    const report = opts.gradient ? null : measure(data, map);
    const groupOpacity = routeGroup.opacity;
    const inFbo = { outerIn, coreIn };
    map.remove();
    container.innerHTML = '';
    return { mode, report, png, groupOpacity, inFbo };
  },
};
