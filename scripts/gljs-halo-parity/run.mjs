// GL JS halo group-composite parity harness — node driver.
//
// Builds the browser harness (esbuild) against a chosen maplibre-gl source,
// serves it, drives it in headless Chromium (Playwright), and writes PNGs +
// a JSON report to out/. Mirrors .spike/halo-composite/render-halo-ab.js as
// the GL JS parity gate.
//
// Runs three builds:
//   1. patched  — node_modules/maplibre-gl/dist/maplibre-gl-dev.js (our patch)
//   2. pristine — the untouched 5.22.0 dev bundle (npm pack, extracted)
// baseline + over modes at falloff 0 and 0.7 render against `patched`; the
// pristine build renders ONLY the unused-feature baseline, byte-compared with
// the patched baseline for the no-regression gate.
//
// Usage: node scripts/gljs-halo-parity/run.mjs
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { chromium } from 'playwright';

const WIDTH = 1600;
const HEIGHT = 900;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const SPIKE = path.join(REPO, '.spike/halo-composite');
const FIXTURE = path.join(SPIKE, 'halo-fixture.js');
const MAPVISUALS_ENTRY = path.join(SPIKE, 'mapvisuals-entry.ts');
const PATCHED_MAPLIBRE = path.join(REPO, 'node_modules/maplibre-gl/dist/maplibre-gl-dev.js');

fs.mkdirSync(OUT, { recursive: true });

// ---- esbuild: bundle the harness against a given maplibre source ----------
// Plugin redirects: the bare `maplibre-gl` specifier and the fixture's
// `@fixture` / `@mapvisuals` / stale `./dist/mapvisuals.cjs` requires resolve
// to the chosen maplibre bundle and a FRESH build of the repo's mapVisuals
// (straight from src/lib/mapVisuals via the spike's entry .ts).
async function buildHarness(maplibreSource, outfile) {
  const redirect = {
    name: 'halo-parity-redirect',
    setup(build) {
      build.onResolve({ filter: /^maplibre-gl$/ }, () => ({ path: maplibreSource }));
      build.onResolve({ filter: /^@fixture$/ }, () => ({ path: FIXTURE }));
      build.onResolve({ filter: /^@mapvisuals$/ }, () => ({ path: MAPVISUALS_ENTRY }));
      // halo-fixture.js requires './dist/mapvisuals.cjs' — redirect that stale
      // node bundle to a fresh TS build from current src.
      build.onResolve({ filter: /mapvisuals\.cjs$/ }, () => ({ path: MAPVISUALS_ENTRY }));
    },
  };
  await esbuild.build({
    entryPoints: [path.join(HERE, 'harness-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile,
    plugins: [redirect],
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}

// ---- pristine maplibre-gl dev bundle (untouched 5.22.0) -------------------
function ensurePristineMaplibre() {
  const dest = path.join(OUT, '_pristine', 'maplibre-gl-dev.js');
  if (fs.existsSync(dest)) return dest;
  const tmp = path.join(OUT, '_pack');
  fs.mkdirSync(tmp, { recursive: true });
  const pack = spawnSync('npm', ['pack', 'maplibre-gl@5.22.0', '--pack-destination', tmp], {
    cwd: REPO, encoding: 'utf8',
  });
  if (pack.status !== 0) throw new Error('npm pack failed: ' + pack.stderr);
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  spawnSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp], { encoding: 'utf8' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(tmp, 'package/dist/maplibre-gl-dev.js'), dest);
  return dest;
}

// ---- tiny static server ---------------------------------------------------
function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(dir, rel === '/' ? 'harness.html' : rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function savePng(dataUrl, file) {
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}
function md5(file) {
  return createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

async function runMode(page, mode, opts) {
  return page.evaluate(async ([m, o]) => window.HALO.run(m, o), [mode, opts]);
}

(async () => {
  const results = { generatedAt: new Date().toISOString(), capability: null, runs: {}, noRegression: null };

  // Build patched harness, launch one browser reused across navigations.
  await buildHarness(PATCHED_MAPLIBRE, path.join(HERE, 'harness.bundle.js'));
  const { server, port } = await serve(HERE);
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('  [page error]', msg.text()); });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));

  const modes = [
    { key: 'falloff0', opts: { falloff: 0 } },
    { key: 'falloff0.7', opts: { falloff: 0.7 } },
  ];

  for (const { key, opts } of modes) {
    for (const mode of ['baseline', 'over']) {
      await page.goto(`http://127.0.0.1:${port}/harness.html`);
      const r = await runMode(page, mode, opts);
      if (!results.capability) {
        const cap = await page.evaluate(() => window.HALO.capability);
        results.capability = cap;
      }
      savePng(r.png, path.join(OUT, `${mode}-${key}-solid.png`));
      results.runs[`${mode}-${key}`] = { report: r.report, groupOpacity: r.groupOpacity, inFbo: r.inFbo };
      console.log(`patched ${mode} ${key}: overlap.mean=${r.report.overlap.mean} plateau.mean=${r.report.plateau.mean}`);
    }
  }

  // Gradient eyeball (over, falloff 0) — clean occlusion at crossings.
  await page.goto(`http://127.0.0.1:${port}/harness.html`);
  const grad = await runMode(page, 'over', { falloff: 0, gradient: true });
  savePng(grad.png, path.join(OUT, 'over-falloff0-gradient.png'));
  await page.goto(`http://127.0.0.1:${port}/harness.html`);
  const gradBase = await runMode(page, 'baseline', { falloff: 0, gradient: true });
  savePng(gradBase.png, path.join(OUT, 'baseline-falloff0-gradient.png'));

  // No-regression: pristine build, unused feature, baseline falloff 0.
  const pristineSrc = ensurePristineMaplibre();
  await buildHarness(pristineSrc, path.join(HERE, 'harness.bundle.js'));
  await page.goto(`http://127.0.0.1:${port}/harness.html`);
  const pristineBase = await runMode(page, 'baseline', { falloff: 0 });
  savePng(pristineBase.png, path.join(OUT, 'pristine-baseline-falloff0-solid.png'));
  // Restore the patched bundle for future manual runs.
  await buildHarness(PATCHED_MAPLIBRE, path.join(HERE, 'harness.bundle.js'));

  const patchedBaselineMd5 = md5(path.join(OUT, 'baseline-falloff0-solid.png'));
  const pristineBaselineMd5 = md5(path.join(OUT, 'pristine-baseline-falloff0-solid.png'));
  results.noRegression = {
    patchedBaselineMd5, pristineBaselineMd5,
    identical: patchedBaselineMd5 === pristineBaselineMd5,
  };
  console.log('no-regression identical:', results.noRegression.identical);

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  console.log('wrote', path.join(OUT, 'report.json'));

  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
