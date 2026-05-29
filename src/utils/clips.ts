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
    map_overrides: null,
  };
}

export function mergeClips(existing: Clip[], incoming: ClipMetadata[]): Clip[] {
  const incomingByPath = new Map(incoming.map((c) => [c.path, c]));
  // Update existing clips with fresh metadata, preserve editing state
  const updated = existing.map((c) => {
    const fresh = incomingByPath.get(c.path);
    if (fresh) {
      incomingByPath.delete(c.path);
      // WS9 — re-imports must NOT clobber user color-pipeline state.
      //
      //   - `user_color_class_override` is pure user data. A fresh
      //     `import_media` probe never sets it (it's not derivable from
      //     ffprobe), so the incoming value is always `undefined`. A naïve
      //     `{ ...c, ...fresh }` spread would propagate that undefined and
      //     silently undo the user's declared format on every re-import.
      //   - `suggested_log_class` is derived per-import, but the probe can
      //     fail or regress (e.g. metadata corrupted by AirDrop) and clear
      //     a perfectly good suggestion. Prefer the incoming value when
      //     present; otherwise hold what we had.
      //
      // Contract: incoming wins when set; existing is preserved when the
      // incoming side leaves the field absent. Mirrors the "merge-with-
      // explicit-preservation" pattern from `mergeMapSettings` in
      // `useProject.ts`.
      const merged: Clip = { ...c, ...fresh, id: c.id };
      if (fresh.user_color_class_override === undefined && c.user_color_class_override !== undefined) {
        merged.user_color_class_override = c.user_color_class_override;
      }
      if (fresh.suggested_log_class === undefined && c.suggested_log_class !== undefined) {
        merged.suggested_log_class = c.suggested_log_class;
      }
      return merged;
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
