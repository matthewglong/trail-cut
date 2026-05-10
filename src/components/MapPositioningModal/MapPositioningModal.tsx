import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

export interface MapPositioningModalProps {
  open: boolean;
  onClose: () => void;
}

export function MapPositioningModal({ open, onClose }: MapPositioningModalProps) {
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
          <p style={placeholderStyle}>Per-aspect positioning UI lands in task 210.</p>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
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
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const placeholderStyle: CSSProperties = {
  margin: 0,
  color: '#888',
  fontSize: 13,
};

export default MapPositioningModal;
