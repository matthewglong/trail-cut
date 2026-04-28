# Task 100 — Implement pure `cameraForBounds` helper

**Step**: 1 (Spike)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 010

## Goal

Implement the pure Web Mercator `cameraForBounds(bounds, padding, viewport, extra)` helper inside `src/lib/cameraIntent.ts` per §5.2 of the migration doc. This is one of the two MapLibre built-ins we are lifting out so that bounds fitting can run for any viewport, not just the live DOM container. It is consumed by `resolveIntent` for `region` intents.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — add the `cameraForBounds` function (~30 lines) plus a `lngLatToMercator` helper if not inlined.
- `src/lib/cameraIntent.test.ts` — new — sanity unit tests for the math.

## Deliverables

- Pure function `cameraForBounds(bounds: Bounds, padding: Padding, viewport: Viewport, extra: { bearing: number; pitch: number }): ResolvedCamera`.
- Throws (or clamps) when `padding >= 0.5`.
- ≥3 unit tests: square bounds at known location, asymmetric bounds, very-tight bounds (high zoom).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes for the new test file.
- [ ] For a 1km square at the equator with a 1024×1024 viewport and padding=0, the resolved zoom is within ±0.5 of the value returned by MapLibre's `map.cameraForBounds` for the same inputs (cross-checked manually once or via a fixture).

## Implementation notes

Algorithm verbatim from §5.2:

1. Convert fractional `padding` to pixels: `pad = padding * Math.min(viewport.width, viewport.height)`. Reject `padding >= 0.5` (would inset the viewport to ≤0 in the smaller dimension).
2. Project `bounds.sw` and `bounds.ne` into world pixel coordinates at zoom 0 using the standard `lng/lat → mercator` transform. World size at zoom 0 is `TILE_SIZE = 512` (MapLibre default) or `256` — pick one consistently and document. Recommended: 512 to match MapLibre.
3. Compute `dx = ne.x - sw.x`, `dy = sw.y - ne.y` (latitude flips Y).
4. Compute per-axis zoom: `zx = log2((viewport.width - 2*pad) / dx)`, `zy = log2((viewport.height - 2*pad) / dy)`.
5. `zoom = min(zx, zy)`.
6. Center is bounds midpoint in lng/lat (mid lng is straight average; mid lat needs care if bounds straddle the antimeridian — for v1 don't worry about antimeridian, document the limit).

Mercator projection (zoom 0, world size 512px):
```
x = ((lng + 180) / 360) * 512
y = (1 - log(tan(latRad) + 1/cos(latRad)) / PI) / 2 * 512
```

Bearing/pitch are passed through unchanged to the returned `ResolvedCamera`.
