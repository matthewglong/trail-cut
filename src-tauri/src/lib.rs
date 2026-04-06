mod commands;
mod models;

pub use commands::*;
pub use models::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_directory,
            commands::import_media,
            commands::create_project,
            commands::parse_gpx,
            commands::save_project,
            commands::load_project,
            commands::generate_proxy,
            commands::generate_thumbnail,
            commands::get_recent_projects,
            commands::register_recent_project,
            commands::rename_project,
            commands::delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
