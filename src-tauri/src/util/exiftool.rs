use crate::models::*;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use uuid::Uuid;

pub const VIDEO_EXTENSIONS: &[&str] = &["mov", "mp4", "m4v", "MOV", "MP4", "M4V"];

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| VIDEO_EXTENSIONS.contains(&ext))
        .unwrap_or(false)
}

/// Shared ExifTool runner — takes a list of video file paths, returns metadata
pub fn run_exiftool(video_files: &[String]) -> Result<Vec<ClipMetadata>, String> {
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

pub fn parse_duration_ms(item: &Value) -> Option<u64> {
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

/// Parse an ExifTool date string and format as "Jan 1, 2024"
pub fn format_clip_date(raw: &str) -> Option<String> {
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
