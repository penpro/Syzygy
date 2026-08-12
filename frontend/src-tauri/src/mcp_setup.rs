//! One source of truth for connecting an MCP host to the installed Syzygy executable.
//!
//! The desktop UI and the embedded MCP both use this module so copied setup instructions cannot
//! drift from the executable that is actually running.

use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use toml_edit::{value, Array, Document, Item, Table};

pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
pub const MCP_SERVER_NAME: &str = "syzygy-live";
pub const LAN_MCP_SERVER_NAME: &str = "syzygy-lan";

const STARTER_PROMPT: &str = "Use the Syzygy tools to inspect the live workspace, run the workspace walkthrough, explain the current project to me, and offer one concrete demonstration edit. Read before writing and ask before making the demonstration edit.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionInfo {
    pub app_version: String,
    pub protocol_version: String,
    pub server_name: String,
    pub transport: String,
    pub executable_path: String,
    pub install_folder: String,
    pub arguments: Vec<String>,
    pub generic_json: String,
    pub codex_toml: String,
    pub connection_prompt: String,
    pub starter_prompt: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpInstallResult {
    pub server_name: String,
    pub config_path: String,
    pub changed: bool,
    pub restart_required: bool,
}

fn codex_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map(|directory| directory.join(".codex").join("config.toml"))
        .map_err(|error| format!("Could not locate the Codex configuration folder: {error}"))
}

fn server_table_mut<'a>(document: &'a mut Document, server_name: &str) -> &'a mut Table {
    if !document["mcp_servers"].is_table() {
        document["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = document["mcp_servers"]
        .as_table_mut()
        .expect("table installed above");
    if !servers.get(server_name).is_some_and(Item::is_table) {
        servers[server_name] = Item::Table(Table::new());
    }
    servers[server_name]
        .as_table_mut()
        .expect("table installed above")
}

fn install_server_at_path(
    config_path: &Path,
    server_name: &str,
    command: &str,
    args: &[String],
) -> Result<bool, String> {
    let source = if config_path.exists() {
        fs::read_to_string(config_path)
            .map_err(|error| format!("Could not read the Codex MCP configuration: {error}"))?
    } else {
        String::new()
    };
    let mut document = source
        .parse::<Document>()
        .map_err(|error| format!("Codex config.toml is invalid and was not changed: {error}"))?;
    let before = document.to_string();
    let server = server_table_mut(&mut document, server_name);
    server["command"] = value(command);
    let mut argument_array = Array::new();
    for argument in args {
        argument_array.push(argument.as_str());
    }
    server["args"] = value(argument_array);
    server["enabled"] = value(true);
    server["required"] = value(false);
    server["startup_timeout_sec"] = value(10);
    server["tool_timeout_sec"] = value(65);
    server["default_tools_approval_mode"] = value("writes");
    let next = document.to_string();
    if next == before {
        return Ok(false);
    }

    let directory = config_path
        .parent()
        .ok_or_else(|| "Codex configuration path has no parent folder".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the Codex configuration folder: {error}"))?;
    let temporary = config_path.with_extension("toml.syzygy-new");
    let backup = config_path.with_extension("toml.syzygy-backup");
    if temporary.exists() || backup.exists() {
        return Err("A prior Syzygy Codex-config repair file exists; preserve it and inspect the Codex configuration before retrying".into());
    }
    fs::write(&temporary, next)
        .map_err(|error| format!("Could not stage the Codex MCP configuration: {error}"))?;
    let had_existing = config_path.exists();
    if had_existing {
        fs::rename(config_path, &backup).map_err(|error| {
            format!("Could not preserve the existing Codex configuration: {error}")
        })?;
    }
    if let Err(error) = fs::rename(&temporary, config_path) {
        if had_existing {
            let _ = fs::rename(&backup, config_path);
        }
        return Err(format!(
            "Could not install the Codex MCP configuration: {error}"
        ));
    }
    if had_existing {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Codex MCP was installed, but its temporary backup could not be removed: {error}"
            )
        })?;
    }
    Ok(true)
}

fn install_result(
    config_path: PathBuf,
    server_name: &str,
    command: &str,
    args: &[String],
) -> Result<CodexMcpInstallResult, String> {
    let changed = install_server_at_path(&config_path, server_name, command, args)?;
    Ok(CodexMcpInstallResult {
        server_name: server_name.to_string(),
        config_path: config_path.to_string_lossy().into_owned(),
        changed,
        restart_required: changed,
    })
}

pub fn current() -> Result<McpConnectionInfo, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the running Syzygy executable: {error}"))?;
    from_executable(&executable)
}

fn from_executable(executable: &Path) -> Result<McpConnectionInfo, String> {
    let executable = executable
        .canonicalize()
        .unwrap_or_else(|_| executable.to_path_buf());
    let install_folder = executable
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "The running Syzygy executable has no parent folder".to_string())?;
    let executable_path = executable.to_string_lossy().to_string();
    let install_folder = install_folder.to_string_lossy().to_string();

    let generic_json = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "stdio",
                "command": executable_path,
                "args": ["--mcp"]
            }
        }
    }))
    .map_err(|error| format!("Could not generate MCP JSON: {error}"))?;
    let command_literal = serde_json::to_string(&executable_path)
        .map_err(|error| format!("Could not quote the executable path: {error}"))?;
    let codex_toml =
        format!("[mcp_servers.{MCP_SERVER_NAME}]\ncommand = {command_literal}\nargs = [\"--mcp\"]");
    let connection_prompt = format!(
        "Help me connect this MCP-capable client to Syzygy's local MCP server.\n\n\
Server name: {MCP_SERVER_NAME}\n\
Transport: stdio\n\
Executable: {executable_path}\n\
Arguments: --mcp\n\n\
Use the exact executable path above; do not substitute a network URL or a second project database. \
If you can edit this client's MCP configuration, add the server and tell me when the client must be restarted. \
If you cannot edit it, show me exactly where to paste the configuration. After connecting, call \
syzygy_installation, then launch_syzygy if needed, then syzygy_status and workspace_walkthrough. \
Read the active project before any write, and ask before changing research content."
    );

    Ok(McpConnectionInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: MCP_PROTOCOL_VERSION.to_string(),
        server_name: MCP_SERVER_NAME.to_string(),
        transport: "stdio".to_string(),
        executable_path,
        install_folder,
        arguments: vec!["--mcp".to_string()],
        generic_json,
        codex_toml,
        connection_prompt,
        starter_prompt: STARTER_PROMPT.to_string(),
    })
}

#[tauri::command]
pub fn mcp_connection_info() -> Result<McpConnectionInfo, String> {
    current()
}

#[tauri::command]
pub fn codex_mcp_install_local(app: AppHandle) -> Result<CodexMcpInstallResult, String> {
    let connection = current()?;
    install_result(
        codex_config_path(&app)?,
        MCP_SERVER_NAME,
        &connection.executable_path,
        &connection.arguments,
    )
}

#[tauri::command]
pub fn codex_mcp_install_lan(app: AppHandle) -> Result<CodexMcpInstallResult, String> {
    let attachment = crate::lan_dev_coordinator::codex_lan_attachment(&app)?;
    let args = vec![
        attachment.script.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--control-port".into(),
        attachment.control_port.to_string(),
        "--key-file".into(),
        attachment.key_file,
    ];
    install_result(
        codex_config_path(&app)?,
        LAN_MCP_SERVER_NAME,
        &attachment.command,
        &args,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_uses_exact_executable_and_parent_folder() {
        let path = if cfg!(windows) {
            PathBuf::from(r"C:\Program Files\Syzygy\Syzygy.exe")
        } else {
            PathBuf::from("/opt/Syzygy/Syzygy")
        };
        let info = from_executable(&path).unwrap();

        assert_eq!(info.executable_path, path.to_string_lossy());
        assert_eq!(
            info.install_folder,
            path.parent().unwrap().to_string_lossy()
        );
        assert_eq!(info.arguments, vec!["--mcp"]);
        assert!(info.connection_prompt.contains(&info.executable_path));
        assert!(info.connection_prompt.contains("syzygy_installation"));
    }

    #[test]
    fn generated_json_and_toml_preserve_paths_with_spaces() {
        let path = if cfg!(windows) {
            PathBuf::from(r"C:\Users\Research Team\Syzygy.exe")
        } else {
            PathBuf::from("/home/research team/Syzygy")
        };
        let info = from_executable(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&info.generic_json).unwrap();

        assert_eq!(
            json["mcpServers"][MCP_SERVER_NAME]["command"],
            path.to_string_lossy().as_ref()
        );
        assert_eq!(json["mcpServers"][MCP_SERVER_NAME]["args"][0], "--mcp");
        assert!(info.codex_toml.contains("command = \""));
        assert!(info.codex_toml.contains("args = [\"--mcp\"]"));
    }

    #[test]
    fn codex_install_preserves_other_settings_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("syzygy-codex-mcp-{}", std::process::id()));
        let path = root.join("config.toml");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            "model = \"test-model\"\n\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .unwrap();
        let args = vec!["--mcp".to_string()];

        assert!(install_server_at_path(
            &path,
            MCP_SERVER_NAME,
            r"C:\Program Files\Syzygy\Syzygy.exe",
            &args
        )
        .unwrap());
        assert!(!install_server_at_path(
            &path,
            MCP_SERVER_NAME,
            r"C:\Program Files\Syzygy\Syzygy.exe",
            &args
        )
        .unwrap());
        let installed = fs::read_to_string(&path).unwrap();
        let parsed = installed.parse::<Document>().unwrap();
        assert_eq!(parsed["model"].as_str(), Some("test-model"));
        assert_eq!(
            parsed["mcp_servers"]["other"]["command"].as_str(),
            Some("other")
        );
        assert_eq!(
            parsed["mcp_servers"][MCP_SERVER_NAME]["command"].as_str(),
            Some(r"C:\Program Files\Syzygy\Syzygy.exe")
        );
        assert_eq!(
            parsed["mcp_servers"][MCP_SERVER_NAME]["default_tools_approval_mode"].as_str(),
            Some("writes")
        );
        assert!(!path.with_extension("toml.syzygy-backup").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
