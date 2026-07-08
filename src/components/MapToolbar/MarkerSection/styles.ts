import type { CSSProperties } from 'react';
import { colors, semantic, fonts, radii, typeScale } from '../../../theme/tokens';

// MarkerSection — visual styling for the override-pill row that sits above
// the marker gallery, plus the dotted "upload" tile chrome. The gallery
// itself (the 3×N inverse grid, active-cell flip, hover/disable behavior)
// lives in `src/components/GridPicker.tsx`; the pill styles mirror
// `ColorSection/styles.ts` so the sections feel consistent in clip scope.

export const markerSectionStyles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 10px',
  },

  overridePillRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  overridePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 8px',
    border: `1px solid ${semantic.accentWarm}`,
    borderRadius: 999,
    color: semantic.accentWarm,
    fontSize: typeScale.meta,
    fontFamily: fonts.sans,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  overridePillDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: semantic.accentWarm,
  },
  clearButton: {
    background: 'transparent',
    border: 'none',
    color: semantic.fgDim,
    fontSize: typeScale.meta,
    fontFamily: fonts.sans,
    cursor: 'pointer',
    padding: '2px 6px',
  },

  // The dotted-square "+" upload tile rendered as the gallery's last cell.
  // Idle-cell geometry (padding/minHeight) matches GridPicker's cells so
  // the tile reads as "the next slot" rather than a foreign button.
  uploadTile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 4px 6px',
    minHeight: 58,
    border: `1px dashed ${semantic.border}`,
    borderRadius: radii.base,
    backgroundColor: 'transparent',
    color: semantic.fgMuted,
    cursor: 'pointer',
    boxSizing: 'border-box' as const,
    transition: 'color 0.18s ease, border-color 0.18s ease',
  },
  uploadTileDisabled: {
    cursor: 'wait',
    opacity: 0.5,
  },
  uploadTileLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow - 1.5,
    fontWeight: 500,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    lineHeight: 1,
  },

  // <img> thumbnail inside an image tile's icon box.
  imageThumb: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain' as const,
  },

  errorText: {
    color: colors.dangerLight,
    fontSize: typeScale.meta,
    fontFamily: fonts.sans,
    whiteSpace: 'pre-wrap' as const,
  },
};
