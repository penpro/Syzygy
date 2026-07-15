use app_lib::google_auth::access_token_from_file;
use app_lib::google_drive::{find_folder_by_name, retrieve_context_report, DriveWorkspace};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeOutput {
    passed: bool,
    workspace: String,
    visible_files: usize,
    supported_files: usize,
    native_files: usize,
    sources: Vec<String>,
    expected: String,
    answer: String,
    model: String,
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

fn extract_expected_marker(context: &str) -> Option<String> {
    let lower = context.to_lowercase();
    let marker = "secret word is";
    let start = lower.find(marker)? + marker.len();
    let rest = context.get(start..)?.trim_start();
    let value: String = rest
        .chars()
        .take_while(|ch| ch.is_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    (!value.is_empty()).then_some(value)
}

async fn run() -> Result<ProbeOutput, String> {
    let auth_file = arg_value("--auth")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_auth_file)?;
    let folder_name = arg_value("--folder-name").unwrap_or_else(|| "Syzygy".into());
    let query = arg_value("--query").unwrap_or_else(|| "What is the secret word?".into());
    let base_url = arg_value("--base-url").unwrap_or_else(|| "http://127.0.0.1:11435/v1".into());

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

    let report = retrieve_context_report(&token, workspace, &query, 12_000).await?;
    if report.native_files == 0 {
        return Err(
            "No native Google Docs, Sheets, or Slides are visible in the selected workspace."
                .into(),
        );
    }
    let expected = extract_expected_marker(&report.native_context).ok_or(
        "The retrieved native Google-file evidence did not contain a 'secret word is <value>' canary.",
    )?;

    let client = reqwest::Client::new();
    let models: serde_json::Value = client
        .get(format!("{}/models", base_url.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| format!("Local model endpoint is unavailable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Local model list was invalid JSON: {e}"))?;
    let model = models["data"]
        .get(0)
        .and_then(|entry| entry["id"].as_str())
        .ok_or("The local model endpoint reported no loaded model.")?
        .to_string();
    let response: serde_json::Value = client
        .post(format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .json(&serde_json::json!({
            "model": model,
            "stream": false,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": format!(
                        "Answer only from the Drive evidence below. If it contains the answer, do not ask for a link.\n\n{}",
                        report.context
                    )
                },
                { "role": "user", "content": query }
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("Local model request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Local model response was invalid JSON: {e}"))?;
    let answer = response["choices"]
        .get(0)
        .and_then(|choice| choice["message"]["content"].as_str())
        .ok_or_else(|| format!("Local model returned no answer: {response}"))?
        .trim()
        .to_string();
    let passed = answer.to_lowercase().contains(&expected.to_lowercase());

    Ok(ProbeOutput {
        passed,
        workspace: report.workspace.name,
        visible_files: report.visible_files,
        supported_files: report.supported_files,
        native_files: report.native_files,
        sources: report.sources,
        expected,
        answer,
        model,
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
    fn extracts_canary_from_drive_context_without_hard_coding_value() {
        let context = "[test file]\nThe secret word is narwhal\n";
        assert_eq!(extract_expected_marker(context).as_deref(), Some("narwhal"));
    }

    #[test]
    fn refuses_context_without_canary() {
        assert!(extract_expected_marker("[notes]\nNo test marker here.").is_none());
    }

    #[test]
    fn native_evidence_is_not_confused_by_transcript_language() {
        let transcript = "The secret word is not visible without Drive.";
        let native = "The secret word is narwhal.";
        assert_eq!(extract_expected_marker(transcript).as_deref(), Some("not"));
        assert_eq!(extract_expected_marker(native).as_deref(), Some("narwhal"));
    }
}
