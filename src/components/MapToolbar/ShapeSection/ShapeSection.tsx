// ShapeSection — the shape-gallery picker used by the Waypoints DecorationPanel.
// A thin wrapper over the reusable `GridPicker`: this file owns the
// per-shape definitions (icon + label) and the override-pill row; the
// gallery's visual chrome (the inverse-style 3×N grid, active cell flip,
// hover/disable behavior) lives in `src/components/GridPicker.tsx`.
//
// Routing contract:
//  • `value` is the currently effective shape. The parent computes this
//    as `associated?.shape ?? mapSettings.waypoints.shape` (clip scope) or
//    just `mapSettings.waypoints.shape` (project scope).
//  • `onChange(next)` fires with the clicked shape's enum string. In clip
//    scope the parent writes `Waypoint.shape` via `onWaypointsChange`; in
//    project scope it writes `mapSettings.waypoints.shape`.
//  • `overrideIndicator`, when set, renders the same pill+clear-button row
//    `ColorSection` shows so the two sections feel consistent in clip scope.

import {
  Circle as CircleIcon,
  CircleDot as CircleDotIcon,
  MapPin as MapPinIcon,
  Square as SquareIcon,
  Diamond as DiamondIcon,
} from 'lucide-react';
import GridPicker, { type GridPickerOption } from '../../GridPicker';
import type { WaypointShape } from '../../../types';
import { shapeSectionStyles } from './styles';

export interface ShapeSectionProps {
  /** The currently effective shape — what the gallery should show as
   *  selected. In clip scope this is `associated?.shape ?? project.shape`. */
  value: WaypointShape;
  /** Called with the clicked shape's enum string. Parent routes by scope. */
  onChange: (next: WaypointShape) => void;
  /** When true, dims the gallery and disables pointer events. */
  disabled?: boolean;
  /** When set, renders an override pill (e.g. "Wp 3 · override") with a
   *  clear button. Hidden in project scope; shown in clip scope when the
   *  associated `Waypoint.shape` is defined. */
  overrideIndicator?: { label: string; onClear: () => void } | undefined;
}

const SHAPES: GridPickerOption<WaypointShape>[] = [
  {
    value: 'circle',
    label: 'Circle',
    title: 'Filled circle',
    renderIcon: (size) => <CircleIcon size={size} fill="currentColor" strokeWidth={0} />,
  },
  {
    value: 'ring',
    label: 'Ring',
    title: 'Hollow ring',
    renderIcon: (size) => <CircleDotIcon size={size} strokeWidth={2} />,
  },
  {
    value: 'pin',
    label: 'Pin',
    title: 'Teardrop pin',
    renderIcon: (size) => <MapPinIcon size={size} fill="currentColor" strokeWidth={1.5} />,
  },
  {
    value: 'square',
    label: 'Square',
    title: 'Filled square',
    renderIcon: (size) => <SquareIcon size={size} fill="currentColor" strokeWidth={0} />,
  },
  {
    value: 'diamond',
    label: 'Diamond',
    title: 'Filled diamond',
    renderIcon: (size) => <DiamondIcon size={size} fill="currentColor" strokeWidth={0} />,
  },
];

export function ShapeSection({
  value,
  onChange,
  disabled,
  overrideIndicator,
}: ShapeSectionProps) {
  return (
    <div style={shapeSectionStyles.container} data-testid="shape-section">
      {overrideIndicator && (
        <div style={shapeSectionStyles.overridePillRow}>
          <span style={shapeSectionStyles.overridePill}>
            <span style={shapeSectionStyles.overridePillDot} />
            {overrideIndicator.label}
          </span>
          <button
            type="button"
            onClick={overrideIndicator.onClear}
            style={shapeSectionStyles.clearButton}
            title="Reset to project"
            data-testid="shape-section-clear-override"
          >
            × Reset to project
          </button>
        </div>
      )}

      <GridPicker<WaypointShape>
        value={value}
        options={SHAPES}
        onChange={onChange}
        disabled={disabled}
        ariaLabel="Waypoint shape"
        testIdPrefix="shape-cell"
      />
    </div>
  );
}
