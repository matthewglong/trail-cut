// Shared style fragments — reusable React.CSSProperties objects
// Import these into components to replace repeated inline style patterns.

import { colors } from './tokens';

/** Standard dark button (toolbar, panels — e.g. "Import Media") */
export const buttonBase: React.CSSProperties = {
  padding: '6px 14px',
  backgroundColor: colors.bgSurface,
  color: colors.textMuted,
  border: `1px solid ${colors.borderLight}`,
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '13px',
};

/** Primary accent button (e.g. "New Project") */
export const buttonPrimary: React.CSSProperties = {
  padding: '12px 32px',
  backgroundColor: colors.accent,
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '15px',
  fontWeight: 'bold',
};

/** Danger / destructive button (e.g. "Remove Clip", "Delete") */
export const buttonDanger: React.CSSProperties = {
  backgroundColor: 'transparent',
  color: colors.danger,
  border: `1px solid ${colors.danger}`,
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};

/** Danger button filled (e.g. modal "Delete" confirmation) */
export const buttonDangerFilled: React.CSSProperties = {
  padding: '6px 14px',
  backgroundColor: colors.danger,
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 600,
};

/** Ghost / text-only button (e.g. modal "Cancel", dismiss) */
export const buttonGhost: React.CSSProperties = {
  padding: '6px 14px',
  backgroundColor: 'transparent',
  color: colors.textDim,
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
};

/** Standard dark input field (trim inputs, name inputs, stepper text) */
export const inputBase: React.CSSProperties = {
  backgroundColor: colors.bg,
  color: colors.textMuted,
  border: `1px solid ${colors.border}`,
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '13px',
  fontVariantNumeric: 'tabular-nums',
  outline: 'none',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

/** Dropdown menu container (Import Media, GPX, card context menus) */
export const dropdownBase: React.CSSProperties = {
  position: 'absolute' as const,
  top: '100%',
  right: 0,
  marginTop: '4px',
  backgroundColor: colors.bgSurface,
  border: `1px solid ${colors.borderLight}`,
  borderRadius: '6px',
  overflow: 'hidden',
  zIndex: 100,
  minWidth: '140px',
};

/** Individual dropdown menu item */
export const dropdownItemBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 14px',
  backgroundColor: 'transparent',
  color: colors.textMuted,
  border: 'none',
  cursor: 'pointer',
  fontSize: '13px',
  textAlign: 'left' as const,
};

/** Dark backdrop for modals */
export const modalOverlay: React.CSSProperties = {
  position: 'fixed' as const,
  inset: 0,
  backgroundColor: colors.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

/** Modal container box */
export const modalBox: React.CSSProperties = {
  backgroundColor: colors.bgElevated,
  border: `1px solid ${colors.border}`,
  borderRadius: '10px',
  padding: '20px',
  maxWidth: '320px',
  width: '100%',
};

/** Chip base style */
export const chipBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '5px 12px',
  borderRadius: '20px',
  cursor: 'pointer',
  fontSize: '12px',
  userSelect: 'none' as const,
  transition: 'all 0.15s ease',
};

/** GPX chip — loaded / active state */
export const chipGpxLoaded: React.CSSProperties = {
  ...chipBase,
  border: '1px solid #4a7c59',
  backgroundColor: 'rgba(74, 124, 89, 0.15)',
  color: '#8bc49a',
};

/** GPX chip — empty / placeholder state */
export const chipGpxEmpty: React.CSSProperties = {
  ...chipBase,
  border: '1px dashed #555',
  color: '#777',
};
