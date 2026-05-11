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
import { semantic } from '../../theme/tokens';

export interface LayoutPreviewProps {
  layout: LayoutConfig;
  aspect: AspectRatio;
  /** Container size in CSS pixels. The overlay scales the output frame to
   *  fit this box, preserving aspect — letterbox / pillarbox emerges when
   *  the container's aspect doesn't match the layout's. */
  containerWidth: number;
  containerHeight: number;
  /** Visual mode. `'preview'` (default) shows the labeled, dashed-stroke
   *  read-only overlay used by 080. `'configurator'` suppresses labels and
   *  the dashed background-slot stroke so the configurator (110) can layer
   *  its own interactive handles without visual fight. `'triptych'` fills
   *  each slot with a distinctive composited treatment (topo hatch for
   *  map, warm gradient for video) so the read-only Map Positioning tiles
   *  read as previews rather than wireframes. */
  mode?: 'preview' | 'configurator' | 'triptych';
}

const STROKE_COLOR = '#52d6ff';
const STROKE_OPACITY = 0.9;
const LABEL_BG = 'rgba(7, 27, 38, 0.55)';
const TRIPTYCH_STROKE = semantic.borderStrong;
const TRIPTYCH_LABEL_COLOR = semantic.fgDim;

export function LayoutPreview({
  layout,
  aspect,
  containerWidth,
  containerHeight,
  mode = 'preview',
}: LayoutPreviewProps) {
  const resolved = resolveSlots(layout, aspect);
  const { output, map_slot, video_slot, corner_radius_px, corner_radius_slot } = resolved;
  const isConfigurator = mode === 'configurator';
  const isTriptych = mode === 'triptych';

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

        {isTriptych && <TriptychDefs aspect={aspect} />}

        {isTriptych ? (
          isPip ? (
            // Background slot underneath, inset slot on top with corner
            // radius. `corner_radius_slot` names which slot IS the inset.
            <>
              <SlotFill
                rect={corner_radius_slot === 'map' ? video_slot : map_slot}
                fill={corner_radius_slot === 'map'
                  ? `url(#triptych-video-${aspect})`
                  : `url(#triptych-map-${aspect})`}
                rx={0}
                testId="layout-preview-bg-fill"
              />
              <SlotFill
                rect={corner_radius_slot === 'map' ? map_slot : video_slot}
                fill={corner_radius_slot === 'map'
                  ? `url(#triptych-map-${aspect})`
                  : `url(#triptych-video-${aspect})`}
                rx={corner_radius_px}
                testId="layout-preview-inset-fill"
              />
            </>
          ) : (
            <>
              <SlotFill
                rect={map_slot}
                fill={`url(#triptych-map-${aspect})`}
                rx={0}
                testId="layout-preview-map-fill"
              />
              <SlotFill
                rect={video_slot}
                fill={`url(#triptych-video-${aspect})`}
                rx={0}
                testId="layout-preview-video-fill"
              />
            </>
          )
        ) : (
          <>
            <SlotRect
              rect={map_slot}
              rx={insetIsMap ? corner_radius_px : 0}
              dashed={!isConfigurator && isPip && !insetIsMap}
              strokeWidth={strokeViewBoxUnits}
              testId="layout-preview-map-slot"
            />
            <SlotRect
              rect={video_slot}
              rx={insetIsVideo ? corner_radius_px : 0}
              dashed={!isConfigurator && isPip && !insetIsVideo}
              strokeWidth={strokeViewBoxUnits}
              testId="layout-preview-video-slot"
            />
          </>
        )}

        {!isConfigurator && !isTriptych && (
          <>
            <SlotLabel
              rect={map_slot}
              text="Map"
              fontSize={labelFontPx}
              padding={labelPaddingPx}
              color={STROKE_COLOR}
              bg={LABEL_BG}
              testId="layout-preview-map-label"
            />
            <SlotLabel
              rect={video_slot}
              text="Video"
              fontSize={labelFontPx}
              padding={labelPaddingPx}
              color={STROKE_COLOR}
              bg={LABEL_BG}
              testId="layout-preview-video-label"
            />
          </>
        )}

        {isTriptych && (
          <>
            <SlotLabel
              rect={map_slot}
              text="MAP"
              fontSize={Math.max(28, Math.min(map_slot.w, map_slot.h) * 0.07)}
              padding={12}
              color={TRIPTYCH_LABEL_COLOR}
              bg="transparent"
              tracking={true}
              testId="layout-preview-map-label"
            />
            <SlotLabel
              rect={video_slot}
              text="VIDEO"
              fontSize={Math.max(28, Math.min(video_slot.w, video_slot.h) * 0.07)}
              padding={12}
              color={TRIPTYCH_LABEL_COLOR}
              bg="transparent"
              tracking={true}
              testId="layout-preview-video-label"
            />
          </>
        )}

        {/* Slot outlines on top so the divider/inset reads clearly */}
        {isTriptych && (
          <>
            <rect
              x={map_slot.x}
              y={map_slot.y}
              width={map_slot.w}
              height={map_slot.h}
              rx={insetIsMap ? corner_radius_px : 0}
              ry={insetIsMap ? corner_radius_px : 0}
              fill="none"
              stroke={TRIPTYCH_STROKE}
              strokeWidth={strokeViewBoxUnits}
              pointerEvents="none"
            />
            <rect
              x={video_slot.x}
              y={video_slot.y}
              width={video_slot.w}
              height={video_slot.h}
              rx={insetIsVideo ? corner_radius_px : 0}
              ry={insetIsVideo ? corner_radius_px : 0}
              fill="none"
              stroke={TRIPTYCH_STROKE}
              strokeWidth={strokeViewBoxUnits}
              pointerEvents="none"
            />
          </>
        )}
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
  color: string;
  bg: string;
  tracking?: boolean;
  testId: string;
}

function SlotLabel({ rect, text, fontSize, padding, color, bg, tracking, testId }: SlotLabelProps) {
  const trackingPx = tracking ? fontSize * 0.22 : 0;
  const approxTextWidth = text.length * fontSize * 0.6 + Math.max(0, text.length - 1) * trackingPx;
  const bgWidth = approxTextWidth + padding * 2;
  const bgHeight = fontSize + padding;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  return (
    <g data-testid={testId}>
      {bg !== 'transparent' && (
        <rect
          x={cx - bgWidth / 2}
          y={cy - bgHeight / 2}
          width={bgWidth}
          height={bgHeight}
          rx={padding / 2}
          ry={padding / 2}
          fill={bg}
        />
      )}
      <text
        x={cx}
        y={cy}
        fontSize={fontSize}
        fontFamily={tracking ? "'JetBrains Mono', 'SF Mono', ui-monospace, monospace" : "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"}
        fontWeight={tracking ? 700 : 600}
        letterSpacing={tracking ? trackingPx : undefined}
        fill={color}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {text}
      </text>
    </g>
  );
}

interface SlotFillProps {
  rect: { x: number; y: number; w: number; h: number };
  fill: string;
  rx: number;
  testId: string;
}

function SlotFill({ rect, fill, rx, testId }: SlotFillProps) {
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      rx={rx > 0 ? rx : undefined}
      ry={rx > 0 ? rx : undefined}
      fill={fill}
      data-testid={testId}
    />
  );
}

// Distinctive composited fills for triptych tiles. Map slot reads as topo
// hatch in azure; video slot reads as a warm coral wash. Both stay subtle
// enough that the slot geometry (the actual point of these tiles) still
// dominates visually. Patterns are namespaced by aspect because each tile
// renders its own <svg> root and SVG <pattern> ids must be unique inside
// the document.
function TriptychDefs({ aspect }: { aspect: AspectRatio }) {
  const mapId = `triptych-map-${aspect}`;
  const videoId = `triptych-video-${aspect}`;
  const hatchId = `triptych-hatch-${aspect}`;
  return (
    <defs>
      <pattern id={hatchId} patternUnits="userSpaceOnUse" width={80} height={80} patternTransform="rotate(-12)">
        <rect width={80} height={80} fill={semantic.coldTint} />
        <path d="M0 60 Q40 30 80 50" stroke={semantic.coldStroke} strokeWidth={1.8} fill="none" />
        <path d="M0 30 Q40 0 80 24" stroke={semantic.coldStrokeMid} strokeWidth={1.6} fill="none" />
        <path d="M0 90 Q40 56 80 80" stroke={semantic.coldStrokeFaint} strokeWidth={1.4} fill="none" />
      </pattern>
      <pattern id={mapId} patternUnits="userSpaceOnUse" width={80} height={80}>
        <rect width={80} height={80} fill={`url(#${hatchId})`} />
      </pattern>
      <linearGradient id={videoId} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={semantic.warmTintStrong} />
        <stop offset="0.6" stopColor={semantic.pollenTint} />
        <stop offset="1" stopColor={semantic.surfaceTint} />
      </linearGradient>
    </defs>
  );
}

export default LayoutPreview;
