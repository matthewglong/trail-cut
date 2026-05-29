import type { KeyboardEvent, MouseEvent } from 'react';
import {
  resolveDeliveryTarget,
  type ExportChannel,
  type ExportConfig,
} from '../../types';
import styles from './ExportModal.module.css';

export interface ExportChipProps {
  config: ExportConfig;
  /** Cell channel — required so the chip can resolve its effective delivery
   *  target (`config.delivery_target ?? channelDefault`) and always show the
   *  target token, even when the chip stored `undefined` because the user
   *  picked the channel default (see `ExportModal.handleConfigSave`'s
   *  "keep project.json quiet" rule). Two chips in the same slot — e.g.
   *  TikTok-default vs YouTube HDR — render as distinct tokens this way. */
  channel: ExportChannel;
  /** Human-readable description used for aria-label, e.g.
   *  "Edit 16:9 composite export — 1080 at 30 fps". */
  ariaLabel: string;
  onEdit: () => void;
  onRemove: () => void;
}

export function ExportChip({
  config,
  channel,
  ariaLabel,
  onEdit,
  onRemove,
}: ExportChipProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onEdit();
    }
  };

  const handleRemoveClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onRemove();
  };

  const label = chipLabel(config, channel);
  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.chip}
      aria-label={ariaLabel}
      onClick={onEdit}
      onKeyDown={handleKeyDown}
      data-testid={`export-chip-${config.id}`}
    >
      <span data-testid={`export-chip-${config.id}-label`}>{label}</span>
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={`Remove ${label} export`}
        onClick={handleRemoveClick}
        data-testid={`export-chip-${config.id}-remove`}
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}

/** Visible chip text — `{quality_label}·{fps}·{target_token}`. The target is
 *  always shown so a default-target chip (e.g. composite + TikTok, where
 *  `handleConfigSave` deliberately drops `delivery_target` from the stored
 *  config to keep `project.json` quiet) is still distinguishable from a chip
 *  with a different target in the same slot. The effective target is resolved
 *  per WS5 via `resolveDeliveryTarget(config, channel)` — `channel` is always
 *  known at render time because the chip is rendered inside a cell. Tokens
 *  render as compact uppercase forms (`H265`, `H264`, `HDR`, `PRORES`)
 *  so the chip stays scannable.
 *
 *  WS5 brief acceptance criterion "Multi-select works: picking TikTok +
 *  YouTube HDR produces two output files" requires that two side-by-side
 *  chips be identifiably different in the grid; before this change the
 *  default-target chip rendered as `1080·30` with no token. */
export function chipLabel(config: ExportConfig, channel: ExportChannel): string {
  const target = resolveDeliveryTarget(config, channel);
  return `${qualityLabel(config.quality)}·${config.fps}·${targetToken(target)}`;
}

function targetToken(target: NonNullable<ExportConfig['delivery_target']>): string {
  switch (target) {
    case 'sdr_h265':
      return 'H265';
    case 'sdr_h264':
      return 'H264';
    case 'hdr_hlg':
      return 'HDR';
    case 'prores':
      return 'PRORES';
  }
}

function qualityLabel(quality: ExportConfig['quality']): string {
  switch (quality) {
    case '720p':
      return '720';
    case '1080p':
      return '1080';
    case '1440p':
      return '1440';
    case '2160p':
      return '4K';
  }
}
