// WS9 §2 — Group-level source-format confirmation dialog.
//
// Appears after `import_media` returns, *before* the new clips land in
// project state. Groups the imported clips by `(camera_make, camera_model)`,
// surfaces WS8 suggestions per group, lets the user pick an override per
// group, and optionally remembers the choice for future imports of the
// same camera.
//
// The brief mock is reproduced verbatim in `WS9-source-format-ui.md` §2 —
// keep the heading order (count → detected → suggested → dropdown →
// remember checkbox) in lockstep with that mock.
//
// State machine:
//   - One `selection` map per group key. Defaults to:
//       1. matching preset, if any
//       2. else the group's suggested log class, if any
//       3. else "auto"
//   - One `remember` boolean per group key — only meaningful when the
//     group's `selection` is something other than "auto" (you can't
//     remember "use whatever you'd auto-detect"; that's the no-preset
//     baseline).

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type {
  CameraPreset,
  ClipMetadata,
  SourceColorClass,
} from '../types';
import SourceFormatPicker from './SourceFormatPicker';
import {
  cameraGroupKey,
  cameraGroupLabel,
  isLogClass,
  labelForSourceClass,
  type SourceFormatChoice,
} from '../lib/sourceFormat';

interface SourceFormatConfirmDialogProps {
  open: boolean;
  /** Freshly-imported metadata to group + confirm. */
  clips: ClipMetadata[];
  /** Loaded camera presets — drives default selection per group. */
  presets: CameraPreset[];
  onApply: (
    overrides: Map<string, SourceColorClass | null>,
    presetsToPersist: CameraPreset[],
  ) => void;
  onSkip: () => void;
}

/** One row in the dialog — a camera group's accumulated state. */
interface GroupRow {
  /** Stable key used as the map key in `selection` / `remember`. */
  key: string;
  /** Human label like "DJI Mavic 3" or "Unknown source". */
  label: string;
  /** Make/model strings used to write a preset on apply. Both may be
   *  empty for the Unknown group; in that case `canRemember` is false. */
  make: string;
  model: string;
  /** Every clip in this group (used to fan the override out on apply). */
  clips: ClipMetadata[];
  /** Headline detected class — the one that appears in "Detected: …".
   *  We use the first clip's class because every clip in a group shares
   *  make/model and (almost always) the same color regime; if they
   *  somehow diverge the first one is still a sensible headline. */
  detected: SourceColorClass;
  /** First non-null suggestion across the group's clips. Surfaced as
   *  "Suggested: …" with the amber warning glyph. */
  suggested: SourceColorClass | null;
  /** Matching preset, if any. Drives the "(from preset)" indicator and
   *  the default dropdown choice. */
  preset: CameraPreset | null;
  /** False for the Unknown group (empty make + model) — there's nothing
   *  identifiable to remember. Disables the checkbox. */
  canRemember: boolean;
}

function buildGroups(
  clips: ClipMetadata[],
  presets: CameraPreset[],
): GroupRow[] {
  const byKey = new Map<string, GroupRow>();
  for (const clip of clips) {
    const key = cameraGroupKey(clip);
    let row = byKey.get(key);
    if (!row) {
      const make = clip.camera_make?.trim() ?? '';
      const model = clip.camera_model?.trim() ?? '';
      const preset =
        make && model
          ? presets.find((p) => p.make === make && p.model === model) ?? null
          : null;
      row = {
        key,
        label: cameraGroupLabel(clip),
        make,
        model,
        clips: [],
        detected: clip.source_color_class,
        suggested: clip.suggested_log_class ?? null,
        preset,
        canRemember: !!(make && model),
      };
      byKey.set(key, row);
    }
    row.clips.push(clip);
    // Promote a suggestion if the row's headline clip didn't have one but
    // a later clip in the group does.
    if (!row.suggested && clip.suggested_log_class) {
      row.suggested = clip.suggested_log_class;
    }
  }
  // Order: identified groups first (alphabetical by label), unknown last.
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.key === '__unknown__') return 1;
    if (b.key === '__unknown__') return -1;
    return a.label.localeCompare(b.label);
  });
}

function defaultChoiceFor(row: GroupRow): SourceFormatChoice {
  if (row.preset) return row.preset.color_class;
  if (row.suggested) return row.suggested;
  return 'auto';
}

export default function SourceFormatConfirmDialog({
  open,
  clips,
  presets,
  onApply,
  onSkip,
}: SourceFormatConfirmDialogProps) {
  // Stable group construction — the dialog stays mounted while the user
  // is interacting, so deriving once per props change is fine.
  const groups = useMemo(() => buildGroups(clips, presets), [clips, presets]);

  // Per-group selection + remember state. Keyed by `GroupRow.key` so the
  // identity stays stable across re-renders.
  const [selection, setSelection] = useState<Map<string, SourceFormatChoice>>(
    () => new Map(groups.map((g) => [g.key, defaultChoiceFor(g)])),
  );
  const [remember, setRemember] = useState<Map<string, boolean>>(
    () => new Map(groups.map((g) => [g.key, false])),
  );

  // Rebuild state when the props change (a fresh import opens a fresh
  // dialog). Without this guard the second import would keep the prior
  // import's selection map. The signature avoids resetting state when
  // the user is mid-interaction and only the parent re-rendered.
  const groupKeysSig = useMemo(
    () => groups.map((g) => g.key).join('|'),
    [groups],
  );
  useEffect(() => {
    setSelection(new Map(groups.map((g) => [g.key, defaultChoiceFor(g)])));
    setRemember(new Map(groups.map((g) => [g.key, false])));
    // groups is derived from groupKeysSig; the sig is the stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKeysSig]);

  if (!open) return null;

  const handleApply = () => {
    const overrides = new Map<string, SourceColorClass | null>();
    const presetsToPersist: CameraPreset[] = [];
    for (const group of groups) {
      const choice = selection.get(group.key) ?? 'auto';
      const overrideClass: SourceColorClass | null =
        choice === 'auto' ? null : choice;
      for (const clip of group.clips) {
        overrides.set(clip.id, overrideClass);
      }
      // Only persist when the user opted in AND the group has a remembrable
      // identity AND the choice is something other than "auto" (a preset
      // for "use whatever you'd detect" is meaningless).
      if (
        remember.get(group.key) &&
        group.canRemember &&
        overrideClass !== null
      ) {
        presetsToPersist.push({
          make: group.make,
          model: group.model,
          color_class: overrideClass,
        });
      }
    }
    onApply(overrides, presetsToPersist);
  };

  return (
    <div
      style={overlayStyle}
      data-testid="source-format-confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="source-format-confirm-title"
    >
      <div style={panelStyle}>
        <div style={headerStyle}>
          <h2 id="source-format-confirm-title" style={titleStyle}>
            Confirm source formats
          </h2>
          <p style={subtitleStyle}>
            TrailCut detected the following camera groups. Log formats can't be
            auto-detected — confirm or override below before proxies render.
          </p>
        </div>

        <div style={groupsListStyle}>
          {groups.map((group) => {
            const choice = selection.get(group.key) ?? 'auto';
            const effective: SourceColorClass =
              choice === 'auto'
                ? group.detected
                : choice;
            const willApplyLogLut = isLogClass(effective);
            const isPresetMatched =
              group.preset !== null && choice === group.preset.color_class;
            const triggerLabel =
              choice === 'auto'
                ? `Auto (uses detected: ${labelForSourceClass(group.detected)})`
                : labelForSourceClass(choice) +
                  (isPresetMatched ? ' (from preset)' : '');

            return (
              <div
                key={group.key}
                style={groupCardStyle}
                data-testid={`source-format-group-${group.key}`}
              >
                <div style={groupHeaderRowStyle}>
                  <div style={groupCountStyle}>
                    {group.clips.length}{' '}
                    {group.clips.length === 1 ? 'clip' : 'clips'} ·{' '}
                    <strong>{group.label}</strong>
                  </div>
                </div>
                <div style={groupDetailRowStyle}>
                  <span style={detailLabelStyle}>Detected:</span>{' '}
                  <span style={detailValueStyle}>
                    {labelForSourceClass(group.detected)}
                  </span>
                  {group.suggested && (
                    <>
                      <span style={detailSeparatorStyle}>·</span>
                      <span style={suggestedLabelStyle}>
                        Suggested: {labelForSourceClass(group.suggested)}
                      </span>
                    </>
                  )}
                  {group.preset && (
                    <>
                      <span style={detailSeparatorStyle}>·</span>
                      <span style={presetLabelStyle}>
                        Preset: {labelForSourceClass(group.preset.color_class)}
                      </span>
                    </>
                  )}
                </div>
                <div style={groupControlsRowStyle}>
                  <span style={dropdownLabelStyle}>Source format:</span>
                  <SourceFormatPicker
                    value={choice}
                    onChange={(next) =>
                      setSelection((prev) => {
                        const copy = new Map(prev);
                        copy.set(group.key, next);
                        return copy;
                      })
                    }
                    triggerLabel={triggerLabel}
                    minWidth={260}
                    testId={`group-source-format-${group.key}`}
                  />
                </div>
                {group.canRemember && (
                  <div style={rememberRowStyle}>
                    <label
                      style={rememberLabelStyle}
                      title={
                        choice === 'auto'
                          ? 'Pick a specific format to remember; "Auto" is the no-preset baseline.'
                          : `Remember "${labelForSourceClass(effective)}" for future ${group.label} imports`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={remember.get(group.key) ?? false}
                        disabled={choice === 'auto'}
                        onChange={(e) =>
                          setRemember((prev) => {
                            const copy = new Map(prev);
                            copy.set(group.key, e.target.checked);
                            return copy;
                          })
                        }
                        data-testid={`group-remember-${group.key}`}
                      />
                      Remember this for future {group.label} imports
                    </label>
                  </div>
                )}
                {willApplyLogLut && choice !== 'auto' && (
                  <div style={logHintStyle}>
                    LUT-based development chain will run at proxy + export time.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={onSkip}
            style={skipButtonStyle}
            data-testid="source-format-skip"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={handleApply}
            style={applyButtonStyle}
            data-testid="source-format-apply"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- styles --------------------------------------------------------

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};

const panelStyle: CSSProperties = {
  backgroundColor: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: 8,
  width: 'min(720px, 100%)',
  maxHeight: 'calc(100vh - 48px)',
  display: 'flex',
  flexDirection: 'column',
  color: '#ddd',
  fontFamily: 'inherit',
};

const headerStyle: CSSProperties = {
  padding: '20px 24px 12px',
  borderBottom: '1px solid #2a2a2a',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: '#fff',
};

const subtitleStyle: CSSProperties = {
  margin: '6px 0 0',
  fontSize: 12,
  color: '#888',
  lineHeight: 1.5,
};

const groupsListStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '12px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const groupCardStyle: CSSProperties = {
  border: '1px solid #2a2a2a',
  borderRadius: 6,
  padding: '12px 14px',
  backgroundColor: '#181818',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const groupHeaderRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 13,
};

const groupCountStyle: CSSProperties = {
  color: '#ccc',
};

const groupDetailRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
  fontSize: 12,
  color: '#888',
};

const detailLabelStyle: CSSProperties = {
  color: '#666',
};

const detailValueStyle: CSSProperties = {
  color: '#bbb',
};

const detailSeparatorStyle: CSSProperties = {
  color: '#444',
  margin: '0 2px',
};

const suggestedLabelStyle: CSSProperties = {
  color: '#e8b86a',
};

const presetLabelStyle: CSSProperties = {
  color: '#7fb3e8',
};

const groupControlsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const dropdownLabelStyle: CSSProperties = {
  fontSize: 12,
  color: '#888',
  minWidth: 100,
};

const rememberRowStyle: CSSProperties = {
  fontSize: 12,
  color: '#888',
};

const rememberLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
};

const logHintStyle: CSSProperties = {
  fontSize: 11,
  color: '#7fc89a',
  padding: '4px 8px',
  backgroundColor: 'rgba(74, 124, 89, 0.12)',
  border: '1px solid rgba(74, 124, 89, 0.3)',
  borderRadius: 4,
};

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 24px 18px',
  borderTop: '1px solid #2a2a2a',
};

const skipButtonStyle: CSSProperties = {
  padding: '8px 18px',
  border: '1px solid #444',
  backgroundColor: 'transparent',
  color: '#bbb',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const applyButtonStyle: CSSProperties = {
  padding: '8px 18px',
  border: '1px solid #4a7c59',
  backgroundColor: 'rgba(74, 124, 89, 0.25)',
  color: '#bced09',
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
