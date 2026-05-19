import type { CSSProperties } from 'react';
import { semantic, fonts, radii, typeScale } from '../../../theme/tokens';

// Conic gradient for the custom tile — coral → pollen → chartreuse → azure
// → coral. Pulled from the palette by token rather than hardcoded literals.
const customConic = `conic-gradient(from 90deg at 50% 50%, ${semantic.accentWarm}, ${semantic.accentSoft}, ${semantic.accent}, ${semantic.accentCold}, ${semantic.accentWarm})`;

export const sectionStyles: Record<string, CSSProperties> = {
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

  swatchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  swatchRowDisabled: {
    opacity: 0.42,
    pointerEvents: 'none' as const,
  },

  swatchTile: {
    width: 22,
    height: 22,
    padding: 0,
    border: `1px solid ${semantic.border}`,
    borderRadius: radii.base,
    cursor: 'pointer',
    flexShrink: 0,
    position: 'relative' as const,
    boxSizing: 'border-box' as const,
    transition: 'box-shadow 0.12s ease',
  },
  swatchTileSelected: {
    boxShadow: `0 0 0 1px ${semantic.bg}, 0 0 0 2.5px ${semantic.accent}`,
  },
  swatchTileDisabled: {
    cursor: 'not-allowed' as const,
  },

  customTile: {
    background: customConic,
    border: `1px dashed ${semantic.borderStrong}`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  customInsetDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    boxShadow: '0 0 0 1.5px rgba(14, 20, 22, 0.7)',
  },

  hexInputWrapper: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    width: 92,
    height: 22,
    padding: '0 6px',
    border: `1px solid ${semantic.border}`,
    backgroundColor: semantic.surfaceDeep,
    borderRadius: radii.base,
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.15s ease',
  },
  hexInputWrapperError: {
    borderColor: '#ff5555',
  },
  hexInputWrapperDisabled: {
    opacity: 0.5,
  },
  hexPrefix: {
    color: semantic.fgDim,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginRight: 2,
    userSelect: 'none' as const,
  },
  hexInput: {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    color: semantic.fg,
    fontFamily: fonts.mono,
    fontSize: 11,
    outline: 'none',
    padding: 0,
    letterSpacing: '0.02em',
  },

  pickerWrapper: {
    marginTop: 4,
    // Constrain react-colorful's default 200×200 picker block.
    width: '100%',
  },
};
