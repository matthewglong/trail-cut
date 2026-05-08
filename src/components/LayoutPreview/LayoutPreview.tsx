// Read-only SVG overlay that visualizes a `LayoutConfig` over the editor's
// VideoPreview pane (task 080). Pure / presentational: no state, no IO, no
// Tauri imports. The slot rect math comes from `resolveSlots` only — the
// component must not reimplement layout geometry.
//
// The configurator UI (task 110) replaces this read-only overlay with
// interactive handles; until then, the overlay's job is simply to make the
// stored `project.layouts[aspect]` *visible* in the editor so what the user
// sees lines up with what the export will produce.
//
// See `docs/export/LAYOUT.md` and `docs/export/tasks/080-first-concrete-layout.md`.

import { resolveSlots, type AspectRatio, type LayoutConfig } from '../../lib/layout';

export interface LayoutPreviewProps {
  layout: LayoutConfig;
  aspect: AspectRatio;
  /** Container size in CSS pixels. The overlay scales the output frame to
   *  fit this box, preserving aspect — letterbox / pillarbox emerges when
   *  the container's aspect doesn't match the layout's. */
  containerWidth: number;
  containerHeight: number;
}

const STROKE_COLOR = '#52d6ff';
const STROKE_OPACITY = 0.9;
const LABEL_BG = 'rgba(7, 27, 38, 0.55)';

export function LayoutPreview({ layout, aspect, containerWidth, containerHeight }: LayoutPreviewProps) {
  const resolved = resolveSlots(layout, aspect);
  const { output, map_slot, video_slot, corner_radius_px, corner_radius_slot } = resolved;

  // Aspect-fit: shrink the output frame into the container, preserving
  // ratio. Whichever axis hits the container limit first determines the
  // scale factor; the other axis comes out shorter, producing letterbox or
  // pillarbox via flex centering.
  const widthScale = containerWidth / output.w;
  const heightScale = containerHeight / output.h;
  const scaleFactor = Math.min(widthScale, heightScale);
  const drawnWidth = output.w * scaleFactor;
  const drawnHeight = output.h * scaleFactor;

  // 1.5px on-screen stroke regardless of scale: divide by scaleFactor so the
  // SVG-coordinate stroke compensates for the SVG's CSS-pixel scaling.
  const strokeViewBoxUnits = 1.5 / Math.max(scaleFactor, 1e-6);

  // Label positioning math (output-pixel coords, same space as the rects).
  const labelFontPx = 48;
  const labelPaddingPx = 16;

  const isPip = layout.mode === 'pip';
  // Background slot gets a dashed stroke; the inset slot gets solid + the
  // corner radius.
  const insetIsMap = isPip && corner_radius_slot === 'map';
  const insetIsVideo = isPip && corner_radius_slot === 'video';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
      data-testid="layout-preview-container"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${output.w} ${output.h}`}
        width={drawnWidth}
        height={drawnHeight}
        style={{ pointerEvents: 'none', overflow: 'visible' }}
        data-testid="layout-preview-svg"
      >
        <title>{`layout=${layout.mode} aspect=${aspect}`}</title>

        <SlotRect
          rect={map_slot}
          rx={insetIsMap ? corner_radius_px : 0}
          dashed={isPip && !insetIsMap}
          strokeWidth={strokeViewBoxUnits}
          testId="layout-preview-map-slot"
        />
        <SlotRect
          rect={video_slot}
          rx={insetIsVideo ? corner_radius_px : 0}
          dashed={isPip && !insetIsVideo}
          strokeWidth={strokeViewBoxUnits}
          testId="layout-preview-video-slot"
        />

        <SlotLabel
          rect={map_slot}
          text="Map"
          fontSize={labelFontPx}
          padding={labelPaddingPx}
          testId="layout-preview-map-label"
        />
        <SlotLabel
          rect={video_slot}
          text="Video"
          fontSize={labelFontPx}
          padding={labelPaddingPx}
          testId="layout-preview-video-label"
        />
      </svg>
    </div>
  );
}

interface SlotRectProps {
  rect: { x: number; y: number; w: number; h: number };
  rx: number;
  dashed: boolean;
  strokeWidth: number;
  testId: string;
}

function SlotRect({ rect, rx, dashed, strokeWidth, testId }: SlotRectProps) {
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      rx={rx > 0 ? rx : undefined}
      ry={rx > 0 ? rx : undefined}
      fill="none"
      stroke={STROKE_COLOR}
      strokeOpacity={STROKE_OPACITY}
      strokeWidth={strokeWidth}
      strokeDasharray={dashed ? `${strokeWidth * 6} ${strokeWidth * 4}` : undefined}
      data-testid={testId}
    />
  );
}

interface SlotLabelProps {
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  fontSize: number;
  padding: number;
  testId: string;
}

function SlotLabel({ rect, text, fontSize, padding, testId }: SlotLabelProps) {
  // Approximate label width: glyph_width ≈ 0.6 * fontSize for the
  // system-ui stack we render with. Better than a fixed constant for the
  // wide range of slot sizes the layout system supports.
  const approxTextWidth = text.length * fontSize * 0.6;
  const bgWidth = approxTextWidth + padding * 2;
  const bgHeight = fontSize + padding;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  return (
    <g data-testid={testId}>
      <rect
        x={cx - bgWidth / 2}
        y={cy - bgHeight / 2}
        width={bgWidth}
        height={bgHeight}
        rx={padding / 2}
        ry={padding / 2}
        fill={LABEL_BG}
      />
      <text
        x={cx}
        y={cy}
        fontSize={fontSize}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontWeight={600}
        fill={STROKE_COLOR}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {text}
      </text>
    </g>
  );
}

export default LayoutPreview;
