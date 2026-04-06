import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import Timeline from './components/Timeline';
import MapView from './components/MapView';
import EditToolbar from './components/EditToolbar';
import VideoPreview from './components/VideoPreview';
import type { ClipMetadata, Clip, Project, Route, RecentProject, TrimRange, FocalPoint, Effects } from './types';

type ProxyMap = Record<string, string | 'generating' | null>;
type ThumbnailMap = Record<string, string>;

/** Convert freshly-imported metadata into a Clip with default editing fields. */
function newClipFromMetadata(meta: ClipMetadata): Clip {
  return {
    ...meta,
    trim: meta.duration_ms ? { in_ms: 0, out_ms: meta.duration_ms } : null,
    focal_point: { x: 0.5, y: 0.5, zoom: 1.0 },
    effects: {
      stabilize: { enabled: false, shakiness: 5 },
      color_lut: null,
      speed: 1.0,
    },
    visible: true,
  };
}

function mergeClips(existing: Clip[], incoming: ClipMetadata[]): Clip[] {
  const incomingByPath = new Map(incoming.map((c) => [c.path, c]));
  // Update existing clips with fresh metadata, preserve editing state
  const updated = existing.map((c) => {
    const fresh = incomingByPath.get(c.path);
    if (fresh) {
      incomingByPath.delete(c.path);
      return { ...c, ...fresh, id: c.id };
    }
    return c;
  });
  // Add genuinely new clips with default editing fields
  const newClips = [...incomingByPath.values()].map(newClipFromMetadata);
  const merged = [...updated, ...newClips];
  merged.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return merged;
}

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proxies, setProxies] = useState<ProxyMap>({});
  const [thumbnails, setThumbnails] = useState<ThumbnailMap>({});
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showGpxMenu, setShowGpxMenu] = useState(false);
  const [previewAspect, setPreviewAspect] = useState('16:9');
  const [cropPreview, setCropPreview] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedProxyPath = selectedClip
    ? (proxies[selectedClip.id] !== 'generating' ? proxies[selectedClip.id] ?? null : null)
    : null;

  const hasProject = projectDir !== null;

  // Load recent projects on mount
  useEffect(() => {
    invoke<RecentProject[]>('get_recent_projects')
      .then(setRecentProjects)
      .catch(() => {});
  }, []);

  // Close import dropdown on outside click
  useEffect(() => {
    if (!showImportMenu) return;
    const close = () => setShowImportMenu(false);
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [showImportMenu]);

  // Close GPX dropdown on outside click
  useEffect(() => {
    if (!showGpxMenu) return;
    const close = () => setShowGpxMenu(false);
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [showGpxMenu]);

  const generateProxiesAndThumbnails = useCallback(async (clipList: Clip[], dir: string) => {
    for (const clip of clipList) {
      invoke<string>('generate_thumbnail', { sourcePath: clip.path, projectDir: dir })
        .then((thumbPath) => {
          setThumbnails((prev) => ({ ...prev, [clip.id]: thumbPath }));
        })
        .catch(() => {});

      setProxies((prev) => ({ ...prev, [clip.id]: 'generating' }));
      invoke<string>('generate_proxy', { sourcePath: clip.path, projectDir: dir })
        .then((proxyPath) => {
          setProxies((prev) => ({ ...prev, [clip.id]: proxyPath }));
        })
        .catch(() => {
          setProxies((prev) => ({ ...prev, [clip.id]: null }));
        });
    }
  }, []);

  // Auto-save when clips or route change
  useEffect(() => {
    if (!projectDir || clips.length === 0) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      const project: Project = {
        version: 1,
        clips,
        route,
        exports: [],
      };
      invoke('save_project', { project, projectDir }).catch(() => {});
      invoke('register_recent_project', { projectDir }).catch(() => {});
    }, 1000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [clips, route, projectDir]);

  async function openProjectDir(dir: string) {
    setLoading(true);
    setError(null);
    try {
      const project = await invoke<Project>('load_project', { projectDir: dir });
      setProjectDir(dir);

      setClips(project.clips);
      setRoute(project.route);

      await invoke('register_recent_project', { projectDir: dir });

      if (project.clips.length > 0) {
        setSelectedClipId(project.clips[0].id);
        generateProxiesAndThumbnails(project.clips, dir);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleNewProject() {
    try {
      const selected = await save({
        filters: [{ name: 'TrailCut Project', extensions: ['trailcut'] }],
        defaultPath: 'MyHike.trailcut',
      });
      if (!selected) return;

      await invoke('create_project', { projectDir: selected });
      await invoke('register_recent_project', { projectDir: selected });
      setProjectDir(selected);
      setClips([]);
      setRoute(null);
      setProxies({});
      setThumbnails({});
      setSelectedClipId(null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleOpenProject() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      const dir = selected as string;
      if (!dir.endsWith('.trailcut')) {
        setError('Not a TrailCut project. Select a folder ending in .trailcut');
        return;
      }

      await openProjectDir(dir);
    } catch (err) {
      setError(String(err));
    }
  }

  async function importPaths(paths: string[]) {
    if (!projectDir || paths.length === 0) return;
    try {
      setLoading(true);
      setError(null);

      const result = await invoke<ClipMetadata[]>('import_media', { paths });

      setClips((prev) => {
        const merged = mergeClips(prev, result);
        const newClips = merged.filter((c) => !prev.some((existing) => existing.path === c.path));
        if (newClips.length > 0) generateProxiesAndThumbnails(newClips, projectDir);
        return merged;
      });
      setSelectedClipId((prev) => prev ?? result[0]?.id ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleImportFiles() {
    if (!projectDir) return;
    setShowImportMenu(false);
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: 'Video Files', extensions: ['mov', 'mp4', 'm4v'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths as string[]);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImportFolder() {
    if (!projectDir) return;
    setShowImportMenu(false);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      await importPaths([selected as string]);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImportGpx() {
    if (!projectDir) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'GPS Route', extensions: ['gpx'] }],
      });
      if (!selected) return;

      setLoading(true);
      setError(null);

      const result = await invoke<Route>('parse_gpx', { filePath: selected, projectDir });
      setRoute(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleRemoveClip(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setSelectedClipId((prev) => {
      if (prev !== clipId) return prev;
      const remaining = clips.filter((c) => c.id !== clipId);
      return remaining.length > 0 ? remaining[0].id : null;
    });
  }

  function updateSelectedClip(patch: Partial<Clip>) {
    if (!selectedClipId) return;
    setClips((prev) => prev.map((c) =>
      c.id === selectedClipId ? { ...c, ...patch } : c
    ));
  }

  function handleUpdateTrim(trim: TrimRange) {
    updateSelectedClip({ trim });
  }

  function handleUpdateFocalPoint(focal_point: FocalPoint) {
    updateSelectedClip({ focal_point });
  }

  function handleUpdateEffects(effects: Effects) {
    updateSelectedClip({ effects });
  }

  function handleCloseProject() {
    setProjectDir(null);
    setClips([]);
    setRoute(null);
    setProxies({});
    setThumbnails({});
    setSelectedClipId(null);
    setError(null);
    // Refresh recent projects list
    invoke<RecentProject[]>('get_recent_projects')
      .then(setRecentProjects)
      .catch(() => {});
  }

  // ---- HOME SCREEN ----
  if (!hasProject) {
    return (
      <div style={styles.app}>
        <div style={styles.home}>
          <h1 style={styles.homeTitle}>TrailCut</h1>
          <p style={styles.homeSubtitle}>Turn hiking videos into map-integrated stories</p>

          <div style={styles.homeActions}>
            <button onClick={handleNewProject} style={styles.homePrimaryBtn}>
              New Project
            </button>
            <button onClick={handleOpenProject} style={styles.homeSecondaryBtn}>
              Open Project
            </button>
          </div>

          {error && (
            <div style={styles.homeError}>
              {error}
              <button onClick={() => setError(null)} style={styles.dismissBtn}>dismiss</button>
            </div>
          )}

          {recentProjects.length > 0 && (
            <div style={styles.recentSection}>
              <h2 style={styles.recentTitle}>Projects</h2>
              <div style={styles.recentGrid}>
                {recentProjects.map((project) => (
                  <button
                    key={project.path}
                    onClick={() => openProjectDir(project.path)}
                    style={styles.projectCard}
                  >
                    <div style={styles.cardName}>{project.name.replace('.trailcut', '')}</div>
                    <div style={styles.cardMeta}>
                      {project.clip_count} clip{project.clip_count !== 1 ? 's' : ''}
                    </div>
                    <div style={styles.cardDate}>{project.last_opened}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- PROJECT VIEW ----
  const projectName = projectDir?.split('/').pop()?.replace('.trailcut', '') ?? '';

  return (
    <div style={styles.app}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <button onClick={handleCloseProject} style={styles.backBtn} title="Back to home">
            &#8592;
          </button>
          <span style={styles.logo}>TrailCut</span>
          <span style={styles.projectName}>{projectName}</span>
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
                <button onClick={handleImportFiles} style={styles.dropdownItem}>
                  Select Files
                </button>
                <button onClick={handleImportFolder} style={styles.dropdownItem}>
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
                  handleImportGpx();
                }
              }}
              title={route ? route.source_path : 'Import a GPX route file'}
            >
              <span style={route ? styles.gpxDot : styles.gpxDotEmpty} />
              <span style={styles.gpxLabel}>
                {route ? 'GPX' : 'GPX'}
              </span>
            </div>
            {showGpxMenu && route && (
              <div style={styles.dropdown}>
                <button
                  onClick={() => { setShowGpxMenu(false); handleImportGpx(); }}
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
          <button onClick={() => setError(null)} style={styles.dismissBtn}>
            Dismiss
          </button>
        </div>
      )}

      {loading && <div style={styles.loading}>Loading...</div>}

      {/* Edit toolbar */}
      <EditToolbar
        clip={selectedClip}
        onUpdateFocalPoint={handleUpdateFocalPoint}
        onUpdateEffects={handleUpdateEffects}
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
            onUpdateTrim={handleUpdateTrim}
            onUpdateFocalPoint={handleUpdateFocalPoint}
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
        onRemoveClip={handleRemoveClip}
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

  // ---- Home screen ----
  home: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '40px',
  },
  homeTitle: {
    fontSize: '36px',
    fontWeight: 'bold',
    color: '#ff6b35',
    margin: 0,
  },
  homeSubtitle: {
    fontSize: '16px',
    color: '#888',
    margin: '0 0 16px 0',
  },
  homeActions: {
    display: 'flex',
    gap: '12px',
  },
  homePrimaryBtn: {
    padding: '12px 32px',
    backgroundColor: '#ff6b35',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '15px',
    fontWeight: 'bold',
  },
  homeSecondaryBtn: {
    padding: '12px 32px',
    backgroundColor: '#2a2a2a',
    color: '#ccc',
    border: '1px solid #444',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '15px',
  },
  homeError: {
    padding: '8px 16px',
    backgroundColor: '#5c1a1a',
    color: '#ff8888',
    fontSize: '13px',
    borderRadius: '4px',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
  recentSection: {
    marginTop: '32px',
    width: '100%',
    maxWidth: '640px',
  },
  recentTitle: {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#888',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: '12px',
  },
  recentGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '8px',
  },
  projectCard: {
    padding: '16px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #333',
    borderRadius: '8px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    color: '#fff',
    transition: 'border-color 0.15s',
  },
  cardName: {
    fontSize: '15px',
    fontWeight: 'bold',
    marginBottom: '6px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  cardMeta: {
    fontSize: '12px',
    color: '#aaa',
    marginBottom: '2px',
  },
  cardDate: {
    fontSize: '11px',
    color: '#666',
  },

  // ---- Project view ----
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
    fontSize: '13px',
    color: '#888',
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
