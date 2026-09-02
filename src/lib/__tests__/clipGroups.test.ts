// Tests for the clip-group referential-integrity policy in
// `src/lib/clipGroups.ts`: normalization (the single shared policy for
// persistence + compiler), member removal, and split-clip insertion.

import { describe, it, expect } from 'vitest';
import {
  normalizeClipGroups,
  removeClipFromGroups,
  insertSplitClipIntoGroups,
  resizeGroupEdge,
} from '../clipGroups';
import type { ClipGroup } from '../../types';

const clips = (...ids: string[]) => ids.map((id) => ({ id }));
const group = (id: string, ...clip_ids: string[]): ClipGroup => ({ id, clip_ids });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('normalizeClipGroups', () => {
  it('returns an already-consistent group unchanged', () => {
    const out = normalizeClipGroups([group('g1', 'a', 'b', 'c')], clips('a', 'b', 'c', 'd'));
    expect(out).toEqual([group('g1', 'a', 'b', 'c')]);
  });

  it('returns [] for empty input', () => {
    expect(normalizeClipGroups([], clips('a', 'b'))).toEqual([]);
    expect(normalizeClipGroups([group('g1', 'a', 'b')], [])).toEqual([]);
  });

  it('is idempotent (normalize(normalize(x)) deep-equals normalize(x))', () => {
    const timeline = clips('a', 'x', 'b', 'c', 'y', 'd', 'e', 'f');
    const messy: ClipGroup[] = [
      group('g1', 'c', 'b', 'a', 'zzz', 'e', 'd', 'f', 'f'),
      group('g2', 'a', 'x', 'b'),
    ];
    const once = normalizeClipGroups(messy, timeline);
    const twice = normalizeClipGroups(once, timeline);
    expect(twice).toEqual(once);
    // A normalized input requires no minting: ids are preserved verbatim.
    expect(twice.map((g) => g.id)).toEqual(once.map((g) => g.id));
  });

  it('reorders members into timeline order', () => {
    const out = normalizeClipGroups([group('g1', 'c', 'a', 'b')], clips('a', 'b', 'c'));
    expect(out).toEqual([group('g1', 'a', 'b', 'c')]);
  });

  it('drops member ids not present in clips', () => {
    const out = normalizeClipGroups([group('g1', 'a', 'ghost', 'b')], clips('a', 'b'));
    expect(out).toEqual([group('g1', 'a', 'b')]);
  });

  it('drops duplicate ids within a group', () => {
    const out = normalizeClipGroups([group('g1', 'a', 'a', 'b', 'b')], clips('a', 'b'));
    expect(out).toEqual([group('g1', 'a', 'b')]);
  });

  it('resolves duplicate membership across groups: earlier group wins', () => {
    const out = normalizeClipGroups(
      [group('g1', 'a', 'b'), group('g2', 'b', 'c', 'd')],
      clips('a', 'b', 'c', 'd'),
    );
    expect(out).toEqual([group('g1', 'a', 'b'), group('g2', 'c', 'd')]);
  });

  it('dissolves runs with fewer than 2 members', () => {
    const out = normalizeClipGroups(
      [group('g1', 'a'), group('g2', 'b', 'c'), group('g3', 'ghost')],
      clips('a', 'b', 'c'),
    );
    expect(out).toEqual([group('g2', 'b', 'c')]);
  });

  it('splits a group into contiguous runs on re-sort; the FIRST run keeps the id even when it dissolves', () => {
    // Timeline now interleaves `x` after `a`: [a] and [b,c] are separate runs.
    const out = normalizeClipGroups([group('g1', 'a', 'b', 'c')], clips('a', 'x', 'b', 'c'));
    expect(out).toHaveLength(1);
    expect(out[0].clip_ids).toEqual(['b', 'c']);
    // [a] was the first run and kept 'g1' before dissolving, so the
    // surviving [b,c] run carries a freshly minted id, not 'g1'.
    expect(out[0].id).not.toBe('g1');
    expect(out[0].id).toMatch(UUID_RE);
  });

  it('keeps the original id on the first surviving run and mints for later runs', () => {
    const out = normalizeClipGroups(
      [group('g1', 'a', 'b', 'c', 'd')],
      clips('a', 'b', 'x', 'c', 'd'),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(group('g1', 'a', 'b'));
    expect(out[1].clip_ids).toEqual(['c', 'd']);
    expect(out[1].id).not.toBe('g1');
    expect(out[1].id).toMatch(UUID_RE);
  });

  it('mints distinct ids for multiple later runs', () => {
    const out = normalizeClipGroups(
      [group('g1', 'a', 'b', 'c', 'd', 'e', 'f')],
      clips('a', 'b', 'x', 'c', 'd', 'y', 'e', 'f'),
    );
    expect(out.map((g) => g.clip_ids)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(out[0].id).toBe('g1');
    const ids = new Set(out.map((g) => g.id));
    expect(ids.size).toBe(3);
  });

  it('orders output groups by timeline position of their first member', () => {
    const out = normalizeClipGroups(
      [group('late', 'e', 'f'), group('early', 'a', 'b'), group('mid', 'c', 'd')],
      clips('a', 'b', 'c', 'd', 'e', 'f'),
    );
    expect(out.map((g) => g.id)).toEqual(['early', 'mid', 'late']);
  });

  it('does not mutate its inputs', () => {
    const groups: ClipGroup[] = [group('g1', 'c', 'a', 'ghost', 'b'), group('g2', 'a', 'd')];
    const timeline = clips('a', 'b', 'c', 'd');
    const groupsSnapshot = structuredClone(groups);
    const timelineSnapshot = structuredClone(timeline);
    const out = normalizeClipGroups(groups, timeline);
    expect(groups).toEqual(groupsSnapshot);
    expect(timeline).toEqual(timelineSnapshot);
    // Output arrays are fresh, never aliases of the input arrays.
    expect(out[0]).not.toBe(groups[0]);
    expect(out[0].clip_ids).not.toBe(groups[0].clip_ids);
  });
});

describe('removeClipFromGroups', () => {
  it('removes the member and keeps the rest of the group', () => {
    const out = removeClipFromGroups(
      [group('g1', 'a', 'b', 'c')],
      'b',
      clips('a', 'c'),
    );
    expect(out).toEqual([group('g1', 'a', 'c')]);
  });

  it('dissolves a group that drops below 2 members', () => {
    const out = removeClipFromGroups([group('g1', 'a', 'b')], 'a', clips('b'));
    expect(out).toEqual([]);
  });

  it('drops the member even when the clip list still contains it', () => {
    const out = removeClipFromGroups(
      [group('g1', 'a', 'b', 'c')],
      'a',
      clips('a', 'b', 'c'),
    );
    expect(out).toEqual([group('g1', 'b', 'c')]);
  });

  it('does not mutate its inputs', () => {
    const groups = [group('g1', 'a', 'b', 'c')];
    const snapshot = structuredClone(groups);
    removeClipFromGroups(groups, 'b', clips('a', 'c'));
    expect(groups).toEqual(snapshot);
  });
});

describe('insertSplitClipIntoGroups', () => {
  it('inserts the new half immediately after the original in its group', () => {
    const out = insertSplitClipIntoGroups([group('g1', 'a', 'b', 'c')], 'b', 'b2');
    expect(out).toEqual([group('g1', 'a', 'b', 'b2', 'c')]);
  });

  it('inserts after a trailing member', () => {
    const out = insertSplitClipIntoGroups([group('g1', 'a', 'b')], 'b', 'b2');
    expect(out).toEqual([group('g1', 'a', 'b', 'b2')]);
  });

  it('leaves groups that do not contain the original untouched', () => {
    const out = insertSplitClipIntoGroups(
      [group('g1', 'a', 'b'), group('g2', 'c', 'd')],
      'c',
      'c2',
    );
    expect(out).toEqual([group('g1', 'a', 'b'), group('g2', 'c', 'c2', 'd')]);
  });

  it('keeps both halves grouped after normalization against the split timeline', () => {
    const inserted = insertSplitClipIntoGroups([group('g1', 'a', 'b', 'c')], 'b', 'b2');
    const out = normalizeClipGroups(inserted, clips('a', 'b', 'b2', 'c'));
    expect(out).toEqual([group('g1', 'a', 'b', 'b2', 'c')]);
  });

  it('does not mutate its inputs', () => {
    const groups = [group('g1', 'a', 'b')];
    const snapshot = structuredClone(groups);
    const out = insertSplitClipIntoGroups(groups, 'a', 'a2');
    expect(groups).toEqual(snapshot);
    expect(out[0]).not.toBe(groups[0]);
    expect(out[0].clip_ids).not.toBe(groups[0].clip_ids);
  });
});

describe('resizeGroupEdge', () => {
  const timeline = clips('a', 'b', 'c', 'd', 'e', 'f');

  it('grows the start edge leftward onto the target clip', () => {
    const out = resizeGroupEdge([group('g1', 'c', 'd')], 'g1', 'start', 'a', timeline);
    expect(out).toEqual([group('g1', 'a', 'b', 'c', 'd')]);
  });

  it('grows the end edge rightward onto the target clip', () => {
    const out = resizeGroupEdge([group('g1', 'b', 'c')], 'g1', 'end', 'e', timeline);
    expect(out).toEqual([group('g1', 'b', 'c', 'd', 'e')]);
  });

  it('shrinks the start edge rightward onto the target clip', () => {
    const out = resizeGroupEdge([group('g1', 'a', 'b', 'c', 'd')], 'g1', 'start', 'c', timeline);
    expect(out).toEqual([group('g1', 'c', 'd')]);
  });

  it('shrinks the end edge leftward onto the target clip', () => {
    const out = resizeGroupEdge([group('g1', 'a', 'b', 'c', 'd')], 'g1', 'end', 'b', timeline);
    expect(out).toEqual([group('g1', 'a', 'b')]);
  });

  it('is a no-op when the edge already sits on the target', () => {
    const out = resizeGroupEdge([group('g1', 'b', 'c')], 'g1', 'end', 'c', timeline);
    expect(out).toEqual([group('g1', 'b', 'c')]);
  });

  it('stops before a neighboring group when growing (start edge)', () => {
    const out = resizeGroupEdge(
      [group('g0', 'a', 'b'), group('g1', 'd', 'e')],
      'g1',
      'start',
      'a',
      timeline,
    );
    expect(out).toEqual([group('g0', 'a', 'b'), group('g1', 'c', 'd', 'e')]);
  });

  it('stops before a neighboring group when growing (end edge)', () => {
    const out = resizeGroupEdge(
      [group('g1', 'a', 'b'), group('g2', 'd', 'e')],
      'g1',
      'end',
      'f',
      timeline,
    );
    expect(out).toEqual([group('g1', 'a', 'b', 'c'), group('g2', 'd', 'e')]);
  });

  it('refuses to grow at all when the adjacent clip belongs to another group', () => {
    const out = resizeGroupEdge(
      [group('g1', 'a', 'b'), group('g2', 'c', 'd')],
      'g1',
      'end',
      'd',
      timeline,
    );
    expect(out).toEqual([group('g1', 'a', 'b'), group('g2', 'c', 'd')]);
  });

  it('never drops below 2 members: shrinking the end past the floor clamps', () => {
    const out = resizeGroupEdge([group('g1', 'a', 'b', 'c', 'd')], 'g1', 'end', 'a', timeline);
    expect(out).toEqual([group('g1', 'a', 'b')]);
  });

  it('never drops below 2 members: shrinking the start past the floor clamps', () => {
    const out = resizeGroupEdge([group('g1', 'a', 'b', 'c', 'd')], 'g1', 'start', 'f', timeline);
    expect(out).toEqual([group('g1', 'c', 'd')]);
  });

  it('a 2-member group cannot shrink either edge', () => {
    const groups = [group('g1', 'c', 'd')];
    expect(resizeGroupEdge(groups, 'g1', 'start', 'd', timeline)).toEqual(groups);
    expect(resizeGroupEdge(groups, 'g1', 'end', 'c', timeline)).toEqual(groups);
  });

  it('returns the input unchanged for an unknown group id', () => {
    const groups = [group('g1', 'a', 'b')];
    expect(resizeGroupEdge(groups, 'nope', 'end', 'c', timeline)).toBe(groups);
  });

  it('returns the input unchanged for an unknown target clip', () => {
    const groups = [group('g1', 'a', 'b')];
    expect(resizeGroupEdge(groups, 'g1', 'end', 'ghost', timeline)).toBe(groups);
  });

  it('leaves other groups untouched and keeps timeline output order', () => {
    const out = resizeGroupEdge(
      [group('g0', 'a', 'b'), group('g1', 'e', 'f')],
      'g1',
      'start',
      'd',
      timeline,
    );
    expect(out).toEqual([group('g0', 'a', 'b'), group('g1', 'd', 'e', 'f')]);
  });

  it('does not mutate its inputs', () => {
    const groups = [group('g1', 'b', 'c')];
    const snapshot = structuredClone(groups);
    resizeGroupEdge(groups, 'g1', 'end', 'e', timeline);
    expect(groups).toEqual(snapshot);
  });
});
