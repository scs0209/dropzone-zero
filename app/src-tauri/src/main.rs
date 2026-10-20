// Zee: a small always-on-top character for Dropzone Zero. The window only draws
// the character and passes clicks to the local `dz daemon`; all file work stays
// in the daemon, behind the same guardrails as the command line. Zee also starts
// the daemon and Ollama when they are not running, and stops them when it quits
// (see services.rs), so Zee is the only thing that has to be launched.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod services;

use std::sync::Mutex;

use services::Services;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Wry};

const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 380.0;
const TRAY_ID: &str = "zee-tray";

/// The menu item whose label flips between "Hide Zee" and "Show Zee".
struct ToggleItem(Mutex<MenuItem<Wry>>);

/// The daemon's port and token, written by `dz daemon` to a file only this user can read.
#[tauri::command]
fn daemon_info(services: State<Services>) -> Result<String, String> {
    if services.starting() {
        return Err("Starting Dropzone Zero...".to_string());
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    std::fs::read_to_string(format!("{home}/.dropzone-zero/daemon.json"))
        .ok()
        .filter(|_| services::daemon_reachable())
        .ok_or_else(|| "Dropzone Zero is not running. Click Start to start it.".to_string())
}

/// Starts Ollama and the daemon if they are not running (the bubble's Start button).
#[tauri::command]
fn start_services(services: State<Services>) -> Result<(), String> {
    services.ensure()
}

/// Resizes Zee's window to `width` x `height` (logical points) while its bottom-right
/// corner, where Zee sits, stays exactly where it is. Size and position change in
/// one step: done as two calls from the page, the window first grew from its
/// top-left corner and then moved back, so Zee shook on every pointer move while
/// the bubble was being resized.
#[tauri::command]
fn fit_window(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
        window
            .run_on_main_thread(move || {
                use objc2_app_kit::NSWindow;
                use objc2_foundation::NSSize;
                // SAFETY: Tauri hands out the window's live NSWindow, and this runs on the main thread.
                let ns_window = unsafe { &*(ns_window as *const NSWindow) };
                let mut frame = ns_window.frame();
                // Cocoa's origin is the bottom-left corner, so keeping origin.y keeps the
                // bottom edge; the right edge is kept by moving origin.x.
                frame.origin.x += frame.size.width - width;
                frame.size = NSSize::new(width, height);
                ns_window.setFrame_display(frame, true);
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let position = window.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let size = window.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let (right, bottom) = (position.x + size.width, position.y + size.height);
        window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        window
            .set_position(tauri::LogicalPosition::new(right - width, bottom - height))
            .map_err(|e| e.to_string())
    }
}

/// Shows or hides Zee and keeps the menu bar item's label in step.
#[tauri::command]
fn set_zee_visible(app: AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("zee") {
        let _ = if visible { window.show() } else { window.hide() };
    }
    if let Some(item) = app.try_state::<ToggleItem>() {
        if let Ok(item) = item.0.lock() {
            let _ = item.set_text(if visible { "Hide Zee" } else { "Show Zee" });
        }
    }
}

/// Puts the number of open questions next to the menu bar icon, so a hidden Zee can still ask.
#[tauri::command]
fn set_attention(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None });
    }
}

fn toggle(app: &AppHandle) {
    let visible = app
        .get_webview_window("zee")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    set_zee_visible(app.clone(), !visible);
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Services::default())
        .invoke_handler(tauri::generate_handler![daemon_info, start_services, fit_window, set_zee_visible, set_attention])
        .setup(|app| {
            // Bring up what Zee needs without holding up the window.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = handle.state::<Services>().ensure() {
                    eprintln!("{error}");
                }
            });

            // A companion, not an app window: no Dock icon. The menu bar icon brings Zee back.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let toggle_item = MenuItem::with_id(app, "toggle", "Hide Zee", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Zee", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;
            app.manage(ToggleItem(Mutex::new(toggle_item)));

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Zee (Dropzone Zero)")
                .menu(&menu)
                // Left click toggles Zee; the menu opens on right click.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;

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
        .build(tauri::generate_context!())
        .expect("error while building Zee");

    // Quitting Zee stops what Zee started, so nothing keeps running in the background.
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<Services>().stop();
        }
    });
}
