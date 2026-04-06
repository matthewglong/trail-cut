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
