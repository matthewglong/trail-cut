// Map toolbar styling — re-exports EditToolbar's style objects so a single
// design-token change re-skins both toolbars in lockstep, plus segmented
// control styles for the tri-state mode pickers.

import { styles as editStyles } from '../EditToolbar/styles';
import { colors } from '../../theme/tokens';

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

  // Read-only degrees readout shown next to the AUTO mode pill in the
  // bearing group. Typography matches NumberStepper's value (so swapping
  // between fixed-mode stepper and auto-mode readout doesn't jump the
  // layout), but dimmer to signal it's informational, not editable.
  bearingLiveReadout: {
    display: 'inline-block',
    fontSize: '12px',
    fontWeight: 500,
    color: '#888',
    fontVariantNumeric: 'tabular-nums' as const,
    userSelect: 'none' as const,
    cursor: 'default',
    padding: '0 2px',
  },
};
