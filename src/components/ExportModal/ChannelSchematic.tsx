import {
  OUTPUT_DIMS,
  defaultLayout,
  resolveSlots,
} from '../../lib/layout';
import type { AspectRatio, ExportChannel } from '../../types';

export interface ChannelSchematicProps {
  channel: ExportChannel;
  aspect: AspectRatio;
  width?: number;
  height?: number;
}

const FRAME_STROKE = '#666';
const MAP_FILL = '#3a4a52';
const VIDEO_FILL = '#5a4a3a';
const ALPHA_FILL = 'rgba(255, 255, 255, 0.04)';
const ALPHA_STROKE = '#444';

export function ChannelSchematic({
  channel,
  aspect,
  width = 64,
  height = 64,
}: ChannelSchematicProps) {
  const layout = defaultLayout(aspect);
  const resolved = resolveSlots(layout, aspect);
  const out = OUTPUT_DIMS[aspect];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${out.w} ${out.h}`}
      preserveAspectRatio="xMidYMid meet"
      data-testid={`channel-schematic-${channel}`}
      role="img"
      aria-label={schematicLabel(channel, aspect)}
    >
      {channel === 'composite' && (
        <>
          <rect
            x={resolved.video_slot.x}
            y={resolved.video_slot.y}
            width={resolved.video_slot.w}
            height={resolved.video_slot.h}
            fill={VIDEO_FILL}
          />
          <rect
            x={resolved.map_slot.x}
            y={resolved.map_slot.y}
            width={resolved.map_slot.w}
            height={resolved.map_slot.h}
            rx={resolved.corner_radius_px}
            ry={resolved.corner_radius_px}
            fill={MAP_FILL}
          />
        </>
      )}
      {channel === 'map_only' && (
        <>
          <rect
            x={0}
            y={0}
            width={out.w}
            height={out.h}
            fill={ALPHA_FILL}
            stroke={ALPHA_STROKE}
            strokeWidth={out.w * 0.01}
            strokeDasharray={`${out.w * 0.03} ${out.w * 0.02}`}
          />
          <rect
            x={resolved.map_slot.x}
            y={resolved.map_slot.y}
            width={resolved.map_slot.w}
            height={resolved.map_slot.h}
            rx={resolved.corner_radius_px}
            ry={resolved.corner_radius_px}
            fill={MAP_FILL}
          />
        </>
      )}
      {channel === 'video_only' && (
        <>
          <rect
            x={0}
            y={0}
            width={out.w}
            height={out.h}
            fill={ALPHA_FILL}
            stroke={ALPHA_STROKE}
            strokeWidth={out.w * 0.01}
            strokeDasharray={`${out.w * 0.03} ${out.w * 0.02}`}
          />
          <rect
            x={resolved.video_slot.x}
            y={resolved.video_slot.y}
            width={resolved.video_slot.w}
            height={resolved.video_slot.h}
            fill={VIDEO_FILL}
          />
        </>
      )}
      <rect
        x={0}
        y={0}
        width={out.w}
        height={out.h}
        fill="none"
        stroke={FRAME_STROKE}
        strokeWidth={out.w * 0.008}
      />
    </svg>
  );
}

function schematicLabel(channel: ExportChannel, aspect: AspectRatio): string {
  const a = aspect.replace('_', ':');
  switch (channel) {
    case 'composite':
      return `Composite ${a}: map and video composited`;
    case 'map_only':
      return `Map only ${a}: map slot on transparent canvas`;
    case 'video_only':
      return `Video only ${a}: video slot on transparent canvas`;
  }
}
