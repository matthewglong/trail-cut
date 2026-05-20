import type { CSSProperties } from 'react';
import { semantic, fonts, typeScale } from '../../../theme/tokens';

// ShapeSection — visual styling for the override-pill row that sits above
// the shape gallery. The gallery itself (the 3×N inverse grid, active-cell
// flip, hover/disable behavior) lives in `src/components/GridPicker.tsx`;
// these styles only own the section's container + override pill chrome,
// which mirrors `ColorSection/styles.ts` so the two sections feel
// consistent in clip scope.

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
};
