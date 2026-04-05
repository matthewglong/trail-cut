import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import Timeline from './components/Timeline';
import MapView from './components/MapView';
import ClipInfo from './components/ClipInfo';
import type { ClipMetadata, Route } from './types';

export default function App() {
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  async function handleImportFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      setLoading(true);
      setError(null);

      const result = await invoke<ClipMetadata[]>('scan_directory', { path: selected });
      setClips(result);

      if (result.length > 0) {
        setSelectedClipId(result[0].id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleImportGpx() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'GPS Route', extensions: ['gpx'] }],
      });
      if (!selected) return;

      setLoading(true);
      setError(null);

      const result = await invoke<Route>('parse_gpx', { filePath: selected });
      setRoute(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.app}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <span style={styles.logo}>TrailCut</span>
        </div>
        <div style={styles.toolbarActions}>
          <button onClick={handleImportFolder} disabled={loading} style={styles.button}>
            Import Videos
          </button>
          <button onClick={handleImportGpx} disabled={loading} style={styles.button}>
            Import GPX
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.error}>
          {error}
          <button onClick={() => setError(null)} style={styles.dismissBtn}>
            Dismiss
          </button>
        </div>
      )}

      {loading && <div style={styles.loading}>Loading...</div>}

      {/* Main content area */}
      <div style={styles.main}>
        {/* Left: clip info */}
        <div style={styles.leftPane}>
          <ClipInfo clip={selectedClip} />
        </div>

        {/* Right: map */}
        <div style={styles.rightPane}>
          <MapView clips={clips} selectedClipId={selectedClipId} route={route} />
        </div>
      </div>

      {/* Bottom: timeline */}
      <Timeline clips={clips} selectedClipId={selectedClipId} onSelectClip={setSelectedClipId} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#121212',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #333',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  logo: {
    fontSize: '16px',
    fontWeight: 'bold',
    color: '#ff6b35',
  },
  toolbarActions: {
    display: 'flex',
    gap: '8px',
  },
  button: {
    padding: '6px 14px',
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  error: {
    padding: '8px 16px',
    backgroundColor: '#5c1a1a',
    color: '#ff8888',
    fontSize: '13px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    color: '#ff8888',
    cursor: 'pointer',
    textDecoration: 'underline',
    fontSize: '12px',
  },
  loading: {
    padding: '8px 16px',
    backgroundColor: '#1a3a1a',
    color: '#88ff88',
    fontSize: '13px',
    textAlign: 'center',
  },
  main: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPane: {
    width: '280px',
    minWidth: '200px',
    borderRight: '1px solid #333',
    overflow: 'auto',
  },
  rightPane: {
    flex: 1,
    overflow: 'hidden',
  },
};
