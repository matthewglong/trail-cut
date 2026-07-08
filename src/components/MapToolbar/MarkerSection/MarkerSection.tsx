// MarkerSection — the marker gallery shared by the Waypoints and POV
// DecorationPanels (schema v11). A thin wrapper over the reusable
// `GridPicker`: this file owns the per-domain preset definitions
// (icon + label), the library-image tiles, the dotted "+" upload tile, and
// the override-pill row; the gallery's visual chrome lives in
// `src/components/GridPicker.tsx`.
//
// Value encoding: preset markers are their shape enum strings ('circle',
// 'ring', … — for POV, 'dot' stands in for the classic pulsing dot);
// library images are `image:<library id>` — the SAME encoding
// `resolveStaticPaints`' safeMarker expression uses, so the panel and the
// renderer can't drift on what a selection string means.
//
// Routing contract (mirrors the old ShapeSection):
//  • `value` is the currently effective marker; the parent computes it per
//    scope.
//  • `onChange(next)` fires with the clicked value; the parent routes by
//    scope (project settings vs per-clip / per-waypoint override).
//  • Right-clicking an IMAGE tile fires `onDeleteImage(id)` — the parent
//    owns the confirm dialog and the revert-all-uses transform. Presets
//    can't be deleted; right-clicks on them are ignored.
//  • The upload tile fires `onUpload()`; the parent owns the import flow
//    and the library write (library mutations are project-level regardless
//    of scope and must NOT flow through the clip-override diff).

import {
  Circle as CircleIcon,
  CircleDot as CircleDotIcon,
  MapPin as MapPinIcon,
  Plus as PlusIcon,
  Square as SquareIcon,
  Diamond as DiamondIcon,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import GridPicker, { type GridPickerOption } from '../../GridPicker';
import type { MarkerImageRef } from '../../../types';
import { markerSectionStyles } from './styles';

/** A marker selection as the gallery encodes it: a shape preset name or
 *  `image:<library id>`. */
export type MarkerValue = string;

/** Encode / decode helpers shared with the panel's routing code. */
export function imageMarkerValue(id: string): MarkerValue {
  return `image:${id}`;
}
export function imageIdOfMarkerValue(value: MarkerValue): string | null {
  return value.startsWith('image:') ? value.slice('image:'.length) : null;
}

export interface MarkerSectionProps {
  /** Which decoration's presets to offer. 'waypoint' = the five shapes;
   *  'pov' = dot + ring/square/diamond (the catalog's pov domain — the dot
   *  IS the circle there). */
  domain: 'waypoint' | 'pov';
  /** The currently effective marker value. */
  value: MarkerValue;
  /** Called with the clicked marker value. Parent routes by scope. */
  onChange: (next: MarkerValue) => void;
  /** The shared project-level image library (all uploads, both tools). */
  markerImages: MarkerImageRef[];
  /** Bundle dir — resolves image thumbnails via the asset protocol. */
  projectDir?: string | null;
  /** Open the multi-select import flow. Parent owns the library write. */
  onUpload: () => void;
  /** True while an import batch is being validated/baked/persisted. */
  importing?: boolean;
  /** Right-click on an image tile — parent opens the confirm-delete flow. */
  onDeleteImage: (id: string) => void;
  /** Last import error (per-file lines), rendered inline under the grid. */
  uploadError?: string | null;
  /** When true, dims the gallery and disables pointer events. */
  disabled?: boolean;
  /** When set, renders an override pill with a clear button (clip scope). */
  overrideIndicator?: { label: string; onClear: () => void } | undefined;
  /** Accessible label for the radiogroup. */
  ariaLabel?: string;
  /** Test-id prefix for the cells; defaults to `marker-cell`. */
  testIdPrefix?: string;
}

const WAYPOINT_PRESETS: GridPickerOption<MarkerValue>[] = [
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

const POV_PRESETS: GridPickerOption<MarkerValue>[] = [
  {
    value: 'dot',
    label: 'Dot',
    title: 'Classic pulsing dot',
    renderIcon: (size) => <CircleIcon size={size} fill="currentColor" strokeWidth={0} />,
  },
  {
    value: 'ring',
    label: 'Ring',
    title: 'Hollow ring',
    renderIcon: (size) => <CircleDotIcon size={size} strokeWidth={2} />,
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

/** Tile label from the upload's original filename: extension dropped,
 *  truncated so the mono uppercase label stays one line. */
function imageTileLabel(ref: MarkerImageRef): string {
  const base = ref.source_name.replace(/\.[^.]+$/, '') || 'Image';
  return base.length > 9 ? `${base.slice(0, 8)}…` : base;
}

export function MarkerSection({
  domain,
  value,
  onChange,
  markerImages,
  projectDir,
  onUpload,
  importing = false,
  onDeleteImage,
  uploadError,
  disabled,
  overrideIndicator,
  ariaLabel,
  testIdPrefix = 'marker-cell',
}: MarkerSectionProps) {
  const presets = domain === 'pov' ? POV_PRESETS : WAYPOINT_PRESETS;
  const imageOptions: GridPickerOption<MarkerValue>[] = markerImages.map(
    (ref) => ({
      value: imageMarkerValue(ref.id),
      label: imageTileLabel(ref),
      title: `${ref.source_name} — right-click to delete`,
      renderIcon: (size) =>
        projectDir ? (
          <img
            src={convertFileSrc(`${projectDir}/${ref.icon_file}`)}
            alt={ref.source_name}
            style={{
              ...markerSectionStyles.imageThumb,
              maxWidth: size + 6,
              maxHeight: size + 6,
            }}
            draggable={false}
          />
        ) : (
          <SquareIcon size={size} strokeWidth={1} />
        ),
    }),
  );

  return (
    <div style={markerSectionStyles.container} data-testid="marker-section">
      {overrideIndicator && (
        <div style={markerSectionStyles.overridePillRow}>
          <span style={markerSectionStyles.overridePill}>
            <span style={markerSectionStyles.overridePillDot} />
            {overrideIndicator.label}
          </span>
          <button
            type="button"
            onClick={overrideIndicator.onClear}
            style={markerSectionStyles.clearButton}
            title="Reset to project"
            data-testid="marker-section-clear-override"
          >
            × Reset to project
          </button>
        </div>
      )}

      <GridPicker<MarkerValue>
        value={value}
        options={[...presets, ...imageOptions]}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={ariaLabel ?? 'Marker'}
        testIdPrefix={testIdPrefix}
        onOptionContextMenu={(clicked) => {
          const id = imageIdOfMarkerValue(clicked);
          if (id) onDeleteImage(id);
        }}
        trailingCell={
          <button
            type="button"
            onClick={() => {
              if (!importing && !disabled) onUpload();
            }}
            disabled={disabled || importing}
            title="Upload marker image(s) — PNG or SVG"
            aria-label="Upload marker image"
            data-testid="marker-upload-tile"
            style={{
              ...markerSectionStyles.uploadTile,
              ...(importing ? markerSectionStyles.uploadTileDisabled : null),
            }}
          >
            <PlusIcon size={18} strokeWidth={2} />
            <span style={markerSectionStyles.uploadTileLabel}>
              {importing ? 'Importing…' : 'Add'}
            </span>
          </button>
        }
      />

      {uploadError && (
        <div style={markerSectionStyles.errorText} data-testid="marker-upload-error">
          {uploadError}
        </div>
      )}
    </div>
  );
}
