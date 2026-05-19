// Swatch order, left to right. Anchored in `panel-ux.md` §5 and
// `color-gradient.md` §4. The seventh tile (custom) is rendered separately
// because it has different geometry (conic gradient, dashed border) so it
// does not live in this list.
//
// Lives in its own module to satisfy `react-refresh/only-export-components`
// — the picker component file only exports React components.

import { palette } from '../../../theme/tokens';

export const SWATCHES: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'Coral',      hex: palette.coral },
  { name: 'Pollen',     hex: palette.pollen },
  { name: 'Chartreuse', hex: palette.chartreuse },
  { name: 'Azure',      hex: palette.azure },
  { name: 'Granite',    hex: palette.granite },
  { name: 'White',      hex: palette.white },
] as const;

export const SWATCH_HEX_SET = new Set(SWATCHES.map((s) => s.hex.toLowerCase()));

/** Test-facing alias — the tests assert against this exact order. */
export const COLOR_SECTION_SWATCHES = SWATCHES;
