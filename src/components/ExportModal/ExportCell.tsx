import type { AspectRatio, ExportConfig, ExportChannel } from '../../types';
import { ExportChip } from './ExportChip';
import styles from './ExportModal.module.css';

export interface ExportCellProps {
  aspect: AspectRatio;
  channel: ExportChannel;
  configs: ReadonlyArray<ExportConfig>;
  onAdd: () => void;
  onEditChip: (config: ExportConfig) => void;
  onRemoveChip: (configId: string) => void;
}

const ASPECT_DISPLAY: Record<AspectRatio, string> = {
  '9_16': '9:16',
  '4_5': '4:5',
  '16_9': '16:9',
};
const CHANNEL_DISPLAY: Record<ExportChannel, string> = {
  composite: 'composite',
  map_only: 'map only',
  video_only: 'video only',
};

export function ExportCell({
  aspect,
  channel,
  configs,
  onAdd,
  onEditChip,
  onRemoveChip,
}: ExportCellProps) {
  const cellLabel = `${ASPECT_DISPLAY[aspect]} ${CHANNEL_DISPLAY[channel]}`;
  return (
    <div
      className={styles.cell}
      aria-label={cellLabel}
      data-testid={`export-cell-${aspect}-${channel}`}
    >
      {configs.map((config) => (
        <ExportChip
          key={config.id}
          config={config}
          channel={channel}
          ariaLabel={`Edit ${cellLabel} export — ${config.quality} at ${config.fps} fps`}
          onEdit={() => onEditChip(config)}
          onRemove={() => onRemoveChip(config.id)}
        />
      ))}
      <button
        type="button"
        className={styles.add}
        aria-label={`Add ${cellLabel} export`}
        onClick={onAdd}
        data-testid={`export-cell-${aspect}-${channel}-add`}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M8 4v8M4 8h8" />
        </svg>
      </button>
    </div>
  );
}
