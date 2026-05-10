import { useEffect, useRef, useState } from 'react';
import {
  clampLayout,
  drawnAreaSize,
  legalSplitSides,
  type AspectRatio,
  type SplitLayout,
} from '../../lib/layout';
import { snap, splitSnapTargets, SNAP_THRESHOLD } from './snap';

export interface UseSplitDragArgs {
  layout: SplitLayout;
  aspect: AspectRatio;
  containerWidth: number;
  containerHeight: number;
  snapEnabled: boolean;
  onChange: (next: SplitLayout) => void;
  disabled?: boolean;
}

export interface UseSplitDragHandlers {
  beginDrag: (e: PointerEvent | React.PointerEvent) => void;
  isDragging: boolean;
}

interface DragSession {
  startClientX: number;
  startClientY: number;
  startDivider: number;
}

export function useSplitDrag(args: UseSplitDragArgs): UseSplitDragHandlers {
  const [isDragging, setIsDragging] = useState(false);
  const sessionRef = useRef<DragSession | null>(null);

  const latestRef = useRef(args);
  useEffect(() => {
    latestRef.current = args;
  });

  function beginDrag(e: PointerEvent | React.PointerEvent) {
    if (latestRef.current.disabled) return;
    sessionRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startDivider: latestRef.current.layout.divider,
    };
    setIsDragging(true);
  }

  useEffect(() => {
    if (!isDragging) return;
    function handleMove(e: PointerEvent) {
      const session = sessionRef.current;
      const cur = latestRef.current;
      if (!session || cur.disabled) return;
      const drawn = drawnAreaSize(cur.aspect, cur.containerWidth, cur.containerHeight);
      if (drawn.width <= 0 || drawn.height <= 0) return;
      const sides = legalSplitSides(cur.aspect);
      const horizontalAxis = sides[0] === 'left' || sides[0] === 'right';
      const dPx = horizontalAxis
        ? e.clientX - session.startClientX
        : e.clientY - session.startClientY;
      const denom = horizontalAxis ? drawn.width : drawn.height;
      const projected = session.startDivider + dPx / denom;
      const snapped =
        e.altKey || !cur.snapEnabled
          ? projected
          : snap(projected, splitSnapTargets(cur.aspect), SNAP_THRESHOLD);
      const next: SplitLayout = { ...cur.layout, divider: snapped };
      const clamped = clampLayout(next, cur.aspect);
      if (clamped.mode === 'split') {
        cur.onChange(clamped);
      }
    }
    function handleUp() {
      sessionRef.current = null;
      setIsDragging(false);
    }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [isDragging]);

  return { beginDrag, isDragging };
}
