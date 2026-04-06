use crate::models::*;
use crate::util::exiftool::{is_video_file, run_exiftool};
use std::path::Path;

/// Scan a directory for video files and extract metadata via ExifTool
#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<ClipMetadata>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut video_files: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if is_video_file(&path) {
            if let Some(p) = path.to_str() {
                video_files.push(p.to_string());
            }
        }
    }

    run_exiftool(&video_files)
}

/// Import videos from any mix of files and directories
#[tauri::command]
pub fn import_media(paths: Vec<String>) -> Result<Vec<ClipMetadata>, String> {
    let mut video_files: Vec<String> = Vec::new();

    for p in paths {
        let path = Path::new(&p);
        if !path.exists() {
            continue;
        }
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let entry_path = entry.path();
                    if is_video_file(&entry_path) {
                        if let Some(s) = entry_path.to_str() {
                            video_files.push(s.to_string());
                        }
                    }
                }
            }
        } else if is_video_file(path) {
            video_files.push(p);
        }
    }

    run_exiftool(&video_files)
}
