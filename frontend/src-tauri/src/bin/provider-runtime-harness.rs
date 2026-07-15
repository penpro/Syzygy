//! Cross-language provider-run record fixture. No external network or OS credential is used.

use app_lib::credential_vault::{CredentialId, CredentialVault, CredentialVaultError};
use app_lib::model_provider::{
    GenerationRequest, InputRole, ProviderInput, ProviderSecret, RemoteProviderId,
};
use app_lib::provider_runtime::{execute_with, ProviderRuntimeState, ProviderTaskRequest};
use reqwest::{Client, Url};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

struct FixtureVault;

impl CredentialVault for FixtureVault {
    fn set(
        &self,
        _id: &CredentialId,
        _secret: &ProviderSecret,
    ) -> Result<(), CredentialVaultError> {
        Err(CredentialVaultError::Unavailable)
    }

    fn get(&self, _id: &CredentialId) -> Result<ProviderSecret, CredentialVaultError> {
        ProviderSecret::new("interop-secret-canary".to_owned())
            .map_err(|_| CredentialVaultError::InvalidSecret)
    }

    fn delete(&self, _id: &CredentialId) -> Result<(), CredentialVaultError> {
        Err(CredentialVaultError::Unavailable)
    }
}

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture");
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().expect("fixture address")
    ))
    .expect("fixture URL");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept fixture request");
        let mut request = vec![0_u8; 16 * 1024];
        let read = stream.read(&mut request).expect("read fixture request");
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer interop-secret-canary"));
        let body = r#"{"id":"interop-response","status":"completed","model":"interop-model","output":[{"type":"message","content":[{"type":"output_text","text":"interop answer"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("write fixture response");
    });
    let request = ProviderTaskRequest {
        run_id: "interop-run-001".to_owned(),
        call_id: "interop-call-001".to_owned(),
        task_type: "interop.provider-record".to_owned(),
        provider: RemoteProviderId::OpenAi,
        source_snapshot_ids: vec!["interop-source-001".to_owned()],
        timeout_ms: 5_000,
        content_categories: vec!["synthetic interoperability fixture".to_owned()],
        generation: GenerationRequest {
            model: "interop-model".to_owned(),
            input: vec![ProviderInput {
                role: InputRole::User,
                content: "interop prompt canary".to_owned(),
            }],
            max_output_tokens: 128,
        },
    };
    let outcome = tauri::async_runtime::block_on(execute_with(
        &FixtureVault,
        &ProviderRuntimeState::default(),
        &Client::new(),
        endpoint,
        request,
        true,
    ))
    .expect("provider runtime fixture");
    server.join().expect("fixture server");
    println!(
        "{}",
        serde_json::to_string(&outcome.run_record).expect("serialize provider run record")
    );
}
