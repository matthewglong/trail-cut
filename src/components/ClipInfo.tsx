import { open } from '@tauri-apps/plugin-dialog';
import type { Clip, TrimRange, FocalPoint, Effects } from '../types';

interface ClipInfoProps {
  clip: Clip | null;
  onRemove?: () => void;
  onUpdateTrim?: (trim: TrimRange) => void;
  onUpdateFocalPoint?: (fp: FocalPoint) => void;
  onUpdateEffects?: (effects: Effects) => void;
}

function formatMs(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec % 60).toFixed(1);
  return `${min}:${sec.padStart(4, '0')}`;
}

function parseMsInput(value: string, fallback: number): number {
  const num = parseFloat(value);
  return isNaN(num) ? fallback : Math.max(0, num * 1000);
}

export default function ClipInfo({ clip, onRemove, onUpdateTrim, onUpdateFocalPoint, onUpdateEffects }: ClipInfoProps) {
  if (!clip) {
    return (
      <div style={styles.container}>
        <p style={styles.placeholder}>Select a clip to view details</p>
      </div>
    );
  }

  const durationMs = clip.duration_ms ?? 0;
  const trimIn = clip.trim?.in_ms ?? 0;
  const trimOut = clip.trim?.out_ms ?? durationMs;
  const trimmedDuration = trimOut - trimIn;
  const speed = clip.effects.speed;

  function handleTrimInChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!onUpdateTrim) return;
    const newIn = parseMsInput(e.target.value, trimIn);
    onUpdateTrim({ in_ms: Math.min(newIn, trimOut - 100), out_ms: trimOut });
  }

  function handleTrimOutChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!onUpdateTrim) return;
    const newOut = parseMsInput(e.target.value, trimOut);
    onUpdateTrim({ in_ms: trimIn, out_ms: Math.max(newOut, trimIn + 100) });
  }

  function handleResetTrim() {
    if (!onUpdateTrim || !durationMs) return;
    onUpdateTrim({ in_ms: 0, out_ms: durationMs });
  }

  function handleSpeedChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!onUpdateEffects) return;
    onUpdateEffects({ ...clip.effects, speed: parseFloat(e.target.value) });
  }

  async function handleSelectLut() {
    if (!onUpdateEffects) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'LUT Files', extensions: ['cube', '3dl', 'lut'] }],
      });
      if (selected) {
        onUpdateEffects({ ...clip.effects, color_lut: selected as string });
      }
    } catch { /* user cancelled */ }
  }

  function handleClearLut() {
    if (!onUpdateEffects) return;
    onUpdateEffects({ ...clip.effects, color_lut: null });
  }

  const lutFilename = clip.effects.color_lut?.split('/').pop() ?? null;

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>{clip.filename}</h3>

      {/* Metadata */}
      <div style={styles.details}>
        {clip.created_at && (
          <div style={styles.row}>
            <span style={styles.label}>Filmed</span>
            <span style={styles.value}>{clip.created_at}</span>
          </div>
        )}
        {clip.duration_ms !== null && (
          <div style={styles.row}>
            <span style={styles.label}>Duration</span>
            <span style={styles.value}>{(clip.duration_ms / 1000).toFixed(1)}s</span>
          </div>
        )}
        {clip.resolution && (
          <div style={styles.row}>
            <span style={styles.label}>Resolution</span>
            <span style={styles.value}>{clip.resolution}</span>
          </div>
        )}
        {clip.frame_rate && (
          <div style={styles.row}>
            <span style={styles.label}>FPS</span>
            <span style={styles.value}>{clip.frame_rate}</span>
          </div>
        )}
        {clip.gps && (
          <div style={styles.row}>
            <span style={styles.label}>GPS</span>
            <span style={styles.value}>
              {clip.gps.lat.toFixed(5)}, {clip.gps.lng.toFixed(5)}
            </span>
          </div>
        )}
      </div>

      {/* Trim section */}
      {durationMs > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Trim</span>
            <span style={styles.sectionMeta}>{formatMs(trimmedDuration)}</span>
          </div>
          <div style={styles.trimRow}>
            <label style={styles.trimLabel}>In</label>
            <input
              type="number"
              step="0.1"
              min={0}
              max={(trimOut / 1000) - 0.1}
              value={(trimIn / 1000).toFixed(1)}
              onChange={handleTrimInChange}
              style={styles.trimInput}
            />
            <span style={styles.trimUnit}>s</span>
          </div>
          <div style={styles.trimRow}>
            <label style={styles.trimLabel}>Out</label>
            <input
              type="number"
              step="0.1"
              min={(trimIn / 1000) + 0.1}
              max={durationMs / 1000}
              value={(trimOut / 1000).toFixed(1)}
              onChange={handleTrimOutChange}
              style={styles.trimInput}
            />
            <span style={styles.trimUnit}>s</span>
          </div>
          {(trimIn > 0 || trimOut < durationMs) && (
            <button onClick={handleResetTrim} style={styles.resetBtn}>Reset trim</button>
          )}
        </div>
      )}

      {/* Focal point / Zoom section */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Zoom</span>
          <span style={styles.sectionMeta}>{clip.focal_point.zoom.toFixed(1)}x</span>
        </div>
        <input
          type="range"
          min={1.0}
          max={5.0}
          step={0.1}
          value={clip.focal_point.zoom}
          onChange={(e) => onUpdateFocalPoint?.({
            ...clip.focal_point,
            zoom: parseFloat(e.target.value),
          })}
          style={styles.slider}
        />
        <div style={styles.sliderLabels}>
          <span>1x</span>
          <span>3x</span>
          <span>5x</span>
        </div>
        {(clip.focal_point.x !== 0.5 || clip.focal_point.y !== 0.5 || clip.focal_point.zoom !== 1.0) && (
          <button
            onClick={() => onUpdateFocalPoint?.({ x: 0.5, y: 0.5, zoom: 1.0 })}
            style={styles.resetBtn}
          >
            Reset position & zoom
          </button>
        )}
      </div>

      {/* Speed section */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Speed</span>
          <span style={styles.sectionMeta}>{speed}x</span>
        </div>
        <input
          type="range"
          min={0.25}
          max={4.0}
          step={0.25}
          value={speed}
          onChange={handleSpeedChange}
          style={styles.slider}
        />
        <div style={styles.sliderLabels}>
          <span>0.25x</span>
          <span>1x</span>
          <span>4x</span>
        </div>
      </div>

      {/* Color LUT section */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Color Grade</span>
        </div>
        {lutFilename ? (
          <div style={styles.lutRow}>
            <span style={styles.lutName} title={clip.effects.color_lut ?? ''}>{lutFilename}</span>
            <button onClick={handleClearLut} style={styles.lutClearBtn}>X</button>
          </div>
        ) : (
          <button onClick={handleSelectLut} style={styles.lutSelectBtn}>
            Load LUT file
          </button>
        )}
      </div>

      {onRemove && (
        <button onClick={onRemove} style={styles.removeBtn}>
          Remove Clip
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 16px',
    backgroundColor: '#1e1e1e',
    overflow: 'auto',
    height: '100%',
  },
  placeholder: {
    color: '#666',
    fontSize: '13px',
    margin: 0,
  },
  title: {
    color: '#fff',
    fontSize: '14px',
    margin: '0 0 8px 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  details: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '12px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '12px',
  },
  label: {
    color: '#888',
  },
  value: {
    color: '#ccc',
  },
  // Sections
  section: {
    borderTop: '1px solid #333',
    paddingTop: '10px',
    marginTop: '10px',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  sectionTitle: {
    fontSize: '12px',
    fontWeight: 'bold',
    color: '#aaa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  sectionMeta: {
    fontSize: '12px',
    color: '#ff6b35',
    fontVariantNumeric: 'tabular-nums',
  },
  // Trim
  trimRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '4px',
  },
  trimLabel: {
    fontSize: '12px',
    color: '#888',
    width: '24px',
  },
  trimInput: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '3px',
    padding: '4px 6px',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
  },
  trimUnit: {
    fontSize: '11px',
    color: '#666',
  },
  resetBtn: {
    marginTop: '6px',
    width: '100%',
    padding: '4px',
    backgroundColor: 'transparent',
    color: '#888',
    border: '1px solid #444',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
  },
  // Speed slider
  slider: {
    width: '100%',
    height: '4px',
    cursor: 'pointer',
    accentColor: '#ff6b35',
  },
  sliderLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '10px',
    color: '#666',
    marginTop: '2px',
  },
  // LUT
  lutRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  lutName: {
    flex: 1,
    fontSize: '12px',
    color: '#ccc',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  lutClearBtn: {
    backgroundColor: 'transparent',
    color: '#ff4444',
    border: '1px solid #ff4444',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '10px',
    padding: '2px 6px',
    flexShrink: 0,
  },
  lutSelectBtn: {
    width: '100%',
    padding: '6px',
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  removeBtn: {
    marginTop: '16px',
    width: '100%',
    padding: '6px',
    backgroundColor: 'transparent',
    color: '#ff4444',
    border: '1px solid #ff4444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  },
};
