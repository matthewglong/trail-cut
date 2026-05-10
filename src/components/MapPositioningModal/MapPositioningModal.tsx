import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { LayoutConfigurator } from '../LayoutConfigurator';
import {
  defaultLayout,
  type AspectRatio,
  type LayoutConfig,
  type ProjectLayouts,
} from '../../lib/layout';

export interface MapPositioningModalProps {
  open: boolean;
  onClose: () => void;
  layouts: ProjectLayouts;
  onLayoutChange: (aspect: AspectRatio, next: LayoutConfig) => void;
}

const ASPECT_PANES: { aspect: AspectRatio; label: string }[] = [
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
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
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
          {ASPECT_PANES.map(({ aspect, label }) => (
            <AspectPane
              key={aspect}
              aspect={aspect}
              label={label}
              layout={layouts[aspect] ?? defaultLayout(aspect)}
              onChange={(next) => onLayoutChange(aspect, next)}
              onReset={() => onLayoutChange(aspect, defaultLayout(aspect))}
            />
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

interface AspectPaneProps {
  aspect: AspectRatio;
  label: string;
  layout: LayoutConfig;
  onChange: (next: LayoutConfig) => void;
  onReset: () => void;
}

function AspectPane({ aspect, label, layout, onChange, onReset }: AspectPaneProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = surfaceRef.current;
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

  return (
    <div style={paneStyle} data-testid={`map-positioning-pane-${aspect}`}>
      <div style={paneHeaderStyle}>
        <span style={paneLabelStyle}>{label}</span>
        <ResetButton onReset={onReset} aspect={aspect} />
      </div>
      <div style={paneSurfaceStyle} ref={surfaceRef}>
        {size.w > 0 && size.h > 0 && (
          <LayoutConfigurator
            layout={layout}
            aspect={aspect}
            containerWidth={size.w}
            containerHeight={size.h}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
}

interface ResetButtonProps {
  onReset: () => void;
  aspect: AspectRatio;
}

function ResetButton({ onReset, aspect }: ResetButtonProps) {
  return (
    <button
      type="button"
      onClick={onReset}
      style={resetButtonStyle}
      data-testid={`map-positioning-reset-${aspect}`}
    >
      Reset
    </button>
  );
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  width: 'min(80vw, 1200px)',
  minWidth: 720,
  height: '70vh',
  backgroundColor: '#1a1a1a',
  border: '1px solid #3a3a3a',
  borderRadius: 6,
  boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
  display: 'flex',
  flexDirection: 'column',
  color: '#e0e0e0',
  fontFamily: 'inherit',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a2a',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '0.02em',
};

const closeButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#ccc',
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
  flexWrap: 'wrap',
  gap: 16,
  padding: 16,
  overflowY: 'auto',
  alignContent: 'flex-start',
  justifyContent: 'center',
};

const paneStyle: CSSProperties = {
  flex: '1 1 280px',
  minWidth: 280,
  maxWidth: 480,
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  backgroundColor: '#101010',
  overflow: 'hidden',
};

const paneHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  borderBottom: '1px solid #2a2a2a',
  backgroundColor: 'rgba(7, 27, 38, 0.4)',
};

const paneLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#ccc',
  letterSpacing: '0.02em',
};

const paneSurfaceStyle: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 240,
  padding: 16,
};

const resetButtonStyle: CSSProperties = {
  padding: '4px 10px',
  backgroundColor: 'rgba(20, 20, 20, 0.78)',
  color: '#ccc',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
};

export default MapPositioningModal;
