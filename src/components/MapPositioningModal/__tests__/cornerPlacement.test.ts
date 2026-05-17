import { describe, it, expect } from 'vitest';
import { assignChromeCorners } from '../cornerPlacement';
import type { LayoutConfig } from '../../../lib/layout';

// Rendered container sizes that roughly match what the Triptych tile actually
// produces at the layout's default frame height (~440px).
const SIZE_16_9: [number, number] = [782, 440];
const SIZE_4_5:  [number, number] = [352, 440];
const SIZE_9_16: [number, number] = [248, 440];

const pip = (x: number, y: number, w: number, h: number): LayoutConfig => ({
  mode: 'pip',
  inset_source: 'map',
  inset: { x, y, w, h },
  corner_radius: 0,
});

const split = (
  side: 'left' | 'right' | 'top' | 'bottom',
  divider: number,
): LayoutConfig => ({ mode: 'split', video_side: side, divider });

describe('assignChromeCorners — defaults when no collisions', () => {
  it('places ratio tl / modePill tr / reset br when the inset is small and centered', () => {
    const layout = pip(0.45, 0.45, 0.10, 0.10);
    const result = assignChromeCorners(layout, ...SIZE_16_9);
    expect(result).toEqual({ ratio: 'tl', modePill: 'tr', reset: 'br' });
  });

  it('places defaults for centered split (divider at 0.5)', () => {
    const result = assignChromeCorners(split('left', 0.5), ...SIZE_16_9);
    expect(result).toEqual({ ratio: 'tl', modePill: 'tr', reset: 'br' });
  });
});

describe('assignChromeCorners — PiP collisions', () => {
  it('relocates reset off br when the inset sits bottom-right', () => {
    // Matches the 9:16 default: inset at bottom-right.
    const layout = pip(0.65, 0.78, 0.32, 0.18);
    const result = assignChromeCorners(layout, ...SIZE_9_16);
    expect(result.reset).not.toBe('br');
    // Reset should fall to its second preference (bl) since br is dangerous.
    expect(result.reset).toBe('bl');
    // Mode pill default (tr) is still clear.
    expect(result.modePill).toBe('tr');
    // Ratio default (tl) is still clear.
    expect(result.ratio).toBe('tl');
  });

  it('relocates ratio off tl when the inset sits top-left', () => {
    const layout = pip(0.04, 0.04, 0.35, 0.30);
    const result = assignChromeCorners(layout, ...SIZE_16_9);
    expect(result.ratio).not.toBe('tl');
    expect(result.modePill).toBe('tr');
    expect(result.reset).toBe('br');
  });

  it('relocates mode pill off tr when the inset sits top-right', () => {
    const layout = pip(0.62, 0.04, 0.34, 0.28);
    const result = assignChromeCorners(layout, ...SIZE_16_9);
    expect(result.modePill).not.toBe('tr');
    // The mode pill prefers the neutral bl over stealing tl from ratio.
    expect(result.modePill).toBe('bl');
    expect(result.ratio).toBe('tl');
    expect(result.reset).toBe('br');
  });

  it('produces three distinct corners even when two defaults collide', () => {
    // Inset spans the entire bottom edge — threatens both bl and br.
    const layout = pip(0.05, 0.70, 0.90, 0.25);
    const { ratio, modePill, reset } = assignChromeCorners(layout, ...SIZE_16_9);
    const set = new Set([ratio, modePill, reset]);
    expect(set.size).toBe(3);
    // br is dangerous, so reset should hop to a clear corner.
    expect(reset).not.toBe('br');
    expect(reset).not.toBe('bl');
  });
});

describe('assignChromeCorners — Split: per-button flip rule', () => {
  it('keeps defaults when divider sits comfortably mid-frame', () => {
    const result = assignChromeCorners(split('left', 0.5), ...SIZE_16_9);
    expect(result).toEqual({ ratio: 'tl', modePill: 'tr', reset: 'br' });
  });

  it('flips right-side buttons horizontally when a vertical divider squeezes the right', () => {
    // Divider at 0.95 on a 16:9 frame (782px wide): chrome danger width is
    // (90 + 16) / 782 ≈ 0.135. divider > 1 - 0.135 = 0.865, so tr and br are
    // dangerous. Vertical divider → horizontal flip.
    const result = assignChromeCorners(split('left', 0.95), ...SIZE_16_9);
    expect(result.ratio).toBe('tl');           // safe, stays
    expect(result.modePill).toBe('tl');        // tr encroached → flip H → tl
    expect(result.reset).toBe('bl');           // br encroached → flip H → bl
  });

  it('flips left-side buttons horizontally when a vertical divider squeezes the left', () => {
    // Divider at 0.05 < 0.135 → tl and bl are dangerous.
    const result = assignChromeCorners(split('left', 0.05), ...SIZE_16_9);
    expect(result.ratio).toBe('tr');           // tl encroached → flip H → tr
    expect(result.modePill).toBe('tr');        // safe, stays
    expect(result.reset).toBe('br');           // safe, stays
  });

  it('flips top buttons vertically when a horizontal divider squeezes the top', () => {
    // For 9:16 frame (248×440): chrome danger height ≈ (32 + 16) / 440 ≈ 0.109.
    // Divider at 0.05 < 0.109 → tl and tr are dangerous. Horizontal divider →
    // vertical flip.
    const result = assignChromeCorners(split('top', 0.05), ...SIZE_9_16);
    expect(result.ratio).toBe('bl');           // tl encroached → flip V → bl
    expect(result.modePill).toBe('br');        // tr encroached → flip V → br
    expect(result.reset).toBe('br');           // safe, stays
  });

  it('stays at the default when both default and mirror are encroached', () => {
    // A degenerate split where dw is so large that both sides are dangerous
    // simultaneously can't happen with the chrome threshold, so simulate the
    // edge case via a tiny container that makes dw > 0.5. Container 100×440
    // gives dw = 106/100 clamped to 0.6, so any divider < 0.6 makes tl/bl
    // dangerous AND any divider > 0.4 makes tr/br dangerous. A divider at 0.5
    // therefore makes all four corners dangerous.
    const result = assignChromeCorners(split('left', 0.5), 100, 440);
    // Every button stays at its default since both the default and mirror are
    // dangerous — no thrashing.
    expect(result).toEqual({ ratio: 'tl', modePill: 'tr', reset: 'br' });
  });
});

describe('assignChromeCorners — always produces a valid triple', () => {
  it('returns three distinct corners for an oversize inset', () => {
    const layout = pip(0.02, 0.02, 0.96, 0.96);
    const result = assignChromeCorners(layout, ...SIZE_16_9);
    expect(new Set([result.ratio, result.modePill, result.reset]).size).toBe(3);
  });

  it('does not blow up when container dimensions are zero', () => {
    const layout = pip(0.5, 0.5, 0.2, 0.2);
    const result = assignChromeCorners(layout, 0, 0);
    expect(new Set([result.ratio, result.modePill, result.reset]).size).toBe(3);
  });
});
