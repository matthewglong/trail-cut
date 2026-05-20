// GridPicker — the N-column inverse-style grid picker used by the
// DecorationPanel shape gallery and any other place we need a tight
// inline radio grid (e.g. future style libraries, icon pickers).
//
// Visual language: same Inverse (Norton Commander) treatment as
// `SegmentedPicker`. The selected cell becomes a SOLID chartreuse block
// with canvas-dark text and a thin inset highlight; idle cells are
// transparent over the picker's recessed slab.
//
//   ┌────────────────────────────────────────┐
//   │ ◯ Circle  │ ◌ Ring   │ ▼ Pin           │
//   │ ▓▓▓▓▓▓▓▓▓ │ ◇ Diamond │ ⓵ Numbered    │
//   │ Square    │           │                 │
//   └────────────────────────────────────────┘
//
// Mechanics:
//   • Generic over the cell value type so consumers can model their own
//     enums (waypoint shape, style id, etc.) without duplicating the
//     gallery shell.
//   • Each cell renders its `icon` + `label`. Active cell flips colors
//     to canvas-on-chartreuse, label weight bumps to 700 (DOS bold).
//   • `disabled` dims the whole grid + blocks clicks (used when a route
//     prerequisite is missing). Per-cell disabling is supported via
//     `disabledValues`.
//   • Default 3 columns; pass `columns` for other arrangements.

import { useState, type CSSProperties, type ReactElement } from 'react';
import { semantic, fonts, radii, typeScale } from '../theme/tokens';

export interface GridPickerOption<T extends string> {
  value: T;
  label: string;
  /** Rendered above the label. `iconPixelSize` is forwarded so consumers
   *  pick the right glyph size for their grid. */
  renderIcon: (iconPixelSize: number) => ReactElement;
  /** Tooltip for the cell. Falls back to `label`. */
  title?: string;
}

interface GridPickerProps<T extends string> {
  value: T;
  options: GridPickerOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  disabledValues?: T[];
  /** Number of columns. Defaults to 3 (matches the waypoint shape gallery). */
  columns?: number;
  /** Accessible label for the radiogroup. */
  ariaLabel?: string;
  /** Override icon glyph size in pixels. Defaults to 22. */
  iconPixelSize?: number;
  /** Test-id prefix for each cell; defaults to `grid-picker-cell`. */
  testIdPrefix?: string;
}

const DEFAULT_COLUMNS = 3;
const DEFAULT_ICON_PX = 22;

/** Inverse-style grid picker. See module docstring. */
export default function GridPicker<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  disabledValues = [],
  columns = DEFAULT_COLUMNS,
  ariaLabel,
  iconPixelSize = DEFAULT_ICON_PX,
  testIdPrefix = 'grid-picker-cell',
}: GridPickerProps<T>) {
  const [hoveredValue, setHoveredValue] = useState<T | null>(null);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid="grid-picker"
      style={{
        ...containerStyle,
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        ...(disabled ? gridDisabledStyle : null),
      }}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        const isCellDisabled = disabled || disabledValues.includes(opt.value);
        const isHovered = hoveredValue === opt.value && !isCellDisabled;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={isCellDisabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (isCellDisabled || isActive) return;
              onChange(opt.value);
            }}
            onMouseEnter={() => setHoveredValue(opt.value)}
            onMouseLeave={() => setHoveredValue(null)}
            title={opt.title ?? opt.label}
            data-testid={`${testIdPrefix}-${opt.value}`}
            style={cellStyle({ isActive, isDisabled: isCellDisabled, isHovered })}
          >
            <span style={{ ...iconBoxStyle, width: iconPixelSize + 6, height: iconPixelSize + 6 }} aria-hidden="true">
              {opt.renderIcon(iconPixelSize)}
            </span>
            <span style={labelStyle(isActive)}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- styles --------------------------------------------------------

const containerStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  width: '100%',
  padding: 6,
  boxSizing: 'border-box',
  backgroundColor: 'rgba(14, 20, 22, 0.5)',
  border: `1px solid ${semantic.border}`,
  borderRadius: radii.base,
  boxShadow:
    'inset 0 1px 0 rgba(255, 255, 255, 0.03), inset 0 -1px 0 rgba(0, 0, 0, 0.28)',
};

const gridDisabledStyle: CSSProperties = {
  opacity: 0.42,
  pointerEvents: 'none',
};

function cellStyle({
  isActive,
  isDisabled,
  isHovered,
}: {
  isActive: boolean;
  isDisabled: boolean;
  isHovered: boolean;
}): CSSProperties {
  return {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 4px 6px',
    minHeight: 58,
    border: '1px solid transparent',
    borderRadius: 2,
    backgroundColor: isActive ? semantic.accent : 'transparent',
    color: isActive
      ? semantic.bg
      : isHovered
        ? semantic.fg
        : semantic.fgMuted,
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled ? 0.35 : 1,
    boxSizing: 'border-box',
    boxShadow: isActive
      ? 'inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -1px 0 rgba(0, 0, 0, 0.3)'
      : undefined,
    transition: 'color 0.18s ease, background-color 0.18s ease',
  };
}

function labelStyle(isActive: boolean): CSSProperties {
  return {
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow - 1.5, // 9px — matches gallery cells in the spec
    fontWeight: isActive ? 700 : 500,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'currentColor',
    lineHeight: 1,
  };
}

const iconBoxStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginBottom: 6,
  color: 'currentColor',
};
