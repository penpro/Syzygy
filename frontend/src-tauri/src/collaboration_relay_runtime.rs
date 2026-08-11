//! Opt-in lifecycle owner for Syzygy's bundled research-collaboration relay.
//!
//! The relay runs as a child mode of the installed Syzygy executable. This keeps listener and
//! storage lifetime independent from the webview, allows a bounded graceful shutdown, and avoids a
//! Node.js or PowerShell prerequisite. Project invitations remain bearer credentials; this runtime
//! does not claim authenticated human identity.

use crate::collaboration_relay_membership::{
    create_room, issue_member, registry_path, report_room, revoke_member, rotate_member,
    RelayDeviceBinding, RelayMemberCredential, RelayMemberRole, RelayRoomMembershipReport,
};
use crate::collaboration_relay_server::is_private_listen_address;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const CONFIG_FILE: &str = "collaboration-relay.json";
const STORAGE_DIRECTORY: &str = "collaboration-relay";
const DEFAULT_PORT: u16 = 37_665;
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(2);
const STARTUP_DEADLINE: Duration = Duration::from_secs(3);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const PORT_RELEASE_DEADLINE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const RESTART_DELAYS: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationRelayConfig {
    pub enabled: bool,
    pub listen: String,
    pub port: u16,
}

impl Default for CollaborationRelayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            listen: "127.0.0.1".into(),
            port: DEFAULT_PORT,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationRelayReport {
    pub config: CollaborationRelayConfig,
    pub running: bool,
    pub pid: Option<u32>,
    pub endpoint: Option<String>,
    pub storage_path: String,
    pub persistence: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayRoomCredentialResult {
    pub credential: RelayMemberCredential,
    pub room: RelayRoomMembershipReport,
}

struct CollaborationRelayInner {
    config: Option<CollaborationRelayConfig>,
    child: Option<Child>,
    last_error: Option<String>,
    next_restart_at: Instant,
    restart_index: usize,
    supervisor_started: bool,
    stopping: bool,
}

impl Default for CollaborationRelayInner {
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
pub struct CollaborationRelayRuntime(Mutex<CollaborationRelayInner>);

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE))
        .map_err(|error| format!("Could not locate the Syzygy configuration folder: {error}"))
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STORAGE_DIRECTORY))
        .map_err(|error| format!("Could not locate the Syzygy data folder: {error}"))
}

fn socket_address(config: &CollaborationRelayConfig) -> Result<SocketAddr, String> {
    let ip = config
        .listen
        .parse::<IpAddr>()
        .map_err(|_| "Relay host must be an explicit private or loopback IP address".to_string())?;
    Ok(SocketAddr::new(ip, config.port))
}

fn endpoint(config: &CollaborationRelayConfig) -> Result<String, String> {
    Ok(format!("ws://{}", socket_address(config)?))
}

fn validate_config(
    mut config: CollaborationRelayConfig,
) -> Result<CollaborationRelayConfig, String> {
    config.listen = config.listen.trim().to_string();
    if !config.enabled {
        return Ok(config);
    }
    if !is_private_listen_address(&config.listen) {
        return Err("Relay host must be an explicit private or loopback IP address".into());
    }
    if config.port == 0 {
        return Err("Relay port must be between 1 and 65535".into());
    }
    Ok(config)
}

fn load_config(app: &AppHandle) -> Result<Option<CollaborationRelayConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read saved collaboration-relay settings: {error}"))?;
    let config: CollaborationRelayConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved collaboration-relay settings are invalid".to_string())?;
    validate_config(config).map(Some)
}

fn save_config(app: &AppHandle, config: &CollaborationRelayConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Collaboration-relay configuration path has no parent folder".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the Syzygy configuration folder: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|_| "Could not encode collaboration-relay settings".to_string())?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write collaboration-relay settings: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Could not replace collaboration-relay settings: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finish saving collaboration-relay settings: {error}"))
}

fn child_arguments(config: &CollaborationRelayConfig, storage: &std::path::Path) -> Vec<String> {
    vec![
        "--collaboration-relay".into(),
        "--listen".into(),
        config.listen.clone(),
        "--port".into(),
        config.port.to_string(),
        "--data-dir".into(),
        storage.to_string_lossy().into_owned(),
    ]
}

fn port_is_available(address: SocketAddr) -> bool {
    TcpListener::bind(address).is_ok()
}

fn wait_until_ready(child: &mut Child, address: SocketAddr) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_DEADLINE;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect collaboration relay startup: {error}"))?
        {
            return Err(format!(
                "Collaboration relay exited during startup with status {}",
                status
                    .code()
                    .map_or_else(|| "unknown".into(), |code| code.to_string())
            ));
        }
        if TcpStream::connect_timeout(&address, POLL_INTERVAL).is_ok() {
            return Ok(());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Err("Collaboration relay did not open its listener within 3 seconds".into())
}

fn spawn_relay(app: &AppHandle, config: &CollaborationRelayConfig) -> Result<Child, String> {
    let address = socket_address(config)?;
    if !port_is_available(address) {
        return Err(format!(
            "Collaboration relay address {address} is already in use"
        ));
    }
    let storage = storage_path(app)?;
    fs::create_dir_all(&storage)
        .map_err(|error| format!("Could not create collaboration-relay storage: {error}"))?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Syzygy executable: {error}"))?;
    let mut command = Command::new(executable);
    command
        .args(child_arguments(config, &storage))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the bundled collaboration relay: {error}"))?;
    if let Err(error) = wait_until_ready(&mut child, address) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::info!("Collaboration relay: {line}");
            }
        });
    }
    Ok(child)
}

fn wait_for_port_release(address: SocketAddr) -> Result<(), String> {
    let deadline = Instant::now() + PORT_RELEASE_DEADLINE;
    while Instant::now() < deadline {
        if port_is_available(address) {
            return Ok(());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "Collaboration relay process exited but listener {address} was not released within 2 seconds"
    ))
}

fn stop_child(child: &mut Child, address: SocketAddr) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("Could not inspect collaboration relay: {error}"))?
        .is_none()
    {
        // Closing the owned stdin pipe is the relay's graceful shutdown signal.
        drop(child.stdin.take());
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if child
                .try_wait()
                .map_err(|error| {
                    format!("Could not inspect collaboration relay shutdown: {error}")
                })?
                .is_some()
            {
                return wait_for_port_release(address);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        child
            .kill()
            .map_err(|error| format!("Could not stop collaboration relay: {error}"))?;
        child
            .wait()
            .map_err(|error| format!("Could not reap collaboration relay: {error}"))?;
    }
    wait_for_port_release(address)
}

fn schedule_restart(inner: &mut CollaborationRelayInner) {
    let delay = RESTART_DELAYS[inner.restart_index.min(RESTART_DELAYS.len() - 1)];
    inner.restart_index = (inner.restart_index + 1).min(RESTART_DELAYS.len() - 1);
    inner.next_restart_at = Instant::now() + delay;
}

fn reconcile(app: &AppHandle, inner: &mut CollaborationRelayInner) {
    if let Some(child) = inner.child.as_mut() {
        match child.try_wait() {
            Ok(None) => return,
            Ok(Some(status)) => {
                inner.last_error = Some(format!(
                    "Collaboration relay stopped with status {} and will restart",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                ));
                inner.child = None;
                schedule_restart(inner);
            }
            Err(error) => {
                inner.last_error = Some(format!("Could not inspect collaboration relay: {error}"));
                return;
            }
        }
    }
    let Some(config) = inner.config.clone().filter(|config| config.enabled) else {
        return;
    };
    if inner.stopping || Instant::now() < inner.next_restart_at {
        return;
    }
    match spawn_relay(app, &config) {
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

fn report(
    app: &AppHandle,
    inner: &mut CollaborationRelayInner,
) -> Result<CollaborationRelayReport, String> {
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
                    "Collaboration relay stopped with status {} and will restart",
                    status
                        .code()
                        .map_or_else(|| "unknown".into(), |code| code.to_string())
                ));
                inner.child = None;
                schedule_restart(inner);
            }
            Err(error) => {
                inner.last_error = Some(format!("Could not inspect collaboration relay: {error}"))
            }
        }
    }
    let config = inner.config.clone().unwrap_or_default();
    Ok(CollaborationRelayReport {
        endpoint: config.enabled.then(|| endpoint(&config)).transpose()?,
        config,
        running,
        pid,
        storage_path: storage_path(app)?.to_string_lossy().into_owned(),
        persistence: "bounded-sync-update-log-v1".into(),
        last_error: inner.last_error.clone(),
    })
}

fn start_supervisor(app: &AppHandle, inner: &mut CollaborationRelayInner) {
    if inner.supervisor_started {
        return;
    }
    inner.supervisor_started = true;
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(SUPERVISOR_INTERVAL);
        let state = app.state::<CollaborationRelayRuntime>();
        let Ok(mut inner) = state.0.lock() else {
            log::error!("Collaboration relay state lock was poisoned");
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
    let state = app.state::<CollaborationRelayRuntime>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    inner.config = config;
    inner.stopping = false;
    inner.next_restart_at = Instant::now();
    reconcile(app, &mut inner);
    start_supervisor(app, &mut inner);
    Ok(())
}

#[tauri::command]
pub fn collaboration_relay_settings(
    app: AppHandle,
    state: State<'_, CollaborationRelayRuntime>,
) -> Result<CollaborationRelayReport, String> {
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    report(&app, &mut inner)
}

#[tauri::command]
pub fn collaboration_relay_configure(
    app: AppHandle,
    state: State<'_, CollaborationRelayRuntime>,
    config: CollaborationRelayConfig,
) -> Result<CollaborationRelayReport, String> {
    let config = validate_config(config)?;
    save_config(&app, &config)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    if let Some(mut child) = inner.child.take() {
        let address = inner
            .config
            .as_ref()
            .map(socket_address)
            .transpose()?
            .ok_or_else(|| "Running collaboration relay has no saved address".to_string())?;
        if let Err(error) = stop_child(&mut child, address) {
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
    report(&app, &mut inner)
}

fn stop_for_membership_change(inner: &mut CollaborationRelayInner) -> Result<(), String> {
    let config = inner
        .config
        .clone()
        .filter(|config| config.enabled)
        .ok_or_else(|| {
            "Enable this installation's collaboration relay before managing members".to_string()
        })?;
    if let Some(mut child) = inner.child.take() {
        let address = socket_address(&config)?;
        if let Err(error) = stop_child(&mut child, address) {
            inner.child = Some(child);
            return Err(error);
        }
    }
    Ok(())
}

fn resume_after_membership_change(app: &AppHandle, inner: &mut CollaborationRelayInner) {
    inner.restart_index = 0;
    inner.next_restart_at = Instant::now();
    inner.last_error = None;
    reconcile(app, inner);
}

#[tauri::command]
pub fn collaboration_relay_room_status(
    app: AppHandle,
    room_id: String,
) -> Result<RelayRoomMembershipReport, String> {
    report_room(&registry_path(&storage_path(&app)?), &room_id)
}

#[tauri::command]
pub fn collaboration_relay_room_create(
    app: AppHandle,
    state: State<'_, CollaborationRelayRuntime>,
    project_id: String,
    room_id: String,
    device: Option<RelayDeviceBinding>,
) -> Result<RelayRoomCredentialResult, String> {
    let membership_path = registry_path(&storage_path(&app)?);
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    stop_for_membership_change(&mut inner)?;
    let result = create_room(&membership_path, &project_id, &room_id, device);
    resume_after_membership_change(&app, &mut inner);
    result.map(|(credential, room)| RelayRoomCredentialResult { credential, room })
}

#[tauri::command]
pub fn collaboration_relay_member_issue(
    app: AppHandle,
    state: State<'_, CollaborationRelayRuntime>,
    room_id: String,
    expected_revision: u64,
    role: RelayMemberRole,
    expires_in_seconds: Option<u64>,
    device: Option<RelayDeviceBinding>,
) -> Result<RelayRoomCredentialResult, String> {
    let membership_path = registry_path(&storage_path(&app)?);
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    stop_for_membership_change(&mut inner)?;
    let result = issue_member(
        &membership_path,
        &room_id,
        expected_revision,
        role,
        expires_in_seconds,
        device,
    );
    resume_after_membership_change(&app, &mut inner);
    result.map(|(credential, room)| RelayRoomCredentialResult { credential, room })
}

#[tauri::command]
pub fn collaboration_relay_member_rotate(
    app: AppHandle,
    state: State<'_, CollaborationRelayRuntime>,
    room_id: String,
    member_id: String,
    expected_revision: u64,
    expires_in_seconds: Option<u64>,
    device: Option<RelayDeviceBinding>,
) -> Result<RelayRoomCredentialResult, String> {
    let membership_path = registry_path(&storage_path(&app)?);
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    stop_for_membership_change(&mut inner)?;
    let result = rotate_member(
        &membership_path,
        &room_id,
        &member_id,
        expected_revision,
        expires_in_seconds,
        device,
    );
    resume_after_membership_change(&app, &mut inner);
    result.map(|(credential, room)| RelayRoomCredentialResult { credential, room })
}

#[tauri::command]
pub fn collaboration_relay_member_revoke(
    app: AppHandle,
    state: State<'_, CollaborationRelayRuntime>,
    room_id: String,
    member_id: String,
    expected_revision: u64,
) -> Result<RelayRoomMembershipReport, String> {
    let membership_path = registry_path(&storage_path(&app)?);
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    stop_for_membership_change(&mut inner)?;
    let result = revoke_member(&membership_path, &room_id, &member_id, expected_revision);
    resume_after_membership_change(&app, &mut inner);
    result
}

pub fn shutdown(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<CollaborationRelayRuntime>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "Collaboration relay state lock was poisoned".to_string())?;
    inner.stopping = true;
    if let Some(mut child) = inner.child.take() {
        let address = inner
            .config
            .as_ref()
            .map(socket_address)
            .transpose()?
            .ok_or_else(|| "Running collaboration relay has no saved address".to_string())?;
        if let Err(error) = stop_child(&mut child, address) {
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
    fn config_is_private_and_arguments_contain_no_project_or_invitation_secret() {
        let config = validate_config(CollaborationRelayConfig {
            enabled: true,
            listen: " 192.168.1.20 ".into(),
            port: 37_665,
        })
        .unwrap();
        assert_eq!(endpoint(&config).unwrap(), "ws://192.168.1.20:37665");
        assert!(validate_config(CollaborationRelayConfig {
            enabled: true,
            listen: "8.8.8.8".into(),
            port: 37_665,
        })
        .is_err());
        assert!(validate_config(CollaborationRelayConfig {
            enabled: false,
            listen: "unfinished address".into(),
            port: 0,
        })
        .is_ok());
        let arguments = child_arguments(&config, std::path::Path::new("C:\\Syzygy\\relay"));
        assert!(arguments
            .iter()
            .any(|value| value == "--collaboration-relay"));
        assert!(!arguments.iter().any(|value| value.contains("room_")));
        assert!(!arguments.iter().any(|value| value.contains("invitation")));
    }
}
