// Zee: a small always-on-top character for Dropzone Zero. The window only draws
// the character and passes clicks to the local `dz daemon`; all file work stays
// in the daemon, behind the same guardrails as the command line.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 380.0;

/// The daemon's port and token, written by `dz daemon` to a file only this user can read.
#[tauri::command]
fn daemon_info() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    std::fs::read_to_string(format!("{home}/.dropzone-zero/daemon.json")).map_err(|_| {
        "The Dropzone Zero daemon is not running. Start it with `pnpm dz daemon` or `pnpm dz autostart enable`."
            .to_string()
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![daemon_info])
        .setup(|app| {
            // A companion, not an app window: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Sit in the bottom-right corner, above the Dock.
            if let Some(window) = app.get_webview_window("zee") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let x = size.width as f64 / scale - WIDTH - 24.0;
                    let y = size.height as f64 / scale - HEIGHT - 90.0;
                    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Zee");
}
