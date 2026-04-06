import { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Clip } from '../../types';
import { InfoIcon, TrashIcon, EyeOpenIcon, EyeClosedIcon } from './icons';
import InfoPopover from './InfoPopover';
import { styles } from './styles';

interface TimelineProps {
  clips: Clip[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  thumbnails?: Record<string, string>;
  proxies?: Record<string, string | 'generating' | null>;
  onRemoveClip?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
}

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
