import { useState } from 'react';

interface NumberStepperProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

/** Small number stepper with +/- buttons */
export default function NumberStepper({
  value,
  min,
  max,
  step,
  onChange,
}: NumberStepperProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)) * 100) / 100;

  function commitEdit() {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed)) {
      onChange(clamp(parsed));
    }
    setEditing(false);
  }

  return (
    <div style={stepperStyles.container}>
      <button
        style={stepperStyles.btn}
        onClick={() => onChange(clamp(value - step))}
        disabled={value <= min}
      >
        -
      </button>
      {editing ? (
        <input
          autoFocus
          onFocus={(e) => e.target.select()}
          style={stepperStyles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span
          style={stepperStyles.value}
          onClick={() => { setDraft(parseFloat(value.toFixed(2)).toString()); setEditing(true); }}
        >
          {parseFloat(value.toFixed(2))}X
        </span>
      )}
      <button
        style={stepperStyles.btn}
        onClick={() => onChange(clamp(value + step))}
        disabled={value >= max}
      >
        +
      </button>
    </div>
  );
}

const stepperStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'inline-flex',
    alignItems: 'center',
    backgroundColor: '#222',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    overflow: 'hidden',
  },
  btn: {
    width: '24px',
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    color: '#999',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 'bold',
    padding: 0,
  },
  value: {
    width: '46px',
    textAlign: 'center' as const,
    fontSize: '12px',
    color: '#ddd',
    fontVariantNumeric: 'tabular-nums',
    padding: '0 4px',
    borderLeft: '1px solid #3a3a3a',
    borderRight: '1px solid #3a3a3a',
    cursor: 'text',
  },
  input: {
    width: '46px',
    textAlign: 'center' as const,
    fontSize: '12px',
    color: '#fff',
    fontVariantNumeric: 'tabular-nums',
    padding: '0 4px',
    backgroundColor: '#1a1a1a',
    border: 'none',
    borderLeft: '1px solid #3a3a3a',
    borderRight: '1px solid #3a3a3a',
    outline: 'none',
    height: '100%',
  },
};
