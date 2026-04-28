# Task 220 — Tests for `trailUpTo`, `clipWaypointLocation`, `forwardAzimuth`

**Step**: 2 (routeLocation tests)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 200

## Goal

Replace `it.todo` placeholders for `trailUpTo`, `clipWaypointLocation`, and `forwardAzimuth` in `src/lib/routeLocation.test.ts` per the §6.2 table. `trailUpTo` powers the visited-route slime trail (Writer 7, preserved in the migration). `clipWaypointLocation` and `forwardAzimuth` are used by `buildMapTrack` to derive anchor positions and by the bearing math.

## Files to touch

- `src/lib/routeLocation.test.ts` — modify — fill in test bodies for these three functions.

## Deliverables

- `trailUpTo` cases: before route start → empty coords. After route end → all coords. Mid-route → strict-before points + interpolated head. Big gap straddling t → no interpolated head.
- `clipWaypointLocation` cases: anchor at `created_at + trim.in_ms` (verify split-clip semantics — left half and right half of a split clip resolve to different positions).
- `forwardAzimuth` cases: cardinals — due north → 0°, due east → 90°, due south → 180°, due west → 270°. Antipodal edge case (output should be defined, even if any-bearing-is-correct, document the choice).

## Acceptance criteria

- [ ] `npm run test:run` passes all cases for the three functions.
- [ ] No `it.todo` remains in the three describe blocks.
- [ ] Combined line coverage on these three functions ≥90%.
- [ ] Split-clip case demonstrates: a clip with `created_at = T`, `trim.in_ms = 0` → location at point near T; same clip with `trim.in_ms = 5000` → location at point near T+5s (different lat/lng on a moving route).

## Implementation notes

`trailUpTo` lives at `routeLocation.ts:147-184`. Its return is a GeoJSON `LineString` (or equivalent). The "interpolated head" test checks: for t between two points, the last coord in the output is the interpolated lat/lng at exactly t (not the strict-before point). The "big gap straddling t" case asserts the head is NOT interpolated when the surrounding gap exceeds `MAX_INTERPOLATION_GAP_MS`.

`clipWaypointLocation` lives at `routeLocation.ts:197-210`. The anchor time formula is `parseTimestamp(clip.created_at) + (clip.trim?.in_ms ?? 0)`. For a split clip — i.e. the user split one source clip into two — both halves share the same `created_at` but have different `trim.in_ms`. The anchor positions must therefore differ. Construct two clips with the same `created_at` but `trim.in_ms = 0` and `trim.in_ms = 5000`, run them against `linearRoute`, assert different output lat/lng.

`forwardAzimuth` lives at `routeLocation.ts:233-247`. For cardinal tests, construct two points 1 meter apart in each cardinal direction at a non-pole latitude (e.g. lat=37). For the antipodal case, construct two points exactly 180° apart in longitude (e.g. lng=0 and lng=180). Document whether the function returns 0, NaN, or a defined direction — and update the test to match the actual behavior (this is a verification, not a redesign).
