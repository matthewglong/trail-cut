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
}

const HANDLE_RADIUS_PX = 7;
const HANDLE_HIT_RADIUS_PX = 11;
const HANDLE_FILL = '#52d6ff';
const HANDLE_STROKE = '#0b1a23';
const DIVIDER_HANDLE_LENGTH = 56;
const DIVIDER_HANDLE_THICKNESS = 14;
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
          mode="configurator"
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

  return (
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
    </svg>
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

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${resolved.output.w} ${resolved.output.h}`}
      width={drawnWidth}
      height={drawnHeight}
      style={{ ...overlaySvgStyle, touchAction: 'none' }}
      data-testid="layout-configurator-svg"
    >
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
    </svg>
  );
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
