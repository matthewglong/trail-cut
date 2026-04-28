# Task 200 — Scaffold routeLocation test file structure

**Step**: 2 (routeLocation tests)
**Estimated effort**: 30min
**Status**: pending
**Depends on**: 001

## Goal

Create the `src/lib/routeLocation.test.ts` file skeleton with `describe` blocks for each function listed in §6.2 of the migration doc. No actual test bodies yet — those land in tasks 210, 220, 230. This task is just the harness and shared fixtures so the next three tasks can run in parallel without merge conflicts.

## Files to touch

- `src/lib/routeLocation.test.ts` — new — skeleton with `describe` blocks for `parseTimestamp`, `indexRoute`, `locationAt`, `trailUpTo`, `clipWaypointLocation`, `forwardAzimuth`, `bearingAt`, `circularLerp`, `computeBearingKeyframes`, `bearingFromKeyframes`. Each block contains a single `it.todo(...)` placeholder.
- `src/lib/__fixtures__/routes.ts` — new — shared test fixtures: a small linear route (5 trackpoints, 1 Hz), a stationary segment, a route with a >60s gap, a route straddling several timestamps for clip-waypoint tests.

## Deliverables

- Skeleton test file that imports from `vitest` (explicit imports, no globals).
- Fixtures file exporting at minimum: `linearRoute`, `routeWithGap`, `routeWithStationarySegment`, plus a helper `mkPoint(lat, lng, isoTime)`.
- `npm run test:run` reports the `it.todo` items but exits 0.

## Acceptance criteria

- [ ] `npm run test:run` exits 0.
- [ ] Output mentions the 10 describe blocks (one per function under test).
- [ ] All `it.todo` placeholders surface in the output.

## Implementation notes

Fixture design — keep timestamps tight so tests can express "exact hit" / "midpoint" / "before first" / "after last" cases without floating-point fuzz. Suggested:

```ts
export const linearRoute: Route = {
  trackpoints: [
    { lat: 37.0, lng: -122.0, time: '2026-04-04T15:00:00Z' },
    { lat: 37.001, lng: -122.0, time: '2026-04-04T15:00:01Z' },
    { lat: 37.002, lng: -122.0, time: '2026-04-04T15:00:02Z' },
    { lat: 37.003, lng: -122.0, time: '2026-04-04T15:00:03Z' },
    { lat: 37.004, lng: -122.0, time: '2026-04-04T15:00:04Z' },
  ],
};
```

`MAX_INTERPOLATION_GAP_MS` is 60s per `routeLocation.ts` — `routeWithGap` should have one segment whose endpoints are >60s apart.

`mkPoint` helper makes test bodies in 210/220/230 readable without inline date strings.

This task is small and exists to absorb merge-conflict surface — tasks 210/220/230 each fill in a subset of the describe blocks and can land independently.
