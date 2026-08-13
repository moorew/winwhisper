use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Write},
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

// NOTE: no `std::os::windows::process::CommandExt` import here — tokio's
// Command provides creation_flags() inherently on Windows, and importing the
// std trait as well makes it an unused import.

// Windows: prevent the engine's console window from flashing on screen.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Windows: raw LoadLibrary FFI for diagnostic preflight ───────────────────
//
// We need the exact GetLastError() code from LoadLibrary so we can tell what
// is actually missing. PyInstaller's bootloader only reports the generic
// "module could not be found" message, which is useless once every direct
// dependency is bundled.
#[cfg(target_os = "windows")]
mod win_diag {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(lp_lib_file_name: *const u16, h_file: *mut u8, dw_flags: u32) -> *mut u8;
        fn FreeLibrary(h_lib_module: *mut u8) -> i32;
        fn GetLastError() -> u32;
    }

    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;

    fn to_wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }

    pub fn err_name(code: u32) -> &'static str {
        match code {
            2 => "ERROR_FILE_NOT_FOUND (target DLL missing)",
            3 => "ERROR_PATH_NOT_FOUND",
            5 => "ERROR_ACCESS_DENIED (antivirus/EDR blocking?)",
            126 => "ERROR_MOD_NOT_FOUND (a dependency DLL is missing)",
            127 => "ERROR_PROC_NOT_FOUND (a dependency exports the wrong symbols — likely a UCRT/VCRuntime version mismatch)",
            193 => "ERROR_BAD_EXE_FORMAT (32/64-bit mismatch)",
            _ => "<see https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes>",
        }
    }

    pub fn try_load(path: &Path) -> Result<(), u32> {
        let wide = to_wide(path.as_os_str());
        let h = unsafe {
            LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH)
        };
        if h.is_null() {
            let err = unsafe { GetLastError() };
            Err(err)
        } else {
            unsafe { FreeLibrary(h) };
            Ok(())
        }
    }
}

/// How long the engine gets to serve /health after announcing its port.
/// Covers a cold first launch (unpacking + importing torch/ctranslate2) with
/// room to spare, while still bounding a hung or crashed process.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(240);

/// How long the engine gets to print `WINWHISPER_PORT=` on stdout before we
/// treat this candidate as dead and move on to the next one.
const PORT_ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(180);

struct EngineState {
    port: Mutex<Option<u16>>,
}

/// Files dropped onto the window, queued here until the frontend collects them.
///
/// The frontend also subscribes to `tauri://drag-drop`, but that is a core
/// plugin command governed by the capability ACL — when the app shipped without
/// a capabilities file every such subscription was denied and drag-and-drop did
/// nothing at all. Custom commands like `take_dropped_paths` are not subject to
/// that ACL, so this path keeps working regardless of how permissions are
/// configured.
#[derive(Default)]
struct DropState {
    paths: Mutex<Vec<String>>,
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

/// Returns and clears the queue of dropped file paths.
#[tauri::command]
fn take_dropped_paths(state: tauri::State<'_, Arc<DropState>>) -> Vec<String> {
    let mut queued = state.paths.lock().unwrap();
    std::mem::take(&mut *queued)
}

// ── Floating capture windows ────────────────────────────────────────────────
//
// The recorder, dictation HUD and completion toast are separate always-on-top
// windows. They load the same bundle with `?window=<kind>`, which main.tsx
// branches on — a query parameter rather than a route, because the asset
// protocol serves files and would 404 on a client-side path.

/// Size and shape of each floating window, per the design.
fn capture_window_spec(kind: &str) -> Option<(f64, f64)> {
    // Heights are content-driven: these windows have no chrome, so any excess
    // shows as dead space inside the rounded card.
    match kind {
        "recorder" => Some((400.0, 152.0)),
        "dictation" => Some((300.0, 72.0)),
        "toast" => Some((300.0, 76.0)),
        _ => None,
    }
}

#[tauri::command]
async fn open_capture_window(
    app: AppHandle,
    kind: String,
    query: Option<String>,
) -> Result<(), String> {
    let (width, height) = capture_window_spec(&kind)
        .ok_or_else(|| format!("unknown capture window: {kind}"))?;
    let label = format!("capture-{kind}");

    // Already open: just refocus it rather than stacking duplicates.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html?window={kind}{}", query.unwrap_or_default());
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .inner_size(width, height)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("could not open {kind} window: {e}"))?;

    Ok(())
}

#[tauri::command]
fn close_capture_window(app: AppHandle, kind: String) {
    if let Some(window) = app.get_webview_window(&format!("capture-{kind}")) {
        let _ = window.close();
    }
}

/// Brings the main window forward — the completion toast's "Open" action.
#[tauri::command]
fn focus_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
        .manage(Arc::new(DropState::default()))
        // Capture drops here as well as emitting the JS event, so drag-and-drop
        // survives whatever the frontend's event permissions happen to be.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let collected: Vec<String> = paths
                    .iter()
                    .filter_map(|p| p.to_str().map(str::to_string))
                    .collect();
                if collected.is_empty() {
                    return;
                }
                log_line(&format!("[WinWhisper] dropped {} file(s)", collected.len()));
                let state = window.state::<Arc<DropState>>();
                state.paths.lock().unwrap().extend(collected);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            apply_window_material(&handle);
            setup_tray(&handle)?;
            // Show the window immediately so users see the UI while the engine loads
            show_window(&handle);
            spawn_engine(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_port,
            open_external,
            take_dropped_paths,
            open_capture_window,
            close_capture_window,
            focus_main_window
        ])
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

// ── Diagnostic log file ─────────────────────────────────────────────────────
//
// Everything written via `log_line` lands in %APPDATA%\WinWhisper\engine.log.
// This is the only way to debug release builds: Tauri's stdout/stderr is gone
// once the user double-clicks the installed exe.

fn storage_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
            env::var_os("USERPROFILE")
                .map(|p| PathBuf::from(p).join("AppData").join("Roaming"))
        })
    } else {
        env::var_os("HOME").map(|p| PathBuf::from(p).join(".local").join("share"))
    }?;
    let dir = base.join("WinWhisper");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

fn log_path() -> Option<PathBuf> {
    storage_dir().map(|d| d.join("engine.log"))
}

fn log_line(msg: &str) {
    eprintln!("{msg}");
    if let Some(path) = log_path() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let stamped = format!("[{}] {msg}\n", chrono_ish_now());
            let _ = f.write_all(stamped.as_bytes());
        }
    }
}

fn truncate_log() {
    if let Some(path) = log_path() {
        let _ = File::create(&path);
    }
}

// Tiny timestamp without pulling in chrono. Format: 2026-05-20T15:30:42Z
fn chrono_ish_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Naive UTC breakdown — good enough for log timestamps.
    let (year, month, day, hh, mm, ss) = epoch_to_utc(secs as i64);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn epoch_to_utc(mut secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let ss = (secs % 60) as u32;
    secs /= 60;
    let mm = (secs % 60) as u32;
    secs /= 60;
    let hh = (secs % 24) as u32;
    let mut days = secs / 24;
    let mut year: i32 = 1970;
    loop {
        let leap = is_leap(year);
        let ydays = if leap { 366 } else { 365 };
        if days < ydays as i64 {
            break;
        }
        days -= ydays as i64;
        year += 1;
    }
    let mlens: [i64; 12] = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month: u32 = 1;
    for (index, len) in mlens.iter().enumerate() {
        if days < *len {
            month = (index + 1) as u32;
            break;
        }
        days -= *len;
    }
    let day = (days + 1) as u32;
    (year, month, day, hh, mm, ss)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ── _internal.zip extraction ─────────────────────────────────────────────────
//
// Tauri's NSIS bundler reliably handles individual files but silently drops
// subdirectories when using **/* globs. PyInstaller v6's _internal/ contains
// package subdirs (e.g. _internal/pydantic_core/_pydantic_core.cp311-win_amd64.pyd)
// that never made it to the installed app. The fix: CI creates _internal.zip
// (preserving the full directory tree), Tauri bundles the single ZIP file,
// and this code extracts it once at first launch (or whenever the installer
// puts down a newer ZIP — i.e. after an upgrade).

fn extract_internal_zip(bundle_dir: &Path) -> Result<usize, String> {
    let zip_path = bundle_dir.join("_internal.zip");
    let dest = bundle_dir.join("_internal");

    // Remove any stale or partially-extracted _internal/ before re-extracting.
    if dest.is_dir() {
        fs::remove_dir_all(&dest)
            .map_err(|e| format!("remove stale _internal/: {e}"))?;
    }
    fs::create_dir_all(&dest)
        .map_err(|e| format!("create _internal/: {e}"))?;

    let f = File::open(&zip_path)
        .map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(f)
        .map_err(|e| format!("parse ZIP: {e}"))?;

    let n = archive.len();
    for i in 0..n {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("entry {i}: {e}"))?;

        // enclosed_name() rejects path-traversal entries (e.g. ../foo)
        let out_path = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {}: {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir parent {}: {e}", parent.display()))?;
            }
            let mut w = File::create(&out_path)
                .map_err(|e| format!("create {}: {e}", out_path.display()))?;
            io::copy(&mut entry, &mut w)
                .map_err(|e| format!("write {}: {e}", out_path.display()))?;
        }
    }

    // Sentinel: written last so partial extractions are detectable.
    let _ = File::create(dest.join(".extraction_complete"));
    Ok(n)
}

fn needs_extraction(bundle_dir: &Path) -> bool {
    let zip = bundle_dir.join("_internal.zip");
    if !zip.is_file() {
        return false;
    }
    let sentinel = bundle_dir.join("_internal").join(".extraction_complete");
    if !sentinel.is_file() {
        return true; // never extracted, or extraction was interrupted
    }
    // Re-extract when the installer has placed a newer _internal.zip (upgrade).
    let zip_t = fs::metadata(&zip).and_then(|m| m.modified()).ok();
    let sen_t = fs::metadata(&sentinel).and_then(|m| m.modified()).ok();
    matches!((zip_t, sen_t), (Some(z), Some(s)) if z > s)
}

fn ensure_internal_ready(bundle_dir: &Path) -> bool {
    if !needs_extraction(bundle_dir) {
        return true;
    }
    log_line("[WinWhisper] EXTRACT: Unpacking engine internals (first run or update — ~10s)...");
    match extract_internal_zip(bundle_dir) {
        Ok(n) => {
            log_line(&format!("[WinWhisper] EXTRACT: Unpacked {n} files into _internal/ — done."));
            true
        }
        Err(e) => {
            log_line(&format!("[WinWhisper] EXTRACT: Failed — {e}"));
            false
        }
    }
}

// ── Engine spawn ────────────────────────────────────────────────────────────

fn spawn_engine(handle: AppHandle) {
    let state = handle.state::<Arc<EngineState>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        truncate_log();
        log_line(&format!(
            "[WinWhisper] starting engine boot sequence (version {})",
            env!("CARGO_PKG_VERSION")
        ));

        if let Some(port) = attach_existing_engine(&state).await {
            log_line(&format!("[WinWhisper] attached to existing engine on port {port}"));
            let _ = handle.emit("engine-ready", port);
            return;
        }

        let commands = resolve_engine_commands(&handle);
        if commands.is_empty() {
            log_line(
                "[WinWhisper] FATAL: no engine binary found in any known location. \
                 The installer is missing the sidecar.",
            );
            return;
        }

        log_line(&format!(
            "[WinWhisper] {} engine candidate(s) discovered:",
            commands.len()
        ));
        for (i, c) in commands.iter().enumerate() {
            log_line(&format!("  [{i}] {}", c.label));
        }

        // ── Extract _internal.zip on first run / after upgrade ───────────────
        // Tauri bundles _internal.zip as a single resource file.
        // We extract it here rather than relying on the NSIS bundler to
        // preserve PyInstaller's nested _internal/ subdirectory structure.
        if let Some(first) = commands.first() {
            let exe = PathBuf::from(&first.program);
            if let Some(bd) = exe.parent() {
                if !ensure_internal_ready(bd) {
                    log_line(
                        "[WinWhisper] FATAL: could not unpack engine internals — \
                         share %APPDATA%\\WinWhisper\\engine.log for details.",
                    );
                    return;
                }
            }
        }

        // ── DLL preflight (Windows only) ─────────────────────────────────────
        // If we are about to spawn a PyInstaller bundle, sanity-check that
        // python311.dll itself can be loaded from Rust. This bypasses the
        // bootloader's generic error message and gives us the exact Win32
        // error code, plus the full bundle DLL listing so we can see what
        // is actually present at runtime.
        #[cfg(target_os = "windows")]
        {
            if let Some(first) = commands.first() {
                let exe_path = PathBuf::from(&first.program);
                if let Some(bundle_dir) = exe_path.parent() {
                    preflight_dll_check(bundle_dir);
                }
            }
        }

        for (idx, command) in commands.iter().enumerate() {
            log_line(&format!(
                "[WinWhisper] attempting candidate [{idx}]: {}",
                command.label
            ));

            let mut child = match spawn_engine_child(command) {
                Ok(c) => c,
                Err(e) => {
                    log_line(&format!(
                        "[WinWhisper] spawn failed for {}: {e}",
                        command.label
                    ));
                    continue;
                }
            };

            if run_engine_child(&handle, &state, &mut child).await {
                log_line("[WinWhisper] engine is healthy — emitting engine-ready");
                return;
            }

            log_line(&format!(
                "[WinWhisper] candidate [{idx}] never announced a port; killing and trying next.",
            ));
            let _ = child.kill().await;
        }

        log_line(
            "[WinWhisper] FATAL: engine failed to start from every known location. \
             Share %APPDATA%\\WinWhisper\\engine.log so we can see why.",
        );
    });
}

/// Reads one newline-terminated line from the engine, decoding leniently.
///
/// Deliberately not `AsyncBufReadExt::lines()`. That yields `Err(InvalidData)`
/// the moment the child writes a byte that is not valid UTF-8, and every drain
/// here was written as `while let Ok(Some(line))` — which treats an error as
/// end of stream. So one mis-encoded character killed the drain permanently.
///
/// That is not a cosmetic loss. Nothing else reads the pipe, so it fills, and
/// the next `print()` in the engine blocks until someone empties it — which
/// never happens. The engine wedges mid-job with no error, and the stall
/// watchdog cannot report it either, because its own output goes down the same
/// blocked pipe. It looked exactly like a hung transcription.
///
/// Reading bytes and replacing whatever does not decode keeps the pipe moving
/// no matter what the child emits, in any code page.
async fn read_line_lossy<R>(reader: &mut BufReader<R>) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = Vec::new();
    if reader.read_until(b'\n', &mut buf).await? == 0 {
        return Ok(None); // genuine EOF: the child closed the pipe
    }
    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
        buf.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

fn spawn_engine_child(command: &EngineCommand) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(&command.program);
    cmd.args(&command.args)
        .current_dir(&command.cwd)
        // Force line-buffered stdout so WINWHISPER_PORT= is flushed immediately.
        // Without this, Python uses block-buffering when stdout is a pipe and the
        // port announcement may never reach us.
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows-only: suppress the console window that flashes when spawning a
    // console-subsystem PyInstaller bundle from a windowed Tauri parent.
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

async fn run_engine_child(
    handle: &AppHandle,
    state: &Arc<EngineState>,
    child: &mut tokio::process::Child,
) -> bool {
    // Drain stderr in a separate task and mirror it into engine.log so users
    // can share the actual import / runtime error when something breaks.
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(line)) = read_line_lossy(&mut reader).await {
                log_line(&format!("[engine!] {line}"));
            }
        });
    }

    // Scan stdout for the WINWHISPER_PORT= announcement.
    let Some(stdout) = child.stdout.take() else {
        log_line("[WinWhisper] engine stdout pipe was not captured");
        return false;
    };
    let mut reader = BufReader::new(stdout);
    let mut port: Option<u16> = None;

    // Bounded wait for the announcement: an engine that hangs without printing
    // anything and without closing stdout would otherwise block this task
    // forever, leaving the UI stuck on "engine starting" with no log entry.
    let announce_started = std::time::Instant::now();
    loop {
        let remaining = PORT_ANNOUNCE_TIMEOUT.saturating_sub(announce_started.elapsed());
        if remaining.is_zero() {
            log_line(&format!(
                "[WinWhisper] engine printed no WINWHISPER_PORT= within {}s",
                PORT_ANNOUNCE_TIMEOUT.as_secs()
            ));
            break;
        }
        match tokio::time::timeout(remaining, read_line_lossy(&mut reader)).await {
            Ok(Ok(Some(line))) => {
                if let Some(rest) = line.trim().strip_prefix("WINWHISPER_PORT=") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        *state.port.lock().unwrap() = Some(p);
                        port = Some(p);
                    }
                    log_line(&format!("[engine] {line}"));
                    break;
                }
                log_line(&format!("[engine] {line}"));
            }
            // stdout closed, read error, or the deadline elapsed.
            _ => break,
        }
    }

    let port = match port {
        Some(p) => p,
        None => {
            log_line(
                "[WinWhisper] engine exited or stdout closed without printing WINWHISPER_PORT=",
            );
            return false;
        }
    };

    // Keep draining stdout after the port announcement so the pipe never fills.
    // This is not optional bookkeeping: a pipe nobody reads fills, and the next
    // print() on the other side blocks until someone does.
    tauri::async_runtime::spawn(async move {
        loop {
            match read_line_lossy(&mut reader).await {
                Ok(Some(line)) => log_line(&format!("[engine] {line}")),
                // Normal: the engine exited and closed its end.
                Ok(None) => break,
                // Anything else means we have stopped reading a pipe the engine
                // is still writing to, which will wedge it at the next print().
                // Silence here is what made the last one so hard to find, so
                // say so — even though nothing can be done about it from a
                // task that is already failing.
                Err(e) => {
                    log_line(&format!(
                        "[WinWhisper] stdout drain stopped ({e}) — the engine will \
                         block once the pipe fills. Restart the app."
                    ));
                    break;
                }
            }
        }
    });

    // Poll health until the engine accepts requests. The cap is generous — on a
    // first launch the engine unpacks and loads large ML libraries, which can
    // take 60-90 s on slow hardware — but it is NOT unbounded: if the engine
    // dies just after announcing its port (a crash while importing torch, say)
    // an infinite poll would pin the app on a dead process forever, never
    // logging a reason and never falling through to the next candidate.
    let started = std::time::Instant::now();
    let mut healthy = false;
    while started.elapsed() < HEALTH_TIMEOUT {
        if engine_health_ok(port).await {
            healthy = true;
            break;
        }
        // No amount of further polling will revive an exited process.
        match child.try_wait() {
            Ok(Some(status)) => {
                log_line(&format!(
                    "[WinWhisper] engine exited before serving /health (exit status: {status})"
                ));
                *state.port.lock().unwrap() = None;
                return false;
            }
            Ok(None) => {}
            Err(e) => {
                log_line(&format!("[WinWhisper] could not poll engine process state: {e}"));
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if !healthy {
        log_line(&format!(
            "[WinWhisper] engine announced port {port} but never served /health within {}s",
            HEALTH_TIMEOUT.as_secs()
        ));
        *state.port.lock().unwrap() = None;
        return false;
    }

    // Notify the frontend that the engine is ready with its port.
    let _ = handle.emit("engine-ready", port);

    // Keep child alive for the app's lifetime.
    let _ = child.wait().await;
    log_line("[WinWhisper] engine process exited");
    true
}

async fn attach_existing_engine(state: &Arc<EngineState>) -> Option<u16> {
    let port_file = storage_dir()?.join("engine.port");
    let port = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())?;

    if !engine_health_ok(port).await {
        return None;
    }

    *state.port.lock().unwrap() = Some(port);
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

fn resolve_engine_commands(handle: &AppHandle) -> Vec<EngineCommand> {
    let mut commands = Vec::new();

    if let Some(path) = env::var_os("WINWHISPER_ENGINE_EXE") {
        push_binary_command(&mut commands, PathBuf::from(path), true);
    }

    // Production: Tauri places bundled resources under resource_dir/winwhisper_engine/.
    if let Ok(resource_dir) = handle.path().resource_dir() {
        log_line(&format!("[WinWhisper] resource_dir: {}", resource_dir.display()));
        push_binary_command(
            &mut commands,
            resource_dir.join("winwhisper_engine").join("winwhisper_engine.exe"),
            false,
        );
        push_binary_command(
            &mut commands,
            resource_dir
                .join("winwhisper_engine")
                .join("winwhisper_engine"),
            false,
        );
    }

    // Dev / sideloaded layouts: try the build output and any binary the developer
    // copied next to the Tauri executable.
    if let Ok(current_exe) = env::current_exe() {
        if let Some(app_dir) = current_exe.parent() {
            push_binary_command(
                &mut commands,
                app_dir.join("winwhisper_engine").join("winwhisper_engine.exe"),
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
        project_root
            .join("engine")
            .join("dist")
            .join("winwhisper_engine")
            .join("winwhisper_engine.exe"),
        false,
    );

    push_python_source_commands(&mut commands, project_root.join("engine"));

    // Dedupe by canonicalised path so we don't spawn the same exe twice (this
    // was the source of the "two console windows" report).
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    commands.retain(|c| {
        let key = PathBuf::from(&c.program);
        let canonical = std::fs::canonicalize(&key).unwrap_or(key);
        seen.insert(canonical)
    });

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

#[cfg(target_os = "windows")]
fn preflight_dll_check(bundle_dir: &Path) {
    let internal = bundle_dir.join("_internal");
    if !internal.is_dir() {
        log_line(&format!(
            "[WinWhisper] PREFLIGHT: _internal directory not found at {}",
            internal.display()
        ));
        return;
    }

    // 1. List the bundle DLLs so future engine.log shares show what's present.
    match std::fs::read_dir(&internal) {
        Ok(entries) => {
            let mut dlls: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.to_ascii_lowercase().ends_with(".dll"))
                .collect();
            dlls.sort();
            log_line(&format!(
                "[WinWhisper] PREFLIGHT: {} DLL(s) present in _internal:",
                dlls.len()
            ));
            for d in &dlls {
                log_line(&format!("    {d}"));
            }
        }
        Err(e) => {
            log_line(&format!("[WinWhisper] PREFLIGHT: failed to list _internal: {e}"));
        }
    }

    // 2. Try LoadLibrary on each critical DLL — report the exact Win32 error.
    //    Order matters: ucrtbase → vcruntime → python311. If ucrtbase fails,
    //    python311 will too, and we want the leaf failure named explicitly.
    let critical = [
        "ucrtbase.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "python311.dll",
    ];
    for dll in critical {
        let path = internal.join(dll);
        if !path.is_file() {
            log_line(&format!("[WinWhisper] PREFLIGHT: {dll}: not present in _internal"));
            continue;
        }
        match win_diag::try_load(&path) {
            Ok(()) => log_line(&format!("[WinWhisper] PREFLIGHT: {dll}: LOAD OK")),
            Err(code) => {
                log_line(&format!(
                    "[WinWhisper] PREFLIGHT: {dll}: LoadLibrary failed with Win32 error {code} — {}",
                    win_diag::err_name(code)
                ));
            }
        }
    }
}

/// Mica behind the custom titlebar and rail, on the Windows 11 builds that
/// support it. Purely cosmetic: the chrome gradient in globals.css is what the
/// window falls back to, so a failure here is not worth surfacing.
fn apply_window_material(handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        if let Some(window) = handle.get_webview_window("main") {
            // Rounded corners on the undecorated window come from the CSS radius;
            // mica supplies the material behind the titlebar and rail.
            match window_vibrancy::apply_mica(&window, None) {
                Ok(()) => log_line("[WinWhisper] mica applied to the main window"),
                Err(e) => log_line(&format!(
                    "[WinWhisper] mica unavailable ({e}) — using the gradient fallback"
                )),
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = handle;
}

fn show_window(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
