use app_lib::drive_projects::run_live_canary;
use app_lib::google_auth::access_token_from_file;
use app_lib::google_drive::{find_folder_by_name, DriveWorkspace};
use std::path::PathBuf;

fn arg_value(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn default_auth_file() -> Result<PathBuf, String> {
    let appdata =
        std::env::var_os("APPDATA").ok_or("APPDATA is unavailable; pass --auth <path>.")?;
    Ok(PathBuf::from(appdata)
        .join("com.penumbra.syzygy")
        .join("google_auth.json"))
}

fn saved_workspace(auth_file: &std::path::Path) -> Option<DriveWorkspace> {
    let path = auth_file.parent()?.join("drive_workspace.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

async fn run() -> Result<app_lib::drive_projects::DriveProjectCanaryResult, String> {
    let auth_file = arg_value("--auth")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_auth_file)?;
    let folder_name = arg_value("--folder-name").unwrap_or_else(|| "Syzygy".into());
    let token = access_token_from_file(&auth_file).await?;
    let workspace = if let Some(folder_id) = arg_value("--folder-id") {
        DriveWorkspace {
            id: folder_id,
            name: folder_name,
        }
    } else if let Some(saved) = saved_workspace(&auth_file) {
        saved
    } else {
        find_folder_by_name(&token, &folder_name)
            .await?
            .ok_or_else(|| format!("No visible Drive folder named {folder_name:?}."))?
    };
    run_live_canary(&token, workspace).await
}

fn main() {
    match tauri::async_runtime::block_on(run()) {
        Ok(output) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&output).unwrap_or_else(|_| "{}".into())
            );
            if !output.passed {
                std::process::exit(2);
            }
        }
        Err(error) => {
            eprintln!("{}", serde_json::json!({ "passed": false, "error": error }));
            std::process::exit(1);
        }
    }
}
