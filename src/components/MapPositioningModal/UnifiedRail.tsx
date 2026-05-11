import type { CSSProperties } from 'react';
import { semantic } from '../../theme/tokens';
import {
  clampLayout,
  legalSplitSides,
  synthesizeLayoutForMode,
  type AspectRatio,
  type LayoutConfig,
  type PipLayout,
  type SplitLayout,
} from '../../lib/layout';

export interface UnifiedRailProps {
  activeRatio: AspectRatio;
  activeLabel: string;
  activeLayout: LayoutConfig;
  otherRatios: { aspect: AspectRatio; label: string; layout: LayoutConfig }[];
  onLayoutChange: (next: LayoutConfig) => void;
  onCopyFrom: (sourceAspect: AspectRatio) => void;
  onReset: () => void;
}

export function UnifiedRail({
  activeRatio,
  activeLabel,
  activeLayout,
  otherRatios,
  onLayoutChange,
  onCopyFrom,
  onReset,
}: UnifiedRailProps) {
  const isPip = activeLayout.mode === 'pip';

  const handleModeChange = (next: 'pip' | 'split') => {
    if (next === activeLayout.mode) return;
    onLayoutChange(clampLayout(synthesizeLayoutForMode(next, activeRatio), activeRatio));
  };

  const handleSwap = () => {
    if (activeLayout.mode === 'pip') {
      const swapped: PipLayout = {
        ...activeLayout,
        inset_source: activeLayout.inset_source === 'video' ? 'map' : 'video',
      };
      onLayoutChange(clampLayout(swapped, activeRatio));
    } else {
      const sides = legalSplitSides(activeRatio);
      const i = sides.indexOf(activeLayout.video_side);
      const nextSide = sides[(i + 1) % sides.length];
      const swapped: SplitLayout = { ...activeLayout, video_side: nextSide };
      onLayoutChange(clampLayout(swapped, activeRatio));
    }
  };

  const handleDividerChange = (next: number) => {
    if (activeLayout.mode !== 'split') return;
    onLayoutChange(clampLayout({ ...activeLayout, divider: next }, activeRatio));
  };

  return (
    <div style={railStyle} data-testid="map-positioning-rail">
      <Panel title="Composition" hint={`Editing ${activeLabel}`}>
        <div style={modeRowStyle}>
          <ModeCard
            label="PiP"
            active={activeLayout.mode === 'pip'}
            onClick={() => handleModeChange('pip')}
            testId="rail-mode-pip"
          />
          <ModeCard
            label="Split"
            active={activeLayout.mode === 'split'}
            onClick={() => handleModeChange('split')}
            testId="rail-mode-split"
          />
        </div>
      </Panel>

      <Panel title="Order" hint="Click to swap">
        <SwapVisual layout={activeLayout} onSwap={handleSwap} />
      </Panel>

      <Panel title="Divider" hint={isPip ? 'PiP — n/a' : 'Split only'}>
        <DividerSlider
          value={isPip ? 0.5 : (activeLayout as SplitLayout).divider}
          disabled={isPip}
          onChange={handleDividerChange}
        />
      </Panel>

      <Panel title="Apply" hint="Per ratio">
        <div style={{ display: 'grid', gap: 6 }}>
          {otherRatios.map(({ aspect, label }) => (
            <RailButton
              key={aspect}
              onClick={() => onCopyFrom(aspect)}
              testId={`rail-copy-from-${aspect}`}
            >
              Copy from {label}
            </RailButton>
          ))}
          <RailButton
            onClick={onReset}
            testId={`map-positioning-reset-${activeRatio}`}
          >
            Reset {activeLabel}
          </RailButton>
        </div>
      </Panel>
    </div>
  );
}

interface PanelProps {
  title: string;
  hint: string;
  children: React.ReactNode;
}

function Panel({ title, hint, children }: PanelProps) {
  return (
    <div style={panelStyle}>
      <header style={panelHeadStyle}>
        <span style={panelTitleStyle}>{title}</span>
        <span style={panelHintStyle}>{hint}</span>
      </header>
      {children}
    </div>
  );
}

interface ModeCardProps {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}

function ModeCard({ label, active, onClick, testId }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      style={{
        ...modeCardStyle,
        borderColor: active ? semantic.accent : semantic.borderStrong,
        background: active ? semantic.accentTint : semantic.surfaceDeep,
        color: active ? semantic.accent : semantic.fg,
      }}
    >
      <span style={modeCardGlyphStyle} aria-hidden="true">
        {label === 'PiP' ? <PipGlyph color={active ? semantic.accent : semantic.fgMuted} /> : <SplitGlyph color={active ? semantic.accent : semantic.fgMuted} />}
      </span>
      <span style={modeCardNameStyle}>{label}</span>
    </button>
  );
}

function PipGlyph({ color }: { color: string }) {
  return (
    <svg width={26} height={20} viewBox="0 0 26 20" xmlns="http://www.w3.org/2000/svg">
      <rect x={1} y={1} width={24} height={18} fill="none" stroke={color} strokeWidth={1.4} />
      <rect x={15} y={11} width={8} height={6} fill={color} fillOpacity={0.28} stroke={color} strokeWidth={1.2} />
    </svg>
  );
}

function SplitGlyph({ color }: { color: string }) {
  return (
    <svg width={26} height={20} viewBox="0 0 26 20" xmlns="http://www.w3.org/2000/svg">
      <rect x={1} y={1} width={24} height={18} fill="none" stroke={color} strokeWidth={1.4} />
      <line x1={13} y1={1} x2={13} y2={19} stroke={color} strokeWidth={1.4} />
      <rect x={1} y={1} width={12} height={18} fill={color} fillOpacity={0.18} />
    </svg>
  );
}

interface SwapVisualProps {
  layout: LayoutConfig;
  onSwap: () => void;
}

function SwapVisual({ layout, onSwap }: SwapVisualProps) {
  let leftLabel: string;
  let rightLabel: string;
  if (layout.mode === 'pip') {
    leftLabel = `BG · ${layout.inset_source === 'video' ? 'Map' : 'Video'}`;
    rightLabel = `Inset · ${layout.inset_source === 'video' ? 'Video' : 'Map'}`;
  } else {
    const horizontal = layout.video_side === 'left' || layout.video_side === 'right';
    if (horizontal) {
      const videoLeft = layout.video_side === 'left';
      leftLabel = videoLeft ? 'Video · L' : 'Map · L';
      rightLabel = videoLeft ? 'Map · R' : 'Video · R';
    } else {
      const videoTop = layout.video_side === 'top';
      leftLabel = videoTop ? 'Video · T' : 'Map · T';
      rightLabel = videoTop ? 'Map · B' : 'Video · B';
    }
  }
  return (
    <button
      type="button"
      onClick={onSwap}
      data-testid="rail-swap"
      style={swapVisualStyle}
      aria-label="Swap order"
    >
      <span style={swapChipStyle}>{leftLabel}</span>
      <span style={swapArrowStyle} aria-hidden="true">⇄</span>
      <span style={swapChipStyle}>{rightLabel}</span>
    </button>
  );
}

interface DividerSliderProps {
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
}

function DividerSlider({ value, disabled, onChange }: DividerSliderProps) {
  const pct = Math.round(value * 100);
  return (
    <div style={sliderRowStyle}>
      <span style={sliderLabelStyle}>Position</span>
      <span style={sliderValueStyle}>{pct}%</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        data-testid="rail-divider-slider"
        style={{
          ...sliderInputStyle,
          accentColor: disabled ? semantic.fgFaint : semantic.accent,
          opacity: disabled ? 0.4 : 1,
        }}
      />
    </div>
  );
}

interface RailButtonProps {
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}

function RailButton({ onClick, testId, children }: RailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      style={railButtonStyle}
    >
      {children}
    </button>
  );
}

const railStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr',
  gap: 1,
  background: semantic.border,
  borderTop: `1px solid ${semantic.border}`,
};

const panelStyle: CSSProperties = {
  padding: '16px 20px',
  background: semantic.surface,
};

const panelHeadStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  marginBottom: 12,
  paddingBottom: 8,
  borderBottom: `1px solid ${semantic.border}`,
};

const panelTitleStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: semantic.fg,
};

const panelHintStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 9.5,
  letterSpacing: '0.18em',
  color: semantic.fgDim,
  textTransform: 'uppercase',
};

const modeRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 4,
};

const modeCardStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: '22px auto',
  gap: 6,
  padding: 8,
  border: '1px solid',
  borderRadius: 3,
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  alignItems: 'center',
  justifyItems: 'center',
  transition: 'border-color 120ms ease, background-color 120ms ease, color 120ms ease',
};

const modeCardGlyphStyle: CSSProperties = {
  width: 26,
  height: 20,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const modeCardNameStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const swapVisualStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 22px 1fr',
  gap: 8,
  alignItems: 'center',
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  width: '100%',
};

const swapChipStyle: CSSProperties = {
  padding: '6px 8px',
  border: `1px solid ${semantic.borderStrong}`,
  background: semantic.surfaceDeep,
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  textAlign: 'center',
  color: semantic.fg,
  borderRadius: 2,
};

const swapArrowStyle: CSSProperties = {
  textAlign: 'center',
  color: semantic.accent,
  fontSize: 14,
};

const sliderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto auto 1fr',
  alignItems: 'center',
  gap: 8,
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
};

const sliderLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: semantic.fgDim,
};

const sliderValueStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.10em',
  color: semantic.fg,
  fontWeight: 700,
  minWidth: 36,
};

const sliderInputStyle: CSSProperties = {
  width: '100%',
  cursor: 'pointer',
};

const railButtonStyle: CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: 10.5,
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  background: semantic.surfaceDeep,
  color: semantic.fg,
  border: `1px solid ${semantic.borderStrong}`,
  borderRadius: 2,
  cursor: 'pointer',
};

export default UnifiedRail;
