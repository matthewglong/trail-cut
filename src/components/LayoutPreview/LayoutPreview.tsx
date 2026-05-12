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
  /** Suppress slot text labels (MAP / VIDEO). Only meaningful in 'preview'
   *  and 'triptych' modes — 'configurator' never shows labels regardless.
   *  Defaults to true. */
  showLabels?: boolean;
}

const STROKE_COLOR = '#52d6ff';
const STROKE_OPACITY = 0.9;
const LABEL_BG = 'rgba(7, 27, 38, 0.55)';
const TRIPTYCH_STROKE = semantic.borderStrong;

export function LayoutPreview({
  layout,
  aspect,
  containerWidth,
  containerHeight,
  mode = 'preview',
  showLabels = true,
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
              {corner_radius_slot === 'map' ? (
                <>
                  <VideoSlotPaint rect={video_slot} aspect={aspect} rx={0} testId="layout-preview-bg-fill" />
                  <MapSlotPaint rect={map_slot} aspect={aspect} rx={corner_radius_px} testId="layout-preview-inset-fill" />
                </>
              ) : (
                <>
                  <MapSlotPaint rect={map_slot} aspect={aspect} rx={0} testId="layout-preview-bg-fill" />
                  <VideoSlotPaint rect={video_slot} aspect={aspect} rx={corner_radius_px} testId="layout-preview-inset-fill" />
                </>
              )}
            </>
          ) : (
            <>
              <MapSlotPaint rect={map_slot} aspect={aspect} rx={0} testId="layout-preview-map-fill" />
              <VideoSlotPaint rect={video_slot} aspect={aspect} rx={0} testId="layout-preview-video-fill" />
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

        {!isConfigurator && !isTriptych && showLabels && (
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

        {isTriptych && showLabels && (
          <>
            <SlotChip
              rect={map_slot}
              text="MAP"
              testId="layout-preview-map-label"
            />
            <SlotChip
              rect={video_slot}
              text="VIDEO"
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

// Top-left chartreuse-bordered chip used to label the MAP / VIDEO slots in
// the Map Positioning triptych. Sized in slot-relative units so it stays
// legible at any slot scale without going Brobdingnagian in the full-bleed
// background slot.
interface SlotChipProps {
  rect: { x: number; y: number; w: number; h: number };
  text: string;
  testId: string;
}

function SlotChip({ rect, text, testId }: SlotChipProps) {
  const fontSize = Math.max(18, Math.min(rect.w, rect.h) * 0.045);
  const padX = fontSize * 0.7;
  const padY = fontSize * 0.45;
  const tracking = fontSize * 0.22;
  const approxTextWidth = text.length * fontSize * 0.6 + Math.max(0, text.length - 1) * tracking;
  const chipW = approxTextWidth + padX * 2;
  const chipH = fontSize + padY * 2;
  const margin = fontSize * 0.6;
  const x = rect.x + margin;
  const y = rect.y + margin;
  const stroke = Math.max(1, fontSize * 0.06);
  return (
    <g data-testid={testId} style={{ pointerEvents: 'none' }}>
      <rect
        x={x}
        y={y}
        width={chipW}
        height={chipH}
        fill="rgba(14, 20, 22, 0.78)"
        stroke="#bced09"
        strokeWidth={stroke}
      />
      <text
        x={x + chipW / 2}
        y={y + chipH / 2}
        fontSize={fontSize}
        fontFamily="'JetBrains Mono', 'SF Mono', ui-monospace, monospace"
        fontWeight={700}
        letterSpacing={tracking}
        fill="#bced09"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {text}
      </text>
    </g>
  );
}

// Illustrative scene fills for triptych tiles. Map reads as a topo map
// (faint coordinate grid + contour lines around two peaks + dashed
// chartreuse route with start/current/end waypoints). Video reads as a
// mountain landscape (sky gradient sunset + three ridge silhouettes + a
// tiny figure for scale). Lifted from the concept sketches in
// `map-positioning-concepts.html` (#topo-lines, #mtn-scene). Each scene is
// rendered into a nested <svg> so the 400×300 source viewBox slices into
// whatever slot rect we hand it. Defs are namespaced by aspect because
// each tile mounts its own <svg> root.
function TriptychDefs({ aspect }: { aspect: AspectRatio }) {
  const skyId = `triptych-video-sky-${aspect}`;
  const mapVignetteId = `triptych-map-vignette-${aspect}`;
  return (
    <defs>
      <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#1c2e44" />
        <stop offset="35%" stopColor="#3a4a5a" />
        <stop offset="55%" stopColor="#a08a5a" />
        <stop offset="75%" stopColor="#7a4a30" />
        <stop offset="100%" stopColor="#221008" />
      </linearGradient>
      {/* Map base vignette — warm-cool darkening from one quadrant. */}
      <radialGradient id={mapVignetteId} cx="0.3" cy="0.7" r="0.9">
        <stop offset="0%" stopColor="#1c2a25" />
        <stop offset="100%" stopColor="#0e1416" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

interface PaintProps {
  rect: { x: number; y: number; w: number; h: number };
  aspect: AspectRatio;
  rx: number;
  testId: string;
}

// Render a nested SVG into the slot rect, clipped to its (possibly
// rounded) bounds. The nested SVG uses a 400×300 viewBox with `slice`
// preservation so scenes fill any aspect by center-cropping.
function SceneFrame({
  rect,
  rx,
  clipId,
  children,
  testId,
}: {
  rect: PaintProps['rect'];
  rx: number;
  clipId: string;
  children: React.ReactNode;
  testId: string;
}) {
  const r = rx > 0 ? rx : 0;
  return (
    <g data-testid={testId}>
      <defs>
        <clipPath id={clipId}>
          <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={r} ry={r} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <svg
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          viewBox="0 0 400 300"
          preserveAspectRatio="xMidYMid slice"
        >
          {children}
        </svg>
      </g>
    </g>
  );
}

function MapSlotPaint({ rect, aspect, rx, testId }: PaintProps) {
  const clipId = `triptych-map-clip-${aspect}`;
  const vignetteId = `triptych-map-vignette-${aspect}`;
  return (
    <SceneFrame rect={rect} rx={rx} clipId={clipId} testId={testId}>
      {/* base canvas + vignette + faint coordinate grid */}
      <rect width="400" height="300" fill="#0e1416" />
      <rect width="400" height="300" fill={`url(#${vignetteId})`} />
      <g stroke="rgba(76, 91, 92, 0.20)" strokeWidth="0.5" fill="none">
        <line x1="133.33" y1="0" x2="133.33" y2="300" />
        <line x1="266.66" y1="0" x2="266.66" y2="300" />
        <line x1="0" y1="100" x2="400" y2="100" />
        <line x1="0" y1="200" x2="400" y2="200" />
      </g>
      {/* sweeping contour lines */}
      <g stroke="#4c5b5c" fill="none" strokeWidth="0.6" opacity="0.55">
        <path d="M-20,180 Q60,150 140,165 Q220,180 300,150 Q380,120 420,140" />
        <path d="M-20,200 Q60,170 140,185 Q220,200 300,170 Q380,140 420,160" />
        <path d="M-20,160 Q60,130 140,145 Q220,160 300,130 Q380,100 420,120" />
        <path d="M-20,140 Q60,110 140,125 Q220,140 300,110 Q380,80 420,100" />
        <path d="M-20,120 Q60,90 140,105 Q220,120 300,90 Q380,60 420,80" />
        <path d="M-20,220 Q60,195 140,210 Q220,220 300,195 Q380,170 420,190" />
        <path d="M-20,250 Q60,225 140,240 Q220,250 300,225 Q380,200 420,220" />
      </g>
      {/* tighter contours around the main peak */}
      <g stroke="#4c5b5c" fill="none" strokeWidth="0.5" opacity="0.7">
        <ellipse cx="280" cy="100" rx="55" ry="22" />
        <ellipse cx="280" cy="100" rx="38" ry="14" />
        <ellipse cx="280" cy="100" rx="22" ry="8" />
        <ellipse cx="280" cy="100" rx="10" ry="3" />
      </g>
      {/* secondary peak */}
      <g stroke="#4c5b5c" fill="none" strokeWidth="0.5" opacity="0.55">
        <ellipse cx="100" cy="60" rx="35" ry="14" />
        <ellipse cx="100" cy="60" rx="22" ry="8" />
        <ellipse cx="100" cy="60" rx="10" ry="3" />
      </g>
      {/* route — dashed beadline + faint solid trace beneath */}
      <path
        d="M40,260 C100,240 130,210 160,200 S210,170 240,160 280,140 290,120 285,98 280,100"
        stroke="#bced09"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.35"
      />
      <path
        d="M40,260 C100,240 130,210 160,200 S210,170 240,160 280,140 290,120 285,98 280,100"
        stroke="#bced09"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="0.1 4"
      />
      {/* start waypoint */}
      <circle cx="40" cy="260" r="3" fill="#ff715b" />
      <circle cx="40" cy="260" r="6" fill="none" stroke="#ff715b" opacity="0.45" />
      {/* current position */}
      <circle cx="200" cy="180" r="4" fill="#bced09" />
      <circle cx="200" cy="180" r="9" fill="none" stroke="#bced09" opacity="0.45" />
      {/* end waypoint */}
      <circle cx="280" cy="100" r="3" fill="#2f52e0" />
      <circle cx="280" cy="100" r="6" fill="none" stroke="#2f52e0" opacity="0.45" />
    </SceneFrame>
  );
}

function VideoSlotPaint({ rect, aspect, rx, testId }: PaintProps) {
  const clipId = `triptych-video-clip-${aspect}`;
  const skyId = `triptych-video-sky-${aspect}`;
  return (
    <SceneFrame rect={rect} rx={rx} clipId={clipId} testId={testId}>
      <rect width="400" height="300" fill={`url(#${skyId})`} />
      {/* haze */}
      <rect width="400" height="300" fill="#000" opacity="0.05" />
      {/* sun glare — drawn before ridges so they occlude the lower half */}
      <circle cx="320" cy="120" r="32" fill="#f9cb40" opacity="0.10" />
      <circle cx="320" cy="120" r="14" fill="#f9cb40" opacity="0.20" />
      {/* distant ridge */}
      <path
        d="M0,170 L40,150 L90,158 L140,135 L195,150 L240,128 L290,145 L340,118 L400,138 L400,300 L0,300 Z"
        fill="#293a4a"
        opacity="0.85"
      />
      {/* middle ridge */}
      <path
        d="M0,210 L60,180 L120,205 L180,170 L240,200 L290,175 L350,195 L400,175 L400,300 L0,300 Z"
        fill="#1c2838"
      />
      {/* foreground ridge */}
      <path
        d="M0,255 L70,235 L140,250 L210,232 L280,248 L350,238 L400,255 L400,300 L0,300 Z"
        fill="#0a1418"
      />
      {/* tiny figure for scale */}
      <rect x="195" y="230" width="2" height="6" fill="#0a0808" />
      <circle cx="196" cy="228" r="1.2" fill="#0a0808" />
    </SceneFrame>
  );
}

export default LayoutPreview;
