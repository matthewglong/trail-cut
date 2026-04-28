# Task 230 — Tests for bearing math (90% line coverage gate)

**Step**: 2 (routeLocation tests)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 200

## Goal

Replace `it.todo` placeholders for `bearingAt`, `circularLerp`, `computeBearingKeyframes`, and `bearingFromKeyframes` per the §6.2 table. These four functions are the bearing pipeline that powers auto-bearing-mode follow intents — central to the migration because `buildMapTrack` precomputes keyframes once per anchor and `resolveIntent` reads them per frame. Land the **Step 2 pass criterion**: `≥90% line coverage on routeLocation.ts. All tests pass on npm test.`

## Files to touch

- `src/lib/routeLocation.test.ts` — modify — fill in the four remaining describe blocks.

## Deliverables

- `bearingAt`: two-point route → constant bearing. Out-of-range t with clamp. Stationary segment → null.
- `circularLerp`: 350° → 10° at t=0.5 → 0°. 10° → 350° at t=0.5 → 0°. 0° → 180° at t=0.5 → 90° (or 270° — document which arc the function takes; the migration doc flags this as a decision).
- `computeBearingKeyframes`: stops=1 returns single midpoint keyframe. stops=N returns N keyframes at segment midpoints. Stationary first segment → falls back to windowed bearing.
- `bearingFromKeyframes`: before first → first.bearing. After last → last.bearing. Between → circularLerp.

## Acceptance criteria

- [ ] `npm run test:run` passes all 10 describe blocks (this task plus 210 + 220 covers them all).
- [ ] `npm run test:coverage` reports **≥90% line coverage** on `src/lib/routeLocation.ts`. This is the explicit Step 2 pass criterion from §6.2.
- [ ] No `it.todo` remains in `routeLocation.test.ts`.

## Implementation notes

Function locations:
- `bearingAt` — `routeLocation.ts:255-298`
- `circularLerp` — `routeLocation.ts:299-308`
- `computeBearingKeyframes` — `routeLocation.ts:319-361`
- `bearingFromKeyframes` — `routeLocation.ts:366-390`

`circularLerp` short-arc test: in 350° → 10° the short arc goes through 0°, not through 180°. At t=0.5 result is 0°. Conversely 10° → 350° also short-arcs through 0° (going the other way). Verify both directions explicitly because circular interpolation bugs typically only show in one direction.

For the 0° → 180° case there are two equally-short arcs. Run `circularLerp(0, 180, 0.5)` and read the output; document the value (either 90° or 270°) and add a comment explaining the convention. This case is called out in the migration doc table as `"or 270°, document which arc"` — the test codifies the actual behavior.

`computeBearingKeyframes` — the function divides the anchor time range into `stops` segments and emits a keyframe at each segment's midpoint. For `stops=1`, expect 1 keyframe at the midpoint of `[startMs, endMs]`. For `stops=4`, expect 4 keyframes at `startMs + (i+0.5)/4 * (endMs - startMs)` for i in [0..3].

"Stationary first segment fallback" — construct a route where the first 50% has zero displacement (lat/lng constant) and the second 50% moves north. With `stops=4`, the first keyframe is in the stationary half; the function falls back to a windowed bearing computed over a wider window (read the source for exact behavior — this test verifies you-don't-get-NaN).

After this task lands, run `npm run test:coverage` and confirm the 90% gate. If a small uncovered branch remains, add a targeted test rather than over-covering with redundant cases.
