//! Opt-in lifecycle owner for the packaged outbound LAN MCP agent.
//!
//! Configuration contains only routing metadata and a user-selected key-file path. The pairing
//! key itself remains in that file and is read only by the child agent. The GUI never opens a LAN
//! listener; it starts one outbound child and reaps it before the desktop process exits.

use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const CONFIG_FILE: &str = "lan-agent.json";
const DEFAULT_PORT: u16 = 37_663;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanAgentConfig {
    pub enabled: bool,
    pub node_id: String,
    pub coordinator: String,
    pub port: u16,
    pub key_file: String,
}

impl Default for LanAgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            node_id: "syzygy-node".into(),
            coordinator: String::new(),
            port: DEFAULT_PORT,
            key_file: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanAgentReport {
    pub config: LanAgentConfig,
    pub running: bool,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct LanAgentInner {
    config: Option<LanAgentConfig>,
    child: Option<Child>,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct LanAgentRuntime(Mutex<LanAgentInner>);

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE))
        .map_err(|error| format!("Could not locate the Syzygy configuration folder: {error}"))
}

fn is_private_coordinator(value: &str) -> bool {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => address.is_private() || address.is_loopback(),
        Ok(IpAddr::V6(address)) => address.is_loopback() || is_unique_local_ipv6(address),
        Err(_) => false,
    }
}

fn is_unique_local_ipv6(address: Ipv6Addr) -> bool {
    address.octets()[0] & 0xfe == 0xfc
}

fn valid_node_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_config(mut config: LanAgentConfig) -> Result<LanAgentConfig, String> {
    config.node_id = config.node_id.trim().to_string();
    config.coordinator = config.coordinator.trim().to_string();
    config.key_file = config.key_file.trim().to_string();
    if !valid_node_id(&config.node_id) {
        return Err(
            "Computer label must be 1–64 letters, numbers, dots, dashes, or underscores and start with a letter or number"
                .into(),
        );
    }
    if !config.enabled {
        return Ok(config);
    }
    if !is_private_coordinator(&config.coordinator) {
        return Err("Coordinator must be an explicit private or loopback IP address".into());
    }
    if config.port == 0 {
        return Err("Coordinator port must be between 1 and 65535".into());
    }
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

fn load_config(app: &AppHandle) -> Result<Option<LanAgentConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read saved LAN connection settings: {error}"))?;
    let config: LanAgentConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved LAN connection settings are invalid".to_string())?;
    validate_config(config).map(Some)
}

fn save_config(app: &AppHandle, config: &LanAgentConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "LAN configuration path has no parent folder".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the Syzygy configuration folder: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|_| "Could not encode LAN connection settings".to_string())?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write LAN connection settings: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Could not replace LAN connection settings: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finish saving LAN connection settings: {error}"))
}

fn child_arguments(config: &LanAgentConfig) -> Vec<String> {
    vec![
        "--lan-agent".into(),
        "--node-id".into(),
        config.node_id.clone(),
        "--coordinator".into(),
        config.coordinator.clone(),
        "--port".into(),
        config.port.to_string(),
        "--key-file".into(),
        config.key_file.clone(),
    ]
}

fn spawn_agent(config: &LanAgentConfig) -> Result<Child, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate this Syzygy executable: {error}"))?;
    let mut command = Command::new(executable);
    command
        .args(child_arguments(config))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not start the private LAN connection: {error}"))
}

fn stop_child(child: &mut Child) -> Result<(), String> {
    match child
        .try_wait()
        .map_err(|error| format!("Could not inspect the LAN agent process: {error}"))?
    {
        Some(_) => Ok(()),
        None => {
            child
                .kill()
                .map_err(|error| format!("Could not stop the LAN agent process: {error}"))?;
            child
                .wait()
                .map_err(|error| format!("Could not reap the LAN agent process: {error}"))?;
            Ok(())
        }
    }
}

fn report(inner: &mut LanAgentInner) -> LanAgentReport {
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
                    "Private LAN connection stopped with status {}",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                ));
                inner.child = None;
            }
            Err(error) => {
                inner.last_error = Some(format!(
                    "Could not inspect the private LAN connection: {error}"
                ));
            }
        }
    }
    LanAgentReport {
        config: inner.config.clone().unwrap_or_default(),
        running,
        pid,
        last_error: inner.last_error.clone(),
    }
}

pub fn start_saved(app: &AppHandle) -> Result<(), String> {
    let config = load_config(app)?;
    let state = app.state::<LanAgentRuntime>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "LAN agent state lock was poisoned".to_string())?;
    inner.config = config.clone();
    if let Some(config) = config.filter(|value| value.enabled) {
        match spawn_agent(&config) {
            Ok(child) => inner.child = Some(child),
            Err(error) => inner.last_error = Some(error),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn lan_agent_settings(state: State<'_, LanAgentRuntime>) -> Result<LanAgentReport, String> {
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "LAN agent state lock was poisoned".to_string())?;
    Ok(report(&mut inner))
}

#[tauri::command]
pub fn lan_agent_configure(
    app: AppHandle,
    state: State<'_, LanAgentRuntime>,
    config: LanAgentConfig,
) -> Result<LanAgentReport, String> {
    let config = validate_config(config)?;
    save_config(&app, &config)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "LAN agent state lock was poisoned".to_string())?;
    if let Some(mut child) = inner.child.take() {
        if let Err(error) = stop_child(&mut child) {
            inner.child = Some(child);
            return Err(error);
        }
    }
    inner.config = Some(config.clone());
    inner.last_error = None;
    if config.enabled {
        match spawn_agent(&config) {
            Ok(child) => inner.child = Some(child),
            Err(error) => inner.last_error = Some(error),
        }
    }
    Ok(report(&mut inner))
}

pub fn shutdown(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LanAgentRuntime>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "LAN agent state lock was poisoned".to_string())?;
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
    fn accepts_only_private_explicit_coordinators() {
        assert!(is_private_coordinator("192.168.1.73"));
        assert!(is_private_coordinator("10.0.0.9"));
        assert!(is_private_coordinator("127.0.0.1"));
        assert!(is_private_coordinator("fd00::1"));
        assert!(!is_private_coordinator("8.8.8.8"));
        assert!(!is_private_coordinator("example.com"));
    }

    #[test]
    fn bounds_node_identity_and_child_arguments() {
        assert!(valid_node_id("office-secondary"));
        assert!(!valid_node_id("-office-secondary"));
        assert!(!valid_node_id("office secondary"));
        assert!(!valid_node_id(&"a".repeat(65)));
        let config = LanAgentConfig {
            enabled: true,
            node_id: "office-secondary".into(),
            coordinator: "192.168.1.73".into(),
            port: 37_663,
            key_file: "C:\\Users\\researcher\\.syzygy-lan.key".into(),
        };
        assert_eq!(
            child_arguments(&config),
            vec![
                "--lan-agent",
                "--node-id",
                "office-secondary",
                "--coordinator",
                "192.168.1.73",
                "--port",
                "37663",
                "--key-file",
                "C:\\Users\\researcher\\.syzygy-lan.key",
            ]
        );
    }
}
