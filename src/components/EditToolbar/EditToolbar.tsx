import { ZoomIn, Gauge, Crop } from 'lucide-react';
import type { Clip, FocalPoint, Effects } from '../../types';
import NumberStepper from './NumberStepper';
import CollapsibleToolbar from '../CollapsibleToolbar';
import AspectRatioPicker from '../AspectRatioPicker';
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
  onChangeAspect,
  cropPreview,
  onToggleCropPreview,
}: EditToolbarProps) {
  if (!clip) return null;

  const zoom = clip.focal_point.zoom;
  const speed = clip.effects.speed;

  const collapsedContent = (
    <div style={styles.chipRow}>
      <span style={styles.chip}>{zoom.toFixed(1)}x zoom</span>
      <span style={styles.divider} />
      <span style={styles.chip}>{speed}x speed</span>
      <span style={styles.divider} />
      <span style={styles.chipAccent}>{previewAspect}</span>
    </div>
  );

  return (
    <CollapsibleToolbar collapsedContent={collapsedContent}>
      {/* Zoom */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Zoom">
          <ZoomIn size={15} strokeWidth={2} />
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
          <Gauge size={15} strokeWidth={2} />
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

      {/* Crop edit/preview toggle */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Crop">
          <Crop size={15} strokeWidth={2} />
        </span>
        <div
          onClick={onToggleCropPreview}
          style={cropPreview ? styles.previewPillOn : styles.previewPillOff}
          title={cropPreview ? 'Exit crop preview' : 'Preview crop'}
        >
          <span style={cropPreview ? styles.previewDotOn : styles.previewDotOff} />
          <span>PREVIEW</span>
        </div>
      </div>

      <div style={styles.separator} />

      {/* Aspect ratio picker */}
      <div style={styles.group}>
        <AspectRatioPicker
          value={previewAspect}
          onChange={onChangeAspect}
        />
      </div>
    </CollapsibleToolbar>
  );
}
