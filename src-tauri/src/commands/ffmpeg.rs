use crate::util::fs::ensure_dir;
use crate::util::hash::path_hash;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Extract a thumbnail frame at a specific time offset from a video via
/// FFmpeg, stored in project bundle. Used by split clips so each segment gets
/// a thumbnail matching its trim.in_ms. Filename incorporates at_ms so
/// multiple segments of the same source don't collide on disk.
#[tauri::command]
pub async fn generate_thumbnail_at(
    source_path: String,
    at_ms: u64,
    project_dir: String,
) -> Result<String, String> {
    let thumbs_dir = PathBuf::from(&project_dir).join("thumbnails");
    ensure_dir(&thumbs_dir)?;

    let hash = path_hash(&source_path);
    let thumb_path = thumbs_dir.join(format!("{}_{}_thumb.jpg", hash, at_ms));

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

    let seconds = at_ms as f64 / 1000.0;

    let output = Command::new("ffmpeg")
        .arg("-ss")
        .arg(format!("{:.3}", seconds))
        .arg("-i")
        .arg(&source_path)
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
