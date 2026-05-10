import type { CSSProperties } from 'react';

interface CornerRadiusSliderProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}

export function CornerRadiusSlider({ value, onChange, disabled }: CornerRadiusSliderProps) {
  return (
    <label style={wrapperStyle} data-testid="layout-configurator-corner-radius">
      <span style={labelStyle}>Corner</span>
      <input
        type="range"
        min={0}
        max={0.05}
        step={0.001}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={inputStyle}
        data-testid="layout-configurator-corner-radius-input"
      />
    </label>
  );
}

const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: '#ccc',
  fontSize: 12,
};

const labelStyle: CSSProperties = {
  whiteSpace: 'nowrap',
};

const inputStyle: CSSProperties = {
  width: 100,
  accentColor: '#52d6ff',
};
