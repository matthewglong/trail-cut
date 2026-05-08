import { defineConfig } from 'vitest/config';

// Dedicated config for the renderer worker's process-level protocol test.
// The default vitest.config.ts scopes include to `src/**`, so the renderer
// test is invisible to `npm run test:run`. This config flips include to the
// renderer's __tests__ dir and uses the node environment (no jsdom needed —
// the test spawns a child process and reads its stdout).
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src-tauri/sidecars/renderer/__tests__/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 60_000,
  },
});
