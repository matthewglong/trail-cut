// WS9 — Unit tests for the source-format catalog helpers. Lightweight pure
// functions; the heavy lifting (dropdown render, dialog state) gets tested in
// the component test files. These tests guard the user-facing labels and
// grouping behaviour the components depend on.

import { describe, expect, it } from 'vitest';
import type { Clip, ClipMetadata } from '../../types';
import {
  SOURCE_FORMAT_OPTIONS,
  badgeForClip,
  cameraGroupKey,
  cameraGroupLabel,
  effectiveSourceClass,
  isLogClass,
  labelForSourceClass,
} from '../sourceFormat';

function clipFixture(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    path: '/tmp/c1.mov',
    filename: 'c1.mov',
    created_at: null,
    duration_ms: 1000,
    gps: null,
    resolution: null,
    frame_rate: null,
    trim: null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1 },
    effects: { stabilize: { enabled: false, shakiness: 5 }, speed: 1 },
    visible: true,
    map_overrides: null,
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

function metaFixture(over: Partial<ClipMetadata> = {}): ClipMetadata {
  return {
    id: 'm1',
    path: '/tmp/m1.mov',
    filename: 'm1.mov',
    created_at: null,
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

describe('SOURCE_FORMAT_OPTIONS catalog', () => {
  it('starts with Auto and includes every SourceColorClass except Unknown', () => {
    // Auto sentinel + the brief's eight log variants + four non-log classes
    // (Rec.709 / HLG / PQ / DV). Unknown is intentionally excluded — it's an
    // internal sentinel, not a user-pickable format.
    const choices = SOURCE_FORMAT_OPTIONS.filter((o) => o.kind === 'choice').map(
      (o) => (o.kind === 'choice' ? o.value : ''),
    );
    expect(choices[0]).toBe('auto');
    expect(choices).toContain('sdr_bt709');
    expect(choices).toContain('hlg_bt2020');
    expect(choices).toContain('pq_bt2020');
    expect(choices).toContain('dolby_vision');
    expect(choices).toContain('d_log');
    expect(choices).toContain('c_log');
    expect(choices).toContain('c_log2');
    expect(choices).toContain('c_log3');
    expect(choices).toContain('gp_log');
    expect(choices).toContain('v_log');
    expect(choices).toContain('s_log2');
    expect(choices).toContain('s_log3');
    expect(choices).not.toContain('unknown');
  });

  it('renders exactly one divider between HDR/SDR block and log block', () => {
    const dividers = SOURCE_FORMAT_OPTIONS.filter((o) => o.kind === 'divider');
    expect(dividers).toHaveLength(1);
    const dividerIdx = SOURCE_FORMAT_OPTIONS.findIndex((o) => o.kind === 'divider');
    // Everything before the divider is the non-log block; everything after
    // is log variants. Spot-check both halves.
    const before = SOURCE_FORMAT_OPTIONS.slice(0, dividerIdx);
    const after = SOURCE_FORMAT_OPTIONS.slice(dividerIdx + 1);
    expect(before.every((o) => o.kind === 'choice' && !isLogClass(o.value as never))).toBe(true);
    expect(
      after.every((o) => o.kind === 'choice' && isLogClass(o.value as never)),
    ).toBe(true);
  });
});

describe('effectiveSourceClass', () => {
  it('returns user override when present', () => {
    const clip = clipFixture({
      source_color_class: 'sdr_bt709',
      user_color_class_override: 'd_log',
    });
    expect(effectiveSourceClass(clip)).toBe('d_log');
  });

  it('falls back to source_color_class when no override', () => {
    const clip = clipFixture({
      source_color_class: 'hlg_bt2020',
      user_color_class_override: undefined,
    });
    expect(effectiveSourceClass(clip)).toBe('hlg_bt2020');
  });
});

describe('badgeForClip', () => {
  it('returns "overridden" when user_color_class_override is set', () => {
    const clip = clipFixture({ user_color_class_override: 'd_log' });
    expect(badgeForClip(clip)).toBe('overridden');
  });

  it('returns "suggested" when a WS8 hint is present and no override', () => {
    const clip = clipFixture({
      user_color_class_override: undefined,
      suggested_log_class: 'd_log',
    });
    expect(badgeForClip(clip)).toBe('suggested');
  });

  it('returns "detected" when neither override nor suggestion are set', () => {
    const clip = clipFixture({
      user_color_class_override: undefined,
      suggested_log_class: undefined,
    });
    expect(badgeForClip(clip)).toBe('detected');
  });

  it('prefers "overridden" over "suggested" — user intent wins', () => {
    // The user already confirmed; the original suggestion is moot.
    const clip = clipFixture({
      user_color_class_override: 'd_log',
      suggested_log_class: 'd_log',
    });
    expect(badgeForClip(clip)).toBe('overridden');
  });
});

describe('labelForSourceClass', () => {
  it('renders user-readable labels for every class', () => {
    // Spot-check the brief's mock strings. The exact wording is contractual
    // for the dialog mock screenshot in WS9 §2.
    expect(labelForSourceClass('sdr_bt709')).toBe('Rec.709 SDR');
    expect(labelForSourceClass('hlg_bt2020')).toBe('HLG BT.2020 HDR');
    expect(labelForSourceClass('pq_bt2020')).toBe('PQ BT.2020 HDR');
    expect(labelForSourceClass('dolby_vision')).toBe('Dolby Vision');
    expect(labelForSourceClass('d_log')).toBe('D-Log');
    expect(labelForSourceClass('s_log3')).toBe('S-Log3');
  });
});

describe('isLogClass', () => {
  it('returns true only for log variants', () => {
    expect(isLogClass('d_log')).toBe(true);
    expect(isLogClass('c_log3')).toBe(true);
    expect(isLogClass('gp_log')).toBe(true);
    expect(isLogClass('v_log')).toBe(true);
    expect(isLogClass('s_log2')).toBe(true);
    expect(isLogClass('sdr_bt709')).toBe(false);
    expect(isLogClass('hlg_bt2020')).toBe(false);
    expect(isLogClass('dolby_vision')).toBe(false);
    expect(isLogClass('unknown')).toBe(false);
  });
});

describe('camera grouping', () => {
  it('groups by (make, model) string concatenation', () => {
    const a = metaFixture({ camera_make: 'DJI', camera_model: 'Mavic 3' });
    const b = metaFixture({ camera_make: 'DJI', camera_model: 'Mavic 3' });
    const c = metaFixture({ camera_make: 'Apple', camera_model: 'iPhone 15 Pro' });
    expect(cameraGroupKey(a)).toBe(cameraGroupKey(b));
    expect(cameraGroupKey(a)).not.toBe(cameraGroupKey(c));
  });

  it('lands clips missing make/model in a single Unknown bucket', () => {
    const noMake = metaFixture({ camera_make: null, camera_model: null });
    const blanks = metaFixture({ camera_make: '', camera_model: '' });
    expect(cameraGroupKey(noMake)).toBe(cameraGroupKey(blanks));
    expect(cameraGroupLabel(noMake)).toBe('Unknown source');
  });

  it('handles half-populated cameras gracefully', () => {
    const justMake = metaFixture({ camera_make: 'DJI', camera_model: null });
    const justModel = metaFixture({ camera_make: null, camera_model: 'X' });
    expect(cameraGroupLabel(justMake)).toBe('DJI');
    expect(cameraGroupLabel(justModel)).toBe('X');
  });
});
