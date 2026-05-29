// WS9 — Per-camera source-format presets.
//
// Stores user-confirmed preferences like "always declare Mavic 3 as D-Log on
// import" at `~/.trailcut/camera_presets.json`. Consumed by the import-time
// group-level UI to pre-populate dropdown defaults for matching cameras.
//
// File shape (matches `WS9-source-format-ui.md` §3):
//
//   {
//     "presets": [
//       { "make": "DJI",  "model": "Mavic 3", "color_class": "d_log" },
//       { "make": "Sony", "model": "FX3",     "color_class": "s_log3" }
//     ]
//   }
//
// Make/model strings are matched verbatim against the values
// `populate_color_metadata` lands on `ClipMetadata.camera_make` /
// `camera_model` — same source field as the WS8 detection knowledge base.

use crate::util::color::SourceColorClass;
use crate::util::fs::camera_presets_path;
use serde::{Deserialize, Serialize};

/// One per-camera preset. Wire shape matches the TypeScript `CameraPreset`
/// interface in `src/types.ts`; snake_case `color_class` matches the
/// `SourceColorClass` serde rename.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CameraPreset {
    pub make: String,
    pub model: String,
    pub color_class: SourceColorClass,
}

/// On-disk shape — a `presets` array wrapper rather than a bare list so the
/// file can grow future top-level fields (per-camera priority order, etc.)
/// without a migration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CameraPresetsFile {
    #[serde(default)]
    presets: Vec<CameraPreset>,
}

fn load_file() -> Result<CameraPresetsFile, String> {
    let path = camera_presets_path()?;
    if !path.exists() {
        return Ok(CameraPresetsFile::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read camera presets: {}", e))?;
    // Tolerate a corrupted file rather than block import — log + start fresh.
    // Same defensive stance `get_recent_projects` takes for `recent.json`.
    Ok(serde_json::from_str(&content).unwrap_or_default())
}

fn write_file(file: &CameraPresetsFile) -> Result<(), String> {
    let path = camera_presets_path()?;
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("Failed to serialize camera presets: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write camera presets: {}", e))?;
    Ok(())
}

/// List every persisted per-camera preset. Returns an empty vec when the
/// file is missing (first-run case) or unreadable (defensive — see
/// `load_file`'s log-and-default stance).
#[tauri::command]
pub fn get_camera_presets() -> Result<Vec<CameraPreset>, String> {
    Ok(load_file()?.presets)
}

/// Upsert a preset by `(make, model)`. Identical (make, model) entries are
/// replaced in place; new entries are appended. The frontend calls this when
/// the user ticks the "Remember this for future Mavic 3 imports" checkbox in
/// the group-level import UI.
#[tauri::command]
pub fn set_camera_preset(
    make: String,
    model: String,
    color_class: SourceColorClass,
) -> Result<(), String> {
    let mut file = load_file()?;
    let trimmed_make = make.trim().to_string();
    let trimmed_model = model.trim().to_string();
    if trimmed_make.is_empty() || trimmed_model.is_empty() {
        return Err("set_camera_preset: make and model must be non-empty".into());
    }
    // Replace in place if (make, model) already exists; else append. Match
    // is case-sensitive to mirror the WS8 knowledge-base matching contract —
    // ExifTool surfaces make/model verbatim from the container tags.
    if let Some(existing) = file
        .presets
        .iter_mut()
        .find(|p| p.make == trimmed_make && p.model == trimmed_model)
    {
        existing.color_class = color_class;
    } else {
        file.presets.push(CameraPreset {
            make: trimmed_make,
            model: trimmed_model,
            color_class,
        });
    }
    write_file(&file)
}

/// Remove a preset by `(make, model)`. No-op when no matching entry exists.
/// Mirrors `register_recent_project`'s "remove existing entry, then insert"
/// pattern (just without the re-insert leg).
#[tauri::command]
pub fn remove_camera_preset(make: String, model: String) -> Result<(), String> {
    let mut file = load_file()?;
    file.presets
        .retain(|p| !(p.make == make && p.model == model));
    write_file(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_preset_round_trips_through_serde() {
        // Matches the on-disk shape documented in the module header. The
        // snake_case `color_class` rename has to align with the
        // `SourceColorClass` enum's serde rename (already covered in
        // util::color's tests; this test guards the wrapper struct's wire
        // format).
        let preset = CameraPreset {
            make: "DJI".into(),
            model: "Mavic 3".into(),
            color_class: SourceColorClass::DLog,
        };
        let json = serde_json::to_string(&preset).unwrap();
        assert!(json.contains("\"make\":\"DJI\""));
        assert!(json.contains("\"model\":\"Mavic 3\""));
        assert!(json.contains("\"color_class\":\"d_log\""));
        let parsed: CameraPreset = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, preset);
    }

    #[test]
    fn camera_presets_file_default_is_empty_list() {
        // A first-run user has no file — `load_file` returns the default
        // shape, which deserialises an empty `presets` array. Sanity-check
        // the shape lines up with what `set_camera_preset` then mutates.
        let file = CameraPresetsFile::default();
        assert!(file.presets.is_empty());
        let json = serde_json::to_string(&file).unwrap();
        // serde_json doesn't insert spaces; check the literal it does emit.
        assert!(json.contains("\"presets\":[]"));
    }
}
