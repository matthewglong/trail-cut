import type { KeyboardEvent, MouseEvent } from 'react';
import type { ExportConfig } from '../../types';
import styles from './ExportModal.module.css';

export interface ExportChipProps {
  config: ExportConfig;
  /** Human-readable description used for aria-label, e.g.
   *  "Edit 16:9 composite export — 1080 at 30 fps". */
  ariaLabel: string;
  onEdit: () => void;
  onRemove: () => void;
}

export function ExportChip({ config, ariaLabel, onEdit, onRemove }: ExportChipProps) {
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
      <span data-testid={`export-chip-${config.id}-label`}>
        {chipLabel(config)}
      </span>
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={`Remove ${chipLabel(config)} export`}
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

/** Visible chip text — `{quality_label}·{fps}`. Matches the mockup:
 *  `1080·30`, `4K·30`. */
export function chipLabel(config: ExportConfig): string {
  return `${qualityLabel(config.quality)}·${config.fps}`;
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
