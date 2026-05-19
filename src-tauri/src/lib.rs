use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

struct EngineState {
    port: Mutex<Option<u16>>,
}

#[tauri::command]
fn get_engine_port(state: tauri::State<'_, Arc<EngineState>>) -> Option<u16> {
    *state.port.lock().unwrap()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
        let (mut rx, _child) = match handle
            .shell()
            .sidecar("binaries/winwhisper_engine")
            .expect("sidecar not configured")
            .spawn()
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[WinWhisper] Failed to spawn engine: {e}");
                show_window(&handle);
                return;
            }
        };

        // Scan stdout for the WINWHISPER_PORT= announcement
        let mut port: Option<u16> = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    if let Some(rest) = text.trim().strip_prefix("WINWHISPER_PORT=") {
                        if let Ok(p) = rest.trim().parse::<u16>() {
                            *state.port.lock().unwrap() = Some(p);
                            port = Some(p);
                            break;
                        }
                    }
                }
                CommandEvent::Terminated(_) => {
                    eprintln!("[WinWhisper] Engine exited before announcing port");
                    show_window(&handle);
                    return;
                }
                _ => {}
            }
        }

        let port = match port {
            Some(p) => p,
            None => {
                show_window(&handle);
                return;
            }
        };

        // Poll until TCP port accepts connections (30 s timeout)
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

        // Drain remaining I/O so the sidecar process doesn't block on its pipe
        while rx.recv().await.is_some() {}
    });
}

fn show_window(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
