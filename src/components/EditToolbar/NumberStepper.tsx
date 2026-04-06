import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface NumberStepperProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

/** Compact value with persistent (but subtle) stepper arrows to the left. */
export default function NumberStepper({
  value,
  min,
  max,
  step,
  onChange,
}: NumberStepperProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hover, setHover] = useState(false);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)) * 100) / 100;

  function commitEdit() {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed)) onChange(clamp(parsed));
    setEditing(false);
  }

  const atMax = value >= max;
  const atMin = value <= min;
  const upColor = atMax ? '#333' : hover ? '#aaa' : '#555';
  const dnColor = atMin ? '#333' : hover ? '#aaa' : '#555';

  return (
    <div
      style={stepperStyles.container}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={stepperStyles.arrows}>
        <button
          style={{ ...stepperStyles.arrowBtn, color: upColor }}
          onClick={() => onChange(clamp(value + step))}
          disabled={atMax}
          tabIndex={-1}
        >
          <ChevronUp size={10} strokeWidth={3} />
        </button>
        <button
          style={{ ...stepperStyles.arrowBtn, color: dnColor }}
          onClick={() => onChange(clamp(value - step))}
          disabled={atMin}
          tabIndex={-1}
        >
          <ChevronDown size={10} strokeWidth={3} />
        </button>
      </div>
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
          {value.toFixed(2)}<span style={stepperStyles.unit}>x</span>
        </span>
      )}
    </div>
  );
}

const stepperStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '22px',
  },
  value: {
    display: 'inline-block',
    fontSize: '12px',
    fontWeight: 500,
    color: '#bbb',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'text',
    userSelect: 'none',
  },
  unit: {
    fontSize: '10px',
    color: '#777',
    marginLeft: '1px',
  },
  input: {
    width: '38px',
    fontSize: '12px',
    fontWeight: 500,
    color: '#fff',
    fontVariantNumeric: 'tabular-nums',
    backgroundColor: '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: '3px',
    outline: 'none',
    padding: '1px 3px',
  },
  arrows: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'opacity 120ms ease',
  },
  arrowBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '12px',
    height: '9px',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    transition: 'color 120ms ease',
  },
};
