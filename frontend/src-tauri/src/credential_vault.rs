//! Provider credential storage isolated behind the operating-system credential facility.
//!
//! The product-facing runtime is still unwired. This module establishes a narrow, testable
//! boundary whose errors and identifiers cannot contain the secret. CI exercises the same trait
//! with a memory implementation; the separate credential harness checks the real OS backend and
//! immediately deletes its random canary.

use crate::model_provider::{ProviderSecret, RemoteProviderId};
use std::fmt;

const SERVICE: &str = "org.penumbra.syzygy.model-provider";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialId {
    provider: RemoteProviderId,
    profile: String,
}

impl CredentialId {
    pub fn new(provider: RemoteProviderId, profile: String) -> Result<Self, CredentialVaultError> {
        let valid_profile = !profile.is_empty()
            && profile.len() <= 100
            && profile
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        if !valid_profile {
            return Err(CredentialVaultError::InvalidIdentifier);
        }
        Ok(Self { provider, profile })
    }

    fn account(&self) -> String {
        let provider = match self.provider {
            RemoteProviderId::OpenAi => "openai",
            RemoteProviderId::Anthropic => "anthropic",
            RemoteProviderId::Gemini => "gemini",
            RemoteProviderId::Xai => "xai",
        };
        format!("{provider}:{}", self.profile)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialVaultError {
    InvalidIdentifier,
    InvalidSecret,
    NotFound,
    Ambiguous,
    Unavailable,
}

impl fmt::Display for CredentialVaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier => formatter.write_str("Credential identifier is invalid"),
            Self::InvalidSecret => formatter.write_str("Credential secret is invalid"),
            Self::NotFound => formatter.write_str("Provider credential is not configured"),
            Self::Ambiguous => formatter.write_str("Multiple provider credentials matched"),
            Self::Unavailable => formatter.write_str("OS credential storage is unavailable"),
        }
    }
}

pub trait CredentialVault: Send + Sync {
    fn set(&self, id: &CredentialId, secret: &ProviderSecret) -> Result<(), CredentialVaultError>;
    fn get(&self, id: &CredentialId) -> Result<ProviderSecret, CredentialVaultError>;
    fn delete(&self, id: &CredentialId) -> Result<(), CredentialVaultError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct OsCredentialVault;

impl OsCredentialVault {
    fn entry(id: &CredentialId) -> Result<keyring::Entry, CredentialVaultError> {
        keyring::Entry::new(SERVICE, &id.account()).map_err(map_keyring_error)
    }
}

fn map_keyring_error(error: keyring::Error) -> CredentialVaultError {
    match error {
        keyring::Error::NoEntry => CredentialVaultError::NotFound,
        keyring::Error::Ambiguous(_) => CredentialVaultError::Ambiguous,
        _ => CredentialVaultError::Unavailable,
    }
}

impl CredentialVault for OsCredentialVault {
    fn set(&self, id: &CredentialId, secret: &ProviderSecret) -> Result<(), CredentialVaultError> {
        Self::entry(id)?
            .set_password(secret.expose())
            .map_err(map_keyring_error)
    }

    fn get(&self, id: &CredentialId) -> Result<ProviderSecret, CredentialVaultError> {
        let value = Self::entry(id)?.get_password().map_err(map_keyring_error)?;
        ProviderSecret::new(value).map_err(|_| CredentialVaultError::InvalidSecret)
    }

    fn delete(&self, id: &CredentialId) -> Result<(), CredentialVaultError> {
        Self::entry(id)?
            .delete_credential()
            .map_err(map_keyring_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryVault(Mutex<HashMap<String, String>>);

    impl CredentialVault for MemoryVault {
        fn set(
            &self,
            id: &CredentialId,
            secret: &ProviderSecret,
        ) -> Result<(), CredentialVaultError> {
            self.0
                .lock()
                .map_err(|_| CredentialVaultError::Unavailable)?
                .insert(id.account(), secret.expose().to_owned());
            Ok(())
        }

        fn get(&self, id: &CredentialId) -> Result<ProviderSecret, CredentialVaultError> {
            let value = self
                .0
                .lock()
                .map_err(|_| CredentialVaultError::Unavailable)?
                .get(&id.account())
                .cloned()
                .ok_or(CredentialVaultError::NotFound)?;
            ProviderSecret::new(value).map_err(|_| CredentialVaultError::InvalidSecret)
        }

        fn delete(&self, id: &CredentialId) -> Result<(), CredentialVaultError> {
            self.0
                .lock()
                .map_err(|_| CredentialVaultError::Unavailable)?
                .remove(&id.account())
                .map(|_| ())
                .ok_or(CredentialVaultError::NotFound)
        }
    }

    fn contract(vault: &dyn CredentialVault) {
        let id = CredentialId::new(RemoteProviderId::OpenAi, "contract-fixture".to_owned())
            .expect("credential ID");
        let canary = "credential-contract-canary";
        let secret = ProviderSecret::new(canary.to_owned()).expect("secret");
        vault.set(&id, &secret).expect("store secret");
        let loaded = vault.get(&id).expect("load secret");
        assert!(loaded.matches(canary));
        assert!(!format!("{loaded:?}").contains(canary));
        vault.delete(&id).expect("delete secret");
        assert!(matches!(
            vault.get(&id),
            Err(CredentialVaultError::NotFound)
        ));
    }

    #[test]
    fn memory_vault_passes_set_get_delete_contract() {
        contract(&MemoryVault::default());
    }

    #[test]
    fn credential_identifiers_fail_closed() {
        for profile in ["", "../escape", "contains space", "line\nbreak"] {
            assert_eq!(
                CredentialId::new(RemoteProviderId::OpenAi, profile.to_owned()),
                Err(CredentialVaultError::InvalidIdentifier)
            );
        }
    }

    #[test]
    fn provider_credentials_use_distinct_accounts() {
        let openai = CredentialId::new(RemoteProviderId::OpenAi, "default".to_owned())
            .expect("OpenAI credential ID");
        let anthropic = CredentialId::new(RemoteProviderId::Anthropic, "default".to_owned())
            .expect("Anthropic credential ID");
        let gemini = CredentialId::new(RemoteProviderId::Gemini, "default".to_owned())
            .expect("Gemini credential ID");
        let xai = CredentialId::new(RemoteProviderId::Xai, "default".to_owned())
            .expect("xAI credential ID");
        assert_eq!(openai.account(), "openai:default");
        assert_eq!(anthropic.account(), "anthropic:default");
        assert_eq!(gemini.account(), "gemini:default");
        assert_eq!(xai.account(), "xai:default");
        assert_ne!(openai.account(), anthropic.account());
        assert_ne!(openai.account(), gemini.account());
        assert_ne!(anthropic.account(), gemini.account());
        assert_ne!(gemini.account(), xai.account());
    }

    #[test]
    fn vault_errors_are_sanitized() {
        let secret_canary = "must-not-appear";
        for error in [
            CredentialVaultError::InvalidSecret,
            CredentialVaultError::NotFound,
            CredentialVaultError::Ambiguous,
            CredentialVaultError::Unavailable,
        ] {
            assert!(!error.to_string().contains(secret_canary));
        }
    }
}
