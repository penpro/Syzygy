//! One source of truth for connecting an MCP host to the installed Syzygy executable.
//!
//! The desktop UI and the embedded MCP both use this module so copied setup instructions cannot
//! drift from the executable that is actually running.

use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};

pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
pub const MCP_SERVER_NAME: &str = "syzygy-live";

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
}
