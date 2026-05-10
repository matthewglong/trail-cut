import type { ExportChannel } from '../../types';

const CHANNELS: ReadonlyArray<{ value: ExportChannel; label: string }> = [
  { value: 'composite', label: 'Composite (A)' },
  { value: 'map_only', label: 'Map only (B)' },
  { value: 'video_only', label: 'Video only (C)' },
];

export interface ChannelTogglesProps {
  value: ExportChannel[];
  onChange: (next: ExportChannel[]) => void;
}

export function ChannelToggles({ value, onChange }: ChannelTogglesProps) {
  const toggle = (c: ExportChannel) => {
    if (value.includes(c)) {
      onChange(value.filter((v) => v !== c));
    } else {
      onChange([...value, c]);
    }
  };

  return (
    <div style={styles.row} role="group" aria-label="Channels">
      {CHANNELS.map(({ value: c, label }) => {
        const checked = value.includes(c);
        return (
          <label key={c} style={styles.option}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(c)}
              data-testid={`export-channel-${c}`}
            />
            <span>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    gap: '14px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  option: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#ddd',
    userSelect: 'none',
  },
};
