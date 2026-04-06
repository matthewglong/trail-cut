use crate::models::*;
use crate::util::fs::ensure_dir;
use std::path::Path;

/// Create a new project bundle directory
#[tauri::command]
pub fn create_project(project_dir: String) -> Result<(), String> {
    let dir = Path::new(&project_dir);
    ensure_dir(dir)?;
    ensure_dir(&dir.join("proxies"))?;
    ensure_dir(&dir.join("thumbnails"))?;

    let project = Project::default();
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(dir.join("project.json"), json)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;

    Ok(())
}

/// Save project to project bundle
#[tauri::command]
pub fn save_project(project: Project, project_dir: String) -> Result<(), String> {
    let path = Path::new(&project_dir).join("project.json");
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write project file: {}", e))?;
    Ok(())
}

/// Load project from project bundle
#[tauri::command]
pub fn load_project(project_dir: String) -> Result<Project, String> {
    let path = Path::new(&project_dir).join("project.json");
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read project file: {}", e))?;
    let project: Project =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;
    Ok(project)
}

/// Rename a project by updating its name in project.json
#[tauri::command]
pub fn rename_project(project_dir: String, new_name: String) -> Result<(), String> {
    let project_json = Path::new(&project_dir).join("project.json");
    let content = std::fs::read_to_string(&project_json)
        .map_err(|e| format!("Failed to read project: {}", e))?;
    let mut project: Project = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse project: {}", e))?;

    project.name = new_name;

    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(&project_json, json)
        .map_err(|e| format!("Failed to write project: {}", e))?;

    // Update recent projects entry
    super::recent::register_recent_project(project_dir)?;

    Ok(())
}

/// Delete a project directory and remove it from recent projects
#[tauri::command]
pub fn delete_project(project_dir: String) -> Result<(), String> {
    let dir = Path::new(&project_dir);
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|e| format!("Failed to delete project: {}", e))?;
    }

    // Remove from recent projects
    let path = crate::util::fs::recent_projects_path()?;
    if path.exists() {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let mut projects: Vec<RecentProject> = serde_json::from_str(&content).unwrap_or_default();
        projects.retain(|p| p.path != project_dir);
        let json = serde_json::to_string_pretty(&projects)
            .map_err(|e| format!("Failed to serialize recent projects: {}", e))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write recent projects: {}", e))?;
    }

    Ok(())
}
