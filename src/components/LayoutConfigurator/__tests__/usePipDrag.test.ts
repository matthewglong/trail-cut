import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipDrag } from '../usePipDrag';
import type { PipLayout } from '../../../lib/layout';

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; altKey?: boolean },
): PointerEvent {
  const evt = Object.assign(new Event(type, { bubbles: true }), {
    clientX: init.clientX,
    clientY: init.clientY,
    altKey: init.altKey ?? false,
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

describe('usePipDrag — snap behavior', () => {
  it('snaps inset.x to 0.5 when within threshold and snapEnabled', () => {
    const onChange = vi.fn();
    // start.x = 0.49; we need inset.x within 0.015 of 0.5.
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.49, y: 0.1, w: 0.3, h: 0.3 },
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
    // +5 px in x → 0.49 + 5/540 ≈ 0.4993; within threshold of 0.5 → snaps.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 105, clientY: 100 }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).toBe(0.5);
  });

  it('does not snap when altKey is held', () => {
    const onChange = vi.fn();
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.49, y: 0.1, w: 0.3, h: 0.3 },
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
        pointerEvent('pointermove', { clientX: 105, clientY: 100, altKey: true }),
      );
    });
    const next = onChange.mock.calls.at(-1)![0] as PipLayout;
    expect(next.inset.x).not.toBe(0.5);
    expect(next.inset.x).toBeCloseTo(0.49 + 5 / 540, 6);
  });
});

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
    const start: PipLayout = {
      ...baseLayout,
      inset: { x: 0.49, y: 0.1, w: 0.3, h: 0.3 },
    };
    // 4:5 container has different drawn dims; snap targets are aspect-correct.
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
    expect(next.inset.x).toBe(0.5);
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
