// Map toolbar styling — re-exports EditToolbar's style objects so a single
// design-token change re-skins both toolbars in lockstep, plus segmented
// control styles for the tri-state mode pickers.

import { styles as editStyles } from '../EditToolbar/styles';
import { colors, semantic } from '../../theme/tokens';

export const styles: Record<string, React.CSSProperties> = {
  ...editStyles,

  // Tighter layout than EditToolbar — the minimal-variant ModePickers
  // collapse to icon+badge, so large gaps look disproportionate.
  group: {
    ...editStyles.group,
    gap: '4px',
  },
  separator: {
    ...editStyles.separator,
    margin: '0 2px',
  },

  // Follow pill, frozen GROUP state — the clip's camera is owned by its
  // clip group. Uses the override accent so it reads as "locked by a
  // higher authority", not as on/off.
  previewPillLocked: {
    ...editStyles.previewPillOn,
    border: `1px solid ${colors.accent}`,
    backgroundColor: semantic.accentTint,
    color: colors.accent,
    letterSpacing: '0.04em',
  },
  previewDotLocked: {
    ...editStyles.previewDotOn,
    backgroundColor: colors.accent,
  },

  // Bar tints — pre-blended with the base #1a1a1a so the tint is visible
  barTintProject: {
    backgroundColor: '#26332a',
  },
  barTintClip: {
    backgroundColor: '#532e21',
  },

  // --- Option 2 (active): solid scope tab, tinted bar ---
  scopeTabProject: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    margin: '-40px 0 -40px -16px',
    padding: 0,
    border: 'none',
    backgroundColor: '#4a7c59',
    color: '#e0efe4',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
    flexShrink: 0,
    boxShadow: '3px 0 6px rgba(0, 0, 0, 0.35)',
  },
  scopeTabClip: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    margin: '-40px 0 -40px -16px',
    padding: 0,
    border: 'none',
    backgroundColor: colors.accent,
    color: '#fff',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
    flexShrink: 0,
    boxShadow: '3px 0 6px rgba(0, 0, 0, 0.35)',
  },

  // --- Option 1 (inactive): tinted scope tab, colored control text ---
  // To revert, swap the active/inactive blocks above and update
  // MapToolbar to pass scope color down to control text.
  // scopeTabProject: {
  //   ...same as above but:
  //   backgroundColor: 'rgba(74, 124, 89, 0.3)',
  //   color: '#8bc49a',
  // },
  // scopeTabClip: {
  //   ...same as above but:
  //   backgroundColor: 'rgba(255, 107, 53, 0.2)',
  //   color: colors.accent,
  // },

  segmented: {
    display: 'flex',
    alignItems: 'stretch',
    border: '1px solid #555',
    borderRadius: '20px',
    overflow: 'hidden',
    height: '22px',
  },
  segmentedBtn: {
    background: 'transparent',
    border: 'none',
    borderLeft: '1px solid #3a3a3a',
    color: '#888',
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    padding: '0 10px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'all 0.15s ease',
  },
  segmentedBtnActive: {
    backgroundColor: 'rgba(255, 107, 53, 0.18)',
    color: colors.accent,
  },
  segmentedBtnDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },

  // Wrapper around the bar + the optional second-row overflow. The second row
  // is absolutely positioned, anchored to this root's top-right corner just
  // below the bar — so we need a positioning context here.
  root: {
    position: 'relative' as const,
  },

  // One item slot — separator + group. Rendered identically in the bar, the
  // wrapped overflow row, and the hidden measurement mirror so the mirror's
  // offsetWidth equals the item's footprint in the bar exactly.
  itemWrapper: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: '4px',
  },

  // Wrapped overflow row — floats below the bar, anchored top-right, over the
  // content beneath. Same tint as the bar; bottom-left rounded so it reads as
  // a panel descending from the bar.
  overflowRow: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    height: '40px',
    padding: '0 12px',
    gap: '4px',
    borderBottomLeftRadius: '10px',
    boxShadow: '0 6px 16px rgba(0, 0, 0, 0.35)',
  },

  // Hidden measurement mirror — every item rendered off-screen at its natural
  // width so the visible bar can decide how many fit. visibility:hidden +
  // pointer-events:none keeps it invisible and inert; position:fixed escapes
  // the parent's overflow:hidden without affecting layout.
  mirror: {
    position: 'fixed' as const,
    top: -9999,
    left: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    visibility: 'hidden' as const,
    pointerEvents: 'none' as const,
    whiteSpace: 'nowrap' as const,
  },

};
