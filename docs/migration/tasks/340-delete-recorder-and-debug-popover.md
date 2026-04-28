# Task 340 — Delete useMapRecorder hook, recorder prop, and Debug popover

**Step**: 3 (MapView refactor)
**Estimated effort**: 1h
**Status**: pending
**Depends on**: 330

## Goal

Delete `src/hooks/useMapRecorder.ts` entirely. Remove the `recorder` prop from `MapViewProps`. Remove the `useMapRecorder` import + hook call + Debug popover from `ProjectView.tsx`. Per §2.5 of the migration doc: "**This entire tool exists because today there is no 'expected camera at t' to compare against.** In the target model, this divergence cannot exist in the preview by construction (both come from the same `cameraAt(t)`), and in the export it is impossible." Also addresses §8.3 (bearing keyframe interaction at anchor boundaries) — the parity check happens here.

## Files to touch

- `src/hooks/useMapRecorder.ts` — delete — entire file (172 lines).
- `src/components/MapView.tsx` — modify — remove `recorder` from `MapViewProps`, drop the destructured prop, remove the `registerFrameSampler` setup if any remains.
- `src/screens/ProjectView.tsx` — modify — delete the `useMapRecorder` import, the hook call (lines ~209-216), and the Debug popover (lines ~438-482). The `recorder` value is no longer passed to `MapView`.
- `src/components/MapToolbar/MapToolbar.tsx` (if it references the recorder) — modify — drop any "Debug" toolbar button.

## Deliverables

- `useMapRecorder.ts` does not exist on disk.
- No reference to `useMapRecorder`, `recorder` prop, `recordEvent`, `registerFrameSampler`, or "Debug popover" anywhere in `src/`.
- `MapViewProps` matches the §6.3 target shape exactly (track + playheadMs + mapSettings + selectedClipId + route + onSelectClip).
- §8.3 verification: with `bearing_mode: 'auto'`, run a real ≥3-clip project and confirm the gap-arc bearing rotation looks sensible. If it does NOT, document the failure mode in this task's notes — the fix may require `interpolateAnchors` to consult GPX bearing at intermediate times rather than lerp endpoints (per §8.3).

## Acceptance criteria

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev`: app runs. No Debug button visible. No popover. No console errors.
- [ ] `grep -rn "useMapRecorder\|recordEvent\|registerFrameSampler\|MapRecorder" src/` returns no results.
- [ ] `MapViewProps` matches §6.3:
  ```ts
  interface MapViewProps {
    track: MapTrack;
    playheadMs: number | null;
    mapSettings: MapSettings;
    selectedClipId: string | null;
    route: Route | null;
    onSelectClip?: (clipId: string) => void;
  }
  ```
- [ ] §8.3 spot-check completed: ≥3-clip project with auto bearing, gap-arc rotation reviewed. Findings documented as a comment in `cameraIntent.ts` near `interpolateAnchors` (or "no issue found" stated explicitly).

## Implementation notes

The Debug popover lives at `ProjectView.tsx:438-482`. The hook call is at `:209-216`. Both are explicitly called out in §6.3 step 8.

§6.3's pass criterion: "the live preview behavior is equivalent to today's, verified by running the same test project as in Step 1's parity test. The debug recorder is gone and not missed."

§8.3 verification details: "in Step 1's spike, with `bearing_mode: 'auto'`, does the arc rotate as expected when bridging two clips with very different direction-of-travel? If not, `interpolateAnchors` may need to consult the GPX bearing at intermediate times rather than lerp endpoints." The spike (task 140) should have surfaced any issue. This task ratifies the answer: either the lerp-endpoints approach is fine (record the verdict) or it isn't (open a follow-up task; do not block landing 340 on the redesign — it can be a Step 3 follow-up because gap arcs already work, just possibly with a slight bearing oddity).

Keep all uncommitted git changes related to recorder deletion in a single commit so the diff is self-explanatory.
