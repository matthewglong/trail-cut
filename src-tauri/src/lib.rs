mod commands;
pub mod export;
mod models;
pub mod util;

pub use commands::*;
pub use models::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_directory,
            commands::import_media,
            commands::create_project,
            commands::parse_gpx,
            commands::save_project,
            commands::load_project,
            commands::generate_proxy,
            commands::regenerate_proxy_for_class,
            commands::generate_thumbnail,
            commands::generate_thumbnail_at,
            commands::get_recent_projects,
            commands::register_recent_project,
            commands::rename_project,
            commands::delete_project,
            commands::resolve_output_dir,
            commands::probe_encoders,
            commands::get_camera_presets,
            commands::set_camera_preset,
            commands::remove_camera_preset,
            commands::import_marker_image,
            commands::save_marker_icon,
            commands::delete_marker_image,
            export::render_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
