import type { ClipMetadata, Clip } from '../types';

/** Convert freshly-imported metadata into a Clip with default editing fields. */
export function newClipFromMetadata(meta: ClipMetadata): Clip {
  return {
    ...meta,
    trim: meta.duration_ms ? { in_ms: 0, out_ms: meta.duration_ms } : null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1.0 },
    effects: {
      stabilize: { enabled: false, shakiness: 5 },
      speed: 1.0,
    },
    visible: true,
  };
}

export function mergeClips(existing: Clip[], incoming: ClipMetadata[]): Clip[] {
  const incomingByPath = new Map(incoming.map((c) => [c.path, c]));
  // Update existing clips with fresh metadata, preserve editing state
  const updated = existing.map((c) => {
    const fresh = incomingByPath.get(c.path);
    if (fresh) {
      incomingByPath.delete(c.path);
      return { ...c, ...fresh, id: c.id };
    }
    return c;
  });
  // Add genuinely new clips with default editing fields
  const newClips = [...incomingByPath.values()].map(newClipFromMetadata);
  const merged = [...updated, ...newClips];
  merged.sort((a, b) => {
    const cmp = (a.created_at ?? '').localeCompare(b.created_at ?? '');
    if (cmp !== 0) return cmp;
    // Tiebreaker for split clips: within the same source (identical
    // created_at), order by where each segment begins.
    return (a.trim?.in_ms ?? 0) - (b.trim?.in_ms ?? 0);
  });
  return merged;
}
