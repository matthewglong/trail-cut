use crate::models::*;
use std::path::PathBuf;

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
