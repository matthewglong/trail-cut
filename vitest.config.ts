import { defineConfig } from 'vitest/config'

// Vitest config — kept separate from vite.config.ts so that production
// build tooling stays untouched. Globals are disabled on purpose: tests
// must `import { describe, it, expect } from 'vitest'` for grep-friendliness.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Allow `npm run test:run` to succeed before any tests exist.
    // Subsequent migration tasks (200+) will add the first tests.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      // Restrict coverage to the pure-lib surface that the camera-architecture
      // migration cares about. UI code is intentionally excluded for now.
      include: ['src/lib/**/*.ts'],
      // Don't count fixture files toward coverage — they're test data, not
      // production code.
      exclude: ['src/lib/__fixtures__/**'],
      reporter: ['text', 'html'],
      // Step 2 pass criterion (per §6.2 of MAP_ARCHITECTURE_MIGRATION.md):
      // routeLocation.ts must hit ≥90% line coverage. Enforced per-file so
      // we don't paper over a thin module with a high overall average.
      thresholds: {
        perFile: true,
        lines: 90,
      },
    },
  },
})
