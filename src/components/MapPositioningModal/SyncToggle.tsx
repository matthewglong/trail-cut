import type { CSSProperties } from 'react';
import { semantic } from '../../theme/tokens';

export interface SyncToggleProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  testId?: string;
}

export function SyncToggle({ label, enabled, onToggle, testId }: SyncToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      data-testid={testId}
      style={{
        ...wrapperStyle,
        color: enabled ? semantic.fg : semantic.fgMuted,
      }}
    >
      <span style={labelStyle}>{label}</span>
      <span
        aria-hidden="true"
        style={{
          ...pillStyle,
          backgroundColor: enabled ? semantic.accent : 'transparent',
          borderColor: enabled ? semantic.accent : semantic.borderStrong,
        }}
      >
        <span
          style={{
            ...pillKnobStyle,
            backgroundColor: enabled ? semantic.bg : semantic.fgDim,
            transform: enabled ? 'translateX(10px)' : 'translateX(0)',
          }}
        />
      </span>
    </button>
  );
}

const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
};

const labelStyle: CSSProperties = {
  whiteSpace: 'nowrap',
};

const pillStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  width: 24,
  height: 14,
  borderRadius: 999,
  border: '1px solid',
  transition: 'background-color 140ms ease-out, border-color 140ms ease-out',
};

const pillKnobStyle: CSSProperties = {
  position: 'absolute',
  top: 2,
  left: 2,
  width: 8,
  height: 8,
  borderRadius: '50%',
  transition: 'transform 140ms ease-out, background-color 140ms ease-out',
};

export default SyncToggle;
