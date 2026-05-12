import { useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  resolveSlots,
  clampLayout,
  legalSplitSides,
  synthesizeLayoutForMode,
  drawnAreaSize,
  type AspectRatio,
  type LayoutConfig,
  type PipLayout,
  type SplitLayout,
  type PixelRect,
  type SlotResolution,
} from '../../lib/layout';
import { LayoutPreview } from '../LayoutPreview/LayoutPreview';
import { usePipDrag, type PipDragHandle } from './usePipDrag';
import { useSplitDrag } from './useSplitDrag';
import { ModeToggle } from './ModeToggle';
import { SwapToggle } from './SwapToggle';
import { CornerRadiusSlider } from './CornerRadiusSlider';

export interface LayoutConfiguratorProps {
  layout: LayoutConfig;
  aspect: AspectRatio;
  containerWidth: number;
  containerHeight: number;
  onChange: (next: LayoutConfig) => void;
  disabled?: boolean;
  snapEnabledByDefault?: boolean;
  style?: CSSProperties;
  onDone?: () => void;
  /** When true, suppress the bottom chrome row (ModeToggle/Swap/etc.) so
   *  the caller's own control surface (the triptych modal's unified rail)
   *  isn't duplicated. The interactive SVG overlay still mounts. */
  chromeless?: boolean;
  /** Visual mode for the underlying LayoutPreview backdrop. `'configurator'`
   *  (default) is the bare wireframe paired with the interactive overlay.
   *  `'triptych'` paints the distinct map/video fills used in the Map
   *  Positioning tiles. Labels are suppressed in either case. */
  previewMode?: 'configurator' | 'triptych';
}

const HANDLE_RADIUS_PX = 7;
const HANDLE_HIT_RADIUS_PX = 11;
const HANDLE_FILL = '#52d6ff';
const HANDLE_STROKE = '#0b1a23';
const DIVIDER_HANDLE_LENGTH = 56;
const DIVIDER_HANDLE_THICKNESS = 14;
const SWAP_BADGE_RADIUS_PX = 10;
const SNAP_GUIDE_STROKE = 'rgba(120, 180, 255, 0.7)';
const SNAP_EASE_TRANSITION = 'x 120ms ease-out, y 120ms ease-out, width 120ms ease-out, height 120ms ease-out, cx 120ms ease-out, cy 120ms ease-out';

export function LayoutConfigurator({
  layout,
  aspect,
  containerWidth,
  containerHeight,
  onChange,
  disabled = false,
  snapEnabledByDefault = true,
  style,
  onDone,
  chromeless = false,
  previewMode = 'configurator',
}: LayoutConfiguratorProps) {
  // Derived directly from prop — the parent owns snap mode. Past iterations
  // froze this in useState, which silently ignored prop changes mid-session.
  const snapEnabled = snapEnabledByDefault;
  const resolved: SlotResolution = useMemo(() => resolveSlots(layout, aspect), [layout, aspect]);
  const drawn = drawnAreaSize(aspect, containerWidth, containerHeight);
  const scaleFactor = drawn.width > 0 ? drawn.width / resolved.output.w : 1;

  const handleModeChange = (next: 'pip' | 'split') => {
    if (disabled || next === layout.mode) return;
    const synthesized = synthesizeLayoutForMode(next, aspect);
    onChange(clampLayout(synthesized, aspect));
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        ...style,
      }}
      data-testid="layout-configurator"
    >
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        <LayoutPreview
          layout={layout}
          aspect={aspect}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          mode={previewMode}
          showLabels={false}
        />
        {drawn.width > 0 && drawn.height > 0 && (
          <ConfiguratorOverlay
            layout={layout}
            aspect={aspect}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
            drawnWidth={drawn.width}
            drawnHeight={drawn.height}
            scaleFactor={scaleFactor}
            resolved={resolved}
            disabled={disabled}
            snapEnabled={snapEnabled}
            onChange={onChange}
          />
        )}
      </div>
      {!chromeless && (
        <div style={chromeRowStyle} data-testid="layout-configurator-chrome">
          <ModeToggle
            mode={layout.mode}
            onModeChange={handleModeChange}
            disabled={disabled}
          />
          {layout.mode === 'pip' ? (
            <PipChrome layout={layout} aspect={aspect} disabled={disabled} onChange={onChange} />
          ) : (
            <SplitChrome layout={layout} aspect={aspect} disabled={disabled} onChange={onChange} />
          )}
          <div style={{ flex: '1 1 auto' }} />
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              style={doneButtonStyle}
              data-testid="layout-configurator-done"
            >
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface PipChromeProps {
  layout: PipLayout;
  aspect: AspectRatio;
  disabled: boolean;
  onChange: (next: LayoutConfig) => void;
}

function PipChrome({ layout, aspect, disabled, onChange }: PipChromeProps) {
  const handleSwap = () => {
    if (disabled) return;
    const next: PipLayout = {
      ...layout,
      inset_source: layout.inset_source === 'video' ? 'map' : 'video',
    };
    const clamped = clampLayout(next, aspect);
    onChange(clamped);
  };
  const handleCornerRadius = (newValue: number) => {
    if (disabled) return;
    const next: PipLayout = { ...layout, corner_radius: newValue };
    onChange(clampLayout(next, aspect));
  };
  const swapLabel = `Swap (inset: ${layout.inset_source})`;
  return (
    <>
      <SwapToggle label={swapLabel} onSwap={handleSwap} disabled={disabled} />
      <CornerRadiusSlider
        value={layout.corner_radius}
        onChange={handleCornerRadius}
        disabled={disabled}
      />
    </>
  );
}

interface SplitChromeProps {
  layout: SplitLayout;
  aspect: AspectRatio;
  disabled: boolean;
  onChange: (next: LayoutConfig) => void;
}

function SplitChrome({ layout, aspect, disabled, onChange }: SplitChromeProps) {
  const handleSwap = () => {
    if (disabled) return;
    const sides = legalSplitSides(aspect);
    const i = sides.indexOf(layout.video_side);
    const nextSide = sides[(i + 1) % sides.length];
    const next: SplitLayout = { ...layout, video_side: nextSide };
    const clamped = clampLayout(next, aspect);
    onChange(clamped);
  };
  const swapLabel = `Swap (video: ${layout.video_side})`;
  return <SwapToggle label={swapLabel} onSwap={handleSwap} disabled={disabled} />;
}

interface ConfiguratorOverlayProps {
  layout: LayoutConfig;
  aspect: AspectRatio;
  containerWidth: number;
  containerHeight: number;
  drawnWidth: number;
  drawnHeight: number;
  scaleFactor: number;
  resolved: SlotResolution;
  disabled: boolean;
  snapEnabled: boolean;
  onChange: (next: LayoutConfig) => void;
}

function ConfiguratorOverlay(props: ConfiguratorOverlayProps) {
  return (
    <div style={overlayContainerStyle} data-testid="layout-configurator-overlay">
      {props.layout.mode === 'pip' ? (
        <PipOverlay {...props} layout={props.layout} />
      ) : (
        <SplitOverlay {...props} layout={props.layout} />
      )}
    </div>
  );
}

interface PipOverlayProps extends ConfiguratorOverlayProps {
  layout: PipLayout;
}

function PipOverlay({
  layout,
  aspect,
  containerWidth,
  containerHeight,
  drawnWidth,
  drawnHeight,
  scaleFactor,
  resolved,
  disabled,
  snapEnabled,
  onChange,
}: PipOverlayProps) {
  const drag = usePipDrag({
    layout,
    aspect,
    containerWidth,
    containerHeight,
    snapEnabled,
    onChange: (next) => onChange(next),
    disabled,
  });

  const insetSlot: PixelRect =
    layout.inset_source === 'video' ? resolved.video_slot : resolved.map_slot;

  const handleHitR = HANDLE_HIT_RADIUS_PX / Math.max(scaleFactor, 1e-6);
  const handleR = HANDLE_RADIUS_PX / Math.max(scaleFactor, 1e-6);

  function startHandle(handle: PipDragHandle, e: ReactPointerEvent) {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    drag.beginDrag(handle, e);
  }

  const corners: { kind: 'tl' | 'tr' | 'bl' | 'br'; cx: number; cy: number; cursor: string }[] = [
    { kind: 'tl', cx: insetSlot.x, cy: insetSlot.y, cursor: 'nwse-resize' },
    { kind: 'tr', cx: insetSlot.x + insetSlot.w, cy: insetSlot.y, cursor: 'nesw-resize' },
    { kind: 'bl', cx: insetSlot.x, cy: insetSlot.y + insetSlot.h, cursor: 'nesw-resize' },
    { kind: 'br', cx: insetSlot.x + insetSlot.w, cy: insetSlot.y + insetSlot.h, cursor: 'nwse-resize' },
  ];

  const edges: {
    kind: 'top' | 'right' | 'bottom' | 'left';
    x: number;
    y: number;
    w: number;
    h: number;
    cursor: string;
  }[] = [
    { kind: 'top', x: insetSlot.x, y: insetSlot.y, w: insetSlot.w, h: 0, cursor: 'ns-resize' },
    { kind: 'right', x: insetSlot.x + insetSlot.w, y: insetSlot.y, w: 0, h: insetSlot.h, cursor: 'ew-resize' },
    { kind: 'bottom', x: insetSlot.x, y: insetSlot.y + insetSlot.h, w: insetSlot.w, h: 0, cursor: 'ns-resize' },
    { kind: 'left', x: insetSlot.x, y: insetSlot.y, w: 0, h: insetSlot.h, cursor: 'ew-resize' },
  ];

  const edgeHitThicknessSvg = (HANDLE_HIT_RADIUS_PX * 1.5) / Math.max(scaleFactor, 1e-6);

  const guideStroke = Math.max(1 / scaleFactor, 0.5);
  const verticalGuideX =
    drag.activeSnap.x !== null
      ? drag.activeSnap.x * resolved.output.w
      : drag.activeSnap.w !== null
      ? (layout.inset.x + drag.activeSnap.w) * resolved.output.w
      : null;
  const horizontalGuideY =
    drag.activeSnap.y !== null
      ? drag.activeSnap.y * resolved.output.h
      : drag.activeSnap.h !== null
      ? (layout.inset.y + drag.activeSnap.h) * resolved.output.h
      : null;
  const snapEngaged =
    drag.activeSnap.x !== null ||
    drag.activeSnap.y !== null ||
    drag.activeSnap.w !== null ||
    drag.activeSnap.h !== null;
  const settleTransition: CSSProperties = snapEngaged
    ? { transition: SNAP_EASE_TRANSITION }
    : {};

  const readoutText = `${pct(layout.inset.x)} · ${pct(layout.inset.y)}  ·  ${pct(layout.inset.w)} × ${pct(layout.inset.h)}`;

  return (
    <>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${resolved.output.w} ${resolved.output.h}`}
      width={drawnWidth}
      height={drawnHeight}
      style={{ ...overlaySvgStyle, touchAction: 'none' }}
      data-testid="layout-configurator-svg"
    >
      {verticalGuideX !== null && (
        <line
          x1={verticalGuideX}
          y1={0}
          x2={verticalGuideX}
          y2={resolved.output.h}
          stroke={SNAP_GUIDE_STROKE}
          strokeWidth={guideStroke}
          pointerEvents="none"
          data-testid="layout-configurator-snap-guide-vertical"
        />
      )}
      {horizontalGuideY !== null && (
        <line
          x1={0}
          y1={horizontalGuideY}
          x2={resolved.output.w}
          y2={horizontalGuideY}
          stroke={SNAP_GUIDE_STROKE}
          strokeWidth={guideStroke}
          pointerEvents="none"
          data-testid="layout-configurator-snap-guide-horizontal"
        />
      )}
      <rect
        x={insetSlot.x}
        y={insetSlot.y}
        width={insetSlot.w}
        height={insetSlot.h}
        fill="rgba(82, 214, 255, 0.001)"
        style={{ cursor: disabled ? 'default' : 'move', ...settleTransition }}
        onPointerDown={(e) => startHandle({ kind: 'move' }, e)}
        data-testid="layout-configurator-pip-body"
      />
      {edges.map((edge) => (
        <rect
          key={`edge-${edge.kind}`}
          x={edge.x - (edge.w === 0 ? edgeHitThicknessSvg / 2 : 0)}
          y={edge.y - (edge.h === 0 ? edgeHitThicknessSvg / 2 : 0)}
          width={edge.w === 0 ? edgeHitThicknessSvg : edge.w}
          height={edge.h === 0 ? edgeHitThicknessSvg : edge.h}
          fill="transparent"
          style={{ cursor: disabled ? 'default' : edge.cursor, ...settleTransition }}
          onPointerDown={(e) => startHandle({ kind: 'resize-edge', edge: edge.kind }, e)}
          data-testid={`layout-configurator-pip-edge-${edge.kind}`}
        />
      ))}
      {corners.map((corner) => (
        <g key={`corner-${corner.kind}`}>
          <circle
            cx={corner.cx}
            cy={corner.cy}
            r={handleHitR}
            fill="transparent"
            style={{ cursor: disabled ? 'default' : corner.cursor, ...settleTransition }}
            onPointerDown={(e) => startHandle({ kind: 'resize-corner', corner: corner.kind }, e)}
            data-testid={`layout-configurator-pip-corner-${corner.kind}-hit`}
          />
          <circle
            cx={corner.cx}
            cy={corner.cy}
            r={handleR}
            fill={HANDLE_FILL}
            stroke={HANDLE_STROKE}
            strokeWidth={Math.max(1.5 / scaleFactor, 0.5)}
            pointerEvents="none"
            style={settleTransition}
            data-testid={`layout-configurator-pip-corner-${corner.kind}`}
          />
        </g>
      ))}
      {!disabled && !drag.isDragging && (() => {
        // Pick the inset edge to anchor the swap badge to. Horizontal sides
        // (left/right) are preferred — they read more naturally as a "swap"
        // affordance — provided the side has at least 2/3 of the badge's
        // radius of clearance outside the inset. Top/bottom is the fallback.
        const badgeRadius = SWAP_BADGE_RADIUS_PX / Math.max(scaleFactor, 1e-6);
        const threshold = badgeRadius * (2 / 3);
        const rightSpace = resolved.output.w - (insetSlot.x + insetSlot.w);
        const leftSpace = insetSlot.x;
        const topSpace = insetSlot.y;
        const bottomSpace = resolved.output.h - (insetSlot.y + insetSlot.h);

        let side: 'top' | 'right' | 'bottom' | 'left';
        if (rightSpace >= threshold || leftSpace >= threshold) {
          side = rightSpace >= leftSpace ? 'right' : 'left';
        } else {
          side = bottomSpace >= topSpace ? 'bottom' : 'top';
        }

        let badgeCx = insetSlot.x + insetSlot.w / 2;
        let badgeCy = insetSlot.y + insetSlot.h / 2;
        let badgeOrientation: 'horizontal' | 'vertical' = 'horizontal';
        switch (side) {
          case 'top':
            badgeCy = insetSlot.y;
            badgeOrientation = 'vertical';
            break;
          case 'bottom':
            badgeCy = insetSlot.y + insetSlot.h;
            badgeOrientation = 'vertical';
            break;
          case 'left':
            badgeCx = insetSlot.x;
            badgeOrientation = 'horizontal';
            break;
          case 'right':
            badgeCx = insetSlot.x + insetSlot.w;
            badgeOrientation = 'horizontal';
            break;
        }
        return (
          <SwapBadge
            cx={badgeCx}
            cy={badgeCy}
            orientation={badgeOrientation}
            scaleFactor={scaleFactor}
            onSwap={() => {
              const swapped: PipLayout = {
                ...layout,
                inset_source: layout.inset_source === 'video' ? 'map' : 'video',
              };
              onChange(clampLayout(swapped, aspect));
            }}
            ariaLabel={`Swap inset (currently ${layout.inset_source})`}
          />
        );
      })()}
    </svg>
    {drag.isDragging && <DragReadout text={readoutText} />}
    </>
  );
}

interface SplitOverlayProps extends ConfiguratorOverlayProps {
  layout: SplitLayout;
}

function SplitOverlay({
  layout,
  aspect,
  containerWidth,
  containerHeight,
  drawnWidth,
  drawnHeight,
  scaleFactor,
  resolved,
  disabled,
  snapEnabled,
  onChange,
}: SplitOverlayProps) {
  const drag = useSplitDrag({
    layout,
    aspect,
    containerWidth,
    containerHeight,
    snapEnabled,
    onChange: (next) => onChange(next),
    disabled,
  });

  const sides = legalSplitSides(aspect);
  const horizontalAxis = sides[0] === 'left' || sides[0] === 'right';
  const dividerPxX = horizontalAxis ? layout.divider * resolved.output.w : 0;
  const dividerPxY = horizontalAxis ? 0 : layout.divider * resolved.output.h;

  const handleLengthSvg = DIVIDER_HANDLE_LENGTH / Math.max(scaleFactor, 1e-6);
  const handleThicknessSvg = DIVIDER_HANDLE_THICKNESS / Math.max(scaleFactor, 1e-6);

  let handleX: number;
  let handleY: number;
  let handleW: number;
  let handleH: number;
  if (horizontalAxis) {
    handleX = dividerPxX - handleThicknessSvg / 2;
    handleY = resolved.output.h / 2 - handleLengthSvg / 2;
    handleW = handleThicknessSvg;
    handleH = handleLengthSvg;
  } else {
    handleX = resolved.output.w / 2 - handleLengthSvg / 2;
    handleY = dividerPxY - handleThicknessSvg / 2;
    handleW = handleLengthSvg;
    handleH = handleThicknessSvg;
  }

  function startHandle(e: ReactPointerEvent) {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    drag.beginDrag(e);
  }

  const snapEngaged = drag.activeSnap.divider !== null;
  const settleTransition: CSSProperties = snapEngaged
    ? { transition: SNAP_EASE_TRANSITION }
    : {};
  const guideStroke = Math.max(1 / scaleFactor, 0.5);
  const guideX = horizontalAxis && drag.activeSnap.divider !== null
    ? drag.activeSnap.divider * resolved.output.w
    : null;
  const guideY = !horizontalAxis && drag.activeSnap.divider !== null
    ? drag.activeSnap.divider * resolved.output.h
    : null;

  // Pane rects + per-pane readout content while dragging. The readout always
  // shows the pane's percentage of the frame; aspect-fit stops append the
  // pane's aspect ("32% · 9:16") and outline the named pane, proportion stops
  // append the proportion name ("33% · ⅓", "62% · φ"). `leading` = left for
  // 16:9, top for 9:16/4:5.
  const paneInfo = (() => {
    const leadingFraction = layout.divider;
    const trailingFraction = 1 - layout.divider;
    const dPxX = horizontalAxis ? layout.divider * resolved.output.w : 0;
    const dPxY = horizontalAxis ? 0 : layout.divider * resolved.output.h;
    const leadingRect = horizontalAxis
      ? { x: 0, y: 0, w: dPxX, h: resolved.output.h }
      : { x: 0, y: 0, w: resolved.output.w, h: dPxY };
    const trailingRect = horizontalAxis
      ? { x: dPxX, y: 0, w: resolved.output.w - dPxX, h: resolved.output.h }
      : { x: 0, y: dPxY, w: resolved.output.w, h: resolved.output.h - dPxY };

    const active = drag.activeSnap.label;
    let leadingExtra = '';
    let trailingExtra = '';
    let highlightedSide: 'leading' | 'trailing' | null = null;
    if (active) {
      if (active.kind === 'aspect-fit') {
        if (active.side === 'leading') leadingExtra = active.label;
        else trailingExtra = active.label;
        highlightedSide = active.side;
      } else {
        leadingExtra = active.leading;
        trailingExtra = active.trailing;
      }
    }

    return {
      leading: { rect: leadingRect, fraction: leadingFraction, extra: leadingExtra },
      trailing: { rect: trailingRect, fraction: trailingFraction, extra: trailingExtra },
      highlightedSide,
    };
  })();

  return (
    <>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${resolved.output.w} ${resolved.output.h}`}
      width={drawnWidth}
      height={drawnHeight}
      style={{ ...overlaySvgStyle, touchAction: 'none' }}
      data-testid="layout-configurator-svg"
    >
      {paneInfo.highlightedSide && (
        <AspectFitOutline
          rect={paneInfo[paneInfo.highlightedSide].rect}
          scaleFactor={scaleFactor}
        />
      )}
      {guideX !== null && (
        <line
          x1={guideX}
          y1={0}
          x2={guideX}
          y2={resolved.output.h}
          stroke={SNAP_GUIDE_STROKE}
          strokeWidth={guideStroke}
          pointerEvents="none"
          data-testid="layout-configurator-snap-guide-vertical"
        />
      )}
      {guideY !== null && (
        <line
          x1={0}
          y1={guideY}
          x2={resolved.output.w}
          y2={guideY}
          stroke={SNAP_GUIDE_STROKE}
          strokeWidth={guideStroke}
          pointerEvents="none"
          data-testid="layout-configurator-snap-guide-horizontal"
        />
      )}
      {horizontalAxis ? (
        <line
          x1={dividerPxX}
          y1={0}
          x2={dividerPxX}
          y2={resolved.output.h}
          stroke={HANDLE_FILL}
          strokeOpacity={0.6}
          strokeWidth={2 / Math.max(scaleFactor, 1e-6)}
          pointerEvents="none"
          style={settleTransition}
        />
      ) : (
        <line
          x1={0}
          y1={dividerPxY}
          x2={resolved.output.w}
          y2={dividerPxY}
          stroke={HANDLE_FILL}
          strokeOpacity={0.6}
          strokeWidth={2 / Math.max(scaleFactor, 1e-6)}
          pointerEvents="none"
          style={settleTransition}
        />
      )}
      <rect
        x={handleX}
        y={handleY}
        width={handleW}
        height={handleH}
        rx={handleThicknessSvg / 2}
        ry={handleThicknessSvg / 2}
        fill={HANDLE_FILL}
        stroke={HANDLE_STROKE}
        strokeWidth={Math.max(1.5 / scaleFactor, 0.5)}
        style={{ cursor: disabled ? 'default' : horizontalAxis ? 'ew-resize' : 'ns-resize', ...settleTransition }}
        onPointerDown={startHandle}
        data-testid="layout-configurator-split-handle"
      />
      {!disabled && !drag.isDragging && (() => {
        const offsetPx = 60;
        const offsetSvg = offsetPx / Math.max(scaleFactor, 1e-6);
        const badgeCx = horizontalAxis
          ? dividerPxX
          : resolved.output.w / 2 + offsetSvg;
        const badgeCy = horizontalAxis
          ? resolved.output.h / 2 + offsetSvg
          : dividerPxY;
        return (
          <SwapBadge
            cx={badgeCx}
            cy={badgeCy}
            orientation={horizontalAxis ? 'horizontal' : 'vertical'}
            scaleFactor={scaleFactor}
            onSwap={() => {
              const sides = legalSplitSides(aspect);
              const i = sides.indexOf(layout.video_side);
              const nextSide = sides[(i + 1) % sides.length];
              const swapped: SplitLayout = { ...layout, video_side: nextSide };
              onChange(clampLayout(swapped, aspect));
            }}
            ariaLabel={`Swap order (video on ${layout.video_side})`}
          />
        );
      })()}
      {drag.isDragging && (
        <>
          <PaneReadout
            rect={paneInfo.leading.rect}
            text={readoutText(paneInfo.leading.fraction, paneInfo.leading.extra)}
            scaleFactor={scaleFactor}
            testid="layout-configurator-split-readout-leading"
          />
          <PaneReadout
            rect={paneInfo.trailing.rect}
            text={readoutText(paneInfo.trailing.fraction, paneInfo.trailing.extra)}
            scaleFactor={scaleFactor}
            testid="layout-configurator-split-readout-trailing"
          />
        </>
      )}
    </svg>
    </>
  );
}

function readoutText(fraction: number, extra: string): string {
  return extra ? `${pct(fraction)} · ${extra}` : pct(fraction);
}

interface SwapBadgeProps {
  cx: number;
  cy: number;
  orientation: 'horizontal' | 'vertical';
  scaleFactor: number;
  onSwap: () => void;
  ariaLabel: string;
}

function SwapBadge({ cx, cy, orientation, scaleFactor, onSwap, ariaLabel }: SwapBadgeProps) {
  const inv = 1 / Math.max(scaleFactor, 1e-6);
  const r = SWAP_BADGE_RADIUS_PX * inv;
  const stroke = 1.2 * inv;
  const arrowStroke = 1.3 * inv;
  // The two arrows are drawn once in a horizontal layout (top arrow points
  // right, bottom arrow points left). The vertical variant is the same path
  // rotated 90°, so it reads as a true rotation of the horizontal glyph.
  const reach = 5 * inv;
  const sep = 2.5 * inv;
  const headInset = 2.2 * inv;
  const headSpread = 1.6 * inv;
  const rotate = orientation === 'vertical' ? 90 : 0;
  return (
    <g
      style={{ cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); onSwap(); }}
      onPointerDown={(e) => e.stopPropagation()}
      role="button"
      aria-label={ariaLabel}
      data-testid="layout-configurator-swap-badge"
    >
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="rgba(7, 27, 38, 0.92)"
        stroke={HANDLE_FILL}
        strokeWidth={stroke}
      />
      <g
        transform={`translate(${cx} ${cy}) rotate(${rotate})`}
        fill="none"
        stroke={HANDLE_FILL}
        strokeWidth={arrowStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={`M ${-reach} ${-sep} H ${reach} M ${reach - headInset} ${-sep - headSpread} L ${reach} ${-sep} L ${reach - headInset} ${-sep + headSpread}`} />
        <path d={`M ${reach} ${sep} H ${-reach} M ${-reach + headInset} ${sep - headSpread} L ${-reach} ${sep} L ${-reach + headInset} ${sep + headSpread}`} />
      </g>
    </g>
  );
}

interface AspectFitOutlineProps {
  rect: { x: number; y: number; w: number; h: number };
  scaleFactor: number;
}

// Dashed outline + tint on the pane that landed flush at a nameable source
// aspect. The pane's text label is delivered separately via the per-pane
// PaneReadout, which keeps a single labeling surface (the readout chip) and
// lets the outline focus purely on "this pane is the named one".
function AspectFitOutline({ rect, scaleFactor }: AspectFitOutlineProps) {
  const inv = 1 / Math.max(scaleFactor, 1e-6);
  const stroke = 1.6 * inv;
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      fill="rgba(82, 214, 255, 0.10)"
      stroke={HANDLE_FILL}
      strokeOpacity={0.85}
      strokeWidth={stroke}
      strokeDasharray={`${4 * inv} ${3 * inv}`}
      pointerEvents="none"
      data-testid="layout-configurator-aspect-fit-outline"
    />
  );
}

interface PaneReadoutProps {
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  scaleFactor: number;
  testid: string;
}

// Pill-shaped readout centered in a pane during drag. Shows the pane's
// percentage of the frame, optionally augmented with an aspect or proportion
// name. Renders inside the configurator SVG so it scales with the viewBox.
function PaneReadout({ rect, text, scaleFactor, testid }: PaneReadoutProps) {
  const inv = 1 / Math.max(scaleFactor, 1e-6);
  const chipHeight = 24 * inv;
  // Width estimated from char count; JetBrains Mono is roughly 7.2px per
  // glyph at 12px — adding generous padding so short readouts ("33%") and
  // long ones ("33% · ⅓") both look centered without text measurement.
  const chipWidth = Math.max(chipHeight * 2, (text.length + 1.5) * 7.2 * inv);
  const chipX = rect.x + rect.w / 2 - chipWidth / 2;
  const chipY = rect.y + rect.h / 2 - chipHeight / 2;
  const fontSize = 11.5 * inv;
  return (
    <g pointerEvents="none" data-testid={testid}>
      <rect
        x={chipX}
        y={chipY}
        width={chipWidth}
        height={chipHeight}
        rx={3 * inv}
        ry={3 * inv}
        fill="rgba(7, 27, 38, 0.92)"
        stroke={HANDLE_FILL}
        strokeWidth={1.1 * inv}
      />
      <text
        x={chipX + chipWidth / 2}
        y={chipY + chipHeight / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={HANDLE_FILL}
        fontFamily="'JetBrains Mono', 'SF Mono', ui-monospace, monospace"
        fontSize={fontSize}
        fontWeight={700}
        letterSpacing={`${0.4 * inv}px`}
      >
        {text}
      </text>
    </g>
  );
}

function DragReadout({ text }: { text: string }) {
  return (
    <div style={dragReadoutStyle} data-testid="layout-configurator-drag-readout">
      {text}
    </div>
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const overlayContainerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
};

const overlaySvgStyle: CSSProperties = {
  pointerEvents: 'auto',
  overflow: 'visible',
};

const dragReadoutStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '4px 10px',
  background: 'rgba(7, 27, 38, 0.92)',
  border: `1px solid ${HANDLE_FILL}`,
  borderRadius: 3,
  color: HANDLE_FILL,
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.08em',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

const chromeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 10px',
  backgroundColor: 'rgba(7, 27, 38, 0.78)',
  borderTop: '1px solid #3a3a3a',
};

const doneButtonStyle: CSSProperties = {
  padding: '4px 10px',
  backgroundColor: 'rgba(82, 214, 255, 0.18)',
  color: '#52d6ff',
  border: '1px solid #52d6ff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
};

export default LayoutConfigurator;
