use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tokio::io::{AsyncBufReadExt, BufReader};

struct EngineState {
    port: Mutex<Option<u16>>,
}

#[tauri::command]
fn get_engine_port(state: tauri::State<'_, Arc<EngineState>>) -> Option<u16> {
    *state.port.lock().unwrap()
}

pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(EngineState {
            port: Mutex::new(None),
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            setup_tray(&handle)?;
            spawn_engine(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_engine_port])
        .run(tauri::generate_context!())
        .expect("error while running WinWhisper");
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show WinWhisper", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit WinWhisper", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("WinWhisper")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_window(app, true),
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
                toggle_window(tray.app_handle(), false);
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn toggle_window(app: &AppHandle, force_show: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        if force_show || !visible {
            let _ = w.show();
            let _ = w.set_focus();
        } else {
            let _ = w.hide();
        }
    }
}

fn spawn_engine(handle: AppHandle) {
    let state = handle.state::<Arc<EngineState>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        // Engine lives in the app's resource directory, placed there by the Tauri bundle
        let engine_exe = match handle.path().resource_dir() {
            Ok(dir) => dir.join("winwhisper_engine").join("winwhisper_engine.exe"),
            Err(e) => {
                eprintln!("[WinWhisper] Cannot resolve resource dir: {e}");
                show_window(&handle);
                return;
            }
        };

        if !engine_exe.exists() {
            eprintln!("[WinWhisper] Engine not found at {engine_exe:?} — start it manually for dev");
            show_window(&handle);
            return;
        }

        // Run from the engine directory so _internal/ is found correctly
        let engine_dir = engine_exe.parent().unwrap().to_path_buf();

        let mut child = match tokio::process::Command::new(&engine_exe)
            .current_dir(&engine_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[WinWhisper] Failed to spawn engine: {e}");
                show_window(&handle);
                return;
            }
        };

        // Scan stdout for WINWHISPER_PORT= announcement
        let stdout = child.stdout.take().expect("stdout not captured");
        let mut lines = BufReader::new(stdout).lines();
        let mut port: Option<u16> = None;

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if let Some(rest) = line.trim().strip_prefix("WINWHISPER_PORT=") {
                        if let Ok(p) = rest.trim().parse::<u16>() {
                            *state.port.lock().unwrap() = Some(p);
                            port = Some(p);
                        }
                        break;
                    }
                }
                _ => break,
            }
        }

        let port = match port {
            Some(p) => p,
            None => {
                show_window(&handle);
                return;
            }
        };

        // Poll TCP until the engine accepts connections (30 s timeout)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .is_ok()
            {
                break;
            }
            if tokio::time::Instant::now() > deadline {
                eprintln!("[WinWhisper] Engine health-check timed out");
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }

        show_window(&handle);

        // Keep child alive for the app's lifetime
        let _ = child.wait().await;
    });
}

fn show_window(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
