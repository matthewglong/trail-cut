import type React from 'react';
import { colors, semantic } from '../../theme/tokens';

export const popoverStyles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    backgroundColor: '#252525',
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
    padding: '12px 14px',
    minWidth: '220px',
    zIndex: 200,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  title: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#fff',
    marginBottom: '8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
  },
  label: {
    color: '#777',
  },
  value: {
    color: '#bbb',
    fontVariantNumeric: 'tabular-nums',
  },
};

/** Strip top padding reserved for the group bars, px. */
export const GROUP_GUTTER = 10;
const GROUP_BAR_HEIGHT = 6;

export const styles: Record<string, React.CSSProperties> = {
  // ── Clip-group overlay (GroupBar.tsx) — lives INSIDE `strip` so it
  //    scrolls with the cards. `GROUP_GUTTER` px of strip top padding
  //    makes room for the bars above the cards' top edge.
  groupLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: `${GROUP_GUTTER}px`,
    zIndex: 3,
    pointerEvents: 'none',
  },
  groupBar: {
    position: 'absolute',
    top: `${GROUP_GUTTER - GROUP_BAR_HEIGHT}px`,
    height: `${GROUP_BAR_HEIGHT}px`,
    borderRadius: `${GROUP_BAR_HEIGHT / 2}px`,
    backgroundColor: 'rgba(255, 107, 53, 0.45)',
    cursor: 'pointer',
    pointerEvents: 'auto',
    transition: 'background-color 0.15s, box-shadow 0.15s',
  },
  groupBarActive: {
    backgroundColor: '#ff6b35',
    boxShadow: '0 0 0 1px rgba(255, 107, 53, 0.35), 0 0 6px rgba(255, 107, 53, 0.6)',
  },
  // End handles: 10px hit areas straddling each end of the bar.
  groupHandle: {
    position: 'absolute',
    top: '-4px',
    width: '10px',
    height: `${GROUP_BAR_HEIGHT + 8}px`,
    cursor: 'ew-resize',
    touchAction: 'none',
    pointerEvents: 'auto',
  },
  groupHandleStart: {
    left: '-4px',
  },
  groupHandleEnd: {
    right: '-4px',
  },
  // × cap at the bar's right end, shown only while selected.
  groupDeleteCap: {
    position: 'absolute',
    top: `${GROUP_BAR_HEIGHT / 2 - 8}px`,
    right: '-20px',
    width: '16px',
    height: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    lineHeight: 1,
    fontWeight: 700,
    color: '#fff',
    backgroundColor: '#ff6b35',
    border: 'none',
    borderRadius: '50%',
    padding: 0,
    cursor: 'pointer',
    outline: 'none',
    pointerEvents: 'auto',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.6)',
  },
  // "Group (n)" button — floats over the multi-selection, centred on it,
  // inside the strip so it scrolls with the cards.
  groupBtn: {
    position: 'absolute',
    top: '2px',
    transform: 'translateX(-50%)',
    zIndex: 4,
    fontSize: '11px',
    fontWeight: 600,
    color: '#fff',
    backgroundColor: '#ff6b35',
    border: 'none',
    borderRadius: '4px',
    padding: '3px 8px',
    cursor: 'pointer',
    outline: 'none',
    whiteSpace: 'nowrap',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.5)',
    pointerEvents: 'auto',
  },
  container: {
    width: '100%',
    height: '100%',
    backgroundColor: '#161616',
    padding: '8px 0',
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  strip: {
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    gap: '4px',
    // Top gutter hosts the group bars (see `groupLayer`).
    padding: `${GROUP_GUTTER}px 8px 0`,
    minWidth: 'min-content',
    height: '100%',
  },
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    aspectRatio: '4 / 3',
    minWidth: '64px',
    backgroundColor: colors.bgElevated,
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: colors.bgElevated,
    borderRadius: '6px',
    overflow: 'hidden',
    // The active (playhead) ring is a 1px outline pulled inside the 2px
    // border box so neither state changes the card's layout size. Longhands
    // only: mixing the `outline` shorthand with an `outlineColor` override
    // leaves outline-color at its initial `currentColor` (white) when the
    // override is removed, because React never re-applies the unchanged
    // shorthand.
    outlineWidth: '1px',
    outlineStyle: 'solid',
    outlineColor: 'transparent',
    outlineOffset: '-2px',
    transition: 'border-color 0.15s, outline-color 0.15s',
    flexShrink: 0,
  },
  // Selected (user intent — what edits/grouping act on). Wins over the
  // active ring; the bottom action bar still shows active independently.
  cardSelected: {
    borderColor: semantic.accentWarm,
    backgroundColor: semantic.warmTintStrong,
  },
  // Active (the clip the playhead is in). Narrow cold ring — a different
  // channel from selection so "selected" and "playing" never read alike.
  cardActive: {
    outlineColor: semantic.accentSoft,
  },
  cardHidden: {
    opacity: 0.5,
  },
  thumbBtn: {
    display: 'block',
    width: '100%',
    padding: 0,
    margin: 0,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    outline: 'none',
    flex: 1,
    minHeight: 0,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    borderRadius: '4px 4px 0 0',
    display: 'block',
  },
  thumbPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#555',
    backgroundColor: colors.bg,
    borderRadius: '4px 4px 0 0',
  },
  proxyBadge: {
    position: 'absolute',
    top: '4px',
    right: '4px',
    fontSize: '9px',
    color: '#ff6b35',
    backgroundColor: colors.overlay,
    borderRadius: '3px',
    padding: '1px 4px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'center',
    gap: '2px',
    padding: '4px 2px',
    transition: 'background-color 0.15s',
  },
  // Active clip: the action bar carries the playhead color even when the
  // card is also selected (selection owns the border, active owns the bar).
  actionsActive: {
    backgroundColor: semantic.accentSoft,
  },
  // Icons on the active bar: dark on pollen for contrast.
  actionBtnOnActive: {
    color: semantic.bg,
  },
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '22px',
    background: 'none',
    border: 'none',
    color: '#777',
    cursor: 'pointer',
    borderRadius: '3px',
    padding: 0,
    outline: 'none',
  },
  empty: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    backgroundColor: '#161616',
  },
  emptyText: {
    color: '#555',
    fontSize: '14px',
  },
};
