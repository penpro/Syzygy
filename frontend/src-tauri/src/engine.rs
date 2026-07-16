//! Model/engine lifecycle: VRAM detection, listing/loading/deleting models, spawning llama-server.
use crate::state::{model_dir, Engine, MainModel, VisionEngine, LLAMA_PORT};
use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(8);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PORT_RELEASE_TIMEOUT: Duration = Duration::from_secs(2);
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessShutdownReport {
    pub tracked: bool,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub exited: bool,
}

impl ProcessShutdownReport {
    fn not_tracked() -> Self {
        Self {
            tracked: false,
            pid: None,
            exit_code: None,
            exited: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineShutdownReport {
    pub text_engine: ProcessShutdownReport,
    pub vision_engine: ProcessShutdownReport,
    pub port_released: bool,
    pub resources_released: bool,
}

/// The llama.cpp server binary name (`.exe` only on Windows).
fn server_bin() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Resolve the llama-server binary (resource dir when packaged, dev `bin/llama` otherwise).
pub(crate) fn llama_server_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let bin = server_bin();
    let resource = app
        .path()
        .resolve(format!("llama/{bin}"), tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin/llama")
        .join(bin);
    resource.or(Some(dev)).filter(|p| p.exists())
}

/// Launch llama-server hidden, serving `model` on the local port.
pub(crate) fn spawn_engine(app: &tauri::AppHandle, model: &Path) -> Option<Child> {
    let exe = llama_server_path(app)?;
    // Size the KV-cache context to detected VRAM — a 32K context is multiple GB on top of the
    // model weights and can OOM smaller cards. Unknown VRAM falls back to the previous 32K.
    let ctx: &str = match vram_total_mb() {
        Some(mb) if mb < 7000 => "4096",
        Some(mb) if mb < 11000 => "8192",
        Some(mb) if mb < 20000 => "16384",
        _ => "32768",
    };
    let mut cmd = Command::new(&exe);
    cmd.args([
        "-m",
        &model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &LLAMA_PORT.to_string(),
        "-ngl",
        "999",
        "-c",
        ctx,
        "--reasoning",
        "off",
    ]);
    // Don't inherit the parent's stdio: a chatty llama-server would fill its pipe buffer and
    // deadlock if nobody drains it. We read status over HTTP, not stdout.
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => {
            println!("[engine] started (pid {}) on {model:?}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[engine] failed to start: {e}");
            None
        }
    }
}

fn stop_child_with_timeout(
    label: &str,
    child: &mut Child,
    timeout: Duration,
) -> Result<ProcessShutdownReport, String> {
    let pid = child.id();
    match child.try_wait() {
        Ok(Some(status)) => {
            return Ok(ProcessShutdownReport {
                tracked: true,
                pid: Some(pid),
                exit_code: status.code(),
                exited: true,
            });
        }
        Ok(None) => {}
        Err(error) => {
            return Err(format!(
                "Could not inspect {label} process {pid} before shutdown: {error}"
            ));
        }
    }

    child
        .kill()
        .map_err(|error| format!("Could not stop {label} process {pid}: {error}"))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                log::info!("{label} process {pid} exited during shutdown");
                return Ok(ProcessShutdownReport {
                    tracked: true,
                    pid: Some(pid),
                    exit_code: status.code(),
                    exited: true,
                });
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Ok(None) => {
                let retry = child
                    .kill()
                    .err()
                    .map(|error| format!("; final terminate request also failed: {error}"))
                    .unwrap_or_default();
                return Err(format!(
                    "{label} process {pid} was still running after {} seconds{retry}",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                return Err(format!(
                    "Could not verify {label} process {pid} exited: {error}"
                ));
            }
        }
    }
}

fn stop_managed_child(
    slot: &Mutex<Option<Child>>,
    label: &str,
) -> Result<ProcessShutdownReport, String> {
    let mut guard = slot.lock().unwrap_or_else(|error| error.into_inner());
    let Some(child) = guard.as_mut() else {
        return Ok(ProcessShutdownReport::not_tracked());
    };
    let report = stop_child_with_timeout(label, child, PROCESS_EXIT_TIMEOUT)?;
    // try_wait above reaped the process. Only discard the handle after that proof.
    guard.take();
    Ok(report)
}

fn engine_port_accepts_connections() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], LLAMA_PORT));
    TcpStream::connect_timeout(&address, PORT_PROBE_TIMEOUT).is_ok()
}

pub(crate) fn wait_for_engine_port_release() -> Result<(), String> {
    let deadline = Instant::now() + PORT_RELEASE_TIMEOUT;
    while engine_port_accepts_connections() {
        if Instant::now() >= deadline {
            return Err(format!(
                "Local AI port {LLAMA_PORT} is still accepting connections after shutdown. Another llama-server process may still be running."
            ));
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
    Ok(())
}

pub(crate) fn stop_text_engine(app: &tauri::AppHandle) -> Result<ProcessShutdownReport, String> {
    stop_managed_child(&app.state::<Engine>().0, "text engine")
}

pub(crate) fn stop_vision_engine(app: &tauri::AppHandle) -> Result<ProcessShutdownReport, String> {
    stop_managed_child(&app.state::<VisionEngine>().0, "vision engine")
}

/// Stop and reap every model engine, then prove its loopback listener is gone. A successful
/// process wait is the OS-level guarantee that mapped engine DLLs and GPU resources were released.
pub(crate) fn shutdown_engine_state(
    app: &tauri::AppHandle,
) -> Result<EngineShutdownReport, String> {
    // Always attempt both stops so one failure cannot strand the other process.
    let text = stop_text_engine(app);
    let vision = stop_vision_engine(app);
    let mut failures = Vec::new();
    if let Err(error) = &text {
        failures.push(error.clone());
    }
    if let Err(error) = &vision {
        failures.push(error.clone());
    }
    if !failures.is_empty() {
        return Err(failures.join(" "));
    }

    wait_for_engine_port_release()?;
    *app.state::<MainModel>()
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;

    Ok(EngineShutdownReport {
        text_engine: text.expect("checked above"),
        vision_engine: vision.expect("checked above"),
        port_released: true,
        resources_released: true,
    })
}

/// Stop the running model engine(s). Called before an in-app update so the installer can
/// overwrite the engine binaries; otherwise llama-server keeps engine DLLs locked.
#[tauri::command]
pub fn shutdown_engine(app: tauri::AppHandle) -> Result<EngineShutdownReport, String> {
    shutdown_engine_state(&app)
}

/// Live GPU memory (used, total) in MiB via nvidia-smi. None on non-NVIDIA.
#[tauri::command]
pub fn gpu_vram() -> Option<(u64, u64)> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?;
    let mut parts = line.split(',').map(|p| p.trim());
    let used: u64 = parts.next()?.parse().ok()?;
    let total: u64 = parts.next()?.parse().ok()?;
    Some((used, total))
}

/// Dedicated VRAM (MiB) of the largest GPU adapter via DXGI — works on ANY vendor
/// (NVIDIA/AMD/Intel), unlike nvidia-smi.
#[cfg(windows)]
fn detect_vram_mb_dxgi() -> Option<u64> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best: usize = 0;
        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            if let Ok(desc) = adapter.GetDesc1() {
                if desc.DedicatedVideoMemory > best {
                    best = desc.DedicatedVideoMemory;
                }
            }
            i += 1;
        }
        (best > 0).then(|| (best / (1024 * 1024)) as u64)
    }
}

/// Apple Silicon shares system RAM with the GPU, so ~70% of total RAM is the model budget.
#[cfg(target_os = "macos")]
fn detect_mem_budget_mb_macos() -> Option<u64> {
    let out = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some((bytes / (1024 * 1024)) * 7 / 10)
}

/// Total VRAM (MiB) for model recommendation: DXGI on Windows (any GPU vendor),
/// Apple unified-memory budget on macOS, nvidia-smi elsewhere.
#[tauri::command]
pub fn vram_total_mb() -> Option<u64> {
    #[cfg(windows)]
    if let Some(mb) = detect_vram_mb_dxgi() {
        return Some(mb);
    }
    #[cfg(target_os = "macos")]
    if let Some(mb) = detect_mem_budget_mb_macos() {
        return Some(mb);
    }
    gpu_vram().map(|(_, total)| total)
}

/// List downloaded text-model files (*.gguf, excluding vision projectors) in the app model dir.
#[tauri::command]
pub fn list_models(app: tauri::AppHandle) -> Vec<String> {
    let Some(dir) = model_dir(&app) else {
        return vec![];
    };
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // Hide vision projectors — they aren't loadable as standalone text models.
            if name.ends_with(".gguf") && !name.contains("mmproj") {
                out.push(name);
            }
        }
    }
    out
}

/// Absolute path of the app model dir (the download target for the frontend).
#[tauri::command]
pub fn model_dir_path(app: tauri::AppHandle) -> Option<String> {
    model_dir(&app).map(|p| p.to_string_lossy().to_string())
}

/// Start (or restart) the engine on a downloaded model file.
#[tauri::command]
pub fn start_engine(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let dir = model_dir(&app).ok_or("no model dir")?;
    let model = dir.join(&filename);
    if !model.exists() {
        return Err(format!("model not found: {filename}"));
    }
    stop_text_engine(&app)?;
    stop_vision_engine(&app)?;
    wait_for_engine_port_release()?;
    *app.state::<MainModel>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(filename.clone());
    let Some(mut child) = spawn_engine(&app, &model) else {
        return Err("engine failed to launch".into());
    };
    // A doomed spawn (port already in use, incompatible model) exits within a moment. Catch that
    // and report it, instead of storing a dead process and letting the UI hang on a silent engine.
    std::thread::sleep(std::time::Duration::from_millis(600));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!(
            "The engine exited on startup (code {:?}). The port may already be in use by another process, or the model may be incompatible.",
            status.code()
        ));
    }
    *app.state::<Engine>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(child);
    Ok(())
}

/// List model files: (filename, size_bytes, is_loaded_main). Includes vision files + projectors.
#[tauri::command]
pub fn model_files(app: tauri::AppHandle) -> Vec<(String, u64, bool)> {
    let Some(dir) = model_dir(&app) else {
        return vec![];
    };
    let main = app
        .state::<MainModel>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".gguf") {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                let is_main = main.as_deref() == Some(name.as_str());
                out.push((name, size, is_main));
            }
        }
    }
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    out
}

/// Delete a model file. Refuses the active main model (switch first); if a file lock
/// blocks it (e.g. the vision engine), frees that engine and retries.
#[tauri::command]
pub fn delete_model(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let dir = model_dir(&app).ok_or("no model dir")?;
    let path = dir.join(&filename);
    if !path.exists() {
        return Ok(());
    }
    let main = app
        .state::<MainModel>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let main_running = app
        .state::<Engine>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    if main_running && main.as_deref() == Some(filename.as_str()) {
        return Err("That model is currently loaded. Switch to another model first.".into());
    }
    if std::fs::remove_file(&path).is_ok() {
        return Ok(());
    }
    // Possibly locked by the vision engine — free it and retry.
    stop_vision_engine(&app)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_running_child() -> Child {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping -t 127.0.0.1"]);
            command.stdout(Stdio::null()).stderr(Stdio::null());
            command.spawn().expect("spawn long-running Windows child")
        }
        #[cfg(not(windows))]
        {
            Command::new("sh")
                .args(["-c", "while :; do sleep 1; done"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn long-running Unix child")
        }
    }

    #[test]
    fn shutdown_waits_until_the_child_is_reaped() {
        let mut child = long_running_child();
        let report =
            stop_child_with_timeout("test engine", &mut child, Duration::from_secs(3)).unwrap();
        assert!(report.tracked);
        assert!(report.exited);
        assert_eq!(report.pid, Some(child.id()));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_wait_releases_a_windows_file_lock() {
        let nonce = format!(
            "syzygy-engine-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let original = std::env::temp_dir().join(format!("{nonce}.dll"));
        let renamed = std::env::temp_dir().join(format!("{nonce}.released"));
        std::fs::write(&original, b"lock probe").unwrap();

        let script = "$f=[IO.File]::Open($env:SYZYGY_LOCK_PROBE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); Start-Sleep -Seconds 60";
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("SYZYGY_LOCK_PROBE", &original)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn lock-holder");

        let lock_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::rename(&original, &renamed) {
                Ok(()) => {
                    std::fs::rename(&renamed, &original).unwrap();
                    if Instant::now() >= lock_deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        panic!("lock-holder never acquired the file");
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }

        stop_child_with_timeout("lock-holder", &mut child, Duration::from_secs(3)).unwrap();
        std::fs::rename(&original, &renamed)
            .expect("the file must be replaceable immediately after verified process exit");
        std::fs::remove_file(&renamed).unwrap();
    }
}
