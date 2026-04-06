import { convertFileSrc } from '@tauri-apps/api/core';
import type { RecentProject } from '../types';

interface HomeScreenProps {
  recentProjects: RecentProject[];
  error: string | null;
  cardMenuOpen: string | null;
  setCardMenuOpen: (path: string | null) => void;
  renamingCard: string | null;
  setRenamingCard: (path: string | null) => void;
  renameDraft: string;
  setRenameDraft: (name: string) => void;
  deleteConfirm: string | null;
  setDeleteConfirm: (path: string | null) => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenProjectDir: (dir: string) => void;
  onRenameProject: (path: string, name: string) => void;
  onDeleteProject: (path: string) => void;
  onDismissError: () => void;
}

export default function HomeScreen({
  recentProjects,
  error,
  cardMenuOpen,
  setCardMenuOpen,
  renamingCard,
  setRenamingCard,
  renameDraft,
  setRenameDraft,
  deleteConfirm,
  setDeleteConfirm,
  onNewProject,
  onOpenProject,
  onOpenProjectDir,
  onRenameProject,
  onDeleteProject,
  onDismissError,
}: HomeScreenProps) {
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
          <button onClick={onNewProject} style={styles.homePrimaryBtn}>
            New Project
          </button>
          <button onClick={onOpenProject} style={styles.homeSecondaryBtn}>
            Open Project
          </button>
        </div>

        {error && (
          <div style={styles.homeError}>
            {error}
            <button onClick={onDismissError} style={styles.dismissBtn}>dismiss</button>
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
                    onClick={() => onOpenProjectDir(project.path)}
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
                  <div style={styles.cardBody} onClick={() => onOpenProjectDir(project.path)}>
                    {renamingCard === project.path ? (
                      <input
                        autoFocus
                        onFocus={(e) => e.target.select()}
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => onRenameProject(project.path, renameDraft)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onRenameProject(project.path, renameDraft);
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
                onClick={() => onDeleteProject(deleteConfirm)}
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

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#121212',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
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
  dismissBtn: {
    background: 'none',
    border: 'none',
    color: '#ff8888',
    cursor: 'pointer',
    textDecoration: 'underline',
    fontSize: '12px',
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
};
