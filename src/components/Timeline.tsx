import type { ClipMetadata } from '../types';

interface TimelineProps {
  clips: ClipMetadata[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export default function Timeline({ clips, selectedClipId, onSelectClip }: TimelineProps) {
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
        {clips.map((clip, index) => (
          <button
            key={clip.id}
            onClick={() => onSelectClip(clip.id)}
            style={{
              ...styles.clip,
              ...(selectedClipId === clip.id ? styles.clipSelected : {}),
            }}
          >
            <div style={styles.clipIndex}>{index + 1}</div>
            <div style={styles.clipName} title={clip.filename}>
              {clip.filename}
            </div>
            <div style={styles.clipDuration}>{formatDuration(clip.duration_ms)}</div>
            {clip.gps && <div style={styles.clipGps}>GPS</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    borderTop: '1px solid #333',
    backgroundColor: '#1a1a1a',
    padding: '8px 0',
    overflowX: 'auto',
  },
  strip: {
    display: 'flex',
    gap: '4px',
    padding: '0 8px',
    minWidth: 'min-content',
  },
  clip: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: '100px',
    maxWidth: '140px',
    padding: '8px',
    backgroundColor: '#2a2a2a',
    border: '2px solid transparent',
    borderRadius: '6px',
    cursor: 'pointer',
    color: '#ccc',
    fontSize: '11px',
    transition: 'border-color 0.15s',
  },
  clipSelected: {
    borderColor: '#4a9eff',
    backgroundColor: '#1e3a5f',
  },
  clipIndex: {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: '4px',
  },
  clipName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    width: '100%',
    textAlign: 'center',
    marginBottom: '2px',
  },
  clipDuration: {
    color: '#888',
    fontSize: '10px',
  },
  clipGps: {
    color: '#4a9eff',
    fontSize: '9px',
    marginTop: '2px',
    fontWeight: 'bold',
  },
  empty: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '80px',
    backgroundColor: '#1a1a1a',
    borderTop: '1px solid #333',
  },
  emptyText: {
    color: '#666',
    fontSize: '14px',
  },
};
