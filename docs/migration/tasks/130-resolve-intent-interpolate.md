# Task 130 — Implement `resolveIntent` and `interpolateAnchors`

**Step**: 1 (Spike)
**Estimated effort**: 3h
**Status**: pending
**Depends on**: 100, 110, 120

## Goal

Implement the two "render-time" pure functions: `resolveIntent(intent, viewport)` per §3.3, and `interpolateAnchors(a, b, t, feel)` per §3.4. Together with `cameraAt`, these form the complete pure pipeline: `cameraAt → (interpolateAnchors when in gap) → resolveIntent → ResolvedCamera`. The migration doc emphasizes (§3.3): "`resolveIntent` is the **only** place pixel-aware math happens."

## Files to touch

- `src/lib/cameraIntent.ts` — modify — fill in `resolveIntent`, `interpolateAnchors`, plus internal helpers `canonicalCamera`, `clamp01`, `easeInOut`.
- `src/lib/cameraIntent.test.ts` — modify — add tests covering all three intent kinds and gap interpolation.

## Deliverables

- `resolveIntent(intent, viewport): ResolvedCamera` switching on intent.kind:
  - `'point'` → pass through.
  - `'region'` → call `cameraForBounds` (task 100).
  - `'follow'` → `locationAt(intent.playheadMs, intent.route, null)` for center; bearing from `bearingFromKeyframes` (auto) or `fixedBearingDegrees` (fixed); zoom = `targetZoom`.
- `interpolateAnchors(a, b, t, feel): CameraIntent` returning a `point` intent computed by Van Wijk arc with feel-derived duration, plus circular-lerp on bearing and linear lerp on pitch.
- Internal `canonicalCamera(anchor, refTimeMs)` — resolves an anchor to a `ResolvedCamera` at a canonical 1024×1024 viewport for region anchors, evaluated at the boundary time for follow anchors, trivially passed for point anchors.
- Tests: resolve each intent kind, verify region zoom changes when viewport aspect changes (1024×1024 vs 360×640), verify follow at t evaluates `locationAt`/bearing tables, verify gap interpolation produces a point intent that smoothly transitions camA → camB endpoints.

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes including new resolve/interp tests.
- [ ] `resolveIntent(regionIntent, {w:1024,h:1024,...})` and `resolveIntent(regionIntent, {w:360,h:640,...})` return different zoom values for the same intent (proves aspect-awareness).
- [ ] `interpolateAnchors(a, b, t = a.endTimeMs, feel)` returns center+zoom near `canonicalCamera(a, a.endTimeMs)`.
- [ ] `interpolateAnchors(a, b, t = a.endTimeMs + arcDurationMs(arc, feel), feel)` returns center+zoom near `canonicalCamera(b, b.timeMs)`.
- [ ] Bearing rotates the short way: `circularLerp(350, 10, 0.5) === 0`.

## Implementation notes

`resolveIntent` body matches §3.3 verbatim. Use `bearingFromKeyframes` and `locationAt` from existing `routeLocation.ts` exports — no new math. Do NOT walk the route inside `resolveIntent` (the bearing keyframes are precomputed by `buildMapTrack`).

`interpolateAnchors` algorithm (§3.4):
1. Resolve each anchor to a canonical camera via `canonicalCamera(a, a.endTimeMs)` and `canonicalCamera(b, b.timeMs)`. For `region` anchors choose a fixed 1024×1024 reference viewport.
2. Compute Van Wijk arc params: `arc = vanWijkArc(camA, camB)`.
3. Map t (linear in wall-clock) to s ∈ [0, S]:
   ```
   tStart = a.endTimeMs
   tEnd   = a.endTimeMs + arcDurationMs(arc, feel)
   localT = clamp01((t - tStart) / max(1, tEnd - tStart))
   eased  = easeInOut(localT, feel)
   s      = arc.S * eased
   ```
4. `point = vanWijkSample(camA, camB, arc, s)`. Bearing via `circularLerp(camA.bearing, camB.bearing, eased)`. Pitch via linear lerp.
5. Return `{ kind: 'point', center: point.center, zoom: point.zoom, bearing, pitch }`.

`circularLerp` is already exported from `routeLocation.ts:299-308` — import and use it. `easeInOut` can be the standard cubic easeInOut for `'natural'` and slightly different curves for snappy/slow if desired (or use the same curve; the difference comes through duration).

§8.3 question is left for task 340 to verify in the spike. This task does not need to special-case bearing-keyframe bleed — just the documented circularLerp on endpoints.
