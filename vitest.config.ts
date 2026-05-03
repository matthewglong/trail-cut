import { defineConfig } from 'vitest/config'

// Vitest config — kept separate from vite.config.ts so that production
// build tooling stays untouched. Globals are disabled on purpose: tests
// must `import { describe, it, expect } from 'vitest'` for grep-friendliness.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/__fixtures__/**'],
      reporter: ['text', 'html'],
      thresholds: {
        perFile: true,
        lines: 90,
      },
    },
  },
})
