import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { LayoutConfigurator } from '../LayoutConfigurator';
import NumberStepper from '../NumberStepper';
import {
  clampLayout,
  defaultLayout,
  MAGNIFICATION_DEFAULT,
  MAGNIFICATION_MAX,
  MAGNIFICATION_MIN,
  MAGNIFICATION_STEP,
  OUTPUT_DIMS,
  synthesizeLayoutForMode,
  type AspectRatio,
  type LayoutConfig,
} from '../../lib/layout';
import { semantic } from '../../theme/tokens';
import { assignChromeCorners, type Corner } from './cornerPlacement';

export interface TriptychTileProps {
  aspect: AspectRatio;
  label: string;
  layout: LayoutConfig;
  onChange: (next: LayoutConfig) => void;
  /** This aspect's magnification factor — how much the map render is blown
   *  up relative to the frame. Lives in the footer rather than a frame
   *  corner: all four corners are claimable by the existing chrome (the PiP
   *  placement in `cornerPlacement.ts` uses `bl` as its escape hatch), and
   *  the knob is a numeric field, not a glanceable badge. */
  magnification: number;
  onMagnificationChange: (next: number) => void;
}

export function TriptychTile({
  aspect,
  label,
  layout,
  onChange,
  magnification,
  onMagnificationChange,
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

  const corners = useMemo(
    () => assignChromeCorners(layout, size.w, size.h),
    [layout, size.w, size.h],
  );

  const handleModeChange = (next: 'pip' | 'split') => {
    if (next === layout.mode) return;
    onChange(clampLayout(synthesizeLayoutForMode(next, aspect), aspect));
  };

  // Reset is per-tile "give me this ratio's framing back", and magnification
  // is part of that framing — leaving a 1.8× behind after a reset would read
  // as the button not working. Both channels fire; the parent applies them to
  // the two independent stores.
  const handleReset = () => {
    onChange(defaultLayout(aspect));
    onMagnificationChange(MAGNIFICATION_DEFAULT);
  };

  return (
    <div style={tileStyle} data-testid={`map-positioning-pane-${aspect}`}>
      <div
        ref={viewportRef}
        style={{
          ...viewportStyle,
          aspectRatio: `${dims.w} / ${dims.h}`,
        }}
      >
        <Bracket position="tl" />
        <Bracket position="tr" />
        <Bracket position="bl" />
        <Bracket position="br" />

        {size.w > 0 && size.h > 0 && (
          <LayoutConfigurator
            layout={layout}
            aspect={aspect}
            containerWidth={size.w}
            containerHeight={size.h}
            onChange={onChange}
            chromeless
            previewMode="triptych"
          />
        )}

        <ChromeSlot corner={corners.ratio} testid={`tile-${aspect}-ratio`}>
          <span style={ratioChipStyle}>{label}</span>
        </ChromeSlot>

        <ChromeSlot corner={corners.modePill} testid={`tile-${aspect}-modepill`}>
          <ModePill
            aspect={aspect}
            mode={layout.mode}
            onModeChange={handleModeChange}
          />
        </ChromeSlot>

        <ChromeSlot corner={corners.reset} testid={`tile-${aspect}-reset`}>
          <ResetButton label={label} aspect={aspect} onClick={handleReset} />
        </ChromeSlot>
      </div>

      <div style={footerStyle} data-testid={`tile-${aspect}-footer`}>
        <span style={footerLabelStyle}>Magnification</span>
        <div data-testid={`tile-${aspect}-magnification`}>
          <NumberStepper
            value={magnification}
            min={MAGNIFICATION_MIN}
            max={MAGNIFICATION_MAX}
            step={MAGNIFICATION_STEP}
            decimals={1}
            unit="×"
            onChange={onMagnificationChange}
          />
        </div>
      </div>
    </div>
  );
}

// ─── chrome slot ──────────────────────────────────────────────────────────
// Absolute-positioned wrapper that parks its children at one of the frame's
// four corners. The corner is picked upstream by `assignChromeCorners` so the
// chrome never sits on top of the inset / divider.

interface ChromeSlotProps {
  corner: Corner;
  testid: string;
  children: ReactNode;
}

const CHROME_INSET_PX = 10;

function ChromeSlot({ corner, testid, children }: ChromeSlotProps) {
  const style: CSSProperties = { position: 'absolute', zIndex: 3 };
  if (corner === 'tl' || corner === 'tr') style.top = CHROME_INSET_PX;
  else style.bottom = CHROME_INSET_PX;
  if (corner === 'tl' || corner === 'bl') style.left = CHROME_INSET_PX;
  else style.right = CHROME_INSET_PX;
  return (
    <div style={style} data-testid={testid} data-corner={corner}>
      {children}
    </div>
  );
}

interface ModePillProps {
  aspect: AspectRatio;
  mode: 'pip' | 'split';
  onModeChange: (next: 'pip' | 'split') => void;
}

function ModePill({ aspect, mode, onModeChange }: ModePillProps) {
  return (
    <div role="group" aria-label="Composition mode" style={pillStyle}>
      <ModeSegment
        aspect={aspect}
        kind="split"
        active={mode === 'split'}
        onClick={() => onModeChange('split')}
      />
      <span style={pillDividerStyle} aria-hidden="true" />
      <ModeSegment
        aspect={aspect}
        kind="pip"
        active={mode === 'pip'}
        onClick={() => onModeChange('pip')}
      />
    </div>
  );
}

interface ModeSegmentProps {
  aspect: AspectRatio;
  kind: 'pip' | 'split';
  active: boolean;
  onClick: () => void;
}

function ModeSegment({ aspect, kind, active, onClick }: ModeSegmentProps) {
  const color = active ? semantic.accent : semantic.fgMuted;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={kind === 'pip' ? 'Picture in picture' : 'Split'}
      data-testid={`tile-${aspect}-mode-${kind}`}
      style={{
        ...pillSegmentStyle,
        background: active ? semantic.accentTint : 'transparent',
        color,
      }}
    >
      {kind === 'pip' ? <PipGlyph color={color} /> : <SplitGlyph color={color} />}
    </button>
  );
}

function PipGlyph({ color }: { color: string }) {
  return (
    <svg width={22} height={16} viewBox="0 0 22 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x={1} y={1} width={20} height={14} fill="none" stroke={color} strokeWidth={1.3} />
      <rect x={12} y={8.5} width={7} height={5} fill={color} fillOpacity={0.28} stroke={color} strokeWidth={1.1} />
    </svg>
  );
}

function SplitGlyph({ color }: { color: string }) {
  return (
    <svg width={22} height={16} viewBox="0 0 22 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x={1} y={1} width={20} height={14} fill="none" stroke={color} strokeWidth={1.3} />
      <line x1={11} y1={1} x2={11} y2={15} stroke={color} strokeWidth={1.3} />
      <rect x={1} y={1} width={10} height={14} fill={color} fillOpacity={0.18} />
    </svg>
  );
}

interface ResetButtonProps {
  label: string;
  aspect: AspectRatio;
  onClick: () => void;
}

function ResetButton({ label, aspect, onClick }: ResetButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Reset ${label}`}
      title={`Reset ${label}`}
      data-testid={`map-positioning-reset-${aspect}`}
      style={resetButtonStyle}
    >
      <ResetGlyph />
    </button>
  );
}

function ResetGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M3.2 4.3a4.2 4.2 0 1 1-.7 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <polyline
        points="1.5 1.5 3.4 4.4 6.3 3.0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface BracketProps {
  position: 'tl' | 'tr' | 'bl' | 'br';
}

function Bracket({ position }: BracketProps) {
  const color = semantic.fgFaint;
  const length = 14;
  const thickness = 1.5;
  const offset = 0;
  const base: CSSProperties = {
    position: 'absolute',
    width: length,
    height: length,
    pointerEvents: 'none',
    zIndex: 2,
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

// ─── tile container ───────────────────────────────────────────────────────
// The frame carries no header band and no internal padding. Width derives
// from the parent grid (columns proportional to aspect ratio); the frame
// fills the cell so all three tiles render at the same effective scale. The
// magnification row sits BELOW the frame — putting a numeric field inside
// would eat drag surface and fight the corner-placement chrome.

const tileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  background: semantic.surfaceDeep,
};

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  // Aligns with the frame's chrome inset so the row reads as part of the
  // tile rather than a separate strip.
  padding: `6px ${CHROME_INSET_PX}px 0`,
};

const footerLabelStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: semantic.fgFaint,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const viewportStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  background: semantic.surface,
  // Critical: the chromeless LayoutConfigurator's SVG has `overflow: visible`
  // so drag handles render past slot edges. Without `overflow: hidden` here,
  // the handles bleed into adjacent tiles when the user parks the PiP inset
  // near a viewport edge.
  overflow: 'hidden',
};

// ─── chrome element styles ────────────────────────────────────────────────
// Each lives over the scene, so they need a backplate that stays readable
// against bright sky / dim ground without competing visually.

const chromeBackplate: CSSProperties = {
  background: 'rgba(8, 12, 13, 0.55)',
  border: `1px solid ${semantic.borderSoft}`,
  borderRadius: 3,
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
};

const ratioChipStyle: CSSProperties = {
  ...chromeBackplate,
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 8px',
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: '0.06em',
  color: semantic.fg,
};

const pillStyle: CSSProperties = {
  ...chromeBackplate,
  display: 'inline-flex',
  alignItems: 'stretch',
  padding: 1,
  gap: 0,
};

const pillDividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: semantic.borderSoft,
  margin: '2px 0',
};

const pillSegmentStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 20,
  padding: 0,
  border: 'none',
  borderRadius: 2,
  cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease',
};

const resetButtonStyle: CSSProperties = {
  ...chromeBackplate,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  color: semantic.fgMuted,
  cursor: 'pointer',
  transition: 'color 120ms ease, border-color 120ms ease, background-color 120ms ease',
};

export default TriptychTile;
