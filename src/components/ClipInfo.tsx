import type { ClipMetadata } from '../types';

interface ClipInfoProps {
  clip: ClipMetadata | null;
  onRemove?: () => void;
}

export default function ClipInfo({ clip, onRemove }: ClipInfoProps) {
  if (!clip) {
    return (
      <div style={styles.container}>
        <p style={styles.placeholder}>Select a clip to view details</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>{clip.filename}</h3>
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
    borderBottom: '1px solid #333',
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
  removeBtn: {
    marginTop: '12px',
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
