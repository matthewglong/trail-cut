// Tauri command surface for the encoder probe (task 040).
//
// Wraps `export::probe_all` so the export-settings dialog can front-run the
// probe in the background before the user kicks off an export. Frontend wiring
// for the dialog itself ships with the export-settings UI in 060+.

use crate::export::{probe_all, EncoderProbe};

#[tauri::command]
pub async fn probe_encoders() -> Result<EncoderProbe, String> {
    probe_all().map_err(|e| e.to_string())
}
