# WS9 — Source Format UI

**Phase:** 2
**Blocks:** none (final Phase 2 workstream)
**Blocked by:** WS8 (detection results), WS10 (LUT formulas to apply when user accepts)
**Estimated scope:** medium-large — per-clip UI, per-group import UI, per-camera preset persistence

## Goal

Let users declare or override the source color format for clips. Three surfaces:
1. **Per-clip dropdown** in the Inspector — show detected + suggested, allow override.
2. **Per-group setting at import time** — "32 clips from DJI Mavic 3 — set source format for all".
3. **Per-camera persisted preset** — "always declare Mavic 3 as D-Log on import".

This is the workflow that makes log support actually usable. Per-clip declaration of 50 clips is unacceptable; group-level is the only way.

## Context

Read first:
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Phase 2 section.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 6 (group-level declaration).
- [`WS8-log-detection.md`](WS8-log-detection.md) — what suggestions to display.
- [`WS10-log-luts.md`](WS10-log-luts.md) — what happens when user accepts a log declaration.

## Files to modify

| File | Change |
|---|---|
| `src/components/<clip inspector>` | Add "Source format" dropdown per clip. |
| `src/components/<import flow>` | Add group-level format declaration step after metadata extraction. |
| `~/.trailcut/camera_presets.json` (new) | Persist per-camera user preferences. |
| `src-tauri/src/commands.rs` | New Tauri commands: `get_camera_presets`, `set_camera_preset`. |
| `src-tauri/src/models.rs` | Already has `user_color_class_override` from WS0. |

## Implementation

### 1. Per-clip dropdown

In the clip inspector (find the existing component — likely `src/components/EditToolbar/` or similar):

```
Source format: [ Auto (detected: HLG BT.2020) ▼ ]
```

Dropdown options:
- **Auto** — use detected class.
- **Rec.709 SDR**
- **HLG BT.2020 HDR**
- **PQ BT.2020 HDR**
- **Dolby Vision**
- *(divider)*
- **D-Log (DJI)** ⚠️ *Suggested* (if WS8 returned this as suggestion)
- **C-Log / C-Log2 / C-Log3 (Canon)**
- **GP-Log (GoPro)**
- **V-Log (Panasonic)**
- **S-Log2 / S-Log3 (Sony)**

Selecting anything other than "Auto" sets `user_color_class_override` on the clip. Selecting "Auto" clears it.

Show a small badge next to the dropdown label when the effective class differs from the suggestion or the auto-detected class:
- **Detected**: green badge.
- **Suggested (not confirmed)**: amber badge with tooltip "This camera typically records in D-Log — confirm to apply LUT".
- **User-overridden**: blue badge.

### 2. Group-level import UI

After clips are imported and metadata extracted (current import flow), insert a new step **before** the project view opens:

```
┌─────────────────────────────────────────────────────────────┐
│  Confirm source formats                                     │
│                                                             │
│  TrailCut detected the following camera groups:             │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 12 clips · iPhone 15 Pro                             │   │
│  │ Detected: HLG BT.2020 HDR ✓                          │   │
│  │ Source format: [ Auto ▼ ]                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 32 clips · DJI Mavic 3                               │   │
│  │ Detected: Rec.709 SDR                                │   │
│  │ Suggested: D-Log ⚠                                   │   │
│  │ Source format: [ D-Log (suggested) ▼ ]               │   │
│  │ [ ] Remember this for future Mavic 3 imports         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 6 clips · GoPro HERO 12                              │   │
│  │ Detected: HLG BT.2020 HDR ✓                          │   │
│  │ Source format: [ Auto ▼ ]                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│                                          [ Skip ] [ Apply ] │
└─────────────────────────────────────────────────────────────┘
```

Grouping key: `(camera_make, camera_model)` from `ClipMetadata`. Clips with no make/model go in an "Unknown source" group at the bottom.

For each group:
- Show count, camera identifier, detected class, suggested class (if WS8 returned one).
- Dropdown defaults to suggested if available, else Auto.
- Optional checkbox to remember this preference for future imports of the same camera.

"Apply" writes `user_color_class_override` to every clip in groups where the dropdown is set to something other than "Auto". Also persists camera presets if the checkbox is ticked.

"Skip" leaves all clips with their auto-detected class (no override). User can still adjust per-clip later.

### 3. Per-camera preset persistence

Store at `~/.trailcut/camera_presets.json`:

```json
{
  "presets": [
    { "make": "DJI", "model": "Mavic 3", "color_class": "d_log" },
    { "make": "Sony", "model": "FX3", "color_class": "s_log3" }
  ]
}
```

New Tauri commands:
- `get_camera_presets() -> Vec<CameraPreset>`
- `set_camera_preset(make, model, color_class)`
- `remove_camera_preset(make, model)`

At import time, after WS8 detection runs but before the group-level UI shows, apply presets: if a clip's `(make, model)` matches a preset, pre-set the dropdown default to the preset value. Show a small "(from preset)" indicator.

### 4. Settings page (optional, deferred to follow-up)

A settings panel listing all stored camera presets with "edit"/"remove" actions. Not required for this workstream — can be added later. Users can edit `camera_presets.json` directly if needed.

## Acceptance criteria

- [ ] Per-clip dropdown shows all source format options.
- [ ] Selecting an option sets `user_color_class_override` on the clip and triggers proxy regeneration (because the ingest formula changed).
- [ ] Group-level import UI appears after metadata extraction.
- [ ] Groups are correctly partitioned by `(camera_make, camera_model)`.
- [ ] Suggested log formats from WS8 appear as dropdown default.
- [ ] "Remember" checkbox persists the preset.
- [ ] On subsequent imports, matching cameras use the stored preset automatically.
- [ ] Skip button leaves clips unchanged.
- [ ] Clearing user override (selecting "Auto") clears `user_color_class_override`.
- [ ] All UI changes match existing TrailCut design language.

## Out of scope

- Bulk re-grade of existing projects after preset changes (only affects new imports).
- Sharing presets across machines (single-user app).
- A full settings page for preset management (deferred).
- Per-shoot/per-folder presets beyond per-camera (deferred).

## References

- [`WS8-log-detection.md`](WS8-log-detection.md) — detection results consumed here.
- [`WS10-log-luts.md`](WS10-log-luts.md) — what happens when user accepts a log declaration.
- [`../background/design-decisions.md`](../background/design-decisions.md) — Decision 6.
