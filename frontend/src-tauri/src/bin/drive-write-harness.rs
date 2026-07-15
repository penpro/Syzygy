use app_lib::google_auth::access_token_from_file;
use app_lib::google_drive::{
    create_native_spreadsheet, find_folder_by_name, read_sheet_range, trash_file,
    write_sheet_range, DriveWorkspace,
};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeOutput {
    passed: bool,
    workspace: String,
    rows: usize,
    columns: usize,
    cells: usize,
    updated_range: String,
    readback_matched: bool,
    cleanup_succeeded: bool,
}

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

fn probe_values() -> Vec<Vec<String>> {
    (0..20)
        .map(|row| {
            (0..10)
                .map(|column| ((row * 10 + column) % 10).to_string())
                .collect()
        })
        .collect()
}

async fn run() -> Result<ProbeOutput, String> {
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
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let file_id = create_native_spreadsheet(
        &token,
        &workspace.id,
        &format!("Syzygy temporary write probe {stamp}"),
    )
    .await?;
    let values = probe_values();
    let outcome = async {
        let write = write_sheet_range(&token, &file_id, "A1", values.clone()).await?;
        let readback = read_sheet_range(&token, &file_id, "A1:J20").await?;
        Ok::<_, String>((write, readback == values))
    }
    .await;
    let cleanup = trash_file(&token, &file_id).await;
    let (write, readback_matched) = match (outcome, cleanup) {
        (Ok(result), Ok(())) => result,
        (Err(error), Ok(())) => {
            return Err(format!("{error} Temporary write-probe cleanup succeeded."))
        }
        (Ok(_), Err(cleanup_error)) => return Err(cleanup_error),
        (Err(error), Err(cleanup_error)) => {
            return Err(format!("{error} Cleanup also failed: {cleanup_error}"))
        }
    };
    let cleanup_succeeded = true;
    let passed = readback_matched && write.updated_cells == 200 && cleanup_succeeded;
    Ok(ProbeOutput {
        passed,
        workspace: workspace.name,
        rows: write.updated_rows,
        columns: write.updated_columns,
        cells: write.updated_cells,
        updated_range: write.updated_range,
        readback_matched,
        cleanup_succeeded,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_is_the_reported_twenty_by_ten_grid() {
        let values = probe_values();
        assert_eq!(values.len(), 20);
        assert!(values.iter().all(|row| row.len() == 10));
        assert_eq!(values.iter().flatten().count(), 200);
    }
}
