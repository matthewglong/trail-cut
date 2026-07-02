import { defineConfig } from 'vitest/config';

// Dedicated config for the renderer worker tests.
//   - backendSelect.test.ts and tileCache.test.ts are pure unit tests.
//   - protocol.test.ts and tileCacheKeyParity.test.ts are process-level:
//     they spawn the bundled worker (native backend), drive stdin, and
//     assert wire format / on-disk cache keys. They require built dist/ +
//     the staged maplibre-gl-native binding + network on first run.
//
// All live in the same dir; vitest groups them. Default timeout is generous
// so a cold-cache first frame doesn't trip it; warm runs finish in seconds.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src-tauri/sidecars/renderer/__tests__/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 120_000,
  },
});
