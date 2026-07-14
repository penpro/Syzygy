//! Google OAuth 2.0 for installed apps: loopback redirect + PKCE (RFC 8252 §7.3).
//!
//! The whole exchange lives here in the Rust core — the webview never sees a token and the
//! CSP never opens to Google. Flow: spin a one-shot listener on 127.0.0.1:<random>, open the
//! consent URL in the system browser, catch the redirect, swap the code for tokens over TLS,
//! and persist the refresh token to `<app-data>/google_auth.json`. The frontend only ever
//! learns the connected account's email (and, on demand, a short-lived access token for
//! Drive calls made from Rust later).
//!
//! Scope is deliberately minimal: `drive.file` (only files/folders this app creates or the
//! user explicitly picks) + `openid email` for the "Connected as …" display.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use tauri::Manager;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const SCOPE: &str = "openid email https://www.googleapis.com/auth/drive.file";
/// How long we wait for the user to finish the consent screen in their browser.
const CONSENT_TIMEOUT_SECS: u64 = 300;

#[derive(Serialize, Deserialize)]
struct StoredAuth {
    client_id: String,
    refresh_token: String,
    email: String,
}

fn auth_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("google_auth.json"))
}

fn read_stored(app: &tauri::AppHandle) -> Option<StoredAuth> {
    let text = std::fs::read_to_string(auth_file(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn random_urlsafe(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// Decode the (unverified) payload of a JWT and pull the `email` claim. Signature verification
/// is unnecessary here: the token arrives directly from Google's token endpoint over TLS.
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("email")?.as_str().map(str::to_owned)
}

/// Open a URL in the user's default browser (same mechanism as documents::open_path).
fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd").args(["/C", "start", "", url]).status();
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(url).status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("browser launcher exited with {s}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Block on the loopback listener until the browser redirects back with ?code=…&state=….
/// Returns the authorization code after verifying `state`.
fn wait_for_redirect(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(CONSENT_TIMEOUT_SECS);
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(conn) => break conn,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    return Err("Timed out waiting for the browser sign-in to finish.".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;

    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);
    // First line: GET /?code=...&state=... HTTP/1.1
    let path = request
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or("Malformed redirect request")?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    let respond = |stream: &mut std::net::TcpStream, body: &str| {
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
    };

    if let Some(err) = query.get("error") {
        respond(&mut stream, "<html><body style='font-family:sans-serif'><h2>Sign-in was cancelled.</h2><p>You can close this tab and return to Syzygy.</p></body></html>");
        return Err(format!("Google returned: {err}"));
    }
    let code = query.get("code").cloned().ok_or("No authorization code in redirect")?;
    if query.get("state").map(String::as_str) != Some(expected_state) {
        respond(&mut stream, "<html><body style='font-family:sans-serif'><h2>Sign-in failed a security check.</h2><p>Please try connecting again from Syzygy.</p></body></html>");
        return Err("OAuth state mismatch — possible interception; aborted.".into());
    }
    respond(&mut stream, "<html><body style='font-family:sans-serif'><h2>Connected ✔</h2><p>Syzygy is now linked to your Google Drive. You can close this tab.</p></body></html>");
    Ok(code)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    error_description: Option<String>,
    error: Option<String>,
}

async fn token_request(params: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<TokenResponse>(&text).map_err(|e| format!("Bad token response: {e}"))
}

/// Run the full connect flow. Returns the connected account's email.
#[tauri::command]
pub async fn google_oauth_start(app: tauri::AppHandle, client_id: String) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("No Google OAuth client ID configured.".into());
    }

    // PKCE verifier + S256 challenge, plus a state nonce against interception.
    let verifier = random_urlsafe(48)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_urlsafe(24)?;

    // One-shot loopback listener on a random free port.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let mut auth_url = url::Url::parse(AUTH_ENDPOINT).map_err(|e| e.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", &state);

    open_browser(auth_url.as_str())?;

    // The listener blocks — run it off the async runtime's core threads.
    let expected = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_redirect(listener, &expected))
        .await
        .map_err(|e| e.to_string())??;

    let tokens = token_request(&[
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri.as_str()),
    ])
    .await?;

    if let Some(err) = tokens.error {
        return Err(tokens.error_description.unwrap_or(err));
    }
    let refresh_token = tokens
        .refresh_token
        .ok_or("Google did not return a refresh token — try disconnecting the app at myaccount.google.com/permissions and connecting again.")?;
    let email = tokens
        .id_token
        .as_deref()
        .and_then(email_from_id_token)
        .unwrap_or_else(|| "your Google account".into());

    let stored = StoredAuth { client_id, refresh_token, email: email.clone() };
    let path = auth_file(&app)?;
    std::fs::write(&path, serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    Ok(email)
}

/// The connected account's email, or null when not connected.
#[tauri::command]
pub fn google_oauth_status(app: tauri::AppHandle) -> Option<String> {
    read_stored(&app).map(|s| s.email)
}

/// Best-effort token revocation, then remove the stored credentials.
#[tauri::command]
pub async fn google_oauth_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(stored) = read_stored(&app) {
        let client = reqwest::Client::new();
        let _ = client
            .post(REVOKE_ENDPOINT)
            .form(&[("token", stored.refresh_token.as_str())])
            .send()
            .await; // revocation is best-effort; local removal is what matters
    }
    let path = auth_file(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Exchange the stored refresh token for a fresh access token (for Drive calls made from Rust).
/// No caching yet — callers are expected to be infrequent until the sync layer lands.
#[tauri::command]
pub async fn google_access_token(app: tauri::AppHandle) -> Result<String, String> {
    let stored = read_stored(&app).ok_or("Not connected to Google Drive.")?;
    let tokens = token_request(&[
        ("client_id", stored.client_id.as_str()),
        ("refresh_token", stored.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    if let Some(err) = tokens.error {
        return Err(tokens.error_description.unwrap_or(err));
    }
    tokens.access_token.ok_or("No access token in refresh response.".into())
}
