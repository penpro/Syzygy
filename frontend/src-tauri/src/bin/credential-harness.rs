//! Opt-in live proof for the current operating system's credential store.

use app_lib::credential_vault::{
    CredentialId, CredentialVault, CredentialVaultError, OsCredentialVault,
};
use app_lib::model_provider::{ProviderSecret, RemoteProviderId};

fn run() -> Result<(), String> {
    let id = CredentialId::new(
        RemoteProviderId::OpenAi,
        format!("live-canary-{}", std::process::id()),
    )
    .map_err(|error| error.to_string())?;
    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random).map_err(|_| "OS randomness unavailable".to_owned())?;
    let canary = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let secret = ProviderSecret::new(canary.clone()).map_err(|error| error.to_string())?;
    let vault = OsCredentialVault;

    let proof = (|| {
        vault.set(&id, &secret).map_err(|error| error.to_string())?;
        let loaded = vault.get(&id).map_err(|error| error.to_string())?;
        if !loaded.matches(&canary) {
            return Err("OS credential readback did not match the canary".to_owned());
        }
        vault.delete(&id).map_err(|error| error.to_string())?;
        if !matches!(vault.get(&id), Err(CredentialVaultError::NotFound)) {
            return Err("OS credential canary remained after deletion".to_owned());
        }
        Ok(())
    })();

    if proof.is_err() {
        let _ = vault.delete(&id);
    }
    proof
}

fn main() {
    match run() {
        Ok(()) => println!(
            "{{\"passed\":true,\"backend\":\"os-credential-store\",\"canaryPrinted\":false,\"cleanupVerified\":true}}"
        ),
        Err(error) => {
            eprintln!("Credential harness failed: {error}");
            std::process::exit(1);
        }
    }
}
