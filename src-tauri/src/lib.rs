use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct EngineState {
    port: Mutex<Option<u16>>,
}

#[derive(Clone)]
struct EngineCommand {
    program: OsString,
    args: Vec<OsString>,
    cwd: PathBuf,
    label: String,
}

#[tauri::command]
fn get_engine_port(state: tauri::State<'_, Arc<EngineState>>) -> Option<u16> {
    *state.port.lock().unwrap()
}

#[tauri::command]
fn open_external(url: String) {
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
}

pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(EngineState {
            port: Mutex::new(None),
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            setup_tray(&handle)?;
            // Show the window immediately so users see the UI while the engine loads
            show_window(&handle);
            spawn_engine(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_engine_port, open_external])
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
        if let Some(port) = attach_existing_engine(&state).await {
            let _ = handle.emit("engine-ready", port);
            return;
        }

        let commands = resolve_engine_commands(&handle);
        if commands.is_empty() {
            eprintln!(
                "[WinWhisper] No packaged engine or Python source engine found. \
                 Build the engine or set WINWHISPER_ENGINE_EXE."
            );
            return;
        }

        for command in commands {
            let mut child = match spawn_engine_child(&command) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[WinWhisper] Failed to spawn {}: {e}", command.label);
                    continue;
                }
            };

            if run_engine_child(&handle, &state, &mut child).await {
                return;
            }

            let _ = child.kill().await;
        }

        eprintln!("[WinWhisper] Engine failed to start from all known locations");
    });
}

fn spawn_engine_child(command: &EngineCommand) -> std::io::Result<tokio::process::Child> {
    tokio::process::Command::new(&command.program)
        .args(&command.args)
        .current_dir(&command.cwd)
        // Force line-buffered stdout so WINWHISPER_PORT= is flushed immediately.
        // Without this, Python uses block-buffering when stdout is a pipe and the
        // port announcement may never reach us.
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

async fn run_engine_child(
    handle: &AppHandle,
    state: &Arc<EngineState>,
    child: &mut tokio::process::Child,
) -> bool {
    // Drain stderr in a separate task so it never blocks the child process.
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[engine] {line}");
            }
        });
    }

    // Scan stdout for the WINWHISPER_PORT= announcement.
    let Some(stdout) = child.stdout.take() else {
        eprintln!("[WinWhisper] Engine stdout was not captured");
        return false;
    };
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
                println!("[engine] {line}");
            }
            _ => break,
        }
    }

    let port = match port {
        Some(p) => p,
        None => {
            eprintln!("[WinWhisper] Engine exited without announcing port");
            return false;
        }
    };

    // Keep draining stdout after the port announcement.
    tauri::async_runtime::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            println!("[engine] {line}");
        }
    });

    // Poll health until the engine accepts requests. No hard cap — on first launch
    // the engine loads large ML libraries which can take 60-90 s on slow hardware.
    loop {
        if engine_health_ok(port).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // Notify the frontend that the engine is ready with its port.
    let _ = handle.emit("engine-ready", port);

    // Keep child alive for the app's lifetime.
    let _ = child.wait().await;
    eprintln!("[WinWhisper] Engine process exited");
    true
}

async fn attach_existing_engine(state: &Arc<EngineState>) -> Option<u16> {
    let port_file = storage_port_file()?;
    let port = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())?;

    if !engine_health_ok(port).await {
        return None;
    }

    *state.port.lock().unwrap() = Some(port);
    eprintln!("[WinWhisper] Attached to existing engine on port {port}");
    Some(port)
}

async fn engine_health_ok(port: u16) -> bool {
    let Ok(mut stream) = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await else {
        return false;
    };

    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .is_err()
    {
        return false;
    }

    let mut buf = [0_u8; 256];
    let Ok(n) = stream.read(&mut buf).await else {
        return false;
    };

    std::str::from_utf8(&buf[..n])
        .map(|s| s.contains(" 200 "))
        .unwrap_or(false)
}

fn storage_port_file() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Roaming")))
    } else {
        env::var_os("HOME").map(|p| PathBuf::from(p).join(".local").join("share"))
    }?;

    Some(base.join("WinWhisper").join("engine.port"))
}

fn resolve_engine_commands(handle: &AppHandle) -> Vec<EngineCommand> {
    let mut commands = Vec::new();

    if let Some(path) = env::var_os("WINWHISPER_ENGINE_EXE") {
        push_binary_command(&mut commands, PathBuf::from(path), true);
    }

    if let Ok(resource_dir) = handle.path().resource_dir() {
        push_binary_command(
            &mut commands,
            resource_dir.join("winwhisper_engine").join("winwhisper_engine.exe"),
            false,
        );
        push_binary_command(
            &mut commands,
            resource_dir.join("winwhisper_engine").join("winwhisper_engine"),
            false,
        );
        push_binary_command(
            &mut commands,
            resource_dir.join("winwhisper_engine.exe"),
            false,
        );
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(app_dir) = current_exe.parent() {
            push_binary_command(
                &mut commands,
                app_dir.join("winwhisper_engine").join("winwhisper_engine.exe"),
                false,
            );
            push_binary_command(
                &mut commands,
                app_dir.join("resources").join("winwhisper_engine").join("winwhisper_engine.exe"),
                false,
            );
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest_dir.clone());

    push_binary_command(
        &mut commands,
        project_root.join("engine").join("dist").join("winwhisper_engine").join("winwhisper_engine.exe"),
        false,
    );
    push_binary_command(
        &mut commands,
        project_root.join("engine").join("dist").join("winwhisper_engine.exe"),
        false,
    );
    push_binary_command(
        &mut commands,
        manifest_dir.join("resources").join("winwhisper_engine").join("winwhisper_engine.exe"),
        false,
    );
    push_binary_command(
        &mut commands,
        manifest_dir.join("binaries").join("winwhisper_engine-x86_64-pc-windows-msvc.exe"),
        false,
    );

    push_python_source_commands(&mut commands, project_root.join("engine"));

    commands
}

fn push_binary_command(commands: &mut Vec<EngineCommand>, path: PathBuf, explicit: bool) {
    if !explicit && !path.is_file() {
        return;
    }

    let cwd = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let label = path.display().to_string();
    commands.push(EngineCommand {
        program: path.into_os_string(),
        args: Vec::new(),
        cwd,
        label,
    });
}

fn push_python_source_commands(commands: &mut Vec<EngineCommand>, engine_dir: PathBuf) {
    if !engine_dir.join("main.py").is_file() {
        return;
    }

    if let Some(program) = env::var_os("WINWHISPER_ENGINE_PYTHON") {
        commands.push(EngineCommand {
            label: format!("{program:?} main.py"),
            program,
            args: vec![OsString::from("main.py")],
            cwd: engine_dir.clone(),
        });
    }

    if cfg!(target_os = "windows") {
        commands.push(EngineCommand {
            program: OsString::from("py"),
            args: vec![OsString::from("-3"), OsString::from("main.py")],
            cwd: engine_dir.clone(),
            label: "py -3 main.py".into(),
        });
    }

    for program in ["python3", "python"] {
        commands.push(EngineCommand {
            program: OsString::from(program),
            args: vec![OsString::from("main.py")],
            cwd: engine_dir.clone(),
            label: format!("{program} main.py"),
        });
    }
}

fn show_window(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
