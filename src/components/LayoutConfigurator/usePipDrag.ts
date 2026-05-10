import { useEffect, useRef, useState } from 'react';
import {
  clampLayout,
  drawnAreaSize,
  type AspectRatio,
  type PipLayout,
} from '../../lib/layout';
import { findActiveSnapTarget, pipSnapTargets, SNAP_THRESHOLD } from './snap';

export type PipDragHandle =
  | { kind: 'move' }
  | { kind: 'resize-corner'; corner: 'tl' | 'tr' | 'bl' | 'br' }
  | { kind: 'resize-edge'; edge: 'top' | 'right' | 'bottom' | 'left' };

export interface UsePipDragArgs {
  layout: PipLayout;
  aspect: AspectRatio;
  containerWidth: number;
  containerHeight: number;
  snapEnabled: boolean;
  onChange: (next: PipLayout) => void;
  disabled?: boolean;
}

export interface PipActiveSnap {
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}

export interface UsePipDragHandlers {
  beginDrag: (handle: PipDragHandle, e: PointerEvent | React.PointerEvent) => void;
  isDragging: boolean;
  activeSnap: PipActiveSnap;
}

interface DragSession {
  handle: PipDragHandle;
  startClientX: number;
  startClientY: number;
  startLayout: PipLayout;
}

const NO_ACTIVE_SNAP: PipActiveSnap = { x: null, y: null, w: null, h: null };


function applyMove(start: PipLayout, ndx: number, ndy: number): PipLayout {
  return {
    ...start,
    inset: {
      x: start.inset.x + ndx,
      y: start.inset.y + ndy,
      w: start.inset.w,
      h: start.inset.h,
    },
  };
}

function applyResize(
  start: PipLayout,
  handle: Exclude<PipDragHandle, { kind: 'move' }>,
  ndx: number,
  ndy: number,
): PipLayout {
  let { x, y, w, h } = start.inset;
  let touchTop = false;
  let touchRight = false;
  let touchBottom = false;
  let touchLeft = false;
  if (handle.kind === 'resize-corner') {
    touchTop = handle.corner === 'tl' || handle.corner === 'tr';
    touchBottom = handle.corner === 'bl' || handle.corner === 'br';
    touchLeft = handle.corner === 'tl' || handle.corner === 'bl';
    touchRight = handle.corner === 'tr' || handle.corner === 'br';
  } else {
    touchTop = handle.edge === 'top';
    touchBottom = handle.edge === 'bottom';
    touchLeft = handle.edge === 'left';
    touchRight = handle.edge === 'right';
  }
  if (touchLeft) {
    x = start.inset.x + ndx;
    w = start.inset.w - ndx;
  }
  if (touchRight) {
    w = start.inset.w + ndx;
  }
  if (touchTop) {
    y = start.inset.y + ndy;
    h = start.inset.h - ndy;
  }
  if (touchBottom) {
    h = start.inset.h + ndy;
  }
  return { ...start, inset: { x, y, w, h } };
}

interface SnapResult {
  layout: PipLayout;
  active: PipActiveSnap;
}

function applySnap(
  next: PipLayout,
  handle: PipDragHandle,
  shiftKey: boolean,
  snapEnabled: boolean,
  aspect: AspectRatio,
): SnapResult {
  if (shiftKey || !snapEnabled) {
    return { layout: next, active: NO_ACTIVE_SNAP };
  }
  const targets = pipSnapTargets(aspect, next);
  const active: PipActiveSnap = { x: null, y: null, w: null, h: null };
  if (handle.kind === 'move') {
    active.x = findActiveSnapTarget(next.inset.x, targets.x, SNAP_THRESHOLD);
    active.y = findActiveSnapTarget(next.inset.y, targets.y, SNAP_THRESHOLD);
    return {
      layout: {
        ...next,
        inset: {
          ...next.inset,
          x: active.x ?? next.inset.x,
          y: active.y ?? next.inset.y,
        },
      },
      active,
    };
  }
  let { x, y, w, h } = next.inset;
  let touchLeft = false;
  let touchRight = false;
  let touchTop = false;
  let touchBottom = false;
  if (handle.kind === 'resize-corner') {
    touchTop = handle.corner === 'tl' || handle.corner === 'tr';
    touchBottom = handle.corner === 'bl' || handle.corner === 'br';
    touchLeft = handle.corner === 'tl' || handle.corner === 'bl';
    touchRight = handle.corner === 'tr' || handle.corner === 'br';
  } else {
    touchTop = handle.edge === 'top';
    touchBottom = handle.edge === 'bottom';
    touchLeft = handle.edge === 'left';
    touchRight = handle.edge === 'right';
  }
  if (touchRight) {
    active.w = findActiveSnapTarget(w, targets.w, SNAP_THRESHOLD);
    if (active.w !== null) w = active.w;
  }
  if (touchBottom) {
    active.h = findActiveSnapTarget(h, targets.h, SNAP_THRESHOLD);
    if (active.h !== null) h = active.h;
  }
  if (touchLeft) {
    active.x = findActiveSnapTarget(x, targets.x, SNAP_THRESHOLD);
    if (active.x !== null) {
      w = w + (x - active.x);
      x = active.x;
    }
  }
  if (touchTop) {
    active.y = findActiveSnapTarget(y, targets.y, SNAP_THRESHOLD);
    if (active.y !== null) {
      h = h + (y - active.y);
      y = active.y;
    }
  }
  return { layout: { ...next, inset: { x, y, w, h } }, active };
}

export function usePipDrag(args: UsePipDragArgs): UsePipDragHandlers {
  const [isDragging, setIsDragging] = useState(false);
  const [activeSnap, setActiveSnap] = useState<PipActiveSnap>(NO_ACTIVE_SNAP);
  const sessionRef = useRef<DragSession | null>(null);

  const latestRef = useRef(args);
  useEffect(() => {
    latestRef.current = args;
  });

  function beginDrag(handle: PipDragHandle, e: PointerEvent | React.PointerEvent) {
    if (latestRef.current.disabled) return;
    sessionRef.current = {
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startLayout: latestRef.current.layout,
    };
    setIsDragging(true);
  }

  useEffect(() => {
    if (!isDragging) return;
    function handleMove(e: PointerEvent) {
      const session = sessionRef.current;
      const cur = latestRef.current;
      if (!session || cur.disabled) return;
      const drawn = drawnAreaSize(
        cur.aspect,
        cur.containerWidth,
        cur.containerHeight,
      );
      if (drawn.width <= 0 || drawn.height <= 0) return;
      const dx = e.clientX - session.startClientX;
      const dy = e.clientY - session.startClientY;
      const ndx = dx / drawn.width;
      const ndy = dy / drawn.height;
      const projected =
        session.handle.kind === 'move'
          ? applyMove(session.startLayout, ndx, ndy)
          : applyResize(session.startLayout, session.handle, ndx, ndy);
      const { layout: snapped, active } = applySnap(
        projected,
        session.handle,
        e.shiftKey,
        cur.snapEnabled,
        cur.aspect,
      );
      setActiveSnap(active);
      const clamped = clampLayout(snapped, cur.aspect);
      if (clamped.mode === 'pip') {
        cur.onChange(clamped);
      }
    }
    function handleUp() {
      sessionRef.current = null;
      setIsDragging(false);
      setActiveSnap(NO_ACTIVE_SNAP);
    }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [isDragging]);

  return { beginDrag, isDragging, activeSnap };
}
