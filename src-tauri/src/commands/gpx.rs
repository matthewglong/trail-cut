use crate::models::*;
use std::path::{Path, PathBuf};

/// Parse a GPX file into trackpoints, optionally copying into the project bundle
#[tauri::command]
pub fn parse_gpx(file_path: String, project_dir: Option<String>) -> Result<Route, String> {
    // Copy GPX into project bundle if project_dir is provided. Done before
    // parsing so a parse error against an upstream file doesn't leave the
    // bundle in a half-updated state.
    if let Some(ref dir) = project_dir {
        let content = std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read GPX file: {}", e))?;
        let dest = PathBuf::from(dir).join("route.gpx");
        std::fs::write(&dest, &content)
            .map_err(|e| format!("Failed to copy GPX to project: {}", e))?;
    }

    parse_gpx_internal(Path::new(&file_path))
}

/// Pure GPX parser used by both the Tauri command and `load_project`'s
/// route re-population. Reads the file at `path`, parses trackpoints, and
/// returns a `Route` whose `source_path` is the input path.
pub fn parse_gpx_internal(path: &Path) -> Result<Route, String> {
    let content = std::fs::read_to_string(path)
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
        source_path: path.to_string_lossy().into_owned(),
        format: "gpx".to_string(),
        trackpoints,
    })
}
