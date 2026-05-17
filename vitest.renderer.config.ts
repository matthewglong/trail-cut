import { defineConfig } from 'vitest/config';

// Dedicated config for the renderer worker tests.
//   - painterPatch.test.ts, trailcutFetch.test.ts, tileCache.test.ts, and
//     tileCacheKeyParity.test.ts are pure unit tests.
//   - protocol.test.ts is process-level: spawns the bundled worker, drives
//     stdin, asserts wire format. Heavy: requires built dist/ + chrome-
//     headless-shell + network on first run.
//
// All live in the same dir; vitest groups them. Default timeout is generous
// so the protocol test's cold-Chromium first-frame doesn't trip it; the unit
// tests finish well within.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src-tauri/sidecars/renderer/__tests__/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 120_000,
  },
});
