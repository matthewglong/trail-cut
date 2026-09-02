import { describe, it, expect } from 'vitest';
import { formatTotalDuration } from '../format';

describe('formatTotalDuration', () => {
  it('formats sub-hour values as M:SS.t', () => {
    expect(formatTotalDuration(0)).toBe('0:00.0');
    expect(formatTotalDuration(9_400)).toBe('0:09.4');
    expect(formatTotalDuration(65_000)).toBe('1:05.0');
    expect(formatTotalDuration(599_900)).toBe('9:59.9');
  });

  it('rolls minutes into an hours field past 60 minutes', () => {
    expect(formatTotalDuration(3_600_000)).toBe('1:00:00.0');
    expect(formatTotalDuration(3_723_400)).toBe('1:02:03.4');
  });

  it('carries a rounded-up tenth into the next second/minute', () => {
    expect(formatTotalDuration(59_960)).toBe('1:00.0');
    expect(formatTotalDuration(1_550)).toBe('0:01.6');
  });

  it('clamps negatives to zero', () => {
    expect(formatTotalDuration(-100)).toBe('0:00.0');
  });
});
