use crate::models::*;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use uuid::Uuid;

/// Scan a directory for video files and extract metadata via ExifTool
#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<ClipMetadata>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    // Collect video files
    let video_extensions = ["mov", "mp4", "m4v", "MOV", "MP4", "M4V"];
    let mut video_files: Vec<String> = Vec::new();

    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if video_extensions.contains(&ext) {
                if let Some(p) = path.to_str() {
                    video_files.push(p.to_string());
                }
            }
        }
    }

    if video_files.is_empty() {
        return Ok(Vec::new());
    }

    // Run ExifTool in batch JSON mode
    let mut cmd = Command::new("exiftool");
    cmd.arg("-json")
        .arg("-GPSLatitude")
        .arg("-GPSLongitude")
        .arg("-CreateDate")
        .arg("-MediaCreateDate")
        .arg("-Duration")
        .arg("-ImageSize")
        .arg("-VideoFrameRate")
        .arg("-n"); // numeric GPS output

    for file in &video_files {
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

            let created_at = item["CreateDate"]
                .as_str()
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

    // Sort by creation timestamp
    clips.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    Ok(clips)
}

fn parse_duration_ms(item: &Value) -> Option<u64> {
    // ExifTool returns duration in various formats
    if let Some(dur) = item["Duration"].as_f64() {
        return Some((dur * 1000.0) as u64);
    }
    if let Some(dur_str) = item["Duration"].as_str() {
        // Parse "0:00:12" or "12.4 s" formats
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

/// Parse a GPX file into trackpoints
#[tauri::command]
pub fn parse_gpx(file_path: String) -> Result<Route, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read GPX file: {}", e))?;

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

/// Save project to JSON file
#[tauri::command]
pub fn save_project(project: Project, path: String) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write project file: {}", e))?;
    Ok(())
}

/// Load project from JSON file
#[tauri::command]
pub fn load_project(path: String) -> Result<Project, String> {
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read project file: {}", e))?;
    let project: Project =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;
    Ok(project)
}
