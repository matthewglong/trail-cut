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
      reporter: ['text', 'html'],
    },
  },
})
