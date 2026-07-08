import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// TrailCut vendored patch — group composite. The maplibre-gl group-opacity
// compositing feature (halo self-overlap fix) lives as a patch-package diff
// against the UNMINIFIED dev bundle (patches/maplibre-gl+5.22.0.patch) so the
// vendored change stays reviewable. Alias the bare `maplibre-gl` specifier to
// that patched artifact. The regex is anchored ($) to an exact match so
// subpath imports like `maplibre-gl/dist/maplibre-gl.css` still resolve.
const maplibreGlDev = fileURLToPath(
  new URL('./node_modules/maplibre-gl/dist/maplibre-gl-dev.js', import.meta.url),
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: [{ find: /^maplibre-gl$/, replacement: maplibreGlDev }],
  },

  // Prevent vite from obscuring Rust errors
  clearScreen: false,

  // Tauri expects a fixed port
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
