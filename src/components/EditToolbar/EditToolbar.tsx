import { ZoomIn, Gauge, Crop, Palette } from 'lucide-react';
import type { Clip, FocalPoint, Effects, SourceColorClass } from '../../types';
import NumberStepper from '../NumberStepper';
import Toolbar from '../Toolbar';
import ModePicker from '../ModePicker';
import SourceFormatPicker from '../SourceFormatPicker';
import {
  badgeForClip,
  effectiveSourceClass,
  labelForSourceClass,
  type SourceFormatChoice,
} from '../../lib/sourceFormat';
import { styles } from './styles';

const RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const;
type Ratio = typeof RATIOS[number];
const RATIO_OPTIONS = RATIOS.map((r) => ({ value: r, label: r }));

interface EditToolbarProps {
  clip: Clip | null;
  onUpdateFocalPoint: (fp: FocalPoint) => void;
  onUpdateEffects: (effects: Effects) => void;
  /** WS9 — write `user_color_class_override` on the clip. `null` clears the
   *  override (dropdown went back to "Auto"). The handler is also responsible
   *  for firing proxy regeneration — see `useProject.handleUpdateSourceFormat`. */
  onUpdateSourceFormat: (override: SourceColorClass | null) => void;
  previewAspect: string;
  onChangeAspect: (aspect: string) => void;
  cropPreview: boolean;
  onToggleCropPreview: () => void;
}

export default function EditToolbar({
  clip,
  onUpdateFocalPoint,
  onUpdateEffects,
  onUpdateSourceFormat,
  previewAspect,
  onChangeAspect,
  cropPreview,
  onToggleCropPreview,
}: EditToolbarProps) {
  if (!clip) return null;

  const zoom = clip.focal_point.zoom;
  const speed = clip.effects.speed;

  // WS9 — Source-format picker state derived from the clip's color fields.
  // `effectiveClass` is what the pipeline will actually use (override > auto);
  // `dropdownChoice` is what the dropdown shows ("auto" when no override).
  const effectiveClass = effectiveSourceClass(clip);
  const dropdownChoice: SourceFormatChoice =
    clip.user_color_class_override ?? 'auto';
  const badge = badgeForClip(clip);

  // Trigger label composes the dropdown choice with the auto-detected class
  // for the "Auto" row, mirroring the WS9 brief mock:
  //     Source format: [ Auto (detected: HLG BT.2020) ▼ ]
  // Overridden clips just show the override; suggested clips fall under
  // "Auto (detected: …)" — the amber badge handles the affordance.
  const triggerLabel =
    dropdownChoice === 'auto'
      ? `Auto (detected: ${labelForSourceClass(clip.source_color_class)})`
      : labelForSourceClass(effectiveClass);

  const badgeStyle =
    badge === 'overridden'
      ? styles.badgeOverridden
      : badge === 'suggested'
        ? styles.badgeSuggested
        : styles.badgeDetected;
  const badgeText =
    badge === 'overridden'
      ? 'OVERRIDE'
      : badge === 'suggested'
        ? `SUGGESTED: ${labelForSourceClass(clip.suggested_log_class!)}`
        : 'DETECTED';
  const badgeTitle =
    badge === 'overridden'
      ? `User-set source format: ${labelForSourceClass(effectiveClass)}`
      : badge === 'suggested'
        ? `This camera typically records in ${labelForSourceClass(clip.suggested_log_class!)} — confirm via the dropdown to apply the LUT`
        : `Auto-detected from color metadata: ${labelForSourceClass(clip.source_color_class)}`;

  const handleSourceFormatChange = (next: SourceFormatChoice) => {
    onUpdateSourceFormat(next === 'auto' ? null : next);
  };

  return (
    <Toolbar>
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
          max={100.0}
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
        <ModePicker<Ratio>
          value={(RATIOS.includes(previewAspect as Ratio) ? previewAspect : RATIOS[0]) as Ratio}
          options={RATIO_OPTIONS}
          onChange={onChangeAspect}
          title="Aspect ratio"
          minWidth={56}
        />
      </div>

      <div style={styles.separator} />

      {/* WS9 — Source format. Dropdown lets the user declare or override the
          clip's color regime; badge surfaces whether it's auto-detected,
          suggested (WS8), or user-overridden. */}
      <div style={styles.group}>
        <span style={styles.groupLabel} title="Source color format">
          <Palette size={15} strokeWidth={2} />
        </span>
        <SourceFormatPicker
          value={dropdownChoice}
          onChange={handleSourceFormatChange}
          triggerLabel={triggerLabel}
          title={badgeTitle}
          testId="clip-source-format"
        />
        <span
          style={badgeStyle}
          title={badgeTitle}
          data-testid="clip-source-format-badge"
        >
          {badgeText}
        </span>
      </div>
    </Toolbar>
  );
}
