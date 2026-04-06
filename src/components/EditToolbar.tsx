import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Clip, FocalPoint, Effects } from '../types';

interface EditToolbarProps {
  clip: Clip | null;
  onUpdateFocalPoint: (fp: FocalPoint) => void;
  onUpdateEffects: (effects: Effects) => void;
  previewAspect: string;
  onChangeAspect: (aspect: string) => void;
  cropPreview: boolean;
  onToggleCropPreview: () => void;
}

/** Small number stepper with +/- buttons */
function NumberStepper({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)) * 100) / 100;

  return (
    <div style={stepperStyles.container}>
      <button
        style={stepperStyles.btn}
        onClick={() => onChange(clamp(value - step))}
        disabled={value <= min}
      >
        -
      </button>
      <span style={stepperStyles.value}>{format(value)}</span>
      <button
        style={stepperStyles.btn}
        onClick={() => onChange(clamp(value + step))}
        disabled={value >= max}
      >
        +
      </button>
    </div>
  );
}

const stepperStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'inline-flex',
    alignItems: 'center',
    backgroundColor: '#222',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    overflow: 'hidden',
  },
  btn: {
    width: '24px',
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    color: '#999',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 'bold',
    padding: 0,
  },
  value: {
    minWidth: '38px',
    textAlign: 'center' as const,
    fontSize: '12px',
    color: '#ddd',
    fontVariantNumeric: 'tabular-nums',
    padding: '0 2px',
    borderLeft: '1px solid #3a3a3a',
    borderRight: '1px solid #3a3a3a',
  },
};

export default function EditToolbar({
  clip,
  onUpdateFocalPoint,
  onUpdateEffects,
  previewAspect,
  onChangeAspect,
  cropPreview,
  onToggleCropPreview,
}: EditToolbarProps) {
  const [expanded, setExpanded] = useState(true);

  if (!clip) return null;

  const zoom = clip.focal_point.zoom;
  const speed = clip.effects.speed;
  const lutFilename = clip.effects.color_lut?.split('/').pop() ?? null;

  async function handleSelectLut() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'LUT Files', extensions: ['cube', '3dl', 'lut'] }],
      });
      if (selected) {
        onUpdateEffects({ ...clip.effects, color_lut: selected as string });
      }
    } catch { /* user cancelled */ }
  }

  // Collapsed: summary chips
  if (!expanded) {
    return (
      <div style={styles.collapsed} onClick={() => setExpanded(true)}>
        <div style={styles.chipRow}>
          <span style={styles.chip}>
            {zoom.toFixed(1)}x zoom
          </span>
          <span style={styles.divider} />
          <span style={styles.chip}>
            {speed}x speed
          </span>
          <span style={styles.divider} />
          <span style={styles.chip}>
            {previewAspect}
          </span>
          {lutFilename && (
            <>
              <span style={styles.divider} />
              <span style={styles.chip}>{lutFilename}</span>
            </>
          )}
        </div>
        <button style={styles.expandBtn} onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 5L6 8L9 5" stroke="#888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
    );
  }

  return (
    <div style={styles.bar}>
      <div style={styles.sections}>
        {/* Zoom */}
        <div style={styles.group}>
          <span style={styles.groupLabel}>Zoom</span>
          <NumberStepper
            value={zoom}
            min={1.0}
            max={5.0}
            step={0.1}
            format={(v) => `${v.toFixed(1)}x`}
            onChange={(v) => onUpdateFocalPoint({ ...clip.focal_point, zoom: v })}
          />
        </div>

        <div style={styles.separator} />

        {/* Speed */}
        <div style={styles.group}>
          <span style={styles.groupLabel}>Speed</span>
          <NumberStepper
            value={speed}
            min={0.25}
            max={4.0}
            step={0.25}
            format={(v) => `${v}x`}
            onChange={(v) => onUpdateEffects({ ...clip.effects, speed: v })}
          />
        </div>

        <div style={styles.separator} />

        {/* Aspect Ratio + Preview */}
        <div style={styles.group}>
          <span style={styles.groupLabel}>Aspect</span>
          <div style={styles.groupControls}>
            <select
              value={previewAspect}
              onChange={(e) => onChangeAspect(e.target.value)}
              style={styles.select}
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="4:5">4:5</option>
            </select>
            <button
              onClick={onToggleCropPreview}
              style={{
                ...styles.previewToggle,
                backgroundColor: cropPreview ? '#ff6b35' : 'transparent',
                color: cropPreview ? '#000' : '#999',
              }}
            >
              {cropPreview ? 'Edit' : 'Preview'}
            </button>
          </div>
        </div>

        <div style={styles.separator} />

        {/* Color Grade */}
        <div style={styles.group}>
          <span style={styles.groupLabel}>Color</span>
          <div style={styles.groupControls}>
            {lutFilename ? (
              <>
                <span style={styles.lutChip} title={clip.effects.color_lut ?? ''}>{lutFilename}</span>
                <button
                  onClick={() => onUpdateEffects({ ...clip.effects, color_lut: null })}
                  style={styles.lutClear}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </>
            ) : (
              <button onClick={handleSelectLut} style={styles.lutBtn}>
                Load LUT
              </button>
            )}
          </div>
        </div>
      </div>

      <button style={styles.collapseBtn} onClick={() => setExpanded(false)}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 8L6 5L9 8" stroke="#888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Collapsed state
  collapsed: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    cursor: 'pointer',
    userSelect: 'none',
  },
  chipRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  chip: {
    fontSize: '11px',
    color: '#999',
    fontVariantNumeric: 'tabular-nums',
  },
  divider: {
    width: '1px',
    height: '12px',
    backgroundColor: '#333',
  },
  expandBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
  },

  // Expanded state
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
  },
  sections: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flex: 1,
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  groupLabel: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.4px',
  },
  groupControls: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  separator: {
    width: '1px',
    height: '20px',
    backgroundColor: '#2a2a2a',
    flexShrink: 0,
  },


  // Aspect / Preview
  select: {
    backgroundColor: '#222',
    color: '#ddd',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    padding: '4px 6px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  previewToggle: {
    padding: '4px 10px',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  },

  // Color grade
  lutChip: {
    fontSize: '11px',
    color: '#ccc',
    maxWidth: '80px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  lutClear: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
  },
  lutBtn: {
    padding: '4px 10px',
    backgroundColor: '#222',
    color: '#999',
    border: '1px solid #3a3a3a',
    borderRadius: '5px',
    fontSize: '11px',
    cursor: 'pointer',
  },

  collapseBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
    marginLeft: '12px',
  },
};
