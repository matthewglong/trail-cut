import type { CSSProperties } from 'react';
import { semantic, fonts, radii, typeScale } from '../../../theme/tokens';

export const panelStyles: Record<string, CSSProperties> = {
  panel: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    width: 280,
    maxHeight: 480,
    overflowY: 'auto' as const,
    backgroundColor: semantic.surfaceRaised,
    border: `1px solid ${semantic.borderStrong}`,
    borderRadius: radii.lg,
    zIndex: 200,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
    display: 'flex',
    flexDirection: 'column',
    color: semantic.fg,
    fontFamily: fonts.sans,
  },
  panelAnchorLeft: {
    left: 0,
  },
  panelAnchorRight: {
    right: 0,
  },

  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px 8px',
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: semantic.fg,
  },

  scopeBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    margin: '0 10px 6px',
    backgroundColor: semantic.warmTint,
    color: semantic.accentWarm,
    borderRadius: radii.base,
    fontSize: typeScale.meta,
  },
  scopeBannerIcon: {
    fontSize: 12,
    lineHeight: 1,
  },
  scopeBannerText: {
    flex: 1,
  },
  scopeBannerLink: {
    background: 'transparent',
    border: 'none',
    color: semantic.accentWarm,
    fontSize: typeScale.meta,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline dotted' as const,
    fontFamily: fonts.sans,
  },

  section: {
    borderTop: `1px solid ${semantic.border}`,
    padding: '8px 0',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px 4px',
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: semantic.fgDim,
  },
  sectionBody: {
    padding: '2px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  sizeRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '2px 0',
  },
  sizeRowLabel: {
    fontSize: typeScale.meta,
    color: semantic.fgMuted,
  },

  pulseRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  },

  readOnlyBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  readOnlyHeader: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '0 12px',
  },
  readOnlyTag: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: '0.08em',
    color: semantic.fgDim,
    textTransform: 'uppercase' as const,
    padding: '1px 6px',
    border: `1px solid ${semantic.border}`,
    borderRadius: radii.base,
  },
  readOnlyNote: {
    margin: '0 12px',
    fontSize: typeScale.meta,
    color: semantic.fgMuted,
  },
  switchScopeButton: {
    margin: '4px 12px 0',
    padding: '8px 12px',
    width: 'calc(100% - 24px)',
    border: `1px solid ${semantic.borderStrong}`,
    backgroundColor: semantic.surfaceDeep,
    color: semantic.fg,
    cursor: 'pointer',
    borderRadius: radii.base,
    fontFamily: fonts.sans,
    fontSize: typeScale.label,
  },

  caption: {
    margin: '0 12px',
    fontSize: typeScale.meta,
    color: semantic.fgDim,
  },
  noWpBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
};
