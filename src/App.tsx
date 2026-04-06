import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
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
  const [projectName, setProjectName] = useState('');
  const [projectThumbnail, setProjectThumbnail] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
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

  // Auto-default project thumbnail to first clip's thumbnail
  useEffect(() => {
    if (projectThumbnail) return;
    const firstClip = clips[0];
    if (firstClip && thumbnails[firstClip.id]) {
      setProjectThumbnail(thumbnails[firstClip.id]);
    }
  }, [clips, thumbnails, projectThumbnail]);

  // Auto-save when clips or route change
  useEffect(() => {
    if (!projectDir || clips.length === 0) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      const project: Project = {
        version: 1,
        name: projectName,
        thumbnail: projectThumbnail,
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
  }, [clips, route, projectDir, projectName, projectThumbnail]);

  async function openProjectDir(dir: string) {
    setLoading(true);
    setError(null);
    try {
      const project = await invoke<Project>('load_project', { projectDir: dir });
      setProjectDir(dir);

      const fallbackName = dir.split('/').pop()?.replace('.trailcut', '') ?? 'Untitled';
      setProjectName(project.name || fallbackName);
      setProjectThumbnail(project.thumbnail ?? null);
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
      setProjectName(selected.split('/').pop()?.replace('.trailcut', '') ?? 'Untitled');
      setProjectThumbnail(null);
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
    setProjectName('');
    setProjectThumbnail(null);
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
  const [cardMenuOpen, setCardMenuOpen] = useState<string | null>(null);
  const [renamingCard, setRenamingCard] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Close card menu on outside click
  useEffect(() => {
    if (!cardMenuOpen) return;
    const close = () => setCardMenuOpen(null);
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [cardMenuOpen]);

  async function handleRenameProject(projectPath: string, newName: string) {
    if (!newName.trim()) return;
    try {
      await invoke('rename_project', { projectDir: projectPath, newName: newName.trim() });
      const updated = await invoke<RecentProject[]>('get_recent_projects');
      setRecentProjects(updated);
    } catch (err) {
      setError(String(err));
    }
    setRenamingCard(null);
  }

  async function handleDeleteProject(projectPath: string) {
    try {
      await invoke('delete_project', { projectDir: projectPath });
      const updated = await invoke<RecentProject[]>('get_recent_projects');
      setRecentProjects(updated);
    } catch (err) {
      setError(String(err));
    }
    setDeleteConfirm(null);
  }

  if (!hasProject) {
    return (
      <div style={styles.app}>
        <style>{`
          .project-card:hover .card-menu-btn { opacity: 1 !important; }
          .project-card:hover .card-hover-overlay { background-color: rgba(0, 0, 0, 0.3) !important; }
          .project-card:hover { border-color: #3a3a3a !important; }
        `}</style>
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
                  <div key={project.path} className="project-card" style={styles.projectCard}>
                    <div
                      style={styles.cardThumbnail}
                      onClick={() => openProjectDir(project.path)}
                    >
                      {project.thumbnail ? (
                        <img
                          src={convertFileSrc(project.thumbnail)}
                          alt=""
                          style={styles.cardThumbnailImg}
                        />
                      ) : (
                        <div style={styles.cardThumbnailEmpty}>
                          <span style={styles.cardThumbnailIcon}>&#9968;</span>
                        </div>
                      )}
                      <div className="card-hover-overlay" style={styles.cardHoverOverlay} />
                      <button
                        className="card-menu-btn"
                        style={styles.cardMenuBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCardMenuOpen(cardMenuOpen === project.path ? null : project.path);
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="white">
                          <circle cx="8" cy="3" r="1.5" />
                          <circle cx="8" cy="8" r="1.5" />
                          <circle cx="8" cy="13" r="1.5" />
                        </svg>
                      </button>
                    </div>
                    <div style={styles.cardBody} onClick={() => openProjectDir(project.path)}>
                      {renamingCard === project.path ? (
                        <input
                          autoFocus
                          onFocus={(e) => e.target.select()}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => handleRenameProject(project.path, renameDraft)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameProject(project.path, renameDraft);
                            if (e.key === 'Escape') setRenamingCard(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={styles.cardNameInput}
                        />
                      ) : (
                        <div style={styles.cardName}>{project.name}</div>
                      )}
                      <div style={styles.cardMeta}>
                        <span>{project.clip_count} clip{project.clip_count !== 1 ? 's' : ''}</span>
                        {project.first_clip_date && (
                          <span>{project.first_clip_date}</span>
                        )}
                      </div>
                    </div>
                    {cardMenuOpen === project.path && (
                      <div style={styles.cardDropdown}>
                        <button
                          style={styles.dropdownItem}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCardMenuOpen(null);
                            setRenameDraft(project.name);
                            setRenamingCard(project.path);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          style={{ ...styles.dropdownItem, color: '#ff5555' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCardMenuOpen(null);
                            setDeleteConfirm(project.path);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Delete confirmation modal */}
        {deleteConfirm && (
          <div style={styles.modalOverlay} onClick={() => setDeleteConfirm(null)}>
            <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalTitle}>Delete project?</div>
              <div style={styles.modalBody}>
                This will permanently delete the project bundle and all its proxies and thumbnails. Source videos will not be affected.
              </div>
              <div style={styles.modalActions}>
                <button
                  style={styles.modalCancelBtn}
                  onClick={() => setDeleteConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  style={styles.modalDeleteBtn}
                  onClick={() => handleDeleteProject(deleteConfirm)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- PROJECT VIEW ----

  return (
    <div style={styles.app}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <button onClick={handleCloseProject} style={styles.backBtn} title="Back to home">
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
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: '12px',
  },
  projectCard: {
    position: 'relative' as const,
    padding: 0,
    backgroundColor: '#1e1e1e',
    border: '1px solid #2a2a2a',
    borderRadius: '10px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    color: '#fff',
    overflow: 'visible',
    transition: 'border-color 0.2s, transform 0.2s',
  },
  cardThumbnail: {
    position: 'relative' as const,
    width: '100%',
    aspectRatio: '16 / 9',
    overflow: 'hidden',
    backgroundColor: '#141414',
    borderRadius: '10px 10px 0 0',
  },
  cardHoverOverlay: {
    position: 'absolute' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0)',
    transition: 'background-color 0.2s',
    pointerEvents: 'none' as const,
  },
  cardThumbnailImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
    display: 'block',
  },
  cardThumbnailEmpty: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #1a2a1a 0%, #1a1a2a 100%)',
  },
  cardThumbnailIcon: {
    fontSize: '28px',
    opacity: 0.3,
  },
  cardBody: {
    padding: '10px 12px',
  },
  cardName: {
    fontSize: '14px',
    fontWeight: 600,
    marginBottom: '4px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: '#eee',
  },
  cardMeta: {
    fontSize: '11px',
    color: '#777',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardNameInput: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#eee',
    backgroundColor: '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: '4px',
    outline: 'none',
    padding: '2px 6px',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box' as const,
    marginBottom: '4px',
  },
  cardMenuBtn: {
    position: 'absolute' as const,
    top: '6px',
    right: '6px',
    background: 'none',
    border: 'none',
    fontSize: 0,
    cursor: 'pointer',
    padding: '3px 3px',
    lineHeight: 1,
    opacity: 0,
    transition: 'opacity 0.15s',
    zIndex: 2,
  },
  cardDropdown: {
    position: 'absolute' as const,
    top: '32px',
    right: '6px',
    backgroundColor: '#2a2a2a',
    border: '1px solid #444',
    borderRadius: '6px',
    overflow: 'hidden',
    zIndex: 100,
    minWidth: '120px',
  },
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: '#222',
    border: '1px solid #3a3a3a',
    borderRadius: '10px',
    padding: '20px',
    maxWidth: '320px',
    width: '100%',
  },
  modalTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#eee',
    marginBottom: '6px',
  },
  modalBody: {
    fontSize: '12px',
    color: '#888',
    lineHeight: 1.5,
    marginBottom: '16px',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  modalCancelBtn: {
    padding: '6px 14px',
    backgroundColor: 'transparent',
    color: '#888',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  modalDeleteBtn: {
    padding: '6px 14px',
    backgroundColor: '#cc3333',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
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
