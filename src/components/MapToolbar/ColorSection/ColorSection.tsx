// ColorSection — the reusable Color block shared by all three decoration
// panels. Renders a swatch row (six named brand swatches + a custom tile),
// an inline hex input, and an optionally-expanded inline custom picker
// powered by `react-colorful`. Solid-color only at Step 6 — gradient mode is
// Step 7. Per-Waypoint override clearing is surfaced via the optional
// `overrideIndicator` pill.
//
// Storage contract: this component is purely a controlled hex string editor.
// It never writes to MapSettings, MapOverrides, or Waypoint shapes directly
// — its parent (a panel-specific section) translates `onChange(hex)` into
// the right store write per scope.

import { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { sectionStyles } from './styles';
import { SWATCHES, SWATCH_HEX_SET } from './swatches';

export interface ColorSectionProps {
  /** Current hex (lowercased, leading `#`). Component is fully controlled. */
  value: string;
  /** Called with a new hex (lowercased, leading `#`) on any user selection. */
  onChange: (hex: string) => void;
  /** When true, swatches dim to 0.42 opacity and pointer-events are
   *  disabled. Used by Route panel in clip scope (`§7` read-only). */
  disabled?: boolean;
  /** When set, renders an override pill row above the swatch row with the
   *  given text label and a small `×` clear button that calls `onClear`. */
  overrideIndicator?: { label: string; onClear: () => void };
}

/** Normalize any incoming hex value to a lowercase `#rrggbb`. Returns `null`
 *  if the input can't be parsed as a 3- or 6-char hex. */
function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed.split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed}`.toLowerCase();
  }
  return null;
}

export function ColorSection({
  value,
  onChange,
  disabled,
  overrideIndicator,
}: ColorSectionProps) {
  const normalizedValue = (value ?? '').toLowerCase();
  const isNamed = SWATCH_HEX_SET.has(normalizedValue);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState<string>(stripHash(normalizedValue));
  const [flashError, setFlashError] = useState(false);
  const flashTimer = useRef<number | null>(null);

  // Sync draft when the controlled value changes from outside.
  useEffect(() => {
    setHexDraft(stripHash(normalizedValue));
  }, [normalizedValue]);

  // Cleanup the red-flash timer on unmount.
  useEffect(() => {
    return () => {
      if (flashTimer.current != null) {
        window.clearTimeout(flashTimer.current);
      }
    };
  }, []);

  const triggerFlash = () => {
    setFlashError(true);
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashError(false), 400);
  };

  const commitHexDraft = () => {
    const parsed = normalizeHex(hexDraft);
    if (parsed == null) {
      triggerFlash();
      setHexDraft(stripHash(normalizedValue));
      return;
    }
    onChange(parsed);
    setHexDraft(stripHash(parsed));
  };

  const onHexInputChange = (raw: string) => {
    // Allow free typing; only validate on blur / Enter / 6-char immediate.
    setHexDraft(raw);
    const trimmed = raw.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
      const parsed = normalizeHex(trimmed);
      if (parsed) onChange(parsed);
    }
  };

  const onHexKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  const onSwatchClick = (hex: string) => {
    if (disabled) return;
    setPickerOpen(false);
    onChange(hex.toLowerCase());
  };

  const onCustomTileClick = () => {
    if (disabled) return;
    setPickerOpen((p) => !p);
  };

  return (
    <div style={sectionStyles.container} data-testid="color-section">
      {overrideIndicator && (
        <div style={sectionStyles.overridePillRow}>
          <span style={sectionStyles.overridePill}>
            <span style={sectionStyles.overridePillDot} />
            {overrideIndicator.label}
          </span>
          <button
            type="button"
            onClick={overrideIndicator.onClear}
            style={sectionStyles.clearButton}
            title="Reset to project"
          >
            × Reset to project
          </button>
        </div>
      )}

      <div
        style={{
          ...sectionStyles.swatchRow,
          ...(disabled ? sectionStyles.swatchRowDisabled : null),
        }}
      >
        {SWATCHES.map((sw) => {
          const isSelected = !disabled && normalizedValue === sw.hex.toLowerCase();
          return (
            <button
              key={sw.hex}
              type="button"
              onClick={() => onSwatchClick(sw.hex)}
              disabled={disabled}
              title={`${sw.name} — ${sw.hex.toUpperCase()}`}
              data-testid={`swatch-${sw.name.toLowerCase()}`}
              style={{
                ...sectionStyles.swatchTile,
                backgroundColor: sw.hex,
                ...(isSelected ? sectionStyles.swatchTileSelected : null),
                ...(disabled ? sectionStyles.swatchTileDisabled : null),
              }}
            />
          );
        })}
        <button
          type="button"
          onClick={onCustomTileClick}
          disabled={disabled}
          title="Custom color"
          data-testid="swatch-custom"
          style={{
            ...sectionStyles.swatchTile,
            ...sectionStyles.customTile,
            ...(!isNamed && !disabled ? sectionStyles.swatchTileSelected : null),
            ...(disabled ? sectionStyles.swatchTileDisabled : null),
          }}
        >
          {!isNamed && !disabled && (
            <span
              style={{ ...sectionStyles.customInsetDot, backgroundColor: normalizedValue }}
            />
          )}
        </button>

        <div
          style={{
            ...sectionStyles.hexInputWrapper,
            ...(flashError ? sectionStyles.hexInputWrapperError : null),
            ...(disabled ? sectionStyles.hexInputWrapperDisabled : null),
          }}
        >
          <span style={sectionStyles.hexPrefix}>#</span>
          <input
            type="text"
            value={hexDraft.toUpperCase()}
            onChange={(e) => onHexInputChange(e.target.value)}
            onBlur={commitHexDraft}
            onKeyDown={onHexKeyDown}
            disabled={disabled}
            maxLength={7}
            spellCheck={false}
            data-testid="color-section-hex-input"
            style={sectionStyles.hexInput}
          />
        </div>
      </div>

      {pickerOpen && !disabled && (
        <div style={sectionStyles.pickerWrapper} data-testid="color-section-picker">
          <HexColorPicker
            color={normalizedValue}
            onChange={(hex) => onChange(hex.toLowerCase())}
          />
        </div>
      )}
    </div>
  );
}

function stripHash(s: string): string {
  return s.replace(/^#/, '');
}
