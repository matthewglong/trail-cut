import React from 'react';
import { colors } from '../../theme/tokens';

interface DropdownItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface DropdownProps {
  items: DropdownItem[];
  style?: React.CSSProperties;
}

export default function Dropdown({ items, style }: DropdownProps) {
  return (
    <div style={{ ...styles.dropdown, ...style }}>
      {items.map((item, i) => (
        <button
          key={i}
          style={{
            ...styles.dropdownItem,
            ...(item.danger ? { color: colors.dangerLight } : {}),
          }}
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dropdown: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '4px',
    backgroundColor: colors.bgSurface,
    border: `1px solid ${colors.borderLight}`,
    borderRadius: '6px',
    overflow: 'hidden',
    zIndex: 100,
    minWidth: '140px',
  },
  dropdownItem: {
    display: 'block',
    width: '100%',
    padding: '8px 14px',
    backgroundColor: 'transparent',
    color: colors.textMuted,
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    textAlign: 'left',
  },
};
