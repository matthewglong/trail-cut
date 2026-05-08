// Build script for the renderer worker sidecar.
//
//   1. tsc --noEmit on the worker tsconfig — proves the worker source plus
//      everything it pulls from src/lib/ compiles in a Node-CJS context.
//   2. esbuild bundle to dist/renderer.cjs with @maplibre/maplibre-gl-native
//      externalized (it's a native addon — must be a runtime require).
//
// Run via `npm run build:renderer` from repo root.

import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// ---- 1. Type-check ----
console.error('[build:renderer] tsc --noEmit');
const tsc = spawnSync(
  'npx',
  ['tsc', '-p', resolve(here, 'tsconfig.json'), '--noEmit'],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (tsc.status !== 0) {
  console.error('[build:renderer] type-check failed');
  process.exit(tsc.status ?? 1);
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
  // Native addon — leave as runtime require so node-pre-gyp can resolve the
  // platform-specific .node binary out of node_modules (or, post task 130,
  // out of the bundled sidecar dir).
  external: ['@maplibre/maplibre-gl-native'],
  sourcemap: true,
  logLevel: 'info',
});

// ---- 3. esbuild bundle: setup-fixture ----
// Bundles the shared fixture builder used by both the JS protocol test and the
// Rust orchestrator integration test. When run with `node dist/setup_fixture.cjs`,
// it prints a fully-compiled SetupCmd JSON object to stdout. Bundling here keeps
// the fixture in lockstep with the TS sources (cameraIntent, routeLocation,
// types) — drift surfaces as a build-time type error.
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
