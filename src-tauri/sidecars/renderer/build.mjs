// Build script for the chromium renderer worker sidecar.
//
//   0. Ensure full Chrome is present at
//      src-tauri/binaries/chrome-<host-triple>/<inner>. Downloads it via
//      @puppeteer/browsers if missing. ~170 MB on Mac, host arch only;
//      multi-arch CI matrix is task 130's concern.
//
//      Why full Chrome and not chrome-headless-shell: headless-shell on
//      macOS has no path to the GPU and therefore runs WebGL on
//      SwiftShader (software). Maplibre's first paint stalls badly on
//      software WebGL — readPixels takes seconds, the GPU process can
//      crash, the page tears down mid-evaluate, and puppeteer surfaces
//      it as `Runtime.callFunctionOn: Promise was collected`. Full
//      Chrome's new headless mode (--headless=new, exposed as
//      `headless: true` in puppeteer ≥22) routes through ANGLE→Metal
//      on Apple Silicon, where the GPU is right there. The ~50 MB
//      delta is noise for a desktop app that already ships Chromium
//      via Tauri's webview.
//   1. tsc --noEmit on the worker tsconfig — type-check the Node-side
//      worker plus everything it pulls from src/lib/ in a Node-CJS context.
//   2. tsc --noEmit on the page tsconfig — type-check the browser-side
//      page script (separate config: DOM lib, no Node types).
//   3. esbuild bundle worker → dist/renderer.cjs. Externalize puppeteer-core
//      and pngjs (Node deps; resolve at runtime against node_modules).
//   4. esbuild bundle page → dist/page-init.bundle.js. Browser target,
//      IIFE format, includes maplibre-gl-js. The worker reads this file
//      at boot and inlines it into the bootstrap HTML it hands to
//      page.setContent.
//   5. esbuild bundle setup-fixture → dist/setup_fixture.cjs (mirrors the
//      native renderer's build).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const tauriRoot = resolve(repoRoot, 'src-tauri');

// ---- 0. Ensure Chrome binary ----
//
// Pinned Chrome version. Set 2026-05-08 — matches puppeteer-core 24.43.0's
// compatibility matrix. Chrome and chrome-headless-shell ship as twins from
// the Chrome for Testing channel with the same version numbers; bump in
// lockstep with puppeteer-core upgrades.
const CHROME_VERSION = '150.0.7832.0';

function hostTargetTriple() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  // Windows + Linux triples are task 130's concern.
  throw new Error(
    `[build:renderer] unsupported host: platform=${platform} arch=${arch}. ` +
    `Add the triple mapping in build.mjs once task 130 lands.`,
  );
}

// @puppeteer/browsers `--platform` flag values, per
// https://pptr.dev/api/puppeteer.platform.
function browsersPlatformForTriple(triple) {
  switch (triple) {
    case 'aarch64-apple-darwin': return 'mac_arm';
    case 'x86_64-apple-darwin':  return 'mac';
    default:
      throw new Error(`[build:renderer] no @puppeteer/browsers --platform for triple ${triple}`);
  }
}

// Path to the Chrome executable inside the unpacked install. macOS ships
// browsers as .app bundles; the actual binary lives at
// `<App>.app/Contents/MacOS/<App>`. On other platforms this becomes a
// direct path; task 130 will add the Windows branch.
function chromeBinaryRelativePath(platform) {
  if (platform === 'mac' || platform === 'mac_arm') {
    return ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
  }
  throw new Error(`[build:renderer] no chrome binary path for platform ${platform}`);
}

function ensureChrome() {
  const triple = hostTargetTriple();
  const platform = browsersPlatformForTriple(triple);
  const binariesDir = resolve(tauriRoot, 'binaries');
  const targetDir = resolve(binariesDir, `chrome-${triple}`);
  const targetBinary = resolve(targetDir, ...chromeBinaryRelativePath(platform));

  if (existsSync(targetBinary)) {
    console.error(`[build:renderer] chrome already present at ${targetDir}`);
    return;
  }

  console.error(
    `[build:renderer] downloading chrome@${CHROME_VERSION} ` +
    `for ${platform} (~170 MB, one-time per arch)…`,
  );

  // Download into a transient cache dir under binaries/. @puppeteer/browsers
  // produces a versioned subtree:
  //   <cache>/chrome/<platform>-<version>/chrome-<vendorArch>/<App>.app/...
  // We move that inner dir to our stable target path so Tauri's
  // bundle.resources globbing and the orchestrator's Rust path resolver
  // both look in one place.
  const cacheDir = resolve(binariesDir, '.cache');
  mkdirSync(cacheDir, { recursive: true });

  const install = spawnSync(
    'npx',
    [
      '@puppeteer/browsers', 'install',
      `chrome@${CHROME_VERSION}`,
      '--platform', platform,
      '--path', cacheDir,
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (install.status !== 0) {
    throw new Error(`[build:renderer] @puppeteer/browsers install failed (exit ${install.status})`);
  }

  // Locate the unpacked tree. Layout:
  //   <cache>/chrome/<platform>-<version>/chrome-<vendorArch>/
  const versionedDir = resolve(cacheDir, 'chrome', `${platform}-${CHROME_VERSION}`);
  if (!existsSync(versionedDir)) {
    throw new Error(`[build:renderer] expected install layout at ${versionedDir} not found`);
  }
  // @puppeteer/browsers names the inner dir `chrome-mac-arm64`,
  // `chrome-mac-x64`, etc. Filter for that exact prefix shape — `chrome-`
  // alone would match `chrome-headless-shell-*` if a stale install lingers.
  const innerEntries = readdirSync(versionedDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^chrome-(mac|mac_arm|mac-arm64|mac-x64|linux|win32|win64)/.test(d.name));
  if (innerEntries.length !== 1) {
    throw new Error(
      `[build:renderer] expected exactly one chrome-* inner dir in ${versionedDir}, ` +
      `found ${innerEntries.length}`,
    );
  }
  const innerDir = resolve(versionedDir, innerEntries[0].name);

  // Move into stable location. Use rename (atomic on same filesystem); if the
  // target dir exists from a partial prior run, nuke it first.
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(binariesDir, { recursive: true });
  renameSync(innerDir, targetDir);

  // Best-effort cache cleanup (the .cache dir is gitignored, but tidy is nice).
  try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }

  if (!existsSync(targetBinary)) {
    throw new Error(`[build:renderer] post-install verification failed: ${targetBinary} missing`);
  }
  console.error(`[build:renderer] chrome installed at ${targetDir}`);
}

ensureChrome();

// ---- 0b. Ensure the patched maplibre-gl-native binding ----
//
// The worker's native backend (TRAILCUT_RENDERER_BACKEND=native) loads the
// patched @maplibre/maplibre-gl-native binding from
// src-tauri/binaries/mbgl-native-<triple>/. ensure-binding.mjs verifies the
// staged artifact (fast, one child-process load probe) or builds it from
// source (~5 min, cmake; CI caches the staged dir). Provisioned here —
// alongside Chrome — so "npm run build:renderer" remains the single
// precondition for BOTH backends' tests; the suites panic loudly without it
// rather than skip.
console.error('[build:renderer] ensure patched mbgl-native binding');
const ensureBinding = spawnSync(
  process.execPath,
  [resolve(here, 'native', 'ensure-binding.mjs')],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (ensureBinding.status !== 0) {
  console.error('[build:renderer] native binding provisioning failed');
  process.exit(ensureBinding.status ?? 1);
}

// ---- 1. Type-check worker ----
console.error('[build:renderer] tsc --noEmit (worker)');
const tscWorker = spawnSync(
  'npx',
  ['tsc', '-p', resolve(here, 'tsconfig.json'), '--noEmit'],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (tscWorker.status !== 0) {
  console.error('[build:renderer] worker type-check failed');
  process.exit(tscWorker.status ?? 1);
}

// ---- 2. Type-check page ----
console.error('[build:renderer] tsc --noEmit (page)');
const tscPage = spawnSync(
  'npx',
  ['tsc', '-p', resolve(here, 'page', 'tsconfig.json'), '--noEmit'],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (tscPage.status !== 0) {
  console.error('[build:renderer] page type-check failed');
  process.exit(tscPage.status ?? 1);
}

// ---- 3. esbuild bundle: worker ----
console.error('[build:renderer] esbuild → dist/renderer.cjs');
await build({
  entryPoints: [resolve(here, 'index.ts')],
  outfile: resolve(here, 'dist/renderer.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // puppeteer-core ships a Node-target package with a `package.json` that
  // works as a runtime require; bundling it is a 5 MB++ explosion and
  // pulls in CDP type files that don't compile cleanly. External.
  // pngjs likewise is small, pure-JS but with stream APIs that bundle
  // imperfectly; runtime require is safe.
  external: ['puppeteer-core', 'pngjs'],
  sourcemap: true,
  logLevel: 'info',
});

// ---- 4. esbuild bundle: page-side script ----
console.error('[build:renderer] esbuild → dist/page-init.bundle.js');
await build({
  entryPoints: [resolve(here, 'page', 'init.ts')],
  outfile: resolve(here, 'dist/page-init.bundle.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // Inline maplibre-gl into the page bundle — no node_modules in the page.
  // Default: no externals.
  sourcemap: 'inline',
  logLevel: 'info',
  // Avoid a runtime crash if a transitive dep references `process.env.NODE_ENV`.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

// ---- 5. esbuild bundle: setup-fixture ----
console.error('[build:renderer] esbuild → dist/setup_fixture.cjs');
await build({
  entryPoints: [resolve(here, '__tests__/setupFixture.ts')],
  outfile: resolve(here, 'dist/setup_fixture.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
});

console.error('[build:renderer] done');
