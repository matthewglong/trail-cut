use crate::models::*;
use crate::util::exiftool::format_clip_date;
use crate::util::fs::recent_projects_path;
use std::path::Path;

/// Get list of recent projects
#[tauri::command]
pub fn get_recent_projects() -> Result<Vec<RecentProject>, String> {
    let path = recent_projects_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read recent projects: {}", e))?;
    let projects: Vec<RecentProject> = serde_json::from_str(&content).unwrap_or_default();
    // Filter out projects whose directories no longer exist, backfill missing fields
    let valid: Vec<RecentProject> = projects
        .into_iter()
        .filter(|p| Path::new(&p.path).join("project.json").exists())
        .map(|mut p| {
            if p.first_clip_date.is_none() {
                let project_json = Path::new(&p.path).join("project.json");
                if let Ok(content) = std::fs::read_to_string(&project_json) {
                    if let Ok(project) = serde_json::from_str::<Project>(&content) {
                        p.first_clip_date = project.clips.first()
                            .and_then(|c| c.created_at.as_ref())
                            .and_then(|d| format_clip_date(d));
                    }
                }
            }
            p
        })
        .collect();
    Ok(valid)
}

/// Register a project as recently opened
#[tauri::command]
pub fn register_recent_project(project_dir: String) -> Result<(), String> {
    let path = recent_projects_path()?;
    let mut projects: Vec<RecentProject> = if path.exists() {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Remove existing entry for this path
    projects.retain(|p| p.path != project_dir);

    // Read project metadata from project.json
    let project_json_path = Path::new(&project_dir).join("project.json");
    let (clip_count, project_name, thumbnail, first_clip_date) = if project_json_path.exists() {
        let content = std::fs::read_to_string(&project_json_path).unwrap_or_default();
        let project: Project = serde_json::from_str(&content).unwrap_or_default();
        let count = project.clips.len() as u32;
        let name = if project.name.is_empty() {
            Path::new(&project_dir)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Untitled")
                .replace(".trailcut", "")
        } else {
            project.name
        };
        let thumb = project.thumbnail.filter(|t| Path::new(t).exists());
        let clip_date = project.clips.first()
            .and_then(|c| c.created_at.as_ref())
            .and_then(|d| format_clip_date(d));
        (count, name, thumb, clip_date)
    } else {
        let name = Path::new(&project_dir)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Untitled")
            .replace(".trailcut", "");
        (0, name, None, None)
    };

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();

    projects.insert(0, RecentProject {
        path: project_dir,
        name: project_name,
        clip_count,
        last_opened: now,
        thumbnail,
        first_clip_date,
    });


    let json = serde_json::to_string_pretty(&projects)
        .map_err(|e| format!("Failed to serialize recent projects: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write recent projects: {}", e))?;

    Ok(())
}
