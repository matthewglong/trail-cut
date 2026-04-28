# Task 110 — Implement Van Wijk arc primitives

**Step**: 1 (Spike)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 010

## Goal

Implement the three Van Wijk & Nuij (2003) arc primitives — `vanWijkArc`, `vanWijkSample`, `arcDurationMs` — as pure functions per §3.4 of the migration doc. These replace MapLibre's built-in `flyTo` parabolic zoom-out (§5.1: "**Lost**: `map.flyTo({ minZoom, curve, … })` is invoked at `MapView.tsx:173`. It uses Van Wijk & Nuij internally."). They power `interpolateAnchors` (task 130) and produce the smooth zoom-out + pan + zoom-in arc between two anchors.

## Files to touch

- `src/lib/cameraIntent.ts` — modify — add `VanWijkArc` interface (already in §3.4 type block from task 010, confirm present), `vanWijkArc`, `vanWijkSample`, `arcDurationMs`, plus internal `feelMultiplier` helper.
- `src/lib/cameraIntent.test.ts` — modify — add unit tests for arc symmetry, degenerate cases, duration scaling by feel.

## Deliverables

- `vanWijkArc(camA, camB): VanWijkArc` (~12 lines, eqs. (1)-(8) of the paper).
- `vanWijkSample(camA, camB, arc, s): { center: LngLat; zoom: number }` (~10 lines, eq. (9) for u(s) and the `w(s)` width formula; zoom is `log2(w0 / w(s))` plus the higher source zoom).
- `arcDurationMs(arc, feel): number` (~5 lines: `base = clamp(arc.S * MS_PER_S_UNIT, MIN, MAX); return base * feelMultiplier(feel)`).
- Unit tests: sample at s=0 returns camA position+zoom; sample at s=arc.S returns camB; degenerate arc where camA ≈ camB returns near-camA at all s; `arcDurationMs(arc, 'snappy') < arcDurationMs(arc, 'natural') < arcDurationMs(arc, 'slow')`.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes including new arc tests.
- [ ] `vanWijkSample(camA, camB, arc, 0)` ≈ `{center: camA.center, zoom: camA.zoom}` (within float tolerance).
- [ ] `vanWijkSample(camA, camB, arc, arc.S)` ≈ `{center: camB.center, zoom: camB.zoom}`.
- [ ] Duration ordering snappy < natural < slow holds for the same arc.

## Implementation notes

Reference: Van Wijk & Nuij, "Smooth and Efficient Zooming and Panning" (2003), Section 4. Closed-form equations are directly codeable. Cross-check against MapLibre's `src/ui/camera.ts` `flyTo` implementation — same algorithm in TypeScript.

`VanWijkArc` fields (from §3.4):
- `rho` — smoothing parameter, paper recommends 1.42 (matches today's `DEFAULT_MAP_TRANSITION.curve`).
- `u0/u1` — start/end positions on the paper's 1-D parametric line, in units of "world meters at the higher zoom."
- `r0/r1` — coefficients from eq. (7), drive cosh/sinh sweeps.
- `w0` — common-denominator world width at the start (from `zoom`).
- `S` — total arc length; `s ∈ [0, S]` parameterizes the smooth path.

Edge case to handle (eq. (10) of the paper): when the two endpoints are very close in screen-space at the higher zoom (rho * |u1 - u0| is small), switch to a linear-pan branch — MapLibre does this. Don't reinvent; copy the branch logic from MapLibre's source as a structural reference.

Feel multipliers (§3.6 of doc):
- `natural`: 1.0 (matches today's defaults baseMs:1100, msPerZoomLevel:580).
- `snappy`: 0.6 (≈ baseMs:600, msPerZoomLevel:320).
- `slow`: 1.5 (≈ baseMs:1800, msPerZoomLevel:900).

Tune `MS_PER_S_UNIT` and `MIN_MS`/`MAX_MS` clamps so that `'natural'` reproduces today's `runClipTransition` durations within ±10% on a representative arc — verified visually in task 140's spike harness.
