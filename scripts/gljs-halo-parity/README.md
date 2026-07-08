# GL JS halo group-composite parity gate

Proves the PREVIEW engine's group-opacity compositing (the vendored
maplibre-gl patch, `patches/maplibre-gl+5.22.0.patch`) renders halos with the
same semantics the EXPORT engine's native patch 3 measured in
`.spike/halo-composite/VERDICT.md`. Ship rule: the GL JS twin and the native
patch travel together — re-run this gate whenever either side changes
(maplibre-gl version bump, patch edit, `haloGroupPolicy` change).

## Run

```
node scripts/gljs-halo-parity/run.mjs
```

Needs `playwright` (devDependency; chromium via `npx playwright install
chromium` if missing). Renders headless (SwiftShader). Writes PNGs +
`out/report.json`.

## What it does

Reuses the native A/B fixture verbatim (`.spike/halo-composite/
halo-fixture.js` — GPS-jitter zigzag, 6 m out-and-back retrace, perpendicular
crossings, driven through the real `src/lib/mapVisuals` resolvers over a flat
#404040 background) at 1600×900 dpr 1, and ports the native driver's
measurement sections point-for-point (`harness-entry.js`). Coverage α is
recovered from the blue channel: `a = (pix_B − 64)/(255 − 64)`.

Modes per falloff (0 and 0.7):
- **baseline** — raw (un-remapped) halo opacities, no composite: must
  REPRODUCE the self-overlap darkening artifact (proves the fixture bites).
- **over** — the production path: mapVisuals' remapped in-FBO opacities
  (already in the resolver's paints) + the `haloComposites` group via
  `map.setGroupComposite`.

Plus a **no-regression** build: the pristine npm 5.22.0 dev bundle renders
the baseline and is byte-compared (MD5) with the patched-bundle baseline —
the patch with the feature unused must be pixel-identical.

## Gates (all measured PASS, 2026-07-07; native values from
`.spike/halo-composite/out/report-falloff0*.json`)

| gate | native | GL JS |
|---|---|---|
| falloff 0 baseline overlap (artifact) | 0.7487 | 0.7539 |
| falloff 0 over overlap (= plateau, σ=0) | 0.4974, sd 0 | 0.5026, sd 0 |
| falloff 0 over plateau vs baseline | ±0.005 | 0.4984 vs 0.4979 |
| falloff 0 over jitter max (≤ one coat) | 0.4607 | 0.4607 |
| falloff 0.7 over plateau (policy fidelity) | 0.3115 / max 0.3717 | 0.3115 / max 0.3717 |
| falloff 0.7 over overlap (capped, σ=0) | 0.4346, sd 0 | 0.4346, sd 0 |
| no-regression (feature off) | MD5 byte-identical | MD5 identical |

(The residual falloff-0 overlap offset vs native — 0.5026 vs 0.4974 — is one
blue-channel quantization step, 1/191 ≈ 0.0052, from the differing readback
paths; every other headline metric agrees to 4 decimals.)

## The one real GL JS trap (recorded for the next engine surgeon)

`context.createFramebuffer(w, h, hasDepth, hasStencil)` only creates the
attachment WRAPPERS — the depth-stencil RENDERBUFFER storage must be created
and attached explicitly (`fbo.depthAttachment.set(context.createRenderbuffer(
gl.DEPTH_STENCIL, w, h))`, the terrain render-to-texture pattern). A
color-only FBO is still framebuffer-complete, so nothing throws; the stencil
test silently ALWAYS-PASSES, tile clipping stops discriminating, and every
overlapping tile's buffered geometry draws — measured as `1−(1−α)^k` coat
stacking that varies with tile-boundary geometry. Invisible at falloff 0
(in-FBO opacity 1 saturates in one coat); caught by the falloff-0.7 policy-
fidelity gate. This is the GL JS sibling of the native spike's
`resetTileClippingMasks()` stencil trap — both engines' traps live in the
stencil path of the offscreen pass.
