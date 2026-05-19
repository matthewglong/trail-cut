import type { CSSProperties } from 'react';
import { semantic, fonts, radii, typeScale } from '../../../theme/tokens';

// ShapeSection — visual styling for the 2×3 shape gallery + override pill row.
// The gallery uses the same selected-state look as the existing
// `segmentedBtnActive` pattern in `MapToolbar/styles.ts`: an `accentTint`
// fill behind the selected cell with an `accent` (chartreuse) border. The
// override pill row mirrors the row that `ColorSection/styles.ts` declares
// for its own `overrideIndicator` so the two sections feel consistent.

export const shapeSectionStyles: Record<string, CSSProperties> = {
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

  // 2×3 grid: 3 columns, 2 rows. CSS grid keeps cells equal-width even when
  // labels vary in length. With a 260px content column (panel width 280
  // minus 10px horizontal padding on either side), three 52px cells plus
  // two 6px gaps = ~168px — comfortably inside the panel.
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gridAutoRows: 'auto',
    gap: 6,
  },
  gridDisabled: {
    opacity: 0.42,
    pointerEvents: 'none' as const,
  },

  cell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    width: '100%',
    minHeight: 52,
    padding: '6px 4px',
    border: `1px solid ${semantic.border}`,
    backgroundColor: semantic.surfaceDeep,
    color: semantic.fgMuted,
    cursor: 'pointer',
    borderRadius: radii.base,
    boxSizing: 'border-box' as const,
    transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
  },
  cellSelected: {
    backgroundColor: semantic.accentTint,
    borderColor: semantic.accent,
    color: semantic.fg,
  },
  cellDisabled: {
    cursor: 'not-allowed' as const,
  },

  // Icon container — fixed 28px box so all icons (including the inline
  // numbered-circle SVG) sit on the same baseline regardless of glyph metrics.
  iconBox: {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'currentColor',
  },

  label: {
    fontFamily: fonts.sans,
    fontSize: typeScale.meta,
    color: 'currentColor',
    lineHeight: 1,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap' as const,
  },
};
