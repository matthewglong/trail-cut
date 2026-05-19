// ShapeSection — the shape-gallery picker used by the Waypoints DecorationPanel.
// Renders a 2×3 grid of shape cells (52×52px each, centered icon + label
// below). Selected cell uses `semantic.accentTint` background + `semantic.accent`
// border per `panel-ux.md` §5b — the same look the toolbar's
// `segmentedBtnActive` pattern uses.
//
// The icons here are UX hints; the actual map renders are produced by the
// SDF rasterizer in `src/lib/mapVisuals/shapes.ts`. We use lucide-react
// glyphs for five of the six shapes (Circle, CircleDot for ring, MapPin,
// Square, Diamond) and an inline SVG with "1" inside a circle for
// `numbered-circle`. The lucide glyphs' default stroke style is fine for
// the gallery — they're recognizable at 24-28px and consistent with the
// rest of the toolbar.
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
import type { ReactElement } from 'react';
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

interface ShapeDefinition {
  /** The enum string written into `MapSettings.waypoints.shape` /
   *  `Waypoint.shape`. */
  value: WaypointShape;
  /** Display label rendered below the icon. */
  label: string;
  /** Tooltip text shown on hover. */
  title: string;
  /** Icon renderer. Receives the pixel size; returns the JSX element. */
  renderIcon: (size: number) => ReactElement;
}

/** Inline SVG for `numbered-circle`: filled disc with a centered "1"
 *  in white. The disc colour is `currentColor` so the cell's foreground
 *  colour (driven by the selected/unselected style) shows through. The
 *  number is rendered as SVG `<text>` so it scales with the icon box.
 *  This mirrors the SDF rasterizer's "filled circle + label" identity for
 *  the numbered-circle shape (see `shapes.ts` → `drawFilledCircle`). */
function NumberedCircleIcon({ size }: { size: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" fill="currentColor" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="'Manrope', sans-serif"
        fill="#0e1416"
      >
        1
      </text>
    </svg>
  );
}

const SHAPES: ShapeDefinition[] = [
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
  {
    value: 'numbered-circle',
    label: 'Numbered',
    title: 'Numbered circle',
    renderIcon: (size) => <NumberedCircleIcon size={size} />,
  },
];

const ICON_PIXEL_SIZE = 26;

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

      <div
        style={{
          ...shapeSectionStyles.grid,
          ...(disabled ? shapeSectionStyles.gridDisabled : null),
        }}
      >
        {SHAPES.map((shape) => {
          const isSelected = shape.value === value;
          return (
            <button
              key={shape.value}
              type="button"
              onClick={() => {
                if (disabled) return;
                onChange(shape.value);
              }}
              disabled={disabled}
              title={shape.title}
              aria-pressed={isSelected}
              data-testid={`shape-cell-${shape.value}`}
              style={{
                ...shapeSectionStyles.cell,
                ...(isSelected ? shapeSectionStyles.cellSelected : null),
                ...(disabled ? shapeSectionStyles.cellDisabled : null),
              }}
            >
              <span style={shapeSectionStyles.iconBox} aria-hidden="true">
                {shape.renderIcon(ICON_PIXEL_SIZE)}
              </span>
              <span style={shapeSectionStyles.label}>{shape.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
