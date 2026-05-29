// Tests for `mergeClips` and `newClipFromMetadata`.
//
// The merge contract is load-bearing for the WS9 source-format pipeline:
// re-imports must not clobber `user_color_class_override` (user data,
// never produced by ffprobe) and should preserve existing
// `suggested_log_class` when a fresh probe doesn't return one.

import { describe, it, expect } from 'vitest';
import { mergeClips, newClipFromMetadata } from '../clips';
import type { Clip, ClipMetadata } from '../../types';

function metaFixture(over: Partial<ClipMetadata> = {}): ClipMetadata {
  return {
    id: 'm1',
    path: '/tmp/m1.mov',
    filename: 'm1.mov',
    created_at: '2026-01-01T00:00:00Z',
    duration_ms: 1000,
    gps: null,
    resolution: null,
    frame_rate: null,
    pix_fmt: null,
    color_primaries: null,
    color_trc: null,
    color_space: null,
    color_range: null,
    has_dolby_vision: false,
    camera_make: null,
    camera_model: null,
    source_color_class: 'sdr_bt709',
    ...over,
  };
}

function clipFixture(over: Partial<Clip> = {}): Clip {
  return {
    ...newClipFromMetadata(metaFixture()),
    ...over,
  };
}

describe('mergeClips', () => {
  it('preserves user_color_class_override when re-import omits it', () => {
    // The user previously declared this DJI clip as D-Log via the WS9
    // Inspector. A re-import (e.g. user re-runs Import Folder to refresh
    // timestamps) returns fresh ClipMetadata from Rust's ffprobe pass —
    // which never sets `user_color_class_override` because that field is
    // pure user state, not derivable from the file. Naïve spread would
    // propagate the undefined and clobber the override; the merge must
    // hold it.
    const existing = clipFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      user_color_class_override: 'd_log',
    });
    const incoming = metaFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      source_color_class: 'sdr_bt709',
      // user_color_class_override absent — exactly what Rust returns.
    });
    const merged = mergeClips([existing], [incoming]);
    expect(merged).toHaveLength(1);
    expect(merged[0].user_color_class_override).toBe('d_log');
  });

  it('allows incoming user_color_class_override to override existing', () => {
    // Belt-and-braces: if an incoming `ClipMetadata` *does* carry an
    // override (e.g. loading a project bundle into a fresh state and
    // merging — not the current import path, but a reasonable future
    // path), it should win.
    const existing = clipFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      user_color_class_override: 'd_log',
    });
    const incoming = metaFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      user_color_class_override: 'c_log3',
    });
    const merged = mergeClips([existing], [incoming]);
    expect(merged[0].user_color_class_override).toBe('c_log3');
  });

  it('preserves existing suggested_log_class when re-import returns none', () => {
    // Re-import may drop the suggestion if Rust's log_detection regressed
    // (e.g. metadata corrupted by AirDrop). The original suggestion was a
    // valid hint at the time — don't lose it on a metadata refresh.
    const existing = clipFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      suggested_log_class: 'd_log',
    });
    const incoming = metaFixture({ id: 'c1', path: '/tmp/hike.mov' });
    const merged = mergeClips([existing], [incoming]);
    expect(merged[0].suggested_log_class).toBe('d_log');
  });

  it('updates source_color_class to the freshly-probed value', () => {
    // The auto-detected class IS derivable from the file and should
    // refresh on re-import (e.g. user re-encoded the source and the new
    // file is HLG instead of SDR).
    const existing = clipFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      source_color_class: 'sdr_bt709',
    });
    const incoming = metaFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      source_color_class: 'hlg_bt2020',
    });
    const merged = mergeClips([existing], [incoming]);
    expect(merged[0].source_color_class).toBe('hlg_bt2020');
  });

  it('preserves the existing id when the path matches', () => {
    // The id is the canonical primary key in waypoints / proxies /
    // thumbnail maps; re-imports must NOT regenerate it or we orphan
    // every per-id record. Path is the merge key.
    const existing = clipFixture({
      id: 'stable-id',
      path: '/tmp/hike.mov',
    });
    const incoming = metaFixture({
      id: 'fresh-id-from-rust',
      path: '/tmp/hike.mov',
    });
    const merged = mergeClips([existing], [incoming]);
    expect(merged[0].id).toBe('stable-id');
  });

  it('preserves editing state (trim, focal_point, effects) on re-import', () => {
    // Existing in-flight edit state is the whole reason `mergeClips`
    // exists — guard against a regression that would silently reset it.
    const existing = clipFixture({
      id: 'c1',
      path: '/tmp/hike.mov',
      trim: { in_ms: 500, out_ms: 4500 },
      focal_point: { x: 0.3, y: 0.7, zoom: 1.5 },
      effects: { stabilize: { enabled: true, shakiness: 8 }, speed: 2 },
    });
    const incoming = metaFixture({ id: 'c1', path: '/tmp/hike.mov' });
    const merged = mergeClips([existing], [incoming]);
    expect(merged[0].trim).toEqual({ in_ms: 500, out_ms: 4500 });
    expect(merged[0].focal_point).toEqual({ x: 0.3, y: 0.7, zoom: 1.5 });
    expect(merged[0].effects.speed).toBe(2);
    expect(merged[0].effects.stabilize.enabled).toBe(true);
  });

  it('appends genuinely new clips and sorts by created_at', () => {
    const existing = clipFixture({
      id: 'a',
      path: '/tmp/a.mov',
      created_at: '2026-01-02T00:00:00Z',
    });
    const newer = metaFixture({
      id: 'b',
      path: '/tmp/b.mov',
      created_at: '2026-01-03T00:00:00Z',
    });
    const older = metaFixture({
      id: 'c',
      path: '/tmp/c.mov',
      created_at: '2026-01-01T00:00:00Z',
    });
    const merged = mergeClips([existing], [newer, older]);
    expect(merged.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });
});
