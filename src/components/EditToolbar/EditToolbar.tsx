import { open } from '@tauri-apps/plugin-dialog';
import { ZoomIn, Gauge, Crop, Eye, EyeOff, Pipette, X } from 'lucide-react';
import type { Clip, FocalPoint, Effects } from '../../types';
import { colors } from '../../theme/tokens';
import NumberStepper from './NumberStepper';
import CollapsibleToolbar from '../CollapsibleToolbar';
import { styles } from './styles';

interface EditToolbarProps {
  clip: Clip | null;
  onUpdateFocalPoint: (fp: FocalPoint) => void;
  onUpdateEffects: (effects: Effects) => void;
  previewAspect: string;
  onChangeAspect: (aspect: string) => void;
  cropPreview: boolean;
  onToggleCropPreview: () => void;
}

export default function EditToolbar({
  clip,
  onUpdateFocalPoint,
  onUpdateEffects,
  previewAspect,
  onChangeAspect: _onChangeAspect,
  cropPreview,
  onToggleCropPreview,
}: EditToolbarProps) {
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
        onUpdateEffects({ ...clip!.effects, color_lut: selected as string });
      }
    } catch { /* user cancelled */ }
  }

  const collapsedContent = (
    <div style={styles.chipRow}>
      <span style={styles.chip}>{zoom.toFixed(1)}x zoom</span>
      <span style={styles.divider} />
      <span style={styles.chip}>{speed}x speed</span>
      {cropPreview && (
        <>
          <span style={styles.divider} />
          <span style={styles.chipAccent}>{previewAspect}</span>
        </>
      )}
      {lutFilename && (
        <>
          <span style={styles.divider} />
          <span style={styles.chip}>{lutFilename}</span>
        </>
      )}
    </div>
  );

  return (
    <CollapsibleToolbar collapsedContent={collapsedContent}>
      {/* Zoom */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Zoom">
          <ZoomIn size={14} />
        </span>
        <NumberStepper
          value={zoom}
          min={1.0}
          max={5.0}
          step={0.05}
          onChange={(v) => onUpdateFocalPoint({ ...clip.focal_point, zoom: v })}
        />
      </div>

      <div style={styles.separator} />

      {/* Speed */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Speed">
          <Gauge size={14} />
        </span>
        <NumberStepper
          value={speed}
          min={0.25}
          max={4.0}
          step={0.25}
          onChange={(v) => onUpdateEffects({ ...clip.effects, speed: v })}
        />
      </div>

      <div style={styles.separator} />

      {/* Crop preview toggle */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Crop">
          <Crop size={14} />
        </span>
        <button
          onClick={onToggleCropPreview}
          style={{
            ...styles.previewToggle,
            backgroundColor: cropPreview ? colors.accent : 'transparent',
            color: cropPreview ? '#000' : '#999',
          }}
          title={cropPreview ? 'Exit crop preview' : 'Preview crop'}
        >
          {cropPreview ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>

      <div style={styles.separator} />

      {/* Color Grade */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Color Grade">
          <Pipette size={14} />
        </span>
        <div style={styles.groupControls}>
          {lutFilename ? (
            <>
              <span style={styles.lutChip} title={clip.effects.color_lut ?? ''}>{lutFilename}</span>
              <button
                onClick={() => onUpdateEffects({ ...clip.effects, color_lut: null })}
                style={styles.lutClear}
              >
                <X size={10} />
              </button>
            </>
          ) : (
            <button onClick={handleSelectLut} style={styles.lutBtn}>
              Load LUT
            </button>
          )}
        </div>
      </div>
    </CollapsibleToolbar>
  );
}
