import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { semantic } from '../../theme/tokens';
import {
  clampLayout,
  defaultLayout,
  type AspectRatio,
  type LayoutConfig,
  type PipLayout,
  type ProjectLayouts,
} from '../../lib/layout';
import { SyncToggle } from './SyncToggle';
import { TriptychTile } from './TriptychTile';
import { UnifiedRail } from './UnifiedRail';
import { useTriptychKeyboard } from './useTriptychKeyboard';

export interface MapPositioningModalProps {
  open: boolean;
  onClose: () => void;
  layouts: ProjectLayouts;
  onLayoutChange: (aspect: AspectRatio, next: LayoutConfig) => void;
}

interface AspectPaneDef {
  aspect: AspectRatio;
  label: string;
}

const ASPECT_PANES: AspectPaneDef[] = [
  { aspect: '16_9', label: '16:9' },
  { aspect: '4_5', label: '4:5' },
  { aspect: '9_16', label: '9:16' },
];

const LABEL_BY_ASPECT: Record<AspectRatio, string> = {
  '16_9': '16:9',
  '4_5': '4:5',
  '9_16': '9:16',
};

export function MapPositioningModal({
  open,
  onClose,
  layouts,
  onLayoutChange,
}: MapPositioningModalProps) {
  // Draft layer: the modal edits its own copy and only flushes to the parent
  // on Apply. Escape / Cancel drop the draft. This keeps the existing parent
  // contract (`onLayoutChange(aspect, next)`) unchanged.
  const [draftLayouts, setDraftLayouts] = useState<ProjectLayouts>(layouts);
  const [activeRatio, setActiveRatio] = useState<AspectRatio>('16_9');
  const [syncMode, setSyncMode] = useState(false);
  const [syncInset, setSyncInset] = useState(false);

  // Reset draft whenever the modal reopens — guarantees a fresh session
  // captures the parent's current state without forcing the parent to remount.
  useEffect(() => {
    if (open) {
      setDraftLayouts(layouts);
      setActiveRatio('16_9');
      setSyncMode(false);
      setSyncInset(false);
    }
    // We intentionally only depend on `open` — re-snapshotting on every
    // `layouts` change would clobber in-progress drafts while the modal is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const resolveLayout = useCallback(
    (aspect: AspectRatio): LayoutConfig => draftLayouts[aspect] ?? defaultLayout(aspect),
    [draftLayouts],
  );

  const applyDraft = useCallback(
    (aspect: AspectRatio, next: LayoutConfig) => {
      setDraftLayouts((prev) => {
        const updated: ProjectLayouts = { ...prev, [aspect]: next };
        // Sync propagation. Toggle semantics: when enabled, the change to the
        // active ratio mirrors into the other ratios *for this edit*; turning
        // sync off later doesn't un-mirror past edits.
        if (syncMode || syncInset) {
          for (const { aspect: other } of ASPECT_PANES) {
            if (other === aspect) continue;
            const otherCurrent = prev[other] ?? defaultLayout(other);
            const mirrored = mirrorEdit(otherCurrent, next, {
              syncMode,
              syncInset,
            });
            if (mirrored) {
              updated[other] = clampLayout(mirrored, other);
            }
          }
        }
        return updated;
      });
    },
    [syncInset, syncMode],
  );

  const handleApply = useCallback(() => {
    for (const { aspect } of ASPECT_PANES) {
      const next = draftLayouts[aspect];
      if (next !== null) {
        onLayoutChange(aspect, next);
      }
    }
    onClose();
  }, [draftLayouts, onClose, onLayoutChange]);

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  useTriptychKeyboard({
    open,
    setActiveRatio,
    onApply: handleApply,
    onCancel: handleCancel,
  });

  const activeLayout = resolveLayout(activeRatio);
  const activeLabel = LABEL_BY_ASPECT[activeRatio];

  const otherRatios = useMemo(
    () =>
      ASPECT_PANES
        .filter((p) => p.aspect !== activeRatio)
        .map(({ aspect, label }) => ({
          aspect,
          label,
          layout: resolveLayout(aspect),
        })),
    [activeRatio, resolveLayout],
  );

  const nonNullCount = useMemo(
    () => ASPECT_PANES.filter(({ aspect }) => draftLayouts[aspect] !== null).length,
    [draftLayouts],
  );

  if (!open) return null;

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) handleCancel();
  }

  function handleCopyFrom(sourceAspect: AspectRatio) {
    const source = resolveLayout(sourceAspect);
    applyDraft(activeRatio, clampLayout(source, activeRatio));
  }

  function handleResetActive() {
    applyDraft(activeRatio, defaultLayout(activeRatio));
  }

  function handleResetAll() {
    setDraftLayouts({
      '9_16': defaultLayout('9_16'),
      '4_5': defaultLayout('4_5'),
      '16_9': defaultLayout('16_9'),
    });
  }

  const content = (
    <div
      style={backdropStyle}
      onClick={handleBackdropClick}
      data-testid="map-positioning-modal-backdrop"
    >
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-positioning-modal-title"
        data-testid="map-positioning-modal"
      >
        <div style={headerStyle}>
          <div style={headerTitleStyle}>
            <h2 id="map-positioning-modal-title" style={titleStyle}>
              Map Positioning
            </h2>
            <span style={crumbStyle}>Triptych · ch. 04</span>
          </div>
          <div style={headerMetaStyle}>
            <SyncToggle
              label="Sync mode"
              enabled={syncMode}
              onToggle={() => setSyncMode((v) => !v)}
              testId="map-positioning-sync-mode"
            />
            <span style={headerSepStyle} aria-hidden="true">·</span>
            <SyncToggle
              label="Sync inset"
              enabled={syncInset}
              onToggle={() => setSyncInset((v) => !v)}
              testId="map-positioning-sync-inset"
            />
          </div>
          <div style={headerActionsStyle}>
            <button
              type="button"
              onClick={handleCancel}
              style={closeButtonStyle}
              aria-label="Close"
              data-testid="map-positioning-modal-close"
            >
              ×
            </button>
          </div>
        </div>

        <div style={bodyStyle} data-testid="map-positioning-modal-body">
          <div style={gridStyle}>
            {ASPECT_PANES.map(({ aspect, label }) => (
              <TriptychTile
                key={aspect}
                aspect={aspect}
                label={label}
                layout={resolveLayout(aspect)}
                isActive={aspect === activeRatio}
                onActivate={() => setActiveRatio(aspect)}
                onChange={(next) => applyDraft(aspect, next)}
              />
            ))}
          </div>
          <UnifiedRail
            activeRatio={activeRatio}
            activeLabel={activeLabel}
            activeLayout={activeLayout}
            otherRatios={otherRatios}
            onLayoutChange={(next) => applyDraft(activeRatio, next)}
            onCopyFrom={handleCopyFrom}
            onReset={handleResetActive}
          />
        </div>

        <div style={footStyle}>
          <div style={footMetaStyle}>
            <KeyHint k="1" label="16:9" />
            <KeyHint k="2" label="4:5" />
            <KeyHint k="3" label="9:16" />
            <KeyHint k="↵" label="Apply" />
            <KeyHint k="esc" label="Cancel" />
          </div>
          <div style={footActionsStyle}>
            <button
              type="button"
              onClick={handleResetAll}
              style={footGhostButtonStyle}
              data-testid="map-positioning-reset-all"
            >
              Reset all
            </button>
            <button
              type="button"
              onClick={handleCancel}
              style={footButtonStyle}
              data-testid="map-positioning-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              style={footPrimaryButtonStyle}
              data-testid="map-positioning-apply"
            >
              Apply {nonNullCount} layout{nonNullCount === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

interface KeyHintProps {
  k: string;
  label: string;
}

function KeyHint({ k, label }: KeyHintProps) {
  return (
    <span style={keyHintStyle}>
      <kbd style={kbdStyle}>{k}</kbd>
      <span>{label}</span>
    </span>
  );
}

/**
 * Compute the mirrored edit for a non-active ratio when sync toggles are on.
 *
 * - `syncMode`: when the active edit changed the mode, mirror the same mode
 *   onto the other ratio. We synthesize a fresh layout of that mode by
 *   carrying over what's structurally compatible (inset for pip-to-pip,
 *   divider for split-to-split); otherwise the other ratio's defaults are
 *   used by the caller's `clampLayout` pass.
 * - `syncInset`: only meaningful for PiP. When both source and target are
 *   PiP, copy the inset rect normalized to the output frame. Cross-mode
 *   sync (PiP → Split or vice versa) does nothing here unless `syncMode`
 *   is also on.
 *
 * Returns `null` if no mirroring should apply (sync rule doesn't match).
 */
function mirrorEdit(
  current: LayoutConfig,
  edit: LayoutConfig,
  flags: { syncMode: boolean; syncInset: boolean },
): LayoutConfig | null {
  const { syncMode, syncInset } = flags;
  // Mode-sync: when the active edit's mode differs from the other ratio's
  // current mode, switch the other to match. Preserve compatible fields.
  if (syncMode && edit.mode !== current.mode) {
    if (edit.mode === 'pip') {
      const next: PipLayout = {
        mode: 'pip',
        inset_source: edit.inset_source,
        inset: { ...edit.inset },
        corner_radius: edit.corner_radius,
      };
      return next;
    }
    // edit.mode === 'split'
    return {
      mode: 'split',
      video_side: edit.video_side,
      divider: edit.divider,
    };
  }

  // Same mode on both sides: mirror compatible fields.
  if (edit.mode === 'pip' && current.mode === 'pip') {
    if (syncInset || syncMode) {
      const next: PipLayout = {
        ...current,
        ...(syncInset ? { inset: { ...edit.inset } } : null),
        ...(syncMode ? { inset_source: edit.inset_source } : null),
      };
      return next;
    }
  }
  if (edit.mode === 'split' && current.mode === 'split' && syncMode) {
    return { ...current, video_side: edit.video_side, divider: edit.divider };
  }

  return null;
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: semantic.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  width: 'min(90vw, 1280px)',
  minWidth: 960,
  maxHeight: '90vh',
  backgroundColor: semantic.surface,
  border: `1px solid ${semantic.border}`,
  borderRadius: 6,
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
  display: 'flex',
  flexDirection: 'column',
  color: semantic.fg,
  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'center',
  gap: 16,
  padding: '14px 20px',
  borderBottom: `1px solid ${semantic.border}`,
  background: semantic.surfaceRaised,
};

const headerTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: semantic.fg,
};

const crumbStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: semantic.fgDim,
};

const headerMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  justifySelf: 'center',
};

const headerSepStyle: CSSProperties = {
  color: semantic.fgDim,
};

const headerActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const closeButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: semantic.fgMuted,
  fontSize: 22,
  lineHeight: 1,
  width: 28,
  height: 28,
  cursor: 'pointer',
  borderRadius: 4,
  fontFamily: 'inherit',
};

const bodyStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  display: 'grid',
  gridTemplateRows: '1fr auto',
  background: semantic.surface,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.2fr 1fr 0.7fr',
  gap: 1,
  background: semantic.border,
  padding: '1px 0 0',
};

const footStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 20px',
  borderTop: `1px solid ${semantic.border}`,
  background: semantic.surfaceRaised,
};

const footMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const keyHintStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: semantic.fgMuted,
};

const kbdStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 4px',
  borderRadius: 2,
  background: semantic.surfaceDeep,
  border: `1px solid ${semantic.borderStrong}`,
  color: semantic.fg,
  fontFamily: 'inherit',
  fontSize: 10.5,
};

const footActionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
};

const footButtonStyle: CSSProperties = {
  padding: '6px 14px',
  background: semantic.surfaceDeep,
  color: semantic.fg,
  border: `1px solid ${semantic.borderStrong}`,
  borderRadius: 2,
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 11,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
};

const footGhostButtonStyle: CSSProperties = {
  ...footButtonStyle,
  background: 'transparent',
  color: semantic.fgMuted,
  borderColor: semantic.border,
};

const footPrimaryButtonStyle: CSSProperties = {
  ...footButtonStyle,
  background: semantic.accent,
  color: semantic.bg,
  borderColor: semantic.accent,
  fontWeight: 700,
};

export default MapPositioningModal;
