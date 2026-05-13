import type {
  AspectRatio,
  CellKey,
  ExportChannel,
  ExportConfig,
  ExportGrid as ExportGridModel,
} from '../../types';
import { ExportCell } from './ExportCell';
import styles from './ExportModal.module.css';

/** Top-to-bottom row order. Matches the mockup. Mirrors
 *  `ASPECT_ORDER` in `lib/exportFilenames.ts` so the queue
 *  order reads left-to-right, top-to-bottom from this grid. */
const ASPECTS: ReadonlyArray<AspectRatio> = ['16_9', '4_5', '9_16'];
const CHANNELS: ReadonlyArray<ExportChannel> = [
  'composite',
  'map_only',
  'video_only',
];
const ASPECT_LABEL: Record<AspectRatio, string> = {
  '9_16': '9:16',
  '4_5': '4:5',
  '16_9': '16:9',
};
const CHANNEL_HEADER: Record<ExportChannel, string> = {
  composite: 'Composite',
  map_only: 'Map only',
  video_only: 'Video only',
};

export interface ExportGridProps {
  grid: ExportGridModel;
  onAdd: (aspect: AspectRatio, channel: ExportChannel) => void;
  onEditChip: (
    aspect: AspectRatio,
    channel: ExportChannel,
    config: ExportConfig,
  ) => void;
  onRemoveChip: (
    aspect: AspectRatio,
    channel: ExportChannel,
    configId: string,
  ) => void;
}

export function ExportGrid({
  grid,
  onAdd,
  onEditChip,
  onRemoveChip,
}: ExportGridProps) {
  return (
    <div
      className={`${styles.scope} ${styles.grid}`}
      role="grid"
      aria-label="Configured exports"
      data-testid="export-grid"
    >
      <div className={styles.gridHead} role="row">
        <span role="columnheader">Aspect</span>
        {CHANNELS.map((channel) => (
          <span key={channel} role="columnheader">
            {CHANNEL_HEADER[channel]}
          </span>
        ))}
      </div>
      {ASPECTS.map((aspect) => (
        <div
          key={aspect}
          className={styles.gridRow}
          role="row"
          data-testid={`export-grid-row-${aspect}`}
        >
          <div className={styles.ratioCell} role="rowheader">
            <span className={styles.ratio}>{ASPECT_LABEL[aspect]}</span>
          </div>
          {CHANNELS.map((channel) => {
            const key: CellKey = `${aspect}-${channel}`;
            const configs = grid.cells[key] ?? [];
            return (
              <ExportCell
                key={channel}
                aspect={aspect}
                channel={channel}
                configs={configs}
                onAdd={() => onAdd(aspect, channel)}
                onEditChip={(config) => onEditChip(aspect, channel, config)}
                onRemoveChip={(id) => onRemoveChip(aspect, channel, id)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
