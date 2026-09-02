// Clip-group referential-integrity helpers. A `ClipGroup` is a contiguous
// run of ≥2 timeline clips that acts as one camera-stop generator (a
// continuous cross-clip glide — see docs/CLIP_GROUPS_HANDOFF.md §1).
//
// `normalizeClipGroups` is THE single policy for making a group list
// consistent with a clip list. Persistence (load / save), the clip
// lifecycle handlers (remove / split / import re-sort) and the timeline
// compiler all run the same function, so preview and export can never
// disagree about which clips glide together.
//
// All helpers are pure functions over their inputs; they never mutate.

import type { Clip, ClipGroup } from '../types';

/** UUID-or-fallback id minter. Mirrors `newWaypointId` in `waypoints.ts`
 *  (and the inline form in `handleSplitClip`) so this module doesn't grow
 *  a crypto dependency. */
function newGroupId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `cg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Make `groups` consistent with `clips` (whose array order IS timeline
 *  order). Idempotent and pure. Policy, in order:
 *
 *  1. Drop member ids not present in `clips`; drop duplicate membership
 *     across groups (the earlier group wins); drop duplicate ids within a
 *     group (first occurrence wins).
 *  2. Reorder each group's `clip_ids` by index in `clips`.
 *  3. Split each group into contiguous runs of clip indices. The FIRST run
 *     keeps the group's id (even if it later dissolves); later runs mint
 *     fresh ids.
 *  4. Dissolve runs with fewer than 2 members.
 *
 *  Output is ordered by each group's first member index (timeline order).
 *  An already-normalized input yields exactly one run per group, so no id
 *  is minted on a re-run — `normalize(normalize(x))` deep-equals
 *  `normalize(x)`. */
export function normalizeClipGroups(
  groups: ClipGroup[],
  clips: ReadonlyArray<Pick<Clip, 'id'>>,
): ClipGroup[] {
  const indexById = new Map<string, number>();
  clips.forEach((c, i) => {
    if (!indexById.has(c.id)) indexById.set(c.id, i);
  });

  const claimed = new Set<string>();
  const runs: { id: string; indices: number[] }[] = [];

  for (const group of groups) {
    // Rule 1: known, unclaimed, unique-within-group members only.
    const indices: number[] = [];
    for (const clipId of group.clip_ids) {
      const idx = indexById.get(clipId);
      if (idx === undefined) continue;
      if (claimed.has(clipId)) continue;
      claimed.add(clipId);
      indices.push(idx);
    }
    // Rule 2: timeline order.
    indices.sort((a, b) => a - b);

    // Rule 3: contiguous runs; first keeps the id, later ones mint.
    let run: number[] = [];
    let first = true;
    const flush = () => {
      if (run.length === 0) return;
      runs.push({ id: first ? group.id : newGroupId(), indices: run });
      first = false;
      run = [];
    };
    for (const idx of indices) {
      if (run.length > 0 && idx !== run[run.length - 1] + 1) flush();
      run.push(idx);
    }
    flush();
  }

  // Rule 4 + output order.
  return runs
    .filter((r) => r.indices.length >= 2)
    .sort((a, b) => a.indices[0] - b.indices[0])
    .map((r) => ({
      id: r.id,
      clip_ids: r.indices.map((i) => clips[i].id),
    }));
}

/** Drop `clipId` from every group, then normalize against `clips` (which
 *  should already exclude the removed clip; normalization drops it either
 *  way). Runs left with <2 members dissolve. Pure. */
export function removeClipFromGroups(
  groups: ClipGroup[],
  clipId: string,
  clips: ReadonlyArray<Pick<Clip, 'id'>>,
): ClipGroup[] {
  const filtered = groups.map((g) => ({
    id: g.id,
    clip_ids: g.clip_ids.filter((id) => id !== clipId),
  }));
  return normalizeClipGroups(filtered, clips);
}

/** Splitting a member clip keeps both halves grouped: in every group that
 *  contains `originalId`, insert `newId` immediately after it. Does not
 *  normalize — the caller normalizes once the new clip is in the clip
 *  list. Pure; returns new arrays even when nothing matched. */
export function insertSplitClipIntoGroups(
  groups: ClipGroup[],
  originalId: string,
  newId: string,
): ClipGroup[] {
  return groups.map((g) => {
    const at = g.clip_ids.indexOf(originalId);
    if (at < 0) return { id: g.id, clip_ids: [...g.clip_ids] };
    return {
      id: g.id,
      clip_ids: [
        ...g.clip_ids.slice(0, at + 1),
        newId,
        ...g.clip_ids.slice(at + 1),
      ],
    };
  });
}

/** Move one edge of group `groupId` so it lands on `targetClipId`, growing
 *  or shrinking membership along the timeline. This is THE membership rule
 *  behind the GroupBar end-handle drag (docs/CLIP_GROUPS_HANDOFF.md §4):
 *
 *  - `edge: 'start'` moves the group's first member; `'end'` its last.
 *  - Growing never crosses another group: the edge stops at the last free
 *    clip before a foreign member (so a fast drag across two cards clamps
 *    instead of freezing).
 *  - Shrinking never drops below 2 members: the edge stops one clip short
 *    of the opposite edge. Dragging an edge past the far side of the group
 *    therefore clamps to the 2-member floor.
 *  - Unknown group / unknown target → the input list is returned unchanged
 *    (no-op).
 *
 *  The result is normalized, so a caller can commit it directly. Pure. */
export function resizeGroupEdge(
  groups: ClipGroup[],
  groupId: string,
  edge: 'start' | 'end',
  targetClipId: string,
  clips: ReadonlyArray<Pick<Clip, 'id'>>,
): ClipGroup[] {
  const normalized = normalizeClipGroups(groups, clips);
  const group = normalized.find((g) => g.id === groupId);
  if (!group) return groups;

  const indexById = new Map<string, number>();
  clips.forEach((c, i) => {
    if (!indexById.has(c.id)) indexById.set(c.id, i);
  });
  const targetIdx = indexById.get(targetClipId);
  if (targetIdx === undefined) return groups;

  // Normalized groups are contiguous, so the span is [first, last].
  const startIdx = indexById.get(group.clip_ids[0])!;
  const endIdx = indexById.get(group.clip_ids[group.clip_ids.length - 1])!;

  const ownerByIdx = new Map<number, string>();
  for (const g of normalized) {
    for (const id of g.clip_ids) ownerByIdx.set(indexById.get(id)!, g.id);
  }
  const isForeign = (idx: number) => {
    const owner = ownerByIdx.get(idx);
    return owner !== undefined && owner !== groupId;
  };

  let newStart = startIdx;
  let newEnd = endIdx;
  if (edge === 'start') {
    // Floor: keep ≥2 members → start ≤ end − 1.
    let want = Math.min(targetIdx, endIdx - 1);
    // Growing leftward: stop before the first foreign member.
    if (want < startIdx) {
      let limit = startIdx;
      while (limit - 1 >= want && !isForeign(limit - 1)) limit -= 1;
      want = limit;
    }
    newStart = want;
  } else {
    let want = Math.max(targetIdx, startIdx + 1);
    if (want > endIdx) {
      let limit = endIdx;
      while (limit + 1 <= want && !isForeign(limit + 1)) limit += 1;
      want = limit;
    }
    newEnd = want;
  }

  const clip_ids = clips.slice(newStart, newEnd + 1).map((c) => c.id);
  return normalizeClipGroups(
    normalized.map((g) => (g.id === groupId ? { id: g.id, clip_ids } : g)),
    clips,
  );
}
