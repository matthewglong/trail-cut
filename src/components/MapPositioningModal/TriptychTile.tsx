import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { LayoutPreview } from '../LayoutPreview/LayoutPreview';
import { LayoutConfigurator } from '../LayoutConfigurator';
import { OUTPUT_DIMS, type AspectRatio, type LayoutConfig } from '../../lib/layout';
import { semantic } from '../../theme/tokens';
import { TileMetastrip } from './TileMetastrip';

export interface TriptychTileProps {
  aspect: AspectRatio;
  label: string;
  layout: LayoutConfig;
  isActive: boolean;
  onActivate: () => void;
  onChange: (next: LayoutConfig) => void;
}

export function TriptychTile({
  aspect,
  label,
  layout,
  isActive,
  onActivate,
  onChange,
}: TriptychTileProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dims = OUTPUT_DIMS[aspect];

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  }

  return (
    <div
      role="button"
      tabIndex={isActive ? -1 : 0}
      aria-pressed={isActive}
      onClick={isActive ? undefined : onActivate}
      onKeyDown={isActive ? undefined : handleKeyDown}
      style={{
        ...tileStyle,
        background: isActive
          ? `linear-gradient(180deg, ${semantic.surfaceRaised} 0%, ${semantic.surfaceDeep} 60%)`
          : semantic.surfaceDeep,
        cursor: isActive ? 'default' : 'pointer',
        outline: 'none',
      }}
      data-testid={`map-positioning-pane-${aspect}`}
      data-active={isActive ? 'true' : 'false'}
    >
      <div style={tileHeadStyle}>
        <span style={tileNameStyle}>
          {label}
          <span style={tilePxStyle}>{dims.w} × {dims.h}</span>
        </span>
        <span style={{ ...tileFlagStyle, color: isActive ? semantic.accent : semantic.fgDim }}>
          {isActive && (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 5,
                height: 5,
                background: semantic.accent,
                boxShadow: `0 0 6px ${semantic.accentGlow}`,
                marginRight: 6,
              }}
            />
          )}
          {isActive ? 'Editing' : 'Idle'}
        </span>
      </div>

      <div style={viewportWrapStyle}>
        <div
          ref={viewportRef}
          style={{
            ...viewportStyle,
            aspectRatio: `${dims.w} / ${dims.h}`,
            ...(aspect === '16_9'
              ? { width: '100%', maxWidth: 460 }
              : { height: '100%', maxHeight: 360 }),
          }}
        >
          <Bracket position="tl" active={isActive} />
          <Bracket position="tr" active={isActive} />
          <Bracket position="bl" active={isActive} />
          <Bracket position="br" active={isActive} />
          {size.w > 0 && size.h > 0 && (
            <>
              <LayoutPreview
                layout={layout}
                aspect={aspect}
                containerWidth={size.w}
                containerHeight={size.h}
                mode="triptych"
              />
              {isActive && (
                <LayoutConfigurator
                  layout={layout}
                  aspect={aspect}
                  containerWidth={size.w}
                  containerHeight={size.h}
                  onChange={onChange}
                  chromeless
                />
              )}
            </>
          )}
        </div>
      </div>

      <TileMetastrip layout={layout} />
    </div>
  );
}

interface BracketProps {
  position: 'tl' | 'tr' | 'bl' | 'br';
  active: boolean;
}

function Bracket({ position, active }: BracketProps) {
  const color = active ? semantic.accent : semantic.fgFaint;
  const length = 14;
  const thickness = 1.5;
  // Brackets sit flush to the corner (offset: 0). The viewport clips
  // overflow so the configurator's drag handles can't bleed into adjacent
  // tiles, which forces the brackets to live inside the frame too.
  const offset = 0;
  const base: CSSProperties = {
    position: 'absolute',
    width: length,
    height: length,
    pointerEvents: 'none',
  };
  let style: CSSProperties = base;
  switch (position) {
    case 'tl':
      style = {
        ...base,
        top: offset,
        left: offset,
        borderTop: `${thickness}px solid ${color}`,
        borderLeft: `${thickness}px solid ${color}`,
      };
      break;
    case 'tr':
      style = {
        ...base,
        top: offset,
        right: offset,
        borderTop: `${thickness}px solid ${color}`,
        borderRight: `${thickness}px solid ${color}`,
      };
      break;
    case 'bl':
      style = {
        ...base,
        bottom: offset,
        left: offset,
        borderBottom: `${thickness}px solid ${color}`,
        borderLeft: `${thickness}px solid ${color}`,
      };
      break;
    case 'br':
      style = {
        ...base,
        bottom: offset,
        right: offset,
        borderBottom: `${thickness}px solid ${color}`,
        borderRight: `${thickness}px solid ${color}`,
      };
      break;
  }
  return <span style={style} data-testid={`tile-bracket-${position}`} />;
}

const tileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  minHeight: 460,
  padding: '20px 16px 16px',
};

const tileHeadStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  marginBottom: 16,
};

const tileNameStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: '0.04em',
  color: semantic.fg,
};

const tilePxStyle: CSSProperties = {
  fontWeight: 400,
  fontSize: 10.5,
  letterSpacing: '0.18em',
  color: semantic.fgDim,
  marginLeft: 8,
  textTransform: 'uppercase',
};

const tileFlagStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 9.5,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
};

const viewportWrapStyle: CSSProperties = {
  flex: '1 1 auto',
  display: 'grid',
  placeItems: 'center',
  position: 'relative',
  padding: '12px 0',
};

const viewportStyle: CSSProperties = {
  position: 'relative',
  background: semantic.surface,
  border: `1px solid ${semantic.border}`,
  // Critical: the active tile mounts a chromeless LayoutConfigurator whose
  // SVG has `overflow: visible` so drag handles render past slot edges.
  // Without `overflow: hidden` here, the handles bleed into adjacent tiles
  // when the user parks the PiP inset near a viewport edge — particularly
  // visible at the 9:16 column's narrow width at minWidth: 960px.
  overflow: 'hidden',
};

export default TriptychTile;
