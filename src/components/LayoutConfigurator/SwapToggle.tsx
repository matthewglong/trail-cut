import type { CSSProperties } from 'react';

interface SwapToggleProps {
  label: string;
  onSwap: () => void;
  disabled?: boolean;
}

export function SwapToggle({ label, onSwap, disabled }: SwapToggleProps) {
  return (
    <button
      type="button"
      onClick={onSwap}
      disabled={disabled}
      style={buttonStyle}
      data-testid="layout-configurator-swap"
      title={label}
    >
      {label}
    </button>
  );
}

const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  backgroundColor: 'rgba(20, 20, 20, 0.78)',
  color: '#ccc',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
  whiteSpace: 'nowrap' as const,
  userSelect: 'none' as const,
};
