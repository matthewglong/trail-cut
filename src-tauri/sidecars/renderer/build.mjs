// Build script for the renderer worker sidecar.
//
//   0. Ensure the patched @maplibre/maplibre-gl-native binding is staged at
//      src-tauri/binaries/mbgl-native-<host-triple>/ (verify-or-build via
//      native/ensure-binding.mjs; CI caches the staged dir).
//   1. tsc --noEmit on the worker tsconfig — type-check the Node-side
//      worker plus everything it pulls from src/lib/ in a Node-CJS context.
//   2. esbuild bundle worker → dist/renderer.cjs.
//   3. esbuild bundle setup-fixture → dist/setup_fixture.cjs (shared by the
//      JS protocol test and the Rust orchestrator integration tests).
//
// History: until the Phase 5 cutover this script also downloaded a pinned
// Chrome for Testing (~170 MB) for the chrome backend and bundled its
// page-side script. The native backend retired all of it — no Chrome, no
// CDP, no page bundle.

import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// ---- 0. Ensure the patched maplibre-gl-native binding ----
//
// The worker loads the patched @maplibre/maplibre-gl-native binding from
// src-tauri/binaries/mbgl-native-<triple>/. ensure-binding.mjs verifies the
// staged artifact (fast, one child-process load probe) or builds it from
// source (~5 min, cmake; CI caches the staged dir). Provisioned here so
// "npm run build:renderer" remains the single precondition for the renderer
// tests; the suites panic loudly without it rather than skip.
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

// ---- 2. esbuild bundle: worker ----
console.error('[build:renderer] esbuild → dist/renderer.cjs');
await build({
  entryPoints: [resolve(here, 'index.ts')],
  outfile: resolve(here, 'dist/renderer.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
});

// ---- 3. esbuild bundle: setup-fixture ----
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
