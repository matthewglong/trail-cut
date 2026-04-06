import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Clip } from '../types';

interface TimelineProps {
  clips: Clip[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  thumbnails?: Record<string, string>;
  proxies?: Record<string, string | 'generating' | null>;
  onRemoveClip?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Info popover shown when clicking the info icon */
function InfoPopover({ clip, anchorRect, onClose }: { clip: Clip; anchorRect: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handleClick); };
  }, [onClose]);

  // Clamp horizontally so it doesn't go off-screen
  const popoverWidth = 220; // matches minWidth
  const centerX = anchorRect.left + anchorRect.width / 2;
  const clampedLeft = Math.max(8, Math.min(centerX - popoverWidth / 2, window.innerWidth - popoverWidth - 8));

  const popoverContent = (
    <div ref={ref} style={{
      ...popoverStyles.container,
      left: `${clampedLeft}px`,
      top: `${anchorRect.top - 8}px`,
      transform: 'translateY(-100%)',
    }}>
      <div style={popoverStyles.title}>{clip.filename}</div>
      <div style={popoverStyles.rows}>
        {clip.created_at && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>Filmed</span>
            <span style={popoverStyles.value}>{clip.created_at}</span>
          </div>
        )}
        {clip.duration_ms !== null && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>Duration</span>
            <span style={popoverStyles.value}>{(clip.duration_ms / 1000).toFixed(1)}s</span>
          </div>
        )}
        {clip.resolution && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>Resolution</span>
            <span style={popoverStyles.value}>{clip.resolution}</span>
          </div>
        )}
        {clip.frame_rate && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>FPS</span>
            <span style={popoverStyles.value}>{clip.frame_rate}</span>
          </div>
        )}
        {clip.gps && (
          <div style={popoverStyles.row}>
            <span style={popoverStyles.label}>GPS</span>
            <span style={popoverStyles.value}>{clip.gps.lat.toFixed(5)}, {clip.gps.lng.toFixed(5)}</span>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(popoverContent, document.body);
}

const popoverStyles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    backgroundColor: '#252525',
    border: '1px solid #3a3a3a',
    borderRadius: '8px',
    padding: '12px 14px',
    minWidth: '220px',
    zIndex: 200,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  title: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#fff',
    marginBottom: '8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
  },
  label: {
    color: '#777',
  },
  value: {
    color: '#bbb',
    fontVariantNumeric: 'tabular-nums',
  },
};

// SVG icons as inline components
const InfoIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 5.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="6" cy="3.8" r="0.6" fill="currentColor" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2.5 3.5H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M4.5 2.5H7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M3.5 3.5L4 10H8L8.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const EyeOpenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M1.5 7C1.5 7 3.5 3.5 7 3.5C10.5 3.5 12.5 7 12.5 7C12.5 7 10.5 10.5 7 10.5C3.5 10.5 1.5 7 1.5 7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const EyeClosedIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M2 2L12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M1.5 7C1.5 7 3.5 3.5 7 3.5C10.5 3.5 12.5 7 12.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M12.5 7C12.5 7 10.5 10.5 7 10.5C5.5 10.5 4.2 9.8 3.3 9" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

export default function Timeline({
  clips,
  selectedClipId,
  onSelectClip,
  thumbnails = {},
  proxies = {},
  onRemoveClip,
  onToggleVisibility,
}: TimelineProps) {
  const [infoClipId, setInfoClipId] = useState<string | null>(null);
  const [infoAnchorRect, setInfoAnchorRect] = useState<DOMRect | null>(null);

  if (clips.length === 0) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyText}>Import a folder of hiking videos to get started</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.strip}>
        {clips.map((clip, index) => {
          const isSelected = selectedClipId === clip.id;
          const isHidden = !clip.visible;

          return (
            <div
              key={clip.id}
              data-clip-card
              style={{
                ...styles.card,
                ...(isSelected ? styles.cardSelected : {}),
                ...(isHidden ? styles.cardHidden : {}),
              }}
            >
              {/* Thumbnail / click to select */}
              <div
                onClick={() => onSelectClip(clip.id)}
                style={styles.thumbBtn}
              >
                {thumbnails[clip.id] ? (
                  <img
                    src={convertFileSrc(thumbnails[clip.id])}
                    alt={clip.filename}
                    style={{
                      ...styles.thumbnail,
                      ...(isHidden ? { opacity: 0.3 } : {}),
                    }}
                  />
                ) : (
                  <div style={styles.thumbPlaceholder}>{index + 1}</div>
                )}
                {proxies[clip.id] === 'generating' && (
                  <div style={styles.proxyBadge}>...</div>
                )}
              </div>

              {/* Action buttons */}
              <div style={styles.actions}>
                <button
                  style={styles.actionBtn}
                  title="Clip info"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (infoClipId === clip.id) {
                      setInfoClipId(null);
                      setInfoAnchorRect(null);
                    } else {
                      setInfoClipId(clip.id);
                      setInfoAnchorRect((e.currentTarget as HTMLElement).closest('[data-clip-card]')!.getBoundingClientRect());
                    }
                  }}
                >
                  <InfoIcon />
                </button>
                <button
                  style={{
                    ...styles.actionBtn,
                    color: isHidden ? '#ff6b35' : '#777',
                  }}
                  title={isHidden ? 'Show clip' : 'Hide clip'}
                  onClick={(e) => { e.stopPropagation(); onToggleVisibility?.(clip.id); }}
                >
                  {isHidden ? <EyeClosedIcon /> : <EyeOpenIcon />}
                </button>
                <button
                  style={{ ...styles.actionBtn, color: '#777' }}
                  title="Remove clip"
                  onClick={(e) => { e.stopPropagation(); onRemoveClip?.(clip.id); }}
                >
                  <TrashIcon />
                </button>
              </div>

              {/* Info popover (rendered via portal) */}
              {infoClipId === clip.id && infoAnchorRect && (
                <InfoPopover clip={clip} anchorRect={infoAnchorRect} onClose={() => { setInfoClipId(null); setInfoAnchorRect(null); }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    borderTop: '1px solid #2a2a2a',
    backgroundColor: '#161616',
    padding: '8px 0',
    overflowX: 'auto',
  },
  strip: {
    display: 'flex',
    gap: '4px',
    padding: '0 8px',
    minWidth: 'min-content',
  },
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: '96px',
    maxWidth: '120px',
    backgroundColor: '#222',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: '#222',
    borderRadius: '6px',
    overflow: 'visible',
    transition: 'border-color 0.15s',
  },
  cardSelected: {
    borderColor: '#ff6b35',
    backgroundColor: '#2e1a0f',
  },
  cardHidden: {
    opacity: 0.5,
  },
  thumbBtn: {
    display: 'block',
    width: '100%',
    padding: 0,
    margin: 0,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    outline: 'none',
  },
  thumbnail: {
    width: '100%',
    height: '56px',
    objectFit: 'cover',
    borderRadius: '4px 4px 0 0',
    display: 'block',
  },
  thumbPlaceholder: {
    width: '100%',
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#555',
    backgroundColor: '#1a1a1a',
    borderRadius: '4px 4px 0 0',
  },
  proxyBadge: {
    position: 'absolute',
    top: '4px',
    right: '4px',
    fontSize: '9px',
    color: '#ff6b35',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: '3px',
    padding: '1px 4px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'center',
    gap: '2px',
    padding: '4px 2px',
  },
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '22px',
    background: 'none',
    border: 'none',
    color: '#777',
    cursor: 'pointer',
    borderRadius: '3px',
    padding: 0,
    outline: 'none',
  },
  empty: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '80px',
    backgroundColor: '#161616',
    borderTop: '1px solid #2a2a2a',
  },
  emptyText: {
    color: '#555',
    fontSize: '14px',
  },
};
