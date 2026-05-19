// Pure unit tests for the gradient math helpers. No React, no DOM.

import { describe, it, expect } from 'vitest';
import {
  MAX_STOPS,
  MIN_STOP_SEPARATION,
  cloneStops,
  formatDistanceLabel,
  formatTotalDistance,
  hexToRgb,
  initialGradientFromSolid,
  insertStop,
  insertStopAtLargestGap,
  interpolateSrgb,
  moveStop,
  removeStop,
  rgbToHex,
  roundFraction,
  sampleStopsAt,
  setStopColor,
  snapToTicks,
  stopsToCssLinearGradient,
} from '../gradientMath';

describe('hexToRgb / rgbToHex', () => {
  it('round-trips a 6-char hex', () => {
    const v = hexToRgb('#bced09');
    expect(v).toEqual([188, 237, 9]);
    expect(rgbToHex(...(v as [number, number, number]))).toBe('#bced09');
  });
  it('accepts hex without #', () => {
    expect(hexToRgb('ff715b')).toEqual([255, 113, 91]);
  });
  it('rejects malformed input', () => {
    expect(hexToRgb('zzzzzz')).toBeNull();
    expect(hexToRgb('123')).toBeNull(); // 3-char hex not supported by this helper
  });
  it('clamps out-of-range channels on output', () => {
    expect(rgbToHex(-10, 999, 128)).toBe('#00ff80');
  });
});

describe('interpolateSrgb', () => {
  it('interpolates at t=0 to a, t=1 to b', () => {
    expect(interpolateSrgb('#000000', '#ffffff', 0)).toBe('#000000');
    expect(interpolateSrgb('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
  it('interpolates linearly at t=0.5', () => {
    expect(interpolateSrgb('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
  it('falls back to `a` on bad input', () => {
    expect(interpolateSrgb('#bced09', 'zzz', 0.5)).toBe('#bced09');
  });
});

describe('sampleStopsAt', () => {
  const stops = [
    { fraction: 0, color: '#000000' },
    { fraction: 0.5, color: '#ff0000' },
    { fraction: 1, color: '#0000ff' },
  ];
  it('returns the first stop color at 0', () => {
    expect(sampleStopsAt(stops, 0)).toBe('#000000');
  });
  it('returns the last stop color at 1', () => {
    expect(sampleStopsAt(stops, 1)).toBe('#0000ff');
  });
  it('interpolates between stops', () => {
    expect(sampleStopsAt(stops, 0.25)).toBe('#800000');
  });
});

describe('roundFraction', () => {
  it('rounds to 4 decimal places', () => {
    expect(roundFraction(0.123456789)).toBe(0.1235);
    expect(roundFraction(0.99996)).toBe(1);
  });
});

describe('insertStop', () => {
  const baseStops = () => [
    { fraction: 0, color: '#000000' },
    { fraction: 1, color: '#ffffff' },
  ];

  it('inserts a stop with interpolated color at the click fraction', () => {
    const out = insertStop(baseStops(), 0.5);
    expect(out.length).toBe(3);
    expect(out[1].fraction).toBe(0.5);
    expect(out[1].color).toBe('#808080');
  });

  it('rejects when at MAX_STOPS', () => {
    const stops = Array.from({ length: MAX_STOPS }, (_, i) => ({
      fraction: i / (MAX_STOPS - 1),
      color: '#888888',
    }));
    const out = insertStop(stops, 0.123);
    expect(out).toBe(stops);
  });

  it('rejects when within MIN_STOP_SEPARATION of an existing stop', () => {
    const stops = [
      { fraction: 0, color: '#000000' },
      { fraction: 0.5, color: '#888888' },
      { fraction: 1, color: '#ffffff' },
    ];
    const out = insertStop(stops, 0.502); // within 0.005 of 0.5
    expect(out).toBe(stops);
  });

  it('rejects 0 and 1 fractions (endpoints already exist)', () => {
    expect(insertStop(baseStops(), 0)).toEqual(baseStops());
    expect(insertStop(baseStops(), 1)).toEqual(baseStops());
  });
});

describe('insertStopAtLargestGap', () => {
  it('inserts at the midpoint of the widest gap', () => {
    const stops = [
      { fraction: 0, color: '#000000' },
      { fraction: 0.2, color: '#888888' },
      { fraction: 1, color: '#ffffff' },
    ];
    const out = insertStopAtLargestGap(stops);
    expect(out.length).toBe(4);
    // Widest gap is (0.2, 1) — midpoint 0.6
    expect(out[2].fraction).toBe(0.6);
  });

  it('no-ops at MAX_STOPS', () => {
    const stops = Array.from({ length: MAX_STOPS }, (_, i) => ({
      fraction: i / (MAX_STOPS - 1),
      color: '#888888',
    }));
    expect(insertStopAtLargestGap(stops)).toBe(stops);
  });
});

describe('removeStop', () => {
  const stops = [
    { fraction: 0, color: '#000000' },
    { fraction: 0.3, color: '#aaaaaa' },
    { fraction: 0.7, color: '#bbbbbb' },
    { fraction: 1, color: '#ffffff' },
  ];

  it('removes a mid-stop', () => {
    const out = removeStop(stops, 1);
    expect(out.length).toBe(3);
    expect(out.map((s) => s.fraction)).toEqual([0, 0.7, 1]);
  });

  it('refuses to remove the first endpoint', () => {
    expect(removeStop(stops, 0)).toBe(stops);
  });

  it('refuses to remove the last endpoint', () => {
    expect(removeStop(stops, 3)).toBe(stops);
  });

  it('refuses when only 2 stops remain', () => {
    const twoStops = [stops[0], stops[3]];
    expect(removeStop(twoStops, 0)).toBe(twoStops);
  });
});

describe('moveStop', () => {
  const stops = [
    { fraction: 0, color: '#000000' },
    { fraction: 0.5, color: '#888888' },
    { fraction: 1, color: '#ffffff' },
  ];

  it('moves a mid-stop to a new fraction', () => {
    const out = moveStop(stops, 1, 0.3);
    expect(out[1].fraction).toBe(0.3);
  });

  it('refuses to move endpoint 0', () => {
    expect(moveStop(stops, 0, 0.5)).toBe(stops);
  });

  it('refuses to move the last endpoint', () => {
    expect(moveStop(stops, 2, 0.5)).toBe(stops);
  });

  it('snaps to MIN_STOP_SEPARATION when too close to neighbor (left)', () => {
    const out = moveStop(stops, 1, 0.001);
    expect(out[1].fraction).toBeGreaterThanOrEqual(MIN_STOP_SEPARATION);
  });

  it('snaps to MIN_STOP_SEPARATION when too close to neighbor (right)', () => {
    const out = moveStop(stops, 1, 0.999);
    expect(out[1].fraction).toBeLessThanOrEqual(1 - MIN_STOP_SEPARATION);
  });

  it('rounds the final fraction to 4 decimals', () => {
    const out = moveStop(stops, 1, 0.123456789);
    expect(out[1].fraction).toBe(0.1235);
  });
});

describe('setStopColor', () => {
  const stops = [
    { fraction: 0, color: '#000000' },
    { fraction: 1, color: '#ffffff' },
  ];

  it('updates only the color of the indexed stop', () => {
    const out = setStopColor(stops, 0, '#FF0000');
    expect(out[0].color).toBe('#ff0000');
    expect(out[1].color).toBe('#ffffff');
  });

  it('returns the input array unchanged for out-of-range index', () => {
    expect(setStopColor(stops, 99, '#ff0000')).toBe(stops);
  });
});

describe('snapToTicks', () => {
  it('snaps within threshold', () => {
    const out = snapToTicks(0.502, [0.5, 0.8], 0.01);
    expect(out.fraction).toBe(0.5);
    expect(out.snappedTo).toBe(0.5);
  });

  it('does not snap when outside threshold', () => {
    const out = snapToTicks(0.502, [0.5, 0.8], 0.001);
    expect(out.fraction).toBe(0.502);
    expect(out.snappedTo).toBeNull();
  });
});

describe('stopsToCssLinearGradient', () => {
  it('emits a 90deg linear-gradient with percentage stops', () => {
    const out = stopsToCssLinearGradient([
      { fraction: 0, color: '#000000' },
      { fraction: 1, color: '#ffffff' },
    ]);
    expect(out).toContain('linear-gradient(90deg');
    expect(out).toContain('#000000 0.00%');
    expect(out).toContain('#ffffff 100.00%');
  });

  it('returns the single stop color when only one stop', () => {
    expect(stopsToCssLinearGradient([{ fraction: 0, color: '#abc123' }])).toBe('#abc123');
  });
});

describe('formatDistanceLabel / formatTotalDistance', () => {
  it('formats meters when total < 1 km', () => {
    expect(formatDistanceLabel(0.5, 840)).toBe('420 m');
    expect(formatTotalDistance(840)).toBe('840 m');
  });

  it('formats decimal km when total >= 1 km', () => {
    expect(formatDistanceLabel(0.5, 12400)).toBe('6.2 km');
    expect(formatTotalDistance(12400)).toBe('12.4 km');
  });
});

describe('initialGradientFromSolid / cloneStops', () => {
  it('initializes two endpoint stops at the solid color', () => {
    const out = initialGradientFromSolid('#BCED09');
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ fraction: 0, color: '#bced09' });
    expect(out[1]).toEqual({ fraction: 1, color: '#bced09' });
  });

  it('cloneStops returns a deep copy', () => {
    const a = [{ fraction: 0, color: '#000000' }];
    const b = cloneStops(a);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b[0]).not.toBe(a[0]);
  });
});
