import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSplitDrag } from '../useSplitDrag';
import type { SplitLayout } from '../../../lib/layout';

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; shiftKey?: boolean },
): PointerEvent {
  const evt = Object.assign(new Event(type, { bubbles: true }), {
    clientX: init.clientX,
    clientY: init.clientY,
    shiftKey: init.shiftKey ?? false,
    button: 0,
  });
  return evt as unknown as PointerEvent;
}

const portraitSplit: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.5 };
const landscapeSplit: SplitLayout = { mode: 'split', video_side: 'left', divider: 0.5 };

describe('useSplitDrag — 9_16 horizontal divider (vertical drag)', () => {
  it('vertical pixel delta projects through containerHeight to divider', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useSplitDrag({
        layout: portraitSplit,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 130 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as SplitLayout;
    expect(next.divider).toBeCloseTo(0.5 + 30 / 960, 6);
  });
});

describe('useSplitDrag — 16_9 vertical divider (horizontal drag)', () => {
  it('horizontal pixel delta projects through containerWidth (output width)', () => {
    const onChange = vi.fn();
    // For 16_9 output (1920×1080) into a 540×960 container, the drawn area is
    // width-constrained: drawnWidth = 540, drawnHeight = 540 * (1080/1920) = 303.75.
    const { result } = renderHook(() =>
      useSplitDrag({
        layout: landscapeSplit,
        aspect: '16_9',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 140, clientY: 100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as SplitLayout;
    expect(next.divider).toBeCloseTo(0.5 + 40 / 540, 6);
  });
});

describe('useSplitDrag — snap', () => {
  it('snaps divider to 0.5 within threshold when snap enabled', () => {
    const onChange = vi.fn();
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.49 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // +5 px in y → divider 0.49 + 5/960 ≈ 0.4952 — within 0.015 of 0.5.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 105 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as SplitLayout;
    expect(next.divider).toBe(0.5);
  });

  it('does not snap when shiftKey is held', () => {
    const onChange = vi.fn();
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.49 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 105, shiftKey: true }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as SplitLayout;
    expect(next.divider).not.toBe(0.5);
    expect(next.divider).toBeCloseTo(0.49 + 5 / 960, 6);
  });
});

describe('useSplitDrag — listener teardown', () => {
  it('stops emitting after pointerup', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useSplitDrag({
        layout: portraitSplit,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
    });
    onChange.mockClear();
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 200 }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('useSplitDrag — clamping at edges', () => {
  it('clamps divider to upper bound (0.95) when drag exceeds it', () => {
    const onChange = vi.fn();
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.9 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // +200 px → +200/960 ≈ +0.208 → would be 1.108, clamped to 0.95.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 300 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as SplitLayout;
    expect(next.divider).toBeLessThanOrEqual(0.95);
    expect(next.divider).toBeCloseTo(0.95, 6);
  });

  it('clamps divider to lower bound (0.05) when drag exceeds it', () => {
    const onChange = vi.fn();
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.1 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: false,
        onChange,
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    // -200 px → -200/960 ≈ -0.208 → would be -0.108, clamped to 0.05.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: -100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as SplitLayout;
    expect(next.divider).toBeGreaterThanOrEqual(0.05);
    expect(next.divider).toBeCloseTo(0.05, 6);
  });
});

describe('useSplitDrag — disabled', () => {
  it('does not begin a drag when disabled', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useSplitDrag({
        layout: portraitSplit,
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
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    expect(result.current.isDragging).toBe(false);
  });
});

describe('useSplitDrag — activeSnap', () => {
  it('starts as null', () => {
    const { result } = renderHook(() =>
      useSplitDrag({
        layout: portraitSplit,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    expect(result.current.activeSnap.divider).toBeNull();
  });

  it('populates active.divider when drag enters snap range', () => {
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.49 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 105 }),
      );
    });
    expect(result.current.activeSnap.divider).toBe(0.5);
  });

  it('does not populate activeSnap when shiftKey is held', () => {
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.49 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 105, shiftKey: true }),
      );
    });
    expect(result.current.activeSnap.divider).toBeNull();
  });

  it('resets to null on pointerup', () => {
    const layout: SplitLayout = { mode: 'split', video_side: 'top', divider: 0.49 };
    const { result } = renderHook(() =>
      useSplitDrag({
        layout,
        aspect: '9_16',
        containerWidth: 540,
        containerHeight: 960,
        snapEnabled: true,
        onChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.beginDrag(
        pointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 105 }),
      );
    });
    expect(result.current.activeSnap.divider).toBe(0.5);
    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 105 }));
    });
    expect(result.current.activeSnap.divider).toBeNull();
  });
});
