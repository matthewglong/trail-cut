import type { CSSProperties } from 'react';

interface ModeToggleProps {
  mode: 'pip' | 'split';
  onModeChange: (next: 'pip' | 'split') => void;
  disabled?: boolean;
}

export function ModeToggle({ mode, onModeChange, disabled }: ModeToggleProps) {
  return (
    <div style={wrapperStyle} data-testid="layout-configurator-mode">
      <button
        type="button"
        onClick={() => onModeChange('pip')}
        disabled={disabled}
        style={{ ...buttonStyle, ...(mode === 'pip' ? activeStyle : null) }}
        data-testid="layout-configurator-mode-pip"
      >
        PiP
      </button>
      <button
        type="button"
        onClick={() => onModeChange('split')}
        disabled={disabled}
        style={{ ...buttonStyle, ...(mode === 'split' ? activeStyle : null) }}
        data-testid="layout-configurator-mode-split"
      >
        Split
      </button>
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  overflow: 'hidden',
};

const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  backgroundColor: 'rgba(20, 20, 20, 0.78)',
  color: '#ccc',
  border: 'none',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
  whiteSpace: 'nowrap' as const,
  userSelect: 'none' as const,
};

const activeStyle: CSSProperties = {
  backgroundColor: 'rgba(82, 214, 255, 0.18)',
  color: '#52d6ff',
};
