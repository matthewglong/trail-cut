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

  // ---- Mode toggle ([Solid][Gradient]) ----------------------------------
  modeToggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    marginBottom: 6,
  },
  modeToggleSegment: {
    flex: '0 0 auto',
    width: 80,
    height: 22,
    padding: '0 8px',
    border: `1px solid ${semantic.border}`,
    backgroundColor: semantic.surfaceDeep,
    color: semantic.fgMuted,
    fontSize: typeScale.meta,
    fontFamily: fonts.sans,
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    boxSizing: 'border-box' as const,
  },
  modeToggleSegmentLeft: {
    borderTopLeftRadius: radii.base,
    borderBottomLeftRadius: radii.base,
    borderRightWidth: 0,
  },
  modeToggleSegmentRight: {
    borderTopRightRadius: radii.base,
    borderBottomRightRadius: radii.base,
  },
  modeToggleSegmentActive: {
    backgroundColor: semantic.surfacePressed,
    color: semantic.fg,
  },
  modeToggleSegmentDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed' as const,
  },

  // ---- Gradient editor body --------------------------------------------
  gradientBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  // Gradient bar (18px tall). Background is set inline from the live
  // stop array; styles here are the static chrome.
  gradientBar: {
    position: 'relative' as const,
    height: 18,
    borderRadius: radii.base,
    border: `1px solid ${semantic.border}`,
    cursor: 'crosshair',
    boxSizing: 'border-box' as const,
    overflow: 'hidden' as const,
  },
  gradientBarDisabled: {
    cursor: 'default' as const,
  },
  gradientBarTick: {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: semantic.fgFaint,
    pointerEvents: 'none' as const,
  },
  gradientBarTickActive: {
    backgroundColor: semantic.accent,
  },

  // Stop rail (26px tall, transparent — handles sit on the boundary
  // between bar and rail).
  stopRail: {
    position: 'relative' as const,
    height: 26,
    marginTop: -1,
  },
  stopHandle: {
    position: 'absolute' as const,
    top: -7,
    width: 14,
    height: 14,
    transform: 'translateX(-50%)',
    borderRadius: 999,
    border: '1.5px solid rgba(255, 255, 255, 0.9)',
    boxSizing: 'border-box' as const,
    cursor: 'ew-resize',
    padding: 0,
    background: 'transparent',
  },
  stopHandleEndpoint: {
    cursor: 'pointer' as const,
  },
  stopHandleSelected: {
    boxShadow: `0 0 0 1px ${semantic.bg}, 0 0 0 2.5px ${semantic.accent}`,
  },
  stopDeleteAffordance: {
    position: 'absolute' as const,
    top: -22,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 14,
    height: 14,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: semantic.accentWarm,
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
  },
  stopDragLabel: {
    position: 'absolute' as const,
    top: -22,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '2px 5px',
    backgroundColor: semantic.surfacePressed,
    color: semantic.fg,
    fontSize: 10,
    fontFamily: fonts.mono,
    borderRadius: radii.sm,
    whiteSpace: 'nowrap' as const,
    pointerEvents: 'none' as const,
  },

  // Distance axis (below stop rail).
  distanceAxis: {
    position: 'relative' as const,
    height: 14,
    marginTop: 2,
  },
  distanceAxisLabel: {
    position: 'absolute' as const,
    transform: 'translateX(-50%)',
    fontFamily: fonts.mono,
    fontSize: 9,
    color: semantic.fgDim,
    whiteSpace: 'nowrap' as const,
  },

  // STOP COLOR header above the swatch row when in gradient mode.
  stopColorHeader: {
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: semantic.fgMuted,
    marginTop: 4,
  },

  // Action row (+Stop / Copy).
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
  },
  ghostButton: {
    padding: '4px 10px',
    backgroundColor: 'transparent',
    border: `1px solid ${semantic.border}`,
    color: semantic.fgMuted,
    fontSize: typeScale.meta,
    fontFamily: fonts.sans,
    cursor: 'pointer',
    borderRadius: radii.base,
    transition: 'border-color 0.2s ease, color 0.2s ease',
  },
  ghostButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed' as const,
  },
  ghostButtonCopied: {
    borderColor: semantic.accent,
    color: semantic.accent,
  },

  // Trail preview block (header + SVG).
  previewBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginTop: 6,
    paddingTop: 6,
    borderTop: `1px dashed ${semantic.borderSoft}`,
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontFamily: fonts.mono,
    fontSize: 9,
    color: semantic.fgDim,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
  },
  previewSvg: {
    display: 'block',
    width: '100%',
    height: 28,
  },
};
