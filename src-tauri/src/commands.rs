use crate::models::*;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

const VIDEO_EXTENSIONS: &[&str] = &["mov", "mp4", "m4v", "MOV", "MP4", "M4V"];

fn global_config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "Cannot determine home directory")?;
    let dir = PathBuf::from(home).join(".trailcut");
    ensure_dir(&dir)?;
    Ok(dir)
}

fn recent_projects_path() -> Result<PathBuf, String> {
    Ok(global_config_dir()?.join("recent.json"))
}

fn path_hash(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Parse an ExifTool date string and format as "Jan 1, 2024"
fn format_clip_date(raw: &str) -> Option<String> {
    // ExifTool dates: "2024:01:15 10:30:00-07:00" or "2024:01:15 10:30:00"
    let date_part = raw.split(' ').next()?;
    let parts: Vec<&str> = date_part.split(':').collect();
    if parts.len() < 3 { return None; }
    let year: u32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;
    let month_name = match month {
        1 => "Jan", 2 => "Feb", 3 => "Mar", 4 => "Apr",
        5 => "May", 6 => "Jun", 7 => "Jul", 8 => "Aug",
        9 => "Sep", 10 => "Oct", 11 => "Nov", 12 => "Dec",
        _ => return None,
    };
    Some(format!("{} {}, {}", month_name, day, year))
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))
}

/// Shared ExifTool runner — takes a list of video file paths, returns metadata
fn run_exiftool(video_files: &[String]) -> Result<Vec<ClipMetadata>, String> {
    if video_files.is_empty() {
        return Ok(Vec::new());
    }

    let mut cmd = Command::new("exiftool");
    cmd.arg("-json")
        .arg("-GPSLatitude")
        .arg("-GPSLongitude")
        .arg("-CreationDate")
        .arg("-CreateDate")
        .arg("-MediaCreateDate")
        .arg("-Duration")
        .arg("-ImageSize")
        .arg("-VideoFrameRate")
        .arg("-n");

    for file in video_files {
        cmd.arg(file);
    }

    let output = cmd.output().map_err(|e| format!("Failed to run exiftool: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ExifTool error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: Vec<Value> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse ExifTool JSON: {}", e))?;

    let mut clips: Vec<ClipMetadata> = json
        .iter()
        .map(|item| {
            let file_path = item["SourceFile"].as_str().unwrap_or("").to_string();
            let filename = Path::new(&file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // CreationDate has the actual filming time with timezone (iPhone).
            // CreateDate/MediaCreateDate can be corrupted by AirDrop/file transfer.
            let created_at = item["CreationDate"]
                .as_str()
                .or_else(|| item["CreateDate"].as_str())
                .or_else(|| item["MediaCreateDate"].as_str())
                .map(|s| s.to_string());

            let duration_ms = parse_duration_ms(item);

            let gps = match (item["GPSLatitude"].as_f64(), item["GPSLongitude"].as_f64()) {
                (Some(lat), Some(lng)) if lat != 0.0 && lng != 0.0 => {
                    Some(GpsCoord { lat, lng })
                }
                _ => None,
            };

            let resolution = item["ImageSize"].as_str().map(|s| s.to_string());
            let frame_rate = item["VideoFrameRate"].as_f64();

            ClipMetadata {
                id: Uuid::new_v4().to_string(),
                path: file_path,
                filename,
                created_at,
                duration_ms,
                gps,
                resolution,
                frame_rate,
            }
        })
        .collect();

    clips.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    Ok(clips)
}

fn parse_duration_ms(item: &Value) -> Option<u64> {
    if let Some(dur) = item["Duration"].as_f64() {
        return Some((dur * 1000.0) as u64);
    }
    if let Some(dur_str) = item["Duration"].as_str() {
        if dur_str.contains(':') {
            let parts: Vec<&str> = dur_str.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                return Some(((h * 3600.0 + m * 60.0 + s) * 1000.0) as u64);
            }
        } else if let Some(s) = dur_str.strip_suffix(" s") {
            if let Ok(secs) = s.trim().parse::<f64>() {
                return Some((secs * 1000.0) as u64);
            }
        }
    }
    None
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| VIDEO_EXTENSIONS.contains(&ext))
        .unwrap_or(false)
}

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

/// Parse a GPX file into trackpoints, optionally copying into the project bundle
#[tauri::command]
pub fn parse_gpx(file_path: String, project_dir: Option<String>) -> Result<Route, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read GPX file: {}", e))?;

    // Copy GPX into project bundle if project_dir is provided
    if let Some(ref dir) = project_dir {
        let dest = PathBuf::from(dir).join("route.gpx");
        std::fs::write(&dest, &content)
            .map_err(|e| format!("Failed to copy GPX to project: {}", e))?;
    }

    let doc = roxmltree::Document::parse(&content)
        .map_err(|e| format!("Failed to parse GPX XML: {}", e))?;

    let mut trackpoints = Vec::new();

    for node in doc.descendants() {
        if node.has_tag_name("trkpt") {
            let lat = node
                .attribute("lat")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0);
            let lon = node
                .attribute("lon")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0);

            let mut elevation = None;
            let mut timestamp = None;

            for child in node.children() {
                if child.has_tag_name("ele") {
                    elevation = child.text().and_then(|t| t.parse::<f64>().ok());
                }
                if child.has_tag_name("time") {
                    timestamp = child.text().map(|t| t.to_string());
                }
            }

            trackpoints.push(TrackPoint {
                lat,
                lng: lon,
                elevation,
                timestamp,
            });
        }
    }

    Ok(Route {
        source_path: file_path,
        format: "gpx".to_string(),
        trackpoints,
    })
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

/// Generate a 720p H.264 proxy video via FFmpeg, stored in project bundle
#[tauri::command]
pub async fn generate_proxy(source_path: String, project_dir: String) -> Result<String, String> {
    let proxies_dir = PathBuf::from(&project_dir).join("proxies");
    ensure_dir(&proxies_dir)?;

    let hash = path_hash(&source_path);
    let proxy_path = proxies_dir.join(format!("{}.mp4", hash));

    if proxy_path.exists() {
        return proxy_path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid proxy path".to_string());
    }

    if !Path::new(&source_path).exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let proxy_str = proxy_path
        .to_str()
        .ok_or("Invalid proxy path")?
        .to_string();

    let output = Command::new("ffmpeg")
        .arg("-i")
        .arg(&source_path)
        .arg("-vf")
        .arg("scale=-2:720")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("fast")
        .arg("-crf")
        .arg("28")
        .arg("-g")
        .arg("30")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        .arg("-y")
        .arg(&proxy_str)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&proxy_path);
        return Err(format!("FFmpeg proxy generation failed: {}", stderr));
    }

    Ok(proxy_str)
}

/// Extract a thumbnail frame from a video via FFmpeg, stored in project bundle
#[tauri::command]
pub async fn generate_thumbnail(source_path: String, project_dir: String) -> Result<String, String> {
    let thumbs_dir = PathBuf::from(&project_dir).join("thumbnails");
    ensure_dir(&thumbs_dir)?;

    let hash = path_hash(&source_path);
    let thumb_path = thumbs_dir.join(format!("{}_thumb.jpg", hash));

    if thumb_path.exists() {
        return thumb_path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid thumbnail path".to_string());
    }

    if !Path::new(&source_path).exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let thumb_str = thumb_path
        .to_str()
        .ok_or("Invalid thumbnail path")?
        .to_string();

    let output = Command::new("ffmpeg")
        .arg("-i")
        .arg(&source_path)
        .arg("-ss")
        .arg("1")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale=-2:160")
        .arg("-y")
        .arg(&thumb_str)
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&thumb_path);
        return Err(format!("FFmpeg thumbnail extraction failed: {}", stderr));
    }

    Ok(thumb_str)
}

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
    register_recent_project(project_dir)?;

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
    let path = recent_projects_path()?;
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
