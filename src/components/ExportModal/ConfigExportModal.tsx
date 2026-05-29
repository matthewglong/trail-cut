import { useEffect, useMemo, useState } from 'react';
import {
  DELIVERY_TARGETS,
  defaultDeliveryTargetForChannel,
  type AspectRatio,
  type DeliveryTarget,
  type ExportChannel,
  type ExportConfig,
  type ExportFps,
  type OutputResolution,
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
/** A conflict is a (quality, fps, delivery_target) tuple already present in
 *  the target cell. The WS5 picker added `delivery_target` as a third axis —
 *  two chips that share (quality, fps) but differ on target are legal (one
 *  exports as TikTok, the other as ProRes master). */
export interface CellConflict {
  quality: OutputResolution;
  fps: ExportFps;
  delivery_target: DeliveryTarget;
}

/** Tooltip text for the HDR delivery target's info affordance — per WS5
 *  acceptance criterion "HDR target shows the educational tooltip". The
 *  preview is always SDR because WKWebView can't reliably display HDR; the
 *  exported file will look brighter on HLG-capable displays. */
const HDR_TOOLTIP =
  'HDR exports are tagged for HLG playback on YouTube. The preview in TrailCut shows the SDR equivalent — your HDR file will look brighter and more vivid on compatible displays.';

export interface ConfigExportModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  aspect: AspectRatio;
  channel: ExportChannel;
  /** Initial selection. In edit mode this is the chip being edited; in add
   *  mode this is the pre-selected default. WS5 added `delivery_target` to
   *  the tuple; callers may omit it and the modal resolves the channel
   *  default (`composite` → `sdr_h265`, others → `prores`). */
  initial: {
    quality: OutputResolution;
    fps: ExportFps;
    delivery_target?: DeliveryTarget;
  };
  /** Permanently unavailable qualities (e.g. source < this resolution).
   *  These buttons render disabled with the given reason as a tooltip. */
  disabledQualities?: ReadonlyArray<QualityDisabled>;
  /** Permanently unavailable fps (e.g. source < this fps). */
  disabledFps?: ReadonlyArray<FpsDisabled>;
  /** (quality, fps, delivery_target) combos that already exist in the
   *  target cell. The save button is hard-disabled when the current
   *  selection matches one of these. Caller scopes this to add-mode only —
   *  in edit mode pass `[]` so the chip's own combo stays selectable. */
  conflictingCombos?: ReadonlyArray<CellConflict>;
  /** Optional human-readable source-resolution string (e.g. "3840×2160")
   *  shown below the quality row. */
  sourceResolution?: string;
  /** Optional human-readable source-fps string (e.g. "30 fps") shown below
   *  the fps row. */
  sourceFps?: string;
  /** Future-options pill list. Defaults match the mockup. */
  comingLater?: ReadonlyArray<string>;
  onSave: (config: {
    quality: OutputResolution;
    fps: ExportFps;
    delivery_target: DeliveryTarget;
  }) => void;
  onCancel: () => void;
}

/** Future-options pill list shown beneath the active fields. WS5 dropped
 *  `codec` (now driven by the delivery target) and `HDR` (now a first-class
 *  selectable target). */
const DEFAULT_COMING_LATER: ReadonlyArray<string> = [
  'color profile',
  'bitrate',
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
  // Default target depends on channel: composite seeds `sdr_h265` (modern
  // efficiency default; the most-common pick), map_only and video_only
  // seed `prores` (the only legal target). The picker restricts options
  // to `allowedChannels` from `DELIVERY_TARGETS` so a non-composite
  // channel only ever sees the locked ProRes option.
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryTarget>(
    initial.delivery_target ?? defaultDeliveryTargetForChannel(channel),
  );

  // Reset local state to `initial` when the modal opens. Mounting under a
  // `key` prop also works, but resetting via effect keeps consumers free
  // from key-management bookkeeping.
  useEffect(() => {
    if (!open) return;
    setQuality(initial.quality);
    setFps(initial.fps);
    setDeliveryTarget(
      initial.delivery_target ?? defaultDeliveryTargetForChannel(channel),
    );
  }, [open, initial.quality, initial.fps, initial.delivery_target, channel]);

  // Filter the catalog to the targets legal for this cell's channel.
  // map_only / video_only collapse to a single locked ProRes entry; composite
  // sees all five.
  const availableTargets = useMemo(
    () => DELIVERY_TARGETS.filter((t) => t.allowedChannels.includes(channel)),
    [channel],
  );

  // Effective target used for save / conflict checks. If the seeded
  // `deliveryTarget` somehow falls outside the channel's allowed list
  // (e.g. an `sdr_h265` chip got reopened in a map_only cell after a
  // regression), fall back to the channel default at render
  // time. Done synchronously (rather than via setState in an effect) so the
  // payload stays self-consistent without an extra render cycle.
  const effectiveTarget: DeliveryTarget = availableTargets.some(
    (t) => t.id === deliveryTarget,
  )
    ? deliveryTarget
    : defaultDeliveryTargetForChannel(channel);

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
    for (const c of conflictingCombos) {
      s.add(`${c.quality}-${c.fps}-${c.delivery_target}`);
    }
    return s;
  }, [conflictingCombos]);

  if (!open) return null;

  const isConflict = conflictKeys.has(`${quality}-${fps}-${effectiveTarget}`);
  const isQualityForbidden = disabledQualityMap.has(quality);
  const isFpsForbidden = disabledFpsMap.has(fps);
  const saveDisabled = isConflict || isQualityForbidden || isFpsForbidden;
  const saveLabel = mode === 'edit' ? 'Save changes' : 'Add export';

  const saveTooltip = isConflict
    ? `${chipLabel({ id: '', quality, fps, delivery_target: effectiveTarget }, channel)} is already in this cell — change quality, fps, or delivery target.`
    : isQualityForbidden
      ? (disabledQualityMap.get(quality) ?? '')
      : isFpsForbidden
        ? (disabledFpsMap.get(fps) ?? '')
        : undefined;

  const handleBackdropClick = () => onCancel();
  const handleSave = () => {
    if (saveDisabled) return;
    onSave({ quality, fps, delivery_target: effectiveTarget });
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

          <div>
            <div className={styles.fieldLabel}>
              <span className="k">Delivery target</span>
              <span className="rule"></span>
            </div>
            <div
              className={styles.optRow}
              role="radiogroup"
              aria-label="Delivery target"
              data-testid="config-delivery-target-row"
            >
              {availableTargets.map((target) => {
                const selected = target.id === effectiveTarget;
                const locked = availableTargets.length === 1;
                const isHdr = target.id === 'hdr_hlg';
                // HDR row gets the educational tooltip per WS5; the lone-
                // option (ProRes-only) case advertises the lock via tooltip
                // so a confused user understands why nothing else is
                // selectable for this channel.
                const tooltip = isHdr
                  ? HDR_TOOLTIP
                  : locked
                    ? 'Only ProRes master is supported for this channel.'
                    : target.label;
                return (
                  <button
                    key={target.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={target.label}
                    title={tooltip}
                    disabled={locked && !selected}
                    className={`${styles.optButton} ${selected ? styles.optButtonOn : ''}`}
                    onClick={() => setDeliveryTarget(target.id)}
                    data-testid={`config-delivery-target-${target.id}`}
                  >
                    {target.shortLabel}
                    {isHdr && (
                      <span
                        aria-hidden
                        style={{
                          marginLeft: '4px',
                          opacity: 0.7,
                          fontSize: '9.5px',
                        }}
                      >
                        ⓘ
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {availableTargets.length === 1 && (
              <div className={styles.optMeta} data-testid="config-delivery-target-meta">
                <span className="src">{CHANNEL_LABEL[channel]}</span> outputs only
                ProRes master — composite for the full target set.
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
              {CHANNEL_LABEL[channel]} · {ASPECT_LABEL[aspect]} ·{' '}
              <span data-testid="config-export-modal-target-summary">
                {DELIVERY_TARGETS.find((t) => t.id === effectiveTarget)?.shortLabel ?? effectiveTarget}
              </span>
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
 *  `ExportConfig`. Returns `{ quality, fps, delivery_target }` — the modal's
 *  `initial` shape. `delivery_target` round-trips an explicit per-chip
 *  selection; when the chip predates WS5, the field is `undefined` and the
 *  modal resolves the channel default. */
export function configToInitial(config: ExportConfig): {
  quality: OutputResolution;
  fps: ExportFps;
  delivery_target?: DeliveryTarget;
} {
  return {
    quality: config.quality,
    fps: config.fps,
    delivery_target: config.delivery_target,
  };
}
