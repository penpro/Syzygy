//! Opt-in app-owned coordinator for the private LAN development control plane.
//!
//! This is deliberately separate from project transport. The coordinator accepts encrypted
//! outbound Syzygy agents on one explicit private address and exposes an authenticated loopback
//! control attachment for the repository MCP host. Configuration stores only routing metadata and
//! the pairing-key path. The Node coordinator is embedded in the binary, supervised while the GUI
//! is alive, and killed/reaped before shutdown completes.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const CONFIG_FILE: &str = "lan-dev-coordinator.json";
const SCRIPT_DIRECTORY: &str = "lan-dev-runtime";
const COORDINATOR_FILE: &str = "lan-mcp-coordinator.mjs";
const PROTOCOL_FILE: &str = "lan-bridge-protocol.mjs";
const DEFAULT_PORT: u16 = 37_663;
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(2);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_POLL: Duration = Duration::from_millis(25);
const RESTART_DELAYS: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];
const COORDINATOR_SOURCE: &str = include_str!("../../../scripts/lan-mcp-coordinator.mjs");
const PROTOCOL_SOURCE: &str = include_str!("../../../scripts/lan-bridge-protocol.mjs");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanDevCoordinatorConfig {
    pub enabled: bool,
    pub listen: String,
    pub port: u16,
    pub key_file: String,
}

impl Default for LanDevCoordinatorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            listen: String::new(),
            port: DEFAULT_PORT,
            key_file: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanDevCoordinatorReport {
    pub config: LanDevCoordinatorConfig,
    pub running: bool,
    pub pid: Option<u32>,
    pub control_port: Option<u16>,
    pub last_error: Option<String>,
}

struct LanDevCoordinatorInner {
    config: Option<LanDevCoordinatorConfig>,
    child: Option<Child>,
    last_error: Option<String>,
    next_restart_at: Instant,
    restart_index: usize,
    supervisor_started: bool,
    stopping: bool,
}

impl Default for LanDevCoordinatorInner {
    fn default() -> Self {
        Self {
            config: None,
            child: None,
            last_error: None,
            next_restart_at: Instant::now(),
            restart_index: 0,
            supervisor_started: false,
            stopping: false,
        }
    }
}

#[derive(Default)]
pub struct LanDevCoordinatorRuntime(Mutex<LanDevCoordinatorInner>);

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE))
        .map_err(|error| format!("Could not locate the Syzygy configuration folder: {error}"))
}

fn script_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join(SCRIPT_DIRECTORY))
        .map_err(|error| format!("Could not locate the Syzygy cache folder: {error}"))
}

fn is_private_listen_address(value: &str) -> bool {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => address.is_private() || address.is_loopback(),
        Ok(IpAddr::V6(address)) => address.is_loopback() || is_unique_local_ipv6(address),
        Err(_) => false,
    }
}

fn is_unique_local_ipv6(address: Ipv6Addr) -> bool {
    address.octets()[0] & 0xfe == 0xfc
}

fn control_port(port: u16) -> Result<u16, String> {
    port.checked_add(1)
        .filter(|value| *value != 0)
        .ok_or_else(|| "Developer network port must be between 1 and 65534".to_string())
}

fn validate_config(mut config: LanDevCoordinatorConfig) -> Result<LanDevCoordinatorConfig, String> {
    config.listen = config.listen.trim().to_string();
    config.key_file = config.key_file.trim().to_string();
    if !config.enabled {
        return Ok(config);
    }
    if !is_private_listen_address(&config.listen) {
        return Err("Host address must be an explicit private or loopback IP address".into());
    }
    control_port(config.port)?;
    let key_path = Path::new(&config.key_file);
    if !key_path.is_absolute() {
        return Err("Choose an absolute LAN pairing-key file path".into());
    }
    let metadata = fs::metadata(key_path)
        .map_err(|_| "The selected LAN pairing-key file is not available".to_string())?;
    if !metadata.is_file() {
        return Err("The selected LAN pairing-key path is not a file".into());
    }
    config.key_file = key_path
        .canonicalize()
        .map_err(|_| "The selected LAN pairing-key file could not be resolved".to_string())?
        .to_string_lossy()
        .into_owned();
    Ok(config)
}

fn load_config(app: &AppHandle) -> Result<Option<LanDevCoordinatorConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read saved developer-network settings: {error}"))?;
    let config: LanDevCoordinatorConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved developer-network settings are invalid".to_string())?;
    validate_config(config).map(Some)
}

fn save_config(app: &AppHandle, config: &LanDevCoordinatorConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Developer-network configuration path has no parent folder".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the Syzygy configuration folder: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|_| "Could not encode developer-network settings".to_string())?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write developer-network settings: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Could not replace developer-network settings: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finish saving developer-network settings: {error}"))
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read(path).ok().as_deref() == Some(content.as_bytes()) {
        return Ok(());
    }
    let temporary = path.with_extension("mjs.tmp");
    fs::write(&temporary, content)
        .map_err(|error| format!("Could not stage the embedded LAN coordinator: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace the embedded LAN coordinator: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not install the embedded LAN coordinator: {error}"))
}

fn materialize_scripts(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = script_directory(app)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the LAN developer runtime folder: {error}"))?;
    write_if_changed(&directory.join(PROTOCOL_FILE), PROTOCOL_SOURCE)?;
    let coordinator = directory.join(COORDINATOR_FILE);
    write_if_changed(&coordinator, COORDINATOR_SOURCE)?;
    Ok(coordinator)
}

fn coordinator_arguments(
    script: &Path,
    config: &LanDevCoordinatorConfig,
) -> Result<Vec<String>, String> {
    Ok(vec![
        script.to_string_lossy().into_owned(),
        "--listen".into(),
        config.listen.clone(),
        "--port".into(),
        config.port.to_string(),
        "--control-port".into(),
        control_port(config.port)?.to_string(),
        "--key-file".into(),
        config.key_file.clone(),
    ])
}

fn spawn_coordinator(app: &AppHandle, config: &LanDevCoordinatorConfig) -> Result<Child, String> {
    let script = materialize_scripts(app)?;
    let mut command = Command::new("node");
    command
        .args(coordinator_arguments(&script, config)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start the developer network. Install Node.js or disable host mode: {error}"
        )
    })?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("LAN developer coordinator: {line}");
            }
        });
    }
    Ok(child)
}

fn stop_child(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("Could not inspect the developer coordinator: {error}"))?
        .is_some()
    {
        return Ok(());
    }

    // Closing the owned pipe is the coordinator's graceful shutdown signal. It closes both
    // listeners and authenticated control sockets before the process exits.
    drop(child.stdin.take());
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|error| format!("Could not inspect developer coordinator shutdown: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        std::thread::sleep(SHUTDOWN_POLL);
    }

    child
        .kill()
        .map_err(|error| format!("Could not stop the developer coordinator: {error}"))?;
    child
        .wait()
        .map_err(|error| format!("Could not reap the developer coordinator: {error}"))?;
    Ok(())
}

fn schedule_restart(inner: &mut LanDevCoordinatorInner) {
    let delay = RESTART_DELAYS[inner.restart_index.min(RESTART_DELAYS.len() - 1)];
    inner.restart_index = (inner.restart_index + 1).min(RESTART_DELAYS.len() - 1);
    inner.next_restart_at = Instant::now() + delay;
}

fn reconcile(app: &AppHandle, inner: &mut LanDevCoordinatorInner) {
    if let Some(child) = inner.child.as_mut() {
        match child.try_wait() {
            Ok(None) => return,
            Ok(Some(status)) => {
                inner.last_error = Some(format!(
                    "Developer network stopped with status {} and will restart",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                ));
                inner.child = None;
                schedule_restart(inner);
            }
            Err(error) => {
                inner.last_error =
                    Some(format!("Could not inspect the developer network: {error}"));
                return;
            }
        }
    }
    let Some(config) = inner.config.clone().filter(|value| value.enabled) else {
        return;
    };
    if inner.stopping || Instant::now() < inner.next_restart_at {
        return;
    }
    match spawn_coordinator(app, &config) {
        Ok(child) => {
            inner.child = Some(child);
            inner.last_error = None;
            inner.restart_index = 0;
        }
        Err(error) => {
            inner.last_error = Some(error);
            schedule_restart(inner);
        }
    }
}

fn report(inner: &mut LanDevCoordinatorInner) -> LanDevCoordinatorReport {
    let mut running = false;
    let mut pid = None;
    if let Some(child) = inner.child.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                running = true;
                pid = Some(child.id());
            }
            Ok(Some(status)) => {
                inner.last_error = Some(format!(
                    "Developer network stopped with status {} and will restart",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                ));
                inner.child = None;
                schedule_restart(inner);
            }
            Err(error) => {
                inner.last_error = Some(format!(
                    "Could not inspect the developer network process: {error}"
                ))
            }
        }
    }
    let control_port = inner
        .config
        .as_ref()
        .filter(|config| config.enabled)
        .and_then(|config| control_port(config.port).ok());
    LanDevCoordinatorReport {
        config: inner.config.clone().unwrap_or_default(),
        running,
        pid,
        control_port,
        last_error: inner.last_error.clone(),
    }
}

fn start_supervisor(app: &AppHandle, inner: &mut LanDevCoordinatorInner) {
    if inner.supervisor_started {
        return;
    }
    inner.supervisor_started = true;
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SUPERVISOR_INTERVAL);
        let state = app.state::<LanDevCoordinatorRuntime>();
        let Ok(mut inner) = state.0.lock() else {
            log::error!("LAN developer coordinator state lock was poisoned");
            return;
        };
        if inner.stopping {
            return;
        }
        reconcile(&app, &mut inner);
    });
}

pub fn start_saved(app: &AppHandle) -> Result<(), String> {
    let config = load_config(app)?;
    let state = app.state::<LanDevCoordinatorRuntime>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Developer coordinator state lock was poisoned".to_string())?;
    inner.config = config;
    inner.stopping = false;
    inner.next_restart_at = Instant::now();
    reconcile(app, &mut inner);
    start_supervisor(app, &mut inner);
    Ok(())
}

#[tauri::command]
pub fn lan_dev_coordinator_settings(
    state: State<'_, LanDevCoordinatorRuntime>,
) -> Result<LanDevCoordinatorReport, String> {
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Developer coordinator state lock was poisoned".to_string())?;
    Ok(report(&mut inner))
}

#[tauri::command]
pub fn lan_dev_coordinator_configure(
    app: AppHandle,
    state: State<'_, LanDevCoordinatorRuntime>,
    config: LanDevCoordinatorConfig,
) -> Result<LanDevCoordinatorReport, String> {
    let config = validate_config(config)?;
    save_config(&app, &config)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Developer coordinator state lock was poisoned".to_string())?;
    if let Some(mut child) = inner.child.take() {
        if let Err(error) = stop_child(&mut child) {
            inner.child = Some(child);
            return Err(error);
        }
    }
    inner.config = Some(config);
    inner.last_error = None;
    inner.stopping = false;
    inner.restart_index = 0;
    inner.next_restart_at = Instant::now();
    reconcile(&app, &mut inner);
    Ok(report(&mut inner))
}

pub fn shutdown(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LanDevCoordinatorRuntime>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Developer coordinator state lock was poisoned".to_string())?;
    inner.stopping = true;
    if let Some(mut child) = inner.child.take() {
        if let Err(error) = stop_child(&mut child) {
            inner.child = Some(child);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_private_host_and_reserves_adjacent_control_port() {
        assert!(is_private_listen_address("192.168.1.73"));
        assert!(is_private_listen_address("127.0.0.1"));
        assert!(is_private_listen_address("fd00::1"));
        assert!(!is_private_listen_address("8.8.8.8"));
        assert!(!is_private_listen_address("example.com"));
        assert_eq!(control_port(37_663), Ok(37_664));
        assert!(control_port(u16::MAX).is_err());
    }

    #[test]
    fn embeds_exact_coordinator_and_builds_content_free_arguments() {
        assert!(COORDINATOR_SOURCE.contains("syzygy-lan-control-v1"));
        assert!(PROTOCOL_SOURCE.contains("syzygy-lan-v1"));
        let config = LanDevCoordinatorConfig {
            enabled: true,
            listen: "192.168.1.73".into(),
            port: 37_663,
            key_file: "C:\\Users\\researcher\\.syzygy-lan.key".into(),
        };
        let arguments =
            coordinator_arguments(Path::new("C:\\runtime\\lan-mcp-coordinator.mjs"), &config)
                .expect("arguments");
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["--control-port", "37664"]));
        assert!(!arguments
            .iter()
            .any(|argument| argument.contains("pairing key contents")));
    }
}
