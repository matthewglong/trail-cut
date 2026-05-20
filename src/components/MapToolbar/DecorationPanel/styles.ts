import type { CSSProperties } from 'react';
import { semantic, fonts, radii, typeScale } from '../../../theme/tokens';

export const panelStyles: Record<string, CSSProperties> = {
  // Sizing & position (width/height/left/top) are applied inline by the
  // component — both docked and torn-off panels render via portal as
  // `position: fixed` so the map pane's clipping doesn't trap them.
  panel: {
    backgroundColor: semantic.surfaceRaised,
    border: `1px solid ${semantic.borderStrong}`,
    borderRadius: radii.lg,
    zIndex: 200,
    // Heavier shadow than a dropdown — these panels float independently
    // and the elevation cue helps them read as "windows over the map".
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
    display: 'flex',
    flexDirection: 'column',
    color: semantic.fg,
    fontFamily: fonts.sans,
    // Contain the resize handle in the corner so it doesn't poke past the
    // rounded border.
    overflow: 'hidden',
  },
  // Scrollable body that sits between the fixed-height title row and the
  // resize handle. min-height:0 is required for flex children to actually
  // scroll instead of expanding past the panel.
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto' as const,
  },

  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px 8px',
    gap: 8,
    cursor: 'grab',
    userSelect: 'none' as const,
    touchAction: 'none' as const,
    flexShrink: 0,
  },
  titleRowDragging: {
    cursor: 'grabbing',
  },
  titleActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: typeScale.eyebrow,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: semantic.fg,
  },
  // 6-dot grab affordance to the left of the title — communicates "drag this".
  dragHandle: {
    display: 'inline-block',
    width: 8,
    height: 12,
    marginRight: 8,
    backgroundImage: `radial-gradient(${semantic.fgDim} 1px, transparent 1px)`,
    backgroundSize: '4px 4px',
    backgroundPosition: '0 1px',
    opacity: 0.7,
    flexShrink: 0,
  },
  // Tear-off/re-dock icon button on the right side of the title row.
  titleAction: {
    background: 'transparent',
    border: 'none',
    color: semantic.fgDim,
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: radii.base,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    fontSize: 13,
  },
  // Close (×) — same shape as titleAction, slightly larger glyph.
  titleClose: {
    background: 'transparent',
    border: 'none',
    color: semantic.fgDim,
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: radii.base,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    fontSize: 18,
    fontWeight: 300,
  },
  // Bottom-right resize grip. Pure-CSS diagonal stripes — three slashes in
  // a 14×14 box at the rounded corner. The handle itself uses
  // `nwse-resize` cursor and absorbs its own pointer events; the panel's
  // border-radius clips the corner so the stripes don't escape it.
  resizeHandle: {
    position: 'absolute' as const,
    right: 0,
    bottom: 0,
    width: 14,
    height: 14,
    cursor: 'nwse-resize',
    touchAction: 'none' as const,
    backgroundImage: `linear-gradient(135deg, transparent 0%, transparent 55%, ${semantic.fgDim} 55%, ${semantic.fgDim} 65%, transparent 65%, transparent 75%, ${semantic.fgDim} 75%, ${semantic.fgDim} 85%, transparent 85%)`,
    opacity: 0.55,
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
