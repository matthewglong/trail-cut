// First-class waypoint helpers. The project now persists `waypoints: Waypoint[]`
// independently of `clips`, but clip-sourced waypoints still ride the clip
// lifecycle automatically: importing a clip seeds one, deleting a clip drops
// its waypoint, trimming a clip re-anchors the waypoint's wall-clock.
//
// Deletion is sticky. If the user manually deletes a clip-sourced waypoint
// from the list panel, later trims/edits to the underlying clip do NOT
// resurrect it — `syncClipWaypointTrim` updates *existing* clip-sourced
// waypoints only. Only `appendClipWaypoint` ever creates a new one, and it's
// called exclusively from clip add / split paths (genuine new clips).
//
// All helpers are pure functions over the inputs; they do not mutate.

import type { Clip, Waypoint } from '../types';
import { parseTimestamp } from './routeLocation';

/** UUID-or-fallback id minter. Mirrors the inline form used in
 *  `handleSplitClip` so this module doesn't grow a crypto dependency. */
function newWaypointId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Compute the wall-clock anchor for a clip's first frame post-trim, in ms
 *  since epoch. Returns null when the clip has no parseable `created_at` —
 *  in that case the clip can't seed a wall-clock-anchored waypoint and
 *  callers should skip it. Mirrors `clipWaypointLocation`'s anchor math. */
export function clipWallClockAnchor(clip: Clip): number | null {
  const base = parseTimestamp(clip.created_at);
  if (Number.isNaN(base)) return null;
  return base + (clip.trim?.in_ms ?? 0);
}

/** Build a clip-sourced `Waypoint` for the given clip, or null if the clip
 *  can't be anchored (no `created_at`). The waypoint's GPS fallback is the
 *  clip's embedded `gps` when present, so projects without a GPX route
 *  still render waypoints at the clip's filmed location. */
export function waypointFromClip(clip: Clip): Waypoint | null {
  const ms = clipWallClockAnchor(clip);
  if (ms == null) return null;
  return {
    id: newWaypointId(),
    position: {
      kind: 'wall_clock_ms',
      ms,
      ...(clip.gps ? { fallback_gps: { lat: clip.gps.lat, lng: clip.gps.lng } } : {}),
    },
    label: '',
    source: 'clip',
    clip_id: clip.id,
  };
}

/** Seed a full waypoint list from a clip list. Used at project-load time
 *  for legacy bundles (no `waypoints` field) and at new-project import time.
 *  Drops clips that can't be anchored. */
export function seedWaypointsFromClips(clips: Clip[]): Waypoint[] {
  const out: Waypoint[] = [];
  for (const c of clips) {
    const wp = waypointFromClip(c);
    if (wp) out.push(wp);
  }
  return out;
}

/** Append clip-sourced waypoints for clip ids not yet represented. No-op
 *  for clip ids that already have a clip-sourced entry (including ones the
 *  user manually deleted? NO — once deleted, the entry is absent, so this
 *  would re-create. Callers must restrict input to *genuinely new* clip
 *  ids, e.g. fresh imports or split right-halves — never re-import of
 *  existing clips). Returns a new array. */
export function appendClipWaypoints(
  prev: Waypoint[],
  newClips: Clip[],
): Waypoint[] {
  if (newClips.length === 0) return prev;
  const additions: Waypoint[] = [];
  for (const c of newClips) {
    const wp = waypointFromClip(c);
    if (wp) additions.push(wp);
  }
  if (additions.length === 0) return prev;
  return [...prev, ...additions];
}

/** Drop every clip-sourced waypoint matching `clipId`. Used by the clip
 *  remove handler. Returns the original array reference unchanged when
 *  there's nothing to drop — caller can rely on reference equality to skip
 *  a state update. */
export function removeClipWaypoints(
  prev: Waypoint[],
  clipId: string,
): Waypoint[] {
  const next = prev.filter(
    (w) => !(w.source === 'clip' && w.clip_id === clipId),
  );
  return next.length === prev.length ? prev : next;
}

/** Re-anchor any existing clip-sourced waypoint for `clip` to the clip's
 *  current `created_at + trim.in_ms`. Does NOT create one if absent — that
 *  preserves the "manual delete is sticky" contract. Returns the original
 *  array reference unchanged when no waypoint matches (no state churn). */
export function syncClipWaypointTrim(
  prev: Waypoint[],
  clip: Clip,
): Waypoint[] {
  const newMs = clipWallClockAnchor(clip);
  if (newMs == null) return prev;
  let touched = false;
  const next = prev.map((w) => {
    if (w.source !== 'clip' || w.clip_id !== clip.id) return w;
    if (w.position.kind !== 'wall_clock_ms') return w;
    // Compute the new fallback_gps explicitly so a clip whose GPS was
    // stripped on re-import doesn't carry a stale fallback. (The spread
    // form would leave the old `fallback_gps` in place when `clip.gps` is
    // null.)
    const newFallbackGps = clip.gps
      ? { lat: clip.gps.lat, lng: clip.gps.lng }
      : undefined;
    const oldFallbackGps = w.position.fallback_gps;
    const fallbackUnchanged =
      newFallbackGps && oldFallbackGps
        ? newFallbackGps.lat === oldFallbackGps.lat &&
          newFallbackGps.lng === oldFallbackGps.lng
        : newFallbackGps === undefined && oldFallbackGps === undefined;
    if (w.position.ms === newMs && fallbackUnchanged) return w;
    touched = true;
    return {
      ...w,
      position: {
        kind: 'wall_clock_ms' as const,
        ms: newMs,
        ...(newFallbackGps ? { fallback_gps: newFallbackGps } : {}),
      },
    };
  });
  return touched ? next : prev;
}
