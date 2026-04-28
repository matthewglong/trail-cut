# Task 210 — Tests for `parseTimestamp`, `indexRoute`, `locationAt`

**Step**: 2 (routeLocation tests)
**Estimated effort**: 2h
**Status**: pending
**Depends on**: 200

## Goal

Replace `it.todo` placeholders in the `parseTimestamp`, `indexRoute`, and `locationAt` describe blocks of `src/lib/routeLocation.test.ts` with full test cases per the table in §6.2 of the migration doc. These three functions form the timestamp-and-location foundation that every other routeLocation function (and the new `cameraAt`) depends on.

## Files to touch

- `src/lib/routeLocation.test.ts` — modify — fill in test bodies for the three functions named above.
- `src/lib/__fixtures__/routes.ts` — modify (if needed) — add any additional fixtures discovered while writing tests.

## Deliverables

- `parseTimestamp` cases: ISO 8601 (`"2026-04-04T15:13:00Z"`), ExifTool format (`"2026:04:04 12:49:25-07:00"`), null/undefined, garbage string. Verify exact ms output for known inputs.
- `indexRoute` cases: empty route → null. Trackpoints without timestamps dropped. Out-of-order trackpoints sorted ascending. `minTimeMs`/`maxTimeMs` correct.
- `locationAt` cases: exact hit on a trackpoint. Strict-before-first, strict-after-last → fallback. Linear interp midpoint. Gap > `MAX_INTERPOLATION_GAP_MS` (60s) → fallback. Empty route + null fallback → null.

## Acceptance criteria

- [ ] `npm run test:run` passes all cases for the three functions.
- [ ] No `it.todo` remains in the three describe blocks.
- [ ] Coverage on `parseTimestamp`, `indexRoute`, `locationAt` (combined) ≥90% line coverage as measured by `npm run test:coverage`.

## Implementation notes

For `parseTimestamp`, the function lives at `routeLocation.ts:24-36` and accepts both ISO-8601 and the ExifTool format `"YYYY:MM:DD HH:mm:ss±HH:MM"`. Verify a known fixture: `parseTimestamp("1970-01-01T00:00:00Z") === 0` and `parseTimestamp("2026:04:04 12:49:25-07:00")` matches the equivalent ISO conversion to ms.

For `indexRoute` (`routeLocation.ts:59-79`): provide a deliberately out-of-order route and verify the output `points` array is monotonically increasing in `timeMs`.

For `locationAt` (`routeLocation.ts:100-141`):
- "Exact hit" — pass a t equal to a trackpoint's timeMs, expect that point's lat/lng exactly.
- "Linear interp midpoint" — for `linearRoute` at t = midpoint between points 1 and 2, expect lat/lng exactly halfway.
- "Gap > 60s" — use `routeWithGap`. At a t inside the gap, the function should NOT interpolate; it should return the fallback (or null if fallback is null).
- "Strict-before-first" + non-null fallback returns fallback. With null fallback returns null.

The migration doc explicitly lists these cases in the §6.2 table — match them exactly.
