import { useEffect, useMemo, useState } from 'react';
import type {
  AspectRatio,
  ExportChannel,
  ExportConfig,
  ExportFps,
  OutputResolution,
} from '../../types';
import { chipLabel } from './ExportChip';
import styles from './ExportModal.module.css';

const QUALITY_TIERS: ReadonlyArray<OutputResolution> = [
  '720p',
  '1080p',
  '1440p',
  '2160p',
];
const FPS_TIERS: ReadonlyArray<ExportFps> = [24, 30, 60];

const ASPECT_LABEL: Record<AspectRatio, string> = {
  '9_16': '9:16',
  '4_5': '4:5',
  '16_9': '16:9',
};
const CHANNEL_LABEL: Record<ExportChannel, string> = {
  composite: 'Composite',
  map_only: 'Map only',
  video_only: 'Video only',
};

const QUALITY_LABEL: Record<OutputResolution, string> = {
  '720p': '720',
  '1080p': '1080',
  '1440p': '1440',
  '2160p': '4K',
};

export interface QualityDisabled {
  quality: OutputResolution;
  reason: string;
}
export interface FpsDisabled {
  fps: ExportFps;
  reason: string;
}
export interface CellConflict {
  quality: OutputResolution;
  fps: ExportFps;
}

export interface ConfigExportModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  aspect: AspectRatio;
  channel: ExportChannel;
  /** Initial selection. In edit mode this is the chip being edited; in add
   *  mode this is the pre-selected default (typically `{ '1080p', 30 }`). */
  initial: { quality: OutputResolution; fps: ExportFps };
  /** Permanently unavailable qualities (e.g. source < this resolution).
   *  These buttons render disabled with the given reason as a tooltip. */
  disabledQualities?: ReadonlyArray<QualityDisabled>;
  /** Permanently unavailable fps (e.g. source < this fps). */
  disabledFps?: ReadonlyArray<FpsDisabled>;
  /** (quality, fps) combos that already exist in the target cell. The save
   *  button is hard-disabled when the current selection matches one of these.
   *  Caller scopes this to add-mode only — in edit mode pass `[]` so the
   *  chip's own combo stays selectable. */
  conflictingCombos?: ReadonlyArray<CellConflict>;
  /** Optional human-readable source-resolution string (e.g. "3840×2160")
   *  shown below the quality row. */
  sourceResolution?: string;
  /** Optional human-readable source-fps string (e.g. "30 fps") shown below
   *  the fps row. */
  sourceFps?: string;
  /** Future-options pill list. Defaults match the mockup. */
  comingLater?: ReadonlyArray<string>;
  onSave: (config: { quality: OutputResolution; fps: ExportFps }) => void;
  onCancel: () => void;
}

const DEFAULT_COMING_LATER: ReadonlyArray<string> = [
  'codec',
  'color profile',
  'bitrate',
  'HDR',
  'stabilization passthrough',
];

export function ConfigExportModal({
  open,
  mode,
  aspect,
  channel,
  initial,
  disabledQualities = [],
  disabledFps = [],
  conflictingCombos = [],
  sourceResolution,
  sourceFps,
  comingLater = DEFAULT_COMING_LATER,
  onSave,
  onCancel,
}: ConfigExportModalProps) {
  const [quality, setQuality] = useState<OutputResolution>(initial.quality);
  const [fps, setFps] = useState<ExportFps>(initial.fps);

  // Reset local state to `initial` when the modal opens. Mounting under a
  // `key` prop also works, but resetting via effect keeps consumers free
  // from key-management bookkeeping.
  useEffect(() => {
    if (!open) return;
    setQuality(initial.quality);
    setFps(initial.fps);
  }, [open, initial.quality, initial.fps]);

  // Esc closes. The outer ExportModal's Esc handler is gated on
  // `configState !== null` so it doesn't fire while we're mounted —
  // both listeners attach to `window`, where `e.stopPropagation()`
  // would be a no-op between sibling listeners. The layering invariant
  // lives in one place: the outer handler's `configState` guard.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  const disabledQualityMap = useMemo(() => {
    const m = new Map<OutputResolution, string>();
    for (const d of disabledQualities) m.set(d.quality, d.reason);
    return m;
  }, [disabledQualities]);

  const disabledFpsMap = useMemo(() => {
    const m = new Map<ExportFps, string>();
    for (const d of disabledFps) m.set(d.fps, d.reason);
    return m;
  }, [disabledFps]);

  const conflictKeys = useMemo(() => {
    const s = new Set<string>();
    for (const c of conflictingCombos) s.add(`${c.quality}-${c.fps}`);
    return s;
  }, [conflictingCombos]);

  if (!open) return null;

  const isConflict = conflictKeys.has(`${quality}-${fps}`);
  const isQualityForbidden = disabledQualityMap.has(quality);
  const isFpsForbidden = disabledFpsMap.has(fps);
  const saveDisabled = isConflict || isQualityForbidden || isFpsForbidden;
  const saveLabel = mode === 'edit' ? 'Save changes' : 'Add export';

  const saveTooltip = isConflict
    ? `${chipLabel({ id: '', quality, fps })} is already in this cell — change quality or fps.`
    : isQualityForbidden
      ? (disabledQualityMap.get(quality) ?? '')
      : isFpsForbidden
        ? (disabledFpsMap.get(fps) ?? '')
        : undefined;

  const handleBackdropClick = () => onCancel();
  const handleSave = () => {
    if (saveDisabled) return;
    onSave({ quality, fps });
  };

  return (
    <div
      className={styles.configBackdrop}
      onClick={handleBackdropClick}
      data-testid="config-export-modal-backdrop"
    >
      <section
        className={`${styles.scope} ${styles.configModal}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Configure ${ASPECT_LABEL[aspect]} ${CHANNEL_LABEL[channel].toLowerCase()} export`}
        data-testid="config-export-modal"
      >
        <header className={styles.configHeader}>
          <h2 className={styles.configTitle}>
            Configure export
            <span className={styles.configCrumbSep}>/</span>
            <span className={styles.configCrumb} data-testid="config-export-modal-crumb">
              {ASPECT_LABEL[aspect]} · {CHANNEL_LABEL[channel]}
            </span>
          </h2>
          <button
            type="button"
            className={styles.configClose}
            aria-label="Close"
            onClick={onCancel}
            data-testid="config-export-modal-close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className={styles.configBody}>
          <div>
            <div className={styles.fieldLabel}>
              <span className="k">Quality</span>
              <span className="rule"></span>
            </div>
            <div className={styles.optRow} role="radiogroup" aria-label="Quality">
              {QUALITY_TIERS.map((tier) => {
                const reason = disabledQualityMap.get(tier);
                const selected = tier === quality;
                return (
                  <button
                    key={tier}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${QUALITY_LABEL[tier]} quality`}
                    title={reason}
                    disabled={reason !== undefined}
                    className={`${styles.optButton} ${selected ? styles.optButtonOn : ''}`}
                    onClick={() => setQuality(tier)}
                    data-testid={`config-quality-${tier}`}
                  >
                    {QUALITY_LABEL[tier]}
                  </button>
                );
              })}
            </div>
            {sourceResolution && (
              <div className={styles.optMeta} data-testid="config-quality-meta">
                Source <span className="src">{sourceResolution}</span>
              </div>
            )}
          </div>

          <div>
            <div className={styles.fieldLabel}>
              <span className="k">Frame rate</span>
              <span className="rule"></span>
            </div>
            <div className={styles.optRow} role="radiogroup" aria-label="Frame rate">
              {FPS_TIERS.map((tier) => {
                const reason = disabledFpsMap.get(tier);
                const selected = tier === fps;
                return (
                  <button
                    key={tier}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${tier} fps`}
                    title={reason}
                    disabled={reason !== undefined}
                    className={`${styles.optButton} ${selected ? styles.optButtonOn : ''}`}
                    onClick={() => setFps(tier)}
                    data-testid={`config-fps-${tier}`}
                  >
                    {tier}
                  </button>
                );
              })}
            </div>
            {sourceFps && (
              <div className={styles.optMeta} data-testid="config-fps-meta">
                Source <span className="src">{sourceFps}</span>
              </div>
            )}
          </div>

          {comingLater.length > 0 && (
            <div>
              <div className={styles.fieldLabel}>
                <span className="k">Coming later</span>
                <span className="rule"></span>
              </div>
              <div className={styles.future} data-testid="config-future">
                <span className="k">soon</span>
                {comingLater.map((item) => (
                  <span key={item} className="item">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className={styles.configFooter}>
          <div className={styles.configSummary}>
            <div className={styles.configSummaryL1}>
              <strong data-testid="config-export-modal-summary">
                {QUALITY_LABEL[quality]} · {fps} fps
              </strong>
            </div>
            <div className={styles.configSummaryL2}>
              {CHANNEL_LABEL[channel]} · {ASPECT_LABEL[aspect]}
            </div>
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={onCancel}
            data-testid="config-export-modal-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={saveDisabled}
            title={saveTooltip}
            onClick={handleSave}
            data-testid="config-export-modal-save"
          >
            {saveLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

/** Helper for consumers building a `ConfigExportModal` from a saved
 *  `ExportConfig`. Returns `{ quality, fps }` — the modal's `initial`
 *  shape. */
export function configToInitial(config: ExportConfig): {
  quality: OutputResolution;
  fps: ExportFps;
} {
  return { quality: config.quality, fps: config.fps };
}
