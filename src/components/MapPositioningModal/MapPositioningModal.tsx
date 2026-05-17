import {
  useCallback,
  useEffect,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { semantic } from '../../theme/tokens';
import {
  defaultLayout,
  type AspectRatio,
  type LayoutConfig,
  type ProjectLayouts,
} from '../../lib/layout';
import { TriptychTile } from './TriptychTile';

export interface MapPositioningModalProps {
  open: boolean;
  onClose: () => void;
  layouts: ProjectLayouts;
  onLayoutChange: (aspect: AspectRatio, next: LayoutConfig) => void;
}

interface AspectPaneDef {
  aspect: AspectRatio;
  label: string;
}

const ASPECT_PANES: AspectPaneDef[] = [
  { aspect: '16_9', label: '16:9' },
  { aspect: '4_5', label: '4:5' },
  { aspect: '9_16', label: '9:16' },
];

export function MapPositioningModal({
  open,
  onClose,
  layouts,
  onLayoutChange,
}: MapPositioningModalProps) {
  const resolveLayout = useCallback(
    (aspect: AspectRatio): LayoutConfig => layouts[aspect] ?? defaultLayout(aspect),
    [layouts],
  );

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const content = (
    <div
      style={backdropStyle}
      onClick={handleBackdropClick}
      data-testid="map-positioning-modal-backdrop"
    >
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-positioning-modal-title"
        data-testid="map-positioning-modal"
      >
        <div style={headerStyle}>
          <h2 id="map-positioning-modal-title" style={titleStyle}>
            Map Positioning
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={closeButtonStyle}
            aria-label="Close"
            data-testid="map-positioning-modal-close"
          >
            ×
          </button>
        </div>

        <div style={bodyStyle} data-testid="map-positioning-modal-body">
          <div style={gridStyle}>
            {ASPECT_PANES.map(({ aspect, label }) => (
              <TriptychTile
                key={aspect}
                aspect={aspect}
                label={label}
                layout={resolveLayout(aspect)}
                onChange={(next) => onLayoutChange(aspect, next)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: semantic.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  width: 'min(94vw, 1480px)',
  minWidth: 960,
  maxHeight: '90vh',
  backgroundColor: semantic.surface,
  border: `1px solid ${semantic.border}`,
  borderRadius: 6,
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
  display: 'flex',
  flexDirection: 'column',
  color: semantic.fg,
  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '14px 20px',
  borderBottom: `1px solid ${semantic.border}`,
  background: semantic.surfaceRaised,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: semantic.fg,
};

const closeButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: semantic.fgMuted,
  fontSize: 22,
  lineHeight: 1,
  width: 28,
  height: 28,
  cursor: 'pointer',
  borderRadius: 4,
  fontFamily: 'inherit',
};

const bodyStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  display: 'flex',
  background: semantic.surface,
};

// Columns are proportional to each aspect's width-per-unit-height (16/9,
// 4/5, 9/16). Combined with `width: 100%` frames in each cell, this makes
// all three frames render at the same effective scale — no letterboxing,
// no awkward dead space around the narrower aspects.
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.778fr 0.800fr 0.5625fr',
  gap: 20,
  padding: 20,
  flex: '1 1 auto',
  minHeight: 0,
  width: '100%',
};

export default MapPositioningModal;
