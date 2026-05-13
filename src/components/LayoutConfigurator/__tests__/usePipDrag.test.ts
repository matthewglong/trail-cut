import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipDrag } from '../usePipDrag';
import type { PipLayout } from '../../../lib/layout';

function pointerEvent(
  type: string,
  init: {
    clientX: number;
    clientY: number;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  },
): PointerEvent {
  const evt = Object.assign(new Event(type, { bubbles: true }), {
    clientX: init.clientX,
    clientY: init.clientY,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    button: 0,
  });
  return evt as unknown as PointerEvent;
}

const baseLayout: PipLayout = {
  mode: 'pip',
  inset_source: 'map',
  inset: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  corner_radius: 0.012,
};

// ---------------------------------------------------------------------------
// Pointer-delta translation (snap disabled)
// ---------------------------------------------------------------------------

describe('usePipDrag — move', () => {
  it('translates pixel deltas into normalized inset.x / inset.y', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      usePipDrag({
        layout: baseLayout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 150, clientY: 130 }),
      );
    });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBeCloseTo(0.1 + 50 / 540, 6);
    expect(next.inset.y).toBeCloseTo(0.1 + 30 / 960, 6);
    expect(next.inset.w).toBeCloseTo(0.3, 6);
    expect(next.inset.h).toBeCloseTo(0.3, 6);
  });
});

describe('usePipDrag — resize-corner br', () => {
  it('extends inset.w and inset.h; x/y unchanged', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      usePipDrag({
        layout: baseLayout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'resize-corner', corner: 'br' },
        pointerEvent('pointerdown', { clientX: 200, clientY: 200 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 220, clientY: 210 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBeCloseTo(0.1, 6);
    expect(next.inset.y).toBeCloseTo(0.1, 6);
    expect(next.inset.w).toBeCloseTo(0.3 + 20 / 540, 6);
    expect(next.inset.h).toBeCloseTo(0.3 + 10 / 960, 6);
  });
});

describe('usePipDrag — resize-edge right', () => {
  it('only inset.w changes', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      usePipDrag({
        layout: baseLayout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'resize-edge', edge: 'right' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 115, clientY: 200 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBeCloseTo(0.1, 6);
    expect(next.inset.y).toBeCloseTo(0.1, 6);
    expect(next.inset.h).toBeCloseTo(0.3, 6);
    expect(next.inset.w).toBeCloseTo(0.3 + 15 / 540, 6);
  });
});

// ---------------------------------------------------------------------------
// Per-axis position snap
// ---------------------------------------------------------------------------

describe('usePipDrag — axis snap', () => {
  it('snaps inset.x to centered (0.5 - w/2) when within threshold', () => {
    const onChange = vi.fn();
    const w = 0.3;
    // Centered target = 0.5 - 0.15 = 0.35. Start at 0.34, drag +5px → 0.349.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBeCloseTo(0.35, 6);
  });

  it('snaps inset.x to flush left when near 0', () => {
    const onChange = vi.fn();
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.02, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      // -5px → x = 0.02 - 5/540 ≈ 0.0107. Within threshold of 0 → flush.
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 95, clientY: 100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBe(0);
  });

  it('does not snap when shiftKey is held on move drag', () => {
    const onChange = vi.fn();
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100, shiftKey: true }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).not.toBeCloseTo(0.35, 6);
    expect(next.inset.x).toBeCloseTo(0.34 + 5 / 540, 6);
  });
});

// ---------------------------------------------------------------------------
// Aspect snap (corner drag couples w and h)
// ---------------------------------------------------------------------------

describe('usePipDrag — aspect snap', () => {
  it('couples w and h onto the 1:1 aspect line during corner drag', () => {
    const onChange = vi.fn();
    // 9:16 output. 1:1 slope = 1080/1920 = 0.5625. Start with (w=0.4, h=0.225)
    // which IS on the 1:1 line. Drag the BR corner a tiny amount; the snap
    // should keep (w, h) on or very near the 1:1 line.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.2, y: 0.4, w: 0.4, h: 0.225 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'resize-corner', corner: 'br' },
        pointerEvent('pointerdown', { clientX: 200, clientY: 200 }),
      );
    });
    // Pull BR corner outward slightly — w and h both grow a little.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 210, clientY: 210 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    // Inset's actual w / h (in pixel terms, accounting for output) should be ≈ 1:1.
    const actualRatio = (next.inset.w * 1080) / (next.inset.h * 1920);
    expect(actualRatio).toBeCloseTo(1, 1);
  });

  it('exposes the aspect label on activeSnap.aspect when engaged', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.2, y: 0.4, w: 0.4, h: 0.225 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'resize-corner', corner: 'br' },
        pointerEvent('pointerdown', { clientX: 200, clientY: 200 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 210, clientY: 210 }),
      );
    });
    expect(result.current.activeSnap.aspect?.label).toBe('1:1');
  });

  it('does not engage aspect snap on unshifted edge drag', () => {
    // Right-edge drag without shift: only w changes, h stays. No aspect snap.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.2, y: 0.4, w: 0.4, h: 0.225 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'resize-edge', edge: 'right' },
        pointerEvent('pointerdown', { clientX: 200, clientY: 200 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 210, clientY: 200 }),
      );
    });
    expect(result.current.activeSnap.aspect).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shift-locked edge drag (constrain orthogonal dim to start aspect)
// ---------------------------------------------------------------------------

describe('usePipDrag — Shift on edge drag (constrain orthogonal)', () => {
  it('with Shift, dragging the right edge grows h to preserve start aspect', () => {
    const onChange = vi.fn();
    // Start with a non-1:1 aspect so the constrain effect is observable.
    // w = 0.4, h = 0.4 → start ratio (w/h) = 1 in normalized. On 9:16, the
    // aspect IS 9:16 (because the inset normalized box matches the frame aspect).
    // Pick something where the orthogonal grows visibly: w=0.2, h=0.4.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false, // disable snap so the constrain math is observable raw
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'resize-edge', edge: 'right' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // +20px in x → +20/540 ≈ +0.037 to w. Start ratio w/h = 0.5.
    // New w ≈ 0.237; constrained new h = w / 0.5 = 0.474.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 120, clientY: 100, shiftKey: true }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.w / next.inset.h).toBeCloseTo(start.inset.w / start.inset.h, 4);
  });
});

// ---------------------------------------------------------------------------
// Equal-margin coupled snap
// ---------------------------------------------------------------------------

describe('usePipDrag — equal-margin snap', () => {
  it('pulls right = bottom in pixel space during move drag on 9:16', () => {
    const onChange = vi.fn();
    // On 9:16 (1080x1920): right_px = (1-0.45-0.3)*1080 = 270;
    // bottom_px = (1-0.5594-0.3)*1920 ≈ 269.95 — within 24px threshold.
    // Other adjacent pairs are far apart; no axis snap engages here either.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.45, y: 0.5594, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 101, clientY: 101 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    const rightPx = (1 - next.inset.x - next.inset.w) * 1080;
    const bottomPx = (1 - next.inset.y - next.inset.h) * 1920;
    expect(rightPx).toBeCloseTo(bottomPx, 4);
  });

  it('does NOT pull right = bottom when only fractions match on 9:16 (the bug case)', () => {
    // {x:0.1, y:0.1, w:0.3, h:0.3}: right_frac = bottom_frac = 0.6, but
    // right_px = 648, bottom_px = 1152 — way outside the pixel threshold.
    // No equal-margin pull should engage.
    const onChange = vi.fn();
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 101, clientY: 101 }),
      );
    });
    expect(result.current.activeSnap.margins.pairs).not.toContain('right=bottom');
  });

  it('reports recognized margin pairs on activeSnap.margins', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.45, y: 0.5594, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 101, clientY: 101 }),
      );
    });
    expect(result.current.activeSnap.margins.pairs).toContain('right=bottom');
  });
});

// ---------------------------------------------------------------------------
// Listener teardown, clamping, disabled, activeSnap reset
// ---------------------------------------------------------------------------

describe('usePipDrag — listener leaks', () => {
  it('removes window listeners on pointerup', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      usePipDrag({
        layout: baseLayout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    expect(result.current.isDragging).toBe(true);
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
    });
    expect(result.current.isDragging).toBe(false);
    onChange.mockClear();
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 200, clientY: 200 }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('usePipDrag — clamping at edges', () => {
  it('clamps inset.x so inset.x + inset.w never exceeds 1', () => {
    const onChange = vi.fn();
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // +200 px in x → +200/540 ≈ +0.37 → x would be 0.97, but clamped to 1 - w = 0.7.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 300, clientY: 100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x + next.inset.w).toBeLessThanOrEqual(1);
    expect(next.inset.x).toBeCloseTo(0.7, 6);
  });
});

describe('usePipDrag — aspect threading', () => {
  it('applies snap correctly at non-9_16 aspect', () => {
    const onChange = vi.fn();
    // 4:5 output: dimensions 1080x1350; drawn area sized accordingly.
    // Centered target with w=0.3 is 0.35 (axis snap is output-independent).
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '4_5',
        containerWidth: 540,
        containerHeight: 675,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBeCloseTo(0.35, 6);
  });
});

describe('usePipDrag — disabled', () => {
  it('does not begin a drag when disabled', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      usePipDrag({
        layout: baseLayout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
        disabled: true,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    expect(result.current.isDragging).toBe(false);
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 200, clientY: 200 }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('usePipDrag — activeSnap', () => {
  it('starts with no engagement', () => {
    const { result } = renderHook(() =>
      usePipDrag({
        layout: baseLayout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    expect(result.current.activeSnap.axisX).toBeNull();
    expect(result.current.activeSnap.axisY).toBeNull();
    expect(result.current.activeSnap.aspect).toBeNull();
    expect(result.current.activeSnap.margins.pairs).toEqual([]);
  });

  it('populates axisX with the engaged stop during move drag', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX?.label).toBe('center');
    expect(result.current.activeSnap.axisX?.value).toBeCloseTo(0.35, 6);
  });

  it('clears engagement when drag leaves snap range', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX?.label).toBe('center');
    // Drag +40px → x = 0.34 + 40/540 ≈ 0.414. Stops near are 0.35 (center,
    // dist 0.064) and 0.468 (φ, dist 0.054); both outside SNAP_THRESHOLD.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 140, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX).toBeNull();
  });

  it('does not populate axisX when shiftKey is held on move drag', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100, shiftKey: true }),
      );
    });
    expect(result.current.activeSnap.axisX).toBeNull();
  });

  it('holds an engaged stop through a wider release window (hysteresis)', () => {
    // Center target = 0.35; center capture = 0.025; release = 0.025 * 1.6 = 0.04.
    // Engage center, then drag to a value outside the capture window but
    // inside the release window — should stay engaged.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.349, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        // Choose container so drawn.width = 1000 (1px = 0.001 normalized).
        // 9_16 OUTPUT_DIMS is 1080x1920 → scaleFactor = min(1000/1080, 2000/1920)
        // = 1000/1080 → drawn = 1000 x 1778.
        containerWidth: 1000,
        containerHeight: 2000,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // First move: x = 0.349 + 1/1000 = 0.350 → engages center (dist 0).
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 101, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX?.label).toBe('center');
    // Second move: x = 0.349 + 30/1000 = 0.379. Distance to center = 0.029.
    // Outside capture (0.025) but inside release (0.04) → still engaged.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 130, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX?.label).toBe('center');
    // Third move: x = 0.349 + 45/1000 = 0.394. Distance to center = 0.044.
    // Past release threshold (0.04) → releases.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 145, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX).toBeNull();
  });

  it('disables snap when Meta/Ctrl is held mid-drag (Figma-style escape valve)', () => {
    const onChange = vi.fn();
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // Pointer move that WOULD snap center, with metaKey held → no snap.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100, metaKey: true }),
      );
    });
    expect(result.current.activeSnap.axisX).toBeNull();
    expect(result.current.activeSnap.axisY).toBeNull();
    expect(result.current.activeSnap.aspect).toBeNull();
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    // Unsnapped value: 0.34 + 5/540 ≈ 0.3493.
    expect(next.inset.x).toBeCloseTo(0.34 + 5 / 540, 6);
  });

  it('re-engages snap when Meta/Ctrl is released mid-drag', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // Meta held — no snap.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100, metaKey: true }),
      );
    });
    expect(result.current.activeSnap.axisX).toBeNull();
    // Meta released — snap re-engages at the same pointer position.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX?.label).toBe('center');
  });

  it('resets to no engagement on pointerup', () => {
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.34, y: 0.1, w: 0.3, h: 0.3 },
    };
    const { result } = renderHook(() =>
      usePipDrag({
        layout: start,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        { kind: 'move' },
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    expect(result.current.activeSnap.axisX?.label).toBe('center');
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 105, clientY: 100 }));
    });
    expect(result.current.activeSnap.axisX).toBeNull();
    expect(result.current.activeSnap.axisY).toBeNull();
    expect(result.current.activeSnap.aspect).toBeNull();
    expect(result.current.activeSnap.margins.pairs).toEqual([]);
  });
});
