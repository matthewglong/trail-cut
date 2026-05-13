import { useEffect, useRef, useState } from 'react';
import {
  clampLayout,
  drawnAreaSize,
  type AspectRatio,
  type PipLayout,
} from '../../lib/layout';
import {
  axisCaptureThreshold,
  findActiveMarginPair,
  matchActiveAspect,
  matchActiveAxis,
  matchEqualMargins,
  pipAxisTargets,
  projectToAspect,
  projectToEqualMargin,
  SNAP_THRESHOLD,
  type PipAspectTarget,
  type PipAxisTarget,
  type PipEqualMarginsMatch,
  type PipMarginPair,
} from './snap';

// Release threshold is this multiple of capture threshold. Once a stop is
// engaged we hold it through a slightly wider window so drags *near* a stop
// don't oscillate in and out of the snap zone.
const HYSTERESIS_RELEASE_RATIO = 1.6;

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

/** Snap state surfaced to the overlay during drag. All four fields are
 *  independent — a 1:1 inset can simultaneously be centered horizontally,
 *  flush bottom, and have `right = bottom` equal margins. The overlay reads
 *  each one to decide which guide / chip / outline to render. */
export interface PipActiveSnap {
  /** Per-axis position snap on x (or `null` if free). */
  axisX: PipAxisTarget | null;
  /** Per-axis position snap on y (or `null` if free). */
  axisY: PipAxisTarget | null;
  /** Aspect-fit engagement (corner drag, or Shift-locked edge drag). */
  aspect: PipAspectTarget | null;
  /** Recognition state for margin pair-equalities. Always populated — the
   *  overlay lights up chips whenever margins land equal, whether by active
   *  pull or coincidence. */
  margins: PipEqualMarginsMatch;
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

const NO_EQUAL_MARGINS: PipEqualMarginsMatch = {
  pairs: [],
  centeredX: false,
  centeredY: false,
  fullySymmetric: false,
};

const NO_ACTIVE_SNAP: PipActiveSnap = {
  axisX: null,
  axisY: null,
  aspect: null,
  margins: NO_EQUAL_MARGINS,
};

// ---------------------------------------------------------------------------
// Projection — apply the raw pointer delta to the layout, no snaps yet.
// ---------------------------------------------------------------------------

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

function applyCorner(
  start: PipLayout,
  corner: 'tl' | 'tr' | 'bl' | 'br',
  ndx: number,
  ndy: number,
): PipLayout {
  const touchTop = corner === 'tl' || corner === 'tr';
  const touchBottom = corner === 'bl' || corner === 'br';
  const touchLeft = corner === 'tl' || corner === 'bl';
  const touchRight = corner === 'tr' || corner === 'br';
  let x = start.inset.x;
  let y = start.inset.y;
  let w = start.inset.w;
  let h = start.inset.h;
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

function applyEdge(
  start: PipLayout,
  edge: 'top' | 'right' | 'bottom' | 'left',
  ndx: number,
  ndy: number,
): PipLayout {
  let x = start.inset.x;
  let y = start.inset.y;
  let w = start.inset.w;
  let h = start.inset.h;
  switch (edge) {
    case 'left':
      x = start.inset.x + ndx;
      w = start.inset.w - ndx;
      break;
    case 'right':
      w = start.inset.w + ndx;
      break;
    case 'top':
      y = start.inset.y + ndy;
      h = start.inset.h - ndy;
      break;
    case 'bottom':
      h = start.inset.h + ndy;
      break;
  }
  return { ...start, inset: { x, y, w, h } };
}

/** Shift-locked edge drag: the orthogonal dimension follows the start-of-drag
 *  aspect ratio. The dragged edge's anchor (opposite edge) is preserved;
 *  the orthogonal axis grows symmetrically around the inset's centerline. */
function applyEdgeWithShift(
  start: PipLayout,
  edge: 'top' | 'right' | 'bottom' | 'left',
  ndx: number,
  ndy: number,
): PipLayout {
  const startRatio = start.inset.w / Math.max(start.inset.h, 1e-9);
  let x = start.inset.x;
  let y = start.inset.y;
  let w = start.inset.w;
  let h = start.inset.h;
  if (edge === 'left' || edge === 'right') {
    if (edge === 'left') {
      x = start.inset.x + ndx;
      w = start.inset.w - ndx;
    } else {
      w = start.inset.w + ndx;
    }
    const newH = w / startRatio;
    const centerY = start.inset.y + start.inset.h / 2;
    h = newH;
    y = centerY - newH / 2;
  } else {
    if (edge === 'top') {
      y = start.inset.y + ndy;
      h = start.inset.h - ndy;
    } else {
      h = start.inset.h + ndy;
    }
    const newW = h * startRatio;
    const centerX = start.inset.x + start.inset.w / 2;
    w = newW;
    x = centerX - newW / 2;
  }
  return { ...start, inset: { x, y, w, h } };
}

// ---------------------------------------------------------------------------
// Snap stage — apply aspect, per-axis, and equal-margin snaps to the
// projected layout. Each snap respects the handle's anchor convention so
// the user's gesture intent is preserved.
// ---------------------------------------------------------------------------

interface SnapStageResult {
  layout: PipLayout;
  snap: PipActiveSnap;
}

/** Re-anchor `(x, y)` after `(w, h)` changed (aspect snap, e.g.) so the
 *  user's anchor convention for the handle is preserved. */
function reanchor(
  next: PipLayout,
  start: PipLayout,
  handle: PipDragHandle,
  shiftKey: boolean,
): PipLayout {
  if (handle.kind === 'move') return next;
  let { x, y } = next.inset;
  const { w, h } = next.inset;
  if (handle.kind === 'resize-corner') {
    const touchLeft = handle.corner === 'tl' || handle.corner === 'bl';
    const touchTop = handle.corner === 'tl' || handle.corner === 'tr';
    x = touchLeft ? start.inset.x + start.inset.w - w : start.inset.x;
    y = touchTop ? start.inset.y + start.inset.h - h : start.inset.y;
  } else if (shiftKey) {
    // Shift-locked edge drag: dragged edge anchored at its opposite; orthogonal
    // axis symmetric around the inset's start centerline.
    if (handle.edge === 'left' || handle.edge === 'right') {
      x = handle.edge === 'left' ? start.inset.x + start.inset.w - w : start.inset.x;
      y = start.inset.y + start.inset.h / 2 - h / 2;
    } else {
      y = handle.edge === 'top' ? start.inset.y + start.inset.h - h : start.inset.y;
      x = start.inset.x + start.inset.w / 2 - w / 2;
    }
  } else {
    // Unshifted edge drag: dragged edge anchored at opposite; orthogonal axis
    // unchanged from the start (already the case from applyEdge).
    if (handle.edge === 'left') x = start.inset.x + start.inset.w - w;
    else if (handle.edge === 'right') x = start.inset.x;
    else if (handle.edge === 'top') y = start.inset.y + start.inset.h - h;
    else if (handle.edge === 'bottom') y = start.inset.y;
  }
  return { ...next, inset: { x, y, w, h } };
}

function applyAspectSnap(
  projected: PipLayout,
  aspect: AspectRatio,
  start: PipLayout,
  handle: PipDragHandle,
  shiftKey: boolean,
): { layout: PipLayout; aspect: PipAspectTarget | null } {
  const match = matchActiveAspect(aspect, projected.inset.w, projected.inset.h);
  if (!match) return { layout: projected, aspect: null };
  const { w, h } = projectToAspect(projected.inset.w, projected.inset.h, match.slope);
  const next: PipLayout = {
    ...projected,
    inset: { ...projected.inset, w, h },
  };
  return { layout: reanchor(next, start, handle, shiftKey), aspect: match };
}

/** Resolve the active stop for one axis with hysteresis: a previously-engaged
 *  target is held through a release window of `HYSTERESIS_RELEASE_RATIO`×
 *  its capture distance. Falls back to a fresh `matchActiveAxis` call. */
function resolveAxisWithHysteresis(
  value: number,
  extent: number,
  prev: PipAxisTarget | null,
): PipAxisTarget | null {
  if (prev) {
    // Re-derive the previously-engaged target against the current extent
    // (extent can change mid-drag on corner / edge handles).
    const refreshed = pipAxisTargets(extent).find(
      (t) => t.label === prev.label && t.side === prev.side,
    );
    if (refreshed) {
      const release = axisCaptureThreshold(refreshed.label) * HYSTERESIS_RELEASE_RATIO;
      if (Math.abs(value - refreshed.value) < release) return refreshed;
    }
  }
  return matchActiveAxis(value, extent);
}

/** Apply per-axis position snap. For move drag both x and y are free. For
 *  corner / edge drag only axes that the handle actually moves are eligible.
 *  Re-derives dependent dimensions (`w` when x snaps on touchLeft, `h` on
 *  touchTop) so the un-dragged anchor stays put. */
function applyAxisSnaps(
  projected: PipLayout,
  handle: PipDragHandle,
  prevX: PipAxisTarget | null,
  prevY: PipAxisTarget | null,
): { layout: PipLayout; axisX: PipAxisTarget | null; axisY: PipAxisTarget | null } {
  const touchLeft =
    handle.kind === 'resize-corner'
      ? handle.corner === 'tl' || handle.corner === 'bl'
      : handle.kind === 'resize-edge' && handle.edge === 'left';
  const touchTop =
    handle.kind === 'resize-corner'
      ? handle.corner === 'tl' || handle.corner === 'tr'
      : handle.kind === 'resize-edge' && handle.edge === 'top';

  const xMoves = handle.kind === 'move' || touchLeft;
  const yMoves = handle.kind === 'move' || touchTop;

  let { x, y, w, h } = projected.inset;
  let axisX: PipAxisTarget | null = null;
  let axisY: PipAxisTarget | null = null;

  if (xMoves) {
    axisX = resolveAxisWithHysteresis(x, w, prevX);
    if (axisX) {
      const dx = axisX.value - x;
      x = axisX.value;
      // If touchLeft, the right edge (x + w) must stay anchored at start.
      if (touchLeft) w = w - dx;
    }
  }
  if (yMoves) {
    axisY = resolveAxisWithHysteresis(y, h, prevY);
    if (axisY) {
      const dy = axisY.value - y;
      y = axisY.value;
      if (touchTop) h = h - dy;
    }
  }
  return { layout: { ...projected, inset: { x, y, w, h } }, axisX, axisY };
}

/** Equal-margin coupled pull. Engages only when the handle moves both axes
 *  (move drag, corner drag) AND no per-axis snap is already holding one of
 *  the involved axes. Returns the active pair (if any) so the overlay can
 *  flag it; the recognition state via {@link matchEqualMargins} runs
 *  separately on the final layout. */
function applyEqualMarginSnap(
  layout: PipLayout,
  handle: PipDragHandle,
  axisX: PipAxisTarget | null,
  axisY: PipAxisTarget | null,
  aspect: AspectRatio,
): { layout: PipLayout; pair: PipMarginPair | null } {
  const eligible =
    handle.kind === 'move' ||
    (handle.kind === 'resize-corner');
  if (!eligible) return { layout, pair: null };
  if (axisX !== null || axisY !== null) return { layout, pair: null };

  const pair = findActiveMarginPair(layout, aspect);
  if (!pair) return { layout, pair: null };

  const { x: newX, y: newY } = projectToEqualMargin(
    pair,
    layout.inset.x,
    layout.inset.y,
    layout.inset.w,
    layout.inset.h,
    aspect,
  );
  return {
    layout: { ...layout, inset: { ...layout.inset, x: newX, y: newY } },
    pair,
  };
}

function snapStage(
  projected: PipLayout,
  start: PipLayout,
  handle: PipDragHandle,
  shiftKey: boolean,
  suppressSnap: boolean,
  snapEnabled: boolean,
  aspect: AspectRatio,
  prevAxisX: PipAxisTarget | null,
  prevAxisY: PipAxisTarget | null,
): SnapStageResult {
  if (!snapEnabled) {
    return { layout: projected, snap: NO_ACTIVE_SNAP };
  }
  // Ctrl/⌘ held: Figma-style "snap off while held". Bypasses everything,
  // including the shift-key behaviors below.
  if (suppressSnap) {
    return { layout: projected, snap: NO_ACTIVE_SNAP };
  }
  // Shift on move/corner disables snap entirely (Figma-style "drag without
  // snap"). Shift on edge drag is the constrain-proportions modifier —
  // snap remains active there so aspect-fit can engage.
  if (shiftKey && handle.kind !== 'resize-edge') {
    return { layout: projected, snap: NO_ACTIVE_SNAP };
  }

  let layout = projected;
  let aspectMatch: PipAspectTarget | null = null;

  const aspectEligible =
    handle.kind === 'resize-corner' ||
    (handle.kind === 'resize-edge' && shiftKey);
  if (aspectEligible) {
    const r = applyAspectSnap(layout, aspect, start, handle, shiftKey);
    layout = r.layout;
    aspectMatch = r.aspect;
  }

  const { layout: afterAxis, axisX, axisY } = applyAxisSnaps(
    layout,
    handle,
    prevAxisX,
    prevAxisY,
  );
  layout = afterAxis;

  const { layout: afterMargin } = applyEqualMarginSnap(layout, handle, axisX, axisY, aspect);
  layout = afterMargin;

  const margins = matchEqualMargins(layout, aspect);

  return {
    layout,
    snap: { axisX, axisY, aspect: aspectMatch, margins },
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePipDrag(args: UsePipDragArgs): UsePipDragHandlers {
  const [isDragging, setIsDragging] = useState(false);
  const [activeSnap, setActiveSnap] = useState<PipActiveSnap>(NO_ACTIVE_SNAP);
  const sessionRef = useRef<DragSession | null>(null);
  // Hysteresis state: which axis stops are currently held. Cleared on drag
  // start, on pointerup, and when Ctrl/⌘ is held (so a stale engagement
  // doesn't leak past a modifier-release).
  const lastEngagedAxisX = useRef<PipAxisTarget | null>(null);
  const lastEngagedAxisY = useRef<PipAxisTarget | null>(null);

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
    lastEngagedAxisX.current = null;
    lastEngagedAxisY.current = null;
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
      const dx = e.clientX - session.startClientX;
      const dy = e.clientY - session.startClientY;
      const ndx = dx / drawn.width;
      const ndy = dy / drawn.height;

      let projected: PipLayout;
      switch (session.handle.kind) {
        case 'move':
          projected = applyMove(session.startLayout, ndx, ndy);
          break;
        case 'resize-corner':
          projected = applyCorner(session.startLayout, session.handle.corner, ndx, ndy);
          break;
        case 'resize-edge':
          projected = e.shiftKey
            ? applyEdgeWithShift(session.startLayout, session.handle.edge, ndx, ndy)
            : applyEdge(session.startLayout, session.handle.edge, ndx, ndy);
          break;
      }

      const suppressSnap = e.metaKey || e.ctrlKey;
      if (suppressSnap) {
        lastEngagedAxisX.current = null;
        lastEngagedAxisY.current = null;
      }

      const { layout: snapped, snap } = snapStage(
        projected,
        session.startLayout,
        session.handle,
        e.shiftKey,
        suppressSnap,
        cur.snapEnabled,
        cur.aspect,
        lastEngagedAxisX.current,
        lastEngagedAxisY.current,
      );
      lastEngagedAxisX.current = snap.axisX;
      lastEngagedAxisY.current = snap.axisY;
      setActiveSnap(snap);

      const clamped = clampLayout(snapped, cur.aspect);
      if (clamped.mode === 'pip') {
        cur.onChange(clamped);
      }
    }
    function handleUp() {
      sessionRef.current = null;
      lastEngagedAxisX.current = null;
      lastEngagedAxisY.current = null;
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

export { SNAP_THRESHOLD };
