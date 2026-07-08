import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// TrailCut vendored patch — group composite. Tests resolve `maplibre-gl` to
// the same patched dev bundle the app uses (see vite.config.ts), so the
// `groupComposite` capability marker is present in the test environment.
const maplibreGlDev = fileURLToPath(
  new URL('./node_modules/maplibre-gl/dist/maplibre-gl-dev.js', import.meta.url),
)

// Vitest config — kept separate from vite.config.ts so that production
// build tooling stays untouched. Globals are disabled on purpose: tests
// must `import { describe, it, expect } from 'vitest'` for grep-friendliness.
export default defineConfig({
  resolve: {
    alias: [{ find: /^maplibre-gl$/, replacement: maplibreGlDev }],
  },
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
