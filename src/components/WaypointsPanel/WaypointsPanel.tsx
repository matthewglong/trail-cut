// Minimal v1 waypoints editor: a modal list of every waypoint on the
// project, surfacing rename (label) + delete. No add affordance — clip-
// sourced waypoints are seeded automatically; manual add lands in a future
// iteration. Deletion is sticky: once removed, a clip-sourced waypoint
// won't reappear on re-import or re-trim (see `src/lib/waypoints.ts`).

import {
  useEffect,
  useMemo,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { semantic } from '../../theme/tokens';
import type { Waypoint } from '../../types';

export interface WaypointsPanelProps {
  open: boolean;
  onClose: () => void;
  waypoints: Waypoint[];
  /** Rename a single waypoint's label. The parent updates project state
   *  (autosave fires within ~1s). */
  onRename: (id: string, label: string) => void;
  /** Delete a single waypoint from the project. Sticky: clip-sourced
   *  waypoints won't be re-created by subsequent clip edits. */
  onDelete: (id: string) => void;
}

export function WaypointsPanel({
  open,
  onClose,
  waypoints,
  onRename,
  onDelete,
}: WaypointsPanelProps) {
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

  // Stable iteration order matches the array — which is also the index used
  // in `'numbered'` mode, so the ordinal the user sees on the map equals
  // the row position here.
  const rows = useMemo(
    () =>
      waypoints.map((wp, idx) => ({
        wp,
        ordinal: idx + 1,
      })),
    [waypoints],
  );

  if (!open) return null;

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const content = (
    <div
      style={backdropStyle}
      onClick={handleBackdropClick}
      data-testid="waypoints-panel-backdrop"
    >
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="waypoints-panel-title"
        data-testid="waypoints-panel"
      >
        <div style={headerStyle}>
          <h2 id="waypoints-panel-title" style={titleStyle}>
            Waypoints
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={closeButtonStyle}
            aria-label="Close"
            data-testid="waypoints-panel-close"
          >
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          {rows.length === 0 ? (
            <div style={emptyStyle}>
              No waypoints yet. Import clips to seed waypoints from clip
              starts, or (future) add a waypoint by clicking on the map.
            </div>
          ) : (
            <div style={listStyle}>
              {rows.map(({ wp, ordinal }) => (
                <div
                  key={wp.id}
                  style={rowStyle}
                  data-testid={`waypoints-panel-row-${wp.id}`}
                >
                  <div style={ordinalStyle} title={`Source: ${wp.source}`}>
                    {ordinal}
                  </div>
                  <input
                    type="text"
                    value={wp.label}
                    placeholder={placeholderForSource(wp)}
                    onChange={(e) => onRename(wp.id, e.target.value)}
                    style={labelInputStyle}
                    aria-label={`Waypoint ${ordinal} label`}
                    data-testid={`waypoints-panel-label-${wp.id}`}
                  />
                  <button
                    type="button"
                    onClick={() => onDelete(wp.id)}
                    title="Delete waypoint"
                    aria-label={`Delete waypoint ${ordinal}`}
                    style={deleteButtonStyle}
                    data-testid={`waypoints-panel-delete-${wp.id}`}
                  >
                    <Trash2 size={15} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

/** Hint text shown when a label is empty. Surfaces the waypoint's source so
 *  the user knows the row's provenance without expanding it. */
function placeholderForSource(wp: Waypoint): string {
  switch (wp.source) {
    case 'clip':
      return wp.clip_id ? '(clip-sourced — unnamed)' : '(clip — unnamed)';
    case 'gpx':
      return '(GPX waypoint — unnamed)';
    case 'manual':
      return '(manual — unnamed)';
    default:
      return '(unnamed)';
  }
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
  width: 'min(80vw, 560px)',
  maxHeight: '80vh',
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
  padding: '12px 16px',
  borderBottom: `1px solid ${semantic.border}`,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: 0.2,
};

const closeButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: semantic.fg,
  fontSize: 24,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 6px',
};

const bodyStyle: CSSProperties = {
  padding: 16,
  overflow: 'auto',
};

const emptyStyle: CSSProperties = {
  padding: '24px 8px',
  textAlign: 'center',
  color: '#aaa',
  fontSize: 13,
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px',
  backgroundColor: '#1f1f1f',
  border: `1px solid ${semantic.border}`,
  borderRadius: 4,
};

const ordinalStyle: CSSProperties = {
  width: 28,
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 13,
  fontWeight: 600,
  color: '#bbb',
  cursor: 'default',
};

const labelInputStyle: CSSProperties = {
  flex: 1,
  background: '#121212',
  border: `1px solid ${semantic.border}`,
  borderRadius: 4,
  color: semantic.fg,
  padding: '6px 8px',
  fontSize: 13,
  outline: 'none',
};

const deleteButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  background: 'transparent',
  border: `1px solid ${semantic.border}`,
  borderRadius: 4,
  color: '#c8c8c8',
  cursor: 'pointer',
};
