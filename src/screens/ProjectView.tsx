import { useState, useCallback } from 'react';
import Timeline from '../components/Timeline';
import MapView from '../components/MapView';
import EditToolbar from '../components/EditToolbar';
import VideoPreview from '../components/VideoPreview';
import { useDropdownClose } from '../hooks/useDropdownClose';
import type { Clip, Route, TrimRange, FocalPoint, Effects } from '../types';
import type { ProxyMap, ThumbnailMap } from '../hooks/useMediaImport';

interface ProjectViewProps {
  projectName: string;
  setProjectName: (name: string) => void;
  editingName: boolean;
  setEditingName: (editing: boolean) => void;
  clips: Clip[];
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  selectedClip: Clip | null;
  selectedClipId: string | null;
  setSelectedClipId: (id: string) => void;
  route: Route | null;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
  proxies: ProxyMap;
  thumbnails: ThumbnailMap;
  loading: boolean;
  error: string | null;
  onDismissError: () => void;
  onCloseProject: () => void;
  onRemoveClip: (clipId: string) => void;
  onUpdateTrim: (trim: TrimRange) => void;
  onUpdateFocalPoint: (fp: FocalPoint) => void;
  onUpdateEffects: (effects: Effects) => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onImportGpx: () => void;
}

export default function ProjectView({
  projectName,
  setProjectName,
  editingName,
  setEditingName,
  clips,
  setClips,
  selectedClip,
  selectedClipId,
  setSelectedClipId,
  route,
  setRoute,
  proxies,
  thumbnails,
  loading,
  error,
  onDismissError,
  onCloseProject,
  onRemoveClip,
  onUpdateTrim,
  onUpdateFocalPoint,
  onUpdateEffects,
  onImportFiles,
  onImportFolder,
  onImportGpx,
}: ProjectViewProps) {
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showGpxMenu, setShowGpxMenu] = useState(false);
  const [previewAspect, setPreviewAspect] = useState('16:9');
  const [cropPreview, setCropPreview] = useState(false);

  useDropdownClose(showImportMenu, useCallback(() => setShowImportMenu(false), []));
  useDropdownClose(showGpxMenu, useCallback(() => setShowGpxMenu(false), []));

  const selectedProxyPath = selectedClip
    ? (proxies[selectedClip.id] !== 'generating' ? proxies[selectedClip.id] ?? null : null)
    : null;

  return (
    <div style={styles.app}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <button onClick={onCloseProject} style={styles.backBtn} title="Back to home">
            &#8592;
          </button>
          <span style={styles.logo}>TrailCut</span>
          {editingName ? (
            <input
              autoFocus
              onFocus={(e) => e.target.select()}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') setEditingName(false);
              }}
              style={styles.projectNameInput}
            />
          ) : (
            <span
              style={styles.projectName}
              onClick={() => setEditingName(true)}
              title="Click to rename"
            >
              {projectName || 'Untitled'}
            </span>
          )}
        </div>
        <div style={styles.toolbarActions}>
          <div style={styles.importWrapper}>
            <button
              onClick={() => setShowImportMenu(!showImportMenu)}
              disabled={loading}
              style={styles.button}
            >
              Import Media &#9662;
            </button>
            {showImportMenu && (
              <div style={styles.dropdown}>
                <button onClick={() => { setShowImportMenu(false); onImportFiles(); }} style={styles.dropdownItem}>
                  Select Files
                </button>
                <button onClick={() => { setShowImportMenu(false); onImportFolder(); }} style={styles.dropdownItem}>
                  Select Folder
                </button>
              </div>
            )}
          </div>
          <div style={styles.gpxChipWrapper}>
            <div
              style={route ? styles.gpxChipLoaded : styles.gpxChipEmpty}
              onClick={() => {
                if (route) {
                  setShowGpxMenu(!showGpxMenu);
                } else {
                  onImportGpx();
                }
              }}
              title={route ? route.source_path : 'Import a GPX route file'}
            >
              <span style={route ? styles.gpxDot : styles.gpxDotEmpty} />
              <span style={styles.gpxLabel}>GPX</span>
            </div>
            {showGpxMenu && route && (
              <div style={styles.dropdown}>
                <button
                  onClick={() => { setShowGpxMenu(false); onImportGpx(); }}
                  style={styles.dropdownItem}
                >
                  Replace route…
                </button>
                <button
                  onClick={() => { setShowGpxMenu(false); setRoute(null); }}
                  style={styles.dropdownItem}
                >
                  Remove route
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div style={styles.error}>
          {error}
          <button onClick={onDismissError} style={styles.dismissBtn}>
            Dismiss
          </button>
        </div>
      )}

      {loading && <div style={styles.loading}>Loading...</div>}

      {/* Edit toolbar */}
      <EditToolbar
        clip={selectedClip}
        onUpdateFocalPoint={onUpdateFocalPoint}
        onUpdateEffects={onUpdateEffects}
        previewAspect={previewAspect}
        onChangeAspect={setPreviewAspect}
        cropPreview={cropPreview}
        onToggleCropPreview={() => setCropPreview(p => !p)}
      />

      {/* Main content area */}
      <div style={styles.main}>
        <div style={styles.videoPane}>
          <VideoPreview
            clip={selectedClip}
            proxyPath={selectedProxyPath}
            onUpdateTrim={onUpdateTrim}
            onUpdateFocalPoint={onUpdateFocalPoint}
            previewAspect={previewAspect}
            onChangeAspect={setPreviewAspect}
            cropPreview={cropPreview}
          />
          {selectedClip && proxies[selectedClip.id] === 'generating' && (
            <div style={styles.proxyStatus}>Generating proxy...</div>
          )}
        </div>
        <div style={styles.mapPane}>
          <MapView clips={clips} selectedClipId={selectedClipId} route={route} />
        </div>
      </div>

      <Timeline
        clips={clips}
        selectedClipId={selectedClipId}
        onSelectClip={setSelectedClipId}
        thumbnails={thumbnails}
        proxies={proxies}
        onRemoveClip={onRemoveClip}
        onToggleVisibility={(clipId) => {
          setClips(prev => prev.map(c =>
            c.id === clipId ? { ...c, visible: !c.visible } : c
          ));
        }}
      />
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
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
  },
  logo: {
    fontSize: '16px',
    fontWeight: 'bold',
    color: '#ff6b35',
  },
  projectName: {
    fontSize: '15px',
    color: '#ddd',
    fontWeight: 500,
    cursor: 'text',
    padding: '2px 6px',
    borderRadius: '4px',
    borderBottom: '1px solid transparent',
    transition: 'border-color 0.15s ease',
  },
  projectNameInput: {
    fontSize: '15px',
    color: '#ddd',
    fontWeight: 500,
    backgroundColor: '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    outline: 'none',
    padding: '2px 6px',
    fontFamily: 'inherit',
  },
  toolbarActions: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
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
  importWrapper: {
    position: 'relative' as const,
  },
  gpxChipWrapper: {
    position: 'relative' as const,
  },
  gpxChipEmpty: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 12px',
    border: '1px dashed #555',
    borderRadius: '20px',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#777',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  gpxChipLoaded: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 12px',
    border: '1px solid #4a7c59',
    borderRadius: '20px',
    backgroundColor: 'rgba(74, 124, 89, 0.15)',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#8bc49a',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  gpxDotEmpty: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    border: '1px solid #555',
    flexShrink: 0,
  },
  gpxDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: '#6abf7b',
    flexShrink: 0,
  },
  gpxLabel: {
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: '4px',
    backgroundColor: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '6px',
    overflow: 'hidden',
    zIndex: 100,
    minWidth: '140px',
  },
  dropdownItem: {
    display: 'block',
    width: '100%',
    padding: '8px 14px',
    backgroundColor: 'transparent',
    color: '#ccc',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    textAlign: 'left' as const,
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
  videoPane: {
    flex: 2,
    borderRight: '1px solid #333',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  mapPane: {
    flex: 1,
    overflow: 'hidden',
    minWidth: '300px',
  },
  proxyStatus: {
    padding: '8px 12px',
    fontSize: '12px',
    color: '#ff6b35',
    textAlign: 'center',
  },
};
