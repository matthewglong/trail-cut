import { useState, useCallback, useRef, useEffect } from 'react';
import Timeline from '../components/Timeline';
import MapView from '../components/MapView';
import EditToolbar from '../components/EditToolbar';
import CollapsibleToolbar from '../components/CollapsibleToolbar';
import VideoPreview from '../components/VideoPreview';
import { useDropdownClose } from '../hooks/useDropdownClose';
import type { Clip, Route, TrimRange, FocalPoint, Effects } from '../types';
import type { ProxyMap, ThumbnailMap } from '../hooks/useMediaImport';

// Resizer constraints — easy to tune
const V_SPLIT_DEFAULT = 0.65; // video takes 65% of width
const V_SPLIT_MIN = 0.30;
const V_SPLIT_MAX = 0.80;
const H_CLIPS_MIN_PX = 80;
const H_CLIPS_MAX_RATIO = 0.50; // clips can't exceed 50% of height
const H_CLIPS_DEFAULT_PX = 140;

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

  // Resizer state
  const [vSplit, setVSplit] = useState(V_SPLIT_DEFAULT); // fraction of width for video pane
  const [clipsHeight, setClipsHeight] = useState(H_CLIPS_DEFAULT_PX);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'vertical' | 'horizontal' | null>(null);

  useDropdownClose(showImportMenu, useCallback(() => setShowImportMenu(false), []));
  useDropdownClose(showGpxMenu, useCallback(() => setShowGpxMenu(false), []));

  // Keyboard shortcuts: hold Z + -/= to nudge zoom, hold S + -/= to nudge speed,
  // tap C to toggle crop preview, hold C + -/= to cycle aspect ratios
  const ASPECTS = ['16:9', '9:16', '1:1', '4:5'];
  const heldRef = useRef<{
    z: boolean; s: boolean; c: boolean;
    zConsumed: boolean; sConsumed: boolean; cConsumed: boolean;
    zLastTap: number; sLastTap: number;
  }>({
    z: false, s: false, c: false,
    zConsumed: false, sConsumed: false, cConsumed: false,
    zLastTap: 0, sLastTap: 0,
  });
  const DOUBLE_TAP_MS = 300;
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
    };
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const round = (v: number, step: number) => Math.round(v / step) * step;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') { heldRef.current.z = true; return; }
      if (key === 's') { heldRef.current.s = true; return; }
      if (key === 'c') { heldRef.current.c = true; return; }
      if (e.key !== '-' && e.key !== '=') return;
      const delta = e.key === '=' ? 1 : -1;
      if (heldRef.current.c) {
        e.preventDefault();
        heldRef.current.cConsumed = true;
        const idx = ASPECTS.indexOf(previewAspect);
        const base = idx === -1 ? 0 : idx;
        const next = (base + delta + ASPECTS.length) % ASPECTS.length;
        setPreviewAspect(ASPECTS[next]);
        return;
      }
      if (!selectedClip) return;
      if (heldRef.current.z) {
        e.preventDefault();
        heldRef.current.zConsumed = true;
        const step = 0.05;
        const next = clamp(round(selectedClip.focal_point.zoom + delta * step, step), 1.0, 5.0);
        onUpdateFocalPoint({ ...selectedClip.focal_point, zoom: next });
      } else if (heldRef.current.s) {
        e.preventDefault();
        heldRef.current.sConsumed = true;
        const step = 0.25;
        const next = clamp(round(selectedClip.effects.speed + delta * step, step), 0.25, 4.0);
        onUpdateEffects({ ...selectedClip.effects, speed: next });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const now = performance.now();
      if (key === 'z') {
        heldRef.current.z = false;
        if (!heldRef.current.zConsumed) {
          if (now - heldRef.current.zLastTap < DOUBLE_TAP_MS && selectedClip) {
            onUpdateFocalPoint({ ...selectedClip.focal_point, zoom: 1.0 });
            heldRef.current.zLastTap = 0;
          } else {
            heldRef.current.zLastTap = now;
          }
        }
        heldRef.current.zConsumed = false;
      }
      if (key === 's') {
        heldRef.current.s = false;
        if (!heldRef.current.sConsumed) {
          if (now - heldRef.current.sLastTap < DOUBLE_TAP_MS && selectedClip) {
            onUpdateEffects({ ...selectedClip.effects, speed: 1.0 });
            heldRef.current.sLastTap = 0;
          } else {
            heldRef.current.sLastTap = now;
          }
        }
        heldRef.current.sConsumed = false;
      }
      if (key === 'c') {
        heldRef.current.c = false;
        if (!heldRef.current.cConsumed) setCropPreview(p => !p);
        heldRef.current.cConsumed = false;
      }
    };
    const onBlur = () => {
      heldRef.current.z = false;
      heldRef.current.s = false;
      heldRef.current.c = false;
      heldRef.current.zConsumed = false;
      heldRef.current.sConsumed = false;
      heldRef.current.cConsumed = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [selectedClip, onUpdateFocalPoint, onUpdateEffects, previewAspect, cropPreview]);

  // Drag handlers for resizers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      e.preventDefault();
      const rect = containerRef.current.getBoundingClientRect();

      if (draggingRef.current === 'vertical') {
        const ratio = (e.clientX - rect.left) / rect.width;
        setVSplit(Math.min(V_SPLIT_MAX, Math.max(V_SPLIT_MIN, ratio)));
      } else {
        const fromBottom = rect.bottom - e.clientY;
        const maxClips = rect.height * H_CLIPS_MAX_RATIO;
        setClipsHeight(Math.min(maxClips, Math.max(H_CLIPS_MIN_PX, fromBottom)));
      }
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    const handleSelectStart = (e: Event) => {
      if (draggingRef.current) e.preventDefault();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectstart', handleSelectStart);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectstart', handleSelectStart);
    };
  }, []);

  const startDrag = useCallback((axis: 'vertical' | 'horizontal') => {
    draggingRef.current = axis;
    document.body.style.cursor = axis === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const selectedProxyPath = selectedClip
    ? (proxies[selectedClip.id] !== 'generating' ? proxies[selectedClip.id] ?? null : null)
    : null;

  return (
    <div style={styles.app}>
      {/* Global Bar */}
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

      {/* Display + Clips area (fills remaining space) */}
      <div ref={containerRef} style={styles.contentArea}>
        {/* Display: Video + Map side by side */}
        <div style={{ ...styles.displayArea, height: `calc(100% - ${clipsHeight}px - 6px)` }}>
          {/* Video pane */}
          <div style={{ ...styles.videoPane, width: `calc(${vSplit * 100}% - 3px)` }}>
            <EditToolbar
              clip={selectedClip}
              onUpdateFocalPoint={onUpdateFocalPoint}
              onUpdateEffects={onUpdateEffects}
              previewAspect={previewAspect}
              onChangeAspect={setPreviewAspect}
              cropPreview={cropPreview}
              onToggleCropPreview={() => setCropPreview(p => !p)}
            />
            <div style={styles.videoPaneContent}>
              <VideoPreview
                clip={selectedClip}
                proxyPath={selectedProxyPath}
                onUpdateTrim={onUpdateTrim}
                onUpdateFocalPoint={onUpdateFocalPoint}
                previewAspect={previewAspect}
                onChangeAspect={setPreviewAspect}
                cropPreview={cropPreview}
              />
            </div>
          </div>

          {/* Vertical divider */}
          <div
            style={styles.vDivider}
            onMouseDown={() => startDrag('vertical')}
          />

          {/* Map pane */}
          <div style={{ ...styles.mapPane, width: `calc(${(1 - vSplit) * 100}% - 3px)` }}>
            <CollapsibleToolbar>
              <button style={styles.mapPlaceholderBtn} disabled>Placeholder</button>
            </CollapsibleToolbar>
            <div style={styles.mapPaneContent}>
              <MapView clips={clips} selectedClipId={selectedClipId} route={route} />
            </div>
          </div>
        </div>

        {/* Horizontal divider */}
        <div
          style={styles.hDivider}
          onMouseDown={() => startDrag('horizontal')}
        />

        {/* Clips timeline */}
        <div style={{ ...styles.clipsArea, height: clipsHeight }}>
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
      </div>
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
  contentArea: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden',
  },
  displayArea: {
    display: 'flex',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  videoPane: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  videoPaneContent: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  mapPane: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  mapPaneContent: {
    flex: 1,
    overflow: 'hidden',
  },
  mapPlaceholderBtn: {
    padding: '4px 10px',
    backgroundColor: '#222',
    color: '#555',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    fontSize: '11px',
    cursor: 'default',
    opacity: 0.5,
  },
  vDivider: {
    width: '4px',
    cursor: 'col-resize',
    backgroundColor: '#222',
    flexShrink: 0,
  },
  hDivider: {
    height: '4px',
    cursor: 'row-resize',
    backgroundColor: '#222',
    flexShrink: 0,
  },
  clipsArea: {
    overflow: 'hidden',
  },
};
