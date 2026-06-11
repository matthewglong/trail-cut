use std::path::{Path, PathBuf};

pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))
}

pub fn global_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "Cannot determine home directory")?;
    let dir = PathBuf::from(home).join(".trailcut");
    ensure_dir(&dir)?;
    Ok(dir)
}

pub fn recent_projects_path() -> Result<PathBuf, String> {
    Ok(global_config_dir()?.join("recent.json"))
}

/// Path to the global per-camera source-format preset store (WS9). One JSON
/// file at `~/.trailcut/camera_presets.json`, shared across all projects on
/// the machine — the brief calls out single-user-app as scope, so no
/// sync-across-machines concern. The Tauri commands in
/// `commands::camera_presets` read/write this file directly.
pub fn camera_presets_path() -> Result<PathBuf, String> {
    Ok(global_config_dir()?.join("camera_presets.json"))
}

/// Atomically replace `path` with `contents`.
///
/// Writes to a temp file in the SAME directory (a cross-filesystem rename is
/// neither atomic nor guaranteed to succeed), fsyncs it, then renames it over
/// the target. On POSIX a same-directory rename is atomic; on Windows,
/// `std::fs::rename` maps to `MoveFileExW(.., MOVEFILE_REPLACE_EXISTING)`.
/// Either way a crash, kill, or full disk mid-save leaves the OLD complete
/// file or the NEW complete file — never a truncated hybrid.
///
/// Ship review Phase 2a: `project.json` (the only copy of a user's edit
/// state) was previously `std::fs::write`'n in place, so an interrupted save
/// could destroy the project.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("No parent directory for {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid file name in {}", path.display()))?;
    let tmp = dir.join(format!(".{}.tmp", file_name));

    let mut file = std::fs::File::create(&tmp)
        .map_err(|e| format!("Failed to create {}: {}", tmp.display(), e))?;
    let written = file
        .write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Failed to write {}: {}", tmp.display(), e));
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace {}: {}", path.display(), e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trailcut-fs-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_creates_a_new_file() {
        let dir = scratch_dir("create");
        let path = dir.join("project.json");
        write_atomic(&path, b"fresh").expect("write must succeed");
        assert_eq!(std::fs::read(&path).unwrap(), b"fresh");
        assert!(
            !dir.join(".project.json.tmp").exists(),
            "temp file must be renamed away, not left behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_replaces_existing_content_and_cleans_tmp() {
        let dir = scratch_dir("replace");
        let path = dir.join("project.json");
        std::fs::write(&path, b"old project state").unwrap();
        write_atomic(&path, b"new project state").expect("replace must succeed");
        assert_eq!(std::fs::read(&path).unwrap(), b"new project state");
        assert!(
            !dir.join(".project.json.tmp").exists(),
            "temp file must be renamed away, not left behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_fails_loud_when_directory_is_missing() {
        let dir = scratch_dir("missing").join("does-not-exist");
        let path = dir.join("project.json");
        let err = write_atomic(&path, b"x").expect_err("must fail");
        assert!(
            err.contains("Failed to create"),
            "error must name the failing step, got: {err}"
        );
    }
}
