import type { AspectRatio } from '../../types';

const ASPECTS: ReadonlyArray<{ value: AspectRatio; label: string }> = [
  { value: '9_16', label: '9:16' },
  { value: '4_5', label: '4:5' },
  { value: '16_9', label: '16:9' },
];

export interface AspectCheckboxesProps {
  value: AspectRatio[];
  onChange: (next: AspectRatio[]) => void;
}

export function AspectCheckboxes({ value, onChange }: AspectCheckboxesProps) {
  const toggle = (a: AspectRatio) => {
    if (value.includes(a)) {
      onChange(value.filter((v) => v !== a));
    } else {
      onChange([...value, a]);
    }
  };

  return (
    <div style={styles.row} role="group" aria-label="Aspect ratios">
      {ASPECTS.map(({ value: a, label }) => {
        const checked = value.includes(a);
        return (
          <label key={a} style={styles.option}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(a)}
              data-testid={`export-aspect-${a}`}
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
