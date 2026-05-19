// ColorSection — the reusable Color block shared by all three decoration
// panels. Step 6 shipped the swatch row + custom picker for solid mode.
// Step 7 adds:
//
//  • [Solid][Gradient] mode toggle at the top (visibility controlled via
//    `mode` / `onModeChange` props; absent when those are omitted).
//  • Gradient editor body when `mode === 'gradient'`. The swatch row + hex
//    input still appear, but as the STOP COLOR picker below the editor —
//    editing the selected stop's color, not a project-wide solid value.
//  • [+ Stop] and [← Copy from Route] / [Copy → Waypoints] action row,
//    rendered when the editor has copy callbacks.
//
// Storage contract:
//  • `value` is the active hex (solid mode) OR the selected stop's color
//    (gradient mode). The parent feeds whichever applies.
//  • `gradientStops` is the full stop array (gradient mode). Drives the
//    bar background, stop rail, distance axis, and trail preview.
//  • `onGradientStopsChange` receives a new stop array on any edit.
//  • `color_stops_cache` lives one level up (RouteSettings/WaypointsSettings).
//    The parent toggles `mode` while patching the cache; this component
//    only sees the mode flip.
//
// Visibility rules (per `color-gradient.md` §6 and `panel-ux.md` §6c):
//  • POV → omit the mode toggle entirely (POV is solid-only).
//  • Route clip scope → read-only (parent renders RouteColorReadOnly, not
//    this component).
//  • Waypoints clip scope → omit the mode toggle (per-waypoint overrides
//    are solid-only; parent passes `mode === undefined`).
//  • No GPX → GRADIENT segment is rendered as disabled with a tooltip.

import { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import type { GradientStop } from '../../../types';
import { GradientEditor } from './GradientEditor';
import { insertStopAtLargestGap, setStopColor } from './gradientMath';
import { sectionStyles } from './styles';
import { SWATCHES, SWATCH_HEX_SET } from './swatches';

export type ColorMode = 'solid' | 'gradient';

export type GradientCopyDirection = 'toWaypoints' | 'fromRoute';

export interface ColorSectionProps {
  /** Current hex (lowercased, leading `#`). In gradient mode this is the
   *  selected stop's color when a stop is selected, or the first stop's
   *  color when none is selected. Component is fully controlled. */
  value: string;
  /** Called with a new hex on any user selection in solid mode. In gradient
   *  mode, color edits bypass this and go through `onGradientStopsChange`
   *  (the component's internal bridge writes via `setStopColor`). */
  onChange: (hex: string) => void;
  /** When true, swatches dim to 0.42 opacity and pointer-events are
   *  disabled. Used by Route panel in clip scope (`§7` read-only). */
  disabled?: boolean;
  /** When set, renders an override pill row above the swatch row with the
   *  given text label and a small `×` clear button that calls `onClear`. */
  overrideIndicator?: { label: string; onClear: () => void };

  // ---- Gradient mode props (Step 7) -----------------------------------
  /** Current color mode. When undefined, the mode toggle is not rendered —
   *  caller is committing to solid-only (POV, Waypoints clip scope). */
  mode?: ColorMode;
  /** Called when the user toggles between solid and gradient. The parent
   *  is responsible for the `color_stops_cache` stash/restore (§13). */
  onModeChange?: (next: ColorMode) => void;
  /** Whether the GRADIENT segment is enabled. Pass `false` to render the
   *  disabled state with a tooltip. */
  gradientAvailable?: boolean;
  /** Stop array in gradient mode. Endpoints (fraction 0 and 1) must exist. */
  gradientStops?: GradientStop[];
  /** Receives the next stop array on any gradient editor edit. */
  onGradientStopsChange?: (next: GradientStop[]) => void;
  /** Waypoint progress fractions for snap ticks + trail preview dots. */
  waypointProgress?: number[];
  /** Total route distance in metres for distance labels. */
  totalDistMeters?: number;
  /** Copy button — pressed to copy stops between Route and Waypoints. */
  copyDirection?: GradientCopyDirection;
  /** Pressed when the user clicks the Copy button. */
  onCopy?: () => void;
  /** Whether the Copy button is visible. Hidden when nothing useful to copy. */
  copyVisible?: boolean;
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
  mode,
  onModeChange,
  gradientAvailable = true,
  gradientStops,
  onGradientStopsChange,
  waypointProgress = [],
  totalDistMeters = 0,
  copyDirection,
  onCopy,
  copyVisible,
}: ColorSectionProps) {
  const isGradient = mode === 'gradient';
  // The stop currently being edited (gradient mode only). The parent reads
  // `value` independently of this index — when nothing is selected, the
  // parent supplies the first stop's color so the swatch row still has a
  // sensible source. The component itself owns this selection state since
  // the bridge from swatch/hex → stop color uses it.
  const [selectedStopIndex, setSelectedStopIndex] = useState<number | null>(null);
  // Copy button feedback. 500ms chartreuse + "Copied ✓" per §9.
  const [copyFlash, setCopyFlash] = useState(false);
  const copyTimer = useRef<number | null>(null);

  // In gradient mode, the displayed value is the selected stop's color
  // (when one is selected). When nothing is selected we still feed the swatch
  // row a sensible color (the first stop) so it doesn't render blank, but
  // none of the named swatches outline as "active" since the user hasn't
  // picked a stop to edit.
  const displayedHex =
    isGradient && gradientStops && selectedStopIndex != null
      ? (gradientStops[selectedStopIndex]?.color ?? value)
      : value;
  const normalizedValue = (displayedHex ?? '').toLowerCase();
  const isNamed =
    (isGradient ? selectedStopIndex != null : true) &&
    SWATCH_HEX_SET.has(normalizedValue);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState<string>(stripHash(normalizedValue));
  const [flashError, setFlashError] = useState(false);
  const flashTimer = useRef<number | null>(null);

  // Sync draft when the controlled value changes from outside or when the
  // selection changes (we re-read the stop's color into the draft).
  useEffect(() => {
    setHexDraft(stripHash(normalizedValue));
  }, [normalizedValue]);

  // Reset the in-component selection when toggling away from gradient.
  useEffect(() => {
    if (!isGradient) setSelectedStopIndex(null);
  }, [isGradient]);

  // Cleanup the red-flash and copy-flash timers on unmount.
  useEffect(() => {
    return () => {
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const triggerFlash = () => {
    setFlashError(true);
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashError(false), 400);
  };

  // Bridge: in gradient mode with a selected stop, route color changes
  // through the stop array; otherwise straight to the project-level
  // `onChange`. This is the single source of truth for "where does a color
  // edit go" — swatch click, hex input, and custom picker all funnel here.
  const applyColor = (hex: string) => {
    if (isGradient && gradientStops && onGradientStopsChange && selectedStopIndex != null) {
      onGradientStopsChange(setStopColor(gradientStops, selectedStopIndex, hex));
      return;
    }
    onChange(hex);
  };

  const commitHexDraft = () => {
    const parsed = normalizeHex(hexDraft);
    if (parsed == null) {
      triggerFlash();
      setHexDraft(stripHash(normalizedValue));
      return;
    }
    applyColor(parsed);
    setHexDraft(stripHash(parsed));
  };

  const onHexInputChange = (raw: string) => {
    setHexDraft(raw);
    const trimmed = raw.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
      const parsed = normalizeHex(trimmed);
      if (parsed) applyColor(parsed);
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
    applyColor(hex.toLowerCase());
  };

  const onCustomTileClick = () => {
    if (disabled) return;
    setPickerOpen((p) => !p);
  };

  const onCopyClick = () => {
    if (!onCopy || disabled) return;
    onCopy();
    setCopyFlash(true);
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyFlash(false), 500);
  };

  // ---- Mode toggle ----------------------------------------------------
  const renderModeToggle = () => {
    if (mode === undefined || onModeChange == null) return null;
    const gradientDisabled = !gradientAvailable;
    return (
      <div style={sectionStyles.modeToggleRow} data-testid="color-mode-toggle">
        <button
          type="button"
          onClick={() => onModeChange('solid')}
          disabled={disabled}
          data-testid="color-mode-solid"
          style={{
            ...sectionStyles.modeToggleSegment,
            ...sectionStyles.modeToggleSegmentLeft,
            ...(mode === 'solid' ? sectionStyles.modeToggleSegmentActive : null),
          }}
        >
          Solid
        </button>
        <button
          type="button"
          onClick={() => !gradientDisabled && onModeChange('gradient')}
          disabled={disabled || gradientDisabled}
          title={gradientDisabled ? 'Import a GPX route to enable gradients' : undefined}
          data-testid="color-mode-gradient"
          style={{
            ...sectionStyles.modeToggleSegment,
            ...sectionStyles.modeToggleSegmentRight,
            ...(mode === 'gradient' ? sectionStyles.modeToggleSegmentActive : null),
            ...(gradientDisabled ? sectionStyles.modeToggleSegmentDisabled : null),
          }}
        >
          Gradient
        </button>
      </div>
    );
  };

  // ---- Copy button (renderable in both solid and gradient modes) ------
  // Per `color-gradient.md` §9, "← Copy from Route" must be reachable while
  // Waypoints is in solid mode — pressing it is exactly the affordance
  // that flips Waypoints to gradient and preserves the prior solid in
  // `color_stops_cache`. The button visibility is gated only by
  // `copyVisible` (set by the parent based on the SOURCE decoration's
  // gradient state — Route's mode, for the Waypoints panel).
  const renderCopyButton = () => {
    if (!copyVisible || !onCopy) return null;
    return (
      <button
        type="button"
        onClick={onCopyClick}
        disabled={disabled}
        data-testid={
          copyDirection === 'toWaypoints'
            ? 'gradient-copy-to-waypoints'
            : 'gradient-copy-from-route'
        }
        style={{
          ...sectionStyles.ghostButton,
          ...(copyFlash ? sectionStyles.ghostButtonCopied : null),
        }}
      >
        {copyFlash
          ? 'Copied ✓'
          : copyDirection === 'toWaypoints'
            ? 'Copy → Waypoints'
            : '← Copy from Route'}
      </button>
    );
  };

  // ---- Action row (gradient mode) — `+ Stop` + Copy button ------------
  // `+ Stop` only renders in gradient mode (it's a no-op concept in solid).
  const renderGradientActionRow = (currentStops: GradientStop[]) => {
    const addDisabled = disabled || currentStops.length >= 8;
    return (
      <div style={sectionStyles.actionRow}>
        <button
          type="button"
          onClick={() => {
            if (addDisabled) return;
            if (!onGradientStopsChange) return;
            const next = insertStopAtLargestGap(currentStops);
            if (next !== currentStops) onGradientStopsChange(next);
          }}
          disabled={addDisabled}
          title={
            currentStops.length >= 8
              ? 'Maximum 8 stops'
              : 'Add a stop at the largest gap'
          }
          data-testid="gradient-add-stop"
          style={{
            ...sectionStyles.ghostButton,
            ...(addDisabled ? sectionStyles.ghostButtonDisabled : null),
          }}
        >
          + Stop
        </button>
        {renderCopyButton()}
      </div>
    );
  };

  // ---- Solid-mode Copy row — right-aligned button below the swatch row.
  // Only renders when `copyVisible` && `onCopy` are set. The Waypoints
  // panel sets `copyVisible` based on Route's mode (not its own), so
  // pressing the button while Waypoints is solid flips it to gradient.
  const renderSolidCopyRow = () => {
    if (!copyVisible || !onCopy) return null;
    return <div style={sectionStyles.actionRow}>{renderCopyButton()}</div>;
  };

  const showStopPicker = isGradient && selectedStopIndex != null;

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

      {renderModeToggle()}

      {isGradient && gradientStops ? (
        <>
          <GradientEditor
            stops={gradientStops}
            onStopsChange={(next) => onGradientStopsChange?.(next)}
            selectedIndex={selectedStopIndex}
            onSelectedIndexChange={setSelectedStopIndex}
            waypointProgress={waypointProgress}
            totalDistMeters={totalDistMeters}
            disabled={disabled}
          />

          {showStopPicker && (
            <>
              <div style={sectionStyles.stopColorHeader}>
                STOP COLOR (stop {(selectedStopIndex ?? 0) + 1})
              </div>
              <SwatchRow
                normalizedValue={normalizedValue}
                isNamed={isNamed}
                disabled={disabled}
                hexDraft={hexDraft}
                flashError={flashError}
                pickerOpen={pickerOpen}
                onSwatchClick={onSwatchClick}
                onCustomTileClick={onCustomTileClick}
                onHexInputChange={onHexInputChange}
                onHexKeyDown={onHexKeyDown}
                onHexBlur={commitHexDraft}
                onPickerChange={(hex) => applyColor(hex.toLowerCase())}
                testIdPrefix="stop-"
              />
            </>
          )}

          {renderGradientActionRow(gradientStops)}
        </>
      ) : (
        <>
          <SwatchRow
            normalizedValue={normalizedValue}
            isNamed={isNamed}
            disabled={disabled}
            hexDraft={hexDraft}
            flashError={flashError}
            pickerOpen={pickerOpen}
            onSwatchClick={onSwatchClick}
            onCustomTileClick={onCustomTileClick}
            onHexInputChange={onHexInputChange}
            onHexKeyDown={onHexKeyDown}
            onHexBlur={commitHexDraft}
            onPickerChange={(hex) => applyColor(hex.toLowerCase())}
          />
          {renderSolidCopyRow()}
        </>
      )}
    </div>
  );
}

// Shared swatch row + hex input + (collapsible) custom picker. Solid mode
// uses one instance with default test ids; gradient mode's STOP COLOR
// section uses another with the `stop-` prefix so tests can disambiguate.
function SwatchRow({
  normalizedValue,
  isNamed,
  disabled,
  hexDraft,
  flashError,
  pickerOpen,
  onSwatchClick,
  onCustomTileClick,
  onHexInputChange,
  onHexKeyDown,
  onHexBlur,
  onPickerChange,
  testIdPrefix,
}: {
  normalizedValue: string;
  isNamed: boolean;
  disabled?: boolean;
  hexDraft: string;
  flashError: boolean;
  pickerOpen: boolean;
  onSwatchClick: (hex: string) => void;
  onCustomTileClick: () => void;
  onHexInputChange: (raw: string) => void;
  onHexKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onHexBlur: () => void;
  onPickerChange: (hex: string) => void;
  testIdPrefix?: string;
}) {
  const prefix = testIdPrefix ?? '';
  return (
    <>
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
              data-testid={`${prefix}swatch-${sw.name.toLowerCase()}`}
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
          data-testid={`${prefix}swatch-custom`}
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
            onBlur={onHexBlur}
            onKeyDown={onHexKeyDown}
            disabled={disabled}
            maxLength={7}
            spellCheck={false}
            data-testid={`${prefix}color-section-hex-input`}
            style={sectionStyles.hexInput}
          />
        </div>
      </div>

      {pickerOpen && !disabled && (
        <div style={sectionStyles.pickerWrapper} data-testid={`${prefix}color-section-picker`}>
          <HexColorPicker color={normalizedValue} onChange={(hex) => onPickerChange(hex)} />
        </div>
      )}
    </>
  );
}

function stripHash(s: string): string {
  return s.replace(/^#/, '');
}
