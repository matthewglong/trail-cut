import type { CSSProperties } from 'react';
import { semantic } from '../../theme/tokens';
import type { LayoutConfig } from '../../lib/layout';

export interface TileMetastripProps {
  layout: LayoutConfig;
}

export function TileMetastrip({ layout }: TileMetastripProps) {
  return (
    <div style={stripStyle} data-testid="map-positioning-tile-metastrip">
      <span>
        Mode <b style={emphasisStyle}>{layout.mode === 'pip' ? 'PiP' : `Split-${splitAxisLetter(layout.video_side)}`}</b>
      </span>
      <span style={sepStyle} aria-hidden="true" />
      <span>
        {layout.mode === 'pip'
          ? <>Inset <b style={emphasisStyle}>{insetCorner(layout.inset)} · {Math.round(layout.inset.w * 100)}%</b></>
          : <>Order <b style={emphasisStyle}>{orderText(layout.video_side)}</b></>}
      </span>
    </div>
  );
}

function splitAxisLetter(side: 'left' | 'right' | 'top' | 'bottom'): 'V' | 'H' {
  return side === 'left' || side === 'right' ? 'V' : 'H';
}

function insetCorner(inset: { x: number; y: number; w: number; h: number }): string {
  const cx = inset.x + inset.w / 2;
  const cy = inset.y + inset.h / 2;
  const vertical = cy < 0.5 ? 'T' : 'B';
  const horizontal = cx < 0.5 ? 'L' : 'R';
  return `${vertical}${horizontal}`;
}

function orderText(side: 'left' | 'right' | 'top' | 'bottom'): string {
  switch (side) {
    case 'left':   return 'Video ◀ Map';
    case 'right':  return 'Map ▶ Video';
    case 'top':    return 'Video ▲ Map';
    case 'bottom': return 'Map ▼ Video';
  }
}

const stripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto auto 1fr',
  gap: 12,
  alignItems: 'center',
  padding: '12px 0 0',
  marginTop: 'auto',
  borderTop: `1px solid ${semantic.border}`,
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: semantic.fgDim,
};

const sepStyle: CSSProperties = {
  width: 1,
  height: 10,
  background: semantic.border,
};

const emphasisStyle: CSSProperties = {
  color: semantic.fg,
  fontWeight: 600,
};

export default TileMetastrip;
