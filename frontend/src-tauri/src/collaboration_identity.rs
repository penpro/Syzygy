//! Native cryptographic installation identity for collaboration attribution.
//!
//! The private Ed25519 PKCS#8 document stays in the operating-system credential store. The webview
//! can request only typed live-presence or durable project-registration signatures; there is no
//! arbitrary signing command and no command returns the private material. A valid signature proves
//! possession of this installation key, not a person's legal or organizational identity.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "org.penumbra.syzygy.collaboration-identity";
const ACCOUNT: &str = "installation-ed25519-v1";
const IDENTITY_SCHEMA_VERSION: u8 = 1;
const PRESENCE_SCHEMA_VERSION: u8 = 1;
const PRESENCE_DOMAIN: &str = "syzygy-device-presence-v1";
const REGISTRATION_SCHEMA_VERSION: u8 = 1;
const REGISTRATION_DOMAIN: &str = "syzygy-project-device-registration-v1";
const RELAY_ACCESS_SCHEMA_VERSION: u8 = 1;
const RELAY_ACCESS_DOMAIN: &str = "syzygy-relay-member-access-v1";
const MAX_STORED_IDENTITY_BYTES: usize = 1_024;
static IDENTITY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredIdentity {
    schema_version: u8,
    created_at_ms: u64,
    private_key_pkcs8: String,
}

impl Drop for StoredIdentity {
    fn drop(&mut self) {
        self.private_key_pkcs8.zeroize();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceIdentityClaim {
    pub schema_version: u8,
    pub project_id: String,
    pub document_id: String,
    pub participant_id: String,
    pub awareness_client_id: u64,
    pub session_nonce: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDeviceRegistrationClaim {
    pub schema_version: u8,
    pub project_id: String,
    pub participant_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayAccessIdentityClaim {
    pub schema_version: u8,
    pub room_id: String,
    pub member_id: String,
    pub capability_generation: u32,
    pub issued_at_ms: u64,
    pub nonce: String,
    pub capability: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationIdentityReport {
    pub schema_version: u8,
    pub algorithm: String,
    pub key_id: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at_ms: u64,
    pub scope: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevicePresenceProof {
    pub schema_version: u8,
    pub algorithm: String,
    pub key_id: String,
    pub public_key: String,
    pub claim: PresenceIdentityClaim,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeviceRegistrationProof {
    pub schema_version: u8,
    pub algorithm: String,
    pub key_id: String,
    pub public_key: String,
    pub claim: ProjectDeviceRegistrationClaim,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayAccessIdentityProof {
    pub schema_version: u8,
    pub algorithm: String,
    pub key_id: String,
    pub claim: RelayAccessIdentityClaim,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationIdentityInteropProofs {
    pub presence: DevicePresenceProof,
    pub registration: ProjectDeviceRegistrationProof,
    pub relay_access: RelayAccessIdentityProof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IdentityError {
    Unavailable,
    InvalidStoredIdentity,
    InvalidClaim,
    SigningFailed,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => {
                formatter.write_str("OS collaboration identity storage is unavailable")
            }
            Self::InvalidStoredIdentity => {
                formatter.write_str("Saved collaboration identity is invalid")
            }
            Self::InvalidClaim => formatter.write_str("Collaboration identity claim is invalid"),
            Self::SigningFailed => {
                formatter.write_str("Could not sign collaboration identity claim")
            }
        }
    }
}

trait IdentityStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>, IdentityError>;
    fn save(&self, secret: &str) -> Result<(), IdentityError>;
}

#[derive(Clone, Copy, Default)]
struct OsIdentityStore;

impl OsIdentityStore {
    fn entry() -> Result<keyring::Entry, IdentityError> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| IdentityError::Unavailable)
    }
}

impl IdentityStore for OsIdentityStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>, IdentityError> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(IdentityError::Unavailable),
        }
    }

    fn save(&self, secret: &str) -> Result<(), IdentityError> {
        Self::entry()?
            .set_password(secret)
            .map_err(|_| IdentityError::Unavailable)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn generate_identity() -> Result<StoredIdentity, IdentityError> {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| IdentityError::SigningFailed)?;
    Ok(StoredIdentity {
        schema_version: IDENTITY_SCHEMA_VERSION,
        created_at_ms: now_ms(),
        private_key_pkcs8: URL_SAFE_NO_PAD.encode(pkcs8.as_ref()),
    })
}

fn decode_key(identity: &StoredIdentity) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
    if identity.schema_version != IDENTITY_SCHEMA_VERSION
        || identity.created_at_ms == 0
        || identity.private_key_pkcs8.is_empty()
        || identity.private_key_pkcs8.len() > MAX_STORED_IDENTITY_BYTES
    {
        return Err(IdentityError::InvalidStoredIdentity);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(&identity.private_key_pkcs8)
        .map_err(|_| IdentityError::InvalidStoredIdentity)?;
    if decoded.is_empty() || decoded.len() > MAX_STORED_IDENTITY_BYTES {
        return Err(IdentityError::InvalidStoredIdentity);
    }
    Ok(Zeroizing::new(decoded))
}

fn parse_identity(value: &str) -> Result<StoredIdentity, IdentityError> {
    if value.is_empty() || value.len() > MAX_STORED_IDENTITY_BYTES * 2 {
        return Err(IdentityError::InvalidStoredIdentity);
    }
    let identity: StoredIdentity =
        serde_json::from_str(value).map_err(|_| IdentityError::InvalidStoredIdentity)?;
    let key_bytes = decode_key(&identity)?;
    Ed25519KeyPair::from_pkcs8(key_bytes.as_ref())
        .map_err(|_| IdentityError::InvalidStoredIdentity)?;
    Ok(identity)
}

fn load_or_create(store: &dyn IdentityStore) -> Result<StoredIdentity, IdentityError> {
    if let Some(secret) = store.load()? {
        return parse_identity(&secret);
    }
    let identity = generate_identity()?;
    let encoded =
        Zeroizing::new(serde_json::to_string(&identity).map_err(|_| IdentityError::SigningFailed)?);
    store.save(&encoded)?;
    Ok(identity)
}

fn key_pair(identity: &StoredIdentity) -> Result<Ed25519KeyPair, IdentityError> {
    let key_bytes = decode_key(identity)?;
    Ed25519KeyPair::from_pkcs8(key_bytes.as_ref()).map_err(|_| IdentityError::InvalidStoredIdentity)
}

fn fingerprint(public_key: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_key))
}

fn report(identity: &StoredIdentity) -> Result<CollaborationIdentityReport, IdentityError> {
    let key_pair = key_pair(identity)?;
    let public_key = key_pair.public_key().as_ref();
    let fingerprint = fingerprint(public_key);
    Ok(CollaborationIdentityReport {
        schema_version: IDENTITY_SCHEMA_VERSION,
        algorithm: "Ed25519".into(),
        key_id: format!("ed25519-sha256:{fingerprint}"),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        fingerprint,
        created_at_ms: identity.created_at_ms,
        scope: "installation-device-not-human-identity".into(),
    })
}

fn stable_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 200
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'-')
        })
}

fn validate_claim(claim: &PresenceIdentityClaim) -> Result<(), IdentityError> {
    if claim.schema_version != PRESENCE_SCHEMA_VERSION
        || !stable_id(&claim.project_id)
        || !stable_id(&claim.document_id)
        || !stable_id(&claim.participant_id)
        || claim.awareness_client_id > u32::MAX as u64
    {
        return Err(IdentityError::InvalidClaim);
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&claim.session_nonce)
        .map_err(|_| IdentityError::InvalidClaim)?;
    if nonce.len() != 32 || URL_SAFE_NO_PAD.encode(&nonce) != claim.session_nonce {
        return Err(IdentityError::InvalidClaim);
    }
    Ok(())
}

fn validate_registration_claim(
    claim: &ProjectDeviceRegistrationClaim,
) -> Result<(), IdentityError> {
    if claim.schema_version != REGISTRATION_SCHEMA_VERSION
        || !stable_id(&claim.project_id)
        || !stable_id(&claim.participant_id)
    {
        return Err(IdentityError::InvalidClaim);
    }
    Ok(())
}

fn validate_relay_access_claim(claim: &RelayAccessIdentityClaim) -> Result<(), IdentityError> {
    if claim.schema_version != RELAY_ACCESS_SCHEMA_VERSION
        || !stable_id(&claim.room_id)
        || !(32..=128).contains(&claim.room_id.len())
        || !stable_id(&claim.member_id)
        || !(16..=128).contains(&claim.member_id.len())
        || claim.capability_generation == 0
        || claim.issued_at_ms == 0
        || !stable_id(&claim.capability)
        || !(32..=128).contains(&claim.capability.len())
    {
        return Err(IdentityError::InvalidClaim);
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&claim.nonce)
        .map_err(|_| IdentityError::InvalidClaim)?;
    if nonce.len() != 32 || URL_SAFE_NO_PAD.encode(&nonce) != claim.nonce {
        return Err(IdentityError::InvalidClaim);
    }
    Ok(())
}

pub fn canonical_presence_claim(claim: &PresenceIdentityClaim) -> Result<Vec<u8>, String> {
    validate_claim(claim).map_err(|error| error.to_string())?;
    Ok(format!(
        "{PRESENCE_DOMAIN}\n{}\n{}\n{}\n{}\n{}",
        claim.project_id,
        claim.document_id,
        claim.participant_id,
        claim.awareness_client_id,
        claim.session_nonce,
    )
    .into_bytes())
}

pub fn canonical_registration_claim(
    claim: &ProjectDeviceRegistrationClaim,
) -> Result<Vec<u8>, String> {
    validate_registration_claim(claim).map_err(|error| error.to_string())?;
    Ok(format!(
        "{REGISTRATION_DOMAIN}\n{}\n{}",
        claim.project_id, claim.participant_id,
    )
    .into_bytes())
}

pub fn canonical_relay_access_claim(claim: &RelayAccessIdentityClaim) -> Result<Vec<u8>, String> {
    validate_relay_access_claim(claim).map_err(|error| error.to_string())?;
    Ok(format!(
        "{RELAY_ACCESS_DOMAIN}\n{}\n{}\n{}\n{}\n{}\n{}",
        claim.room_id,
        claim.member_id,
        claim.capability_generation,
        claim.issued_at_ms,
        claim.nonce,
        claim.capability,
    )
    .into_bytes())
}

fn sign_presence(
    identity: &StoredIdentity,
    claim: PresenceIdentityClaim,
) -> Result<DevicePresenceProof, IdentityError> {
    let message = canonical_presence_claim(&claim).map_err(|_| IdentityError::InvalidClaim)?;
    let key_pair = key_pair(identity)?;
    let public_key = key_pair.public_key().as_ref();
    let fingerprint = fingerprint(public_key);
    let signature = key_pair.sign(&message);
    Ok(DevicePresenceProof {
        schema_version: PRESENCE_SCHEMA_VERSION,
        algorithm: "Ed25519".into(),
        key_id: format!("ed25519-sha256:{fingerprint}"),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        claim,
        signature: URL_SAFE_NO_PAD.encode(signature.as_ref()),
    })
}

fn sign_registration(
    identity: &StoredIdentity,
    claim: ProjectDeviceRegistrationClaim,
) -> Result<ProjectDeviceRegistrationProof, IdentityError> {
    let message = canonical_registration_claim(&claim).map_err(|_| IdentityError::InvalidClaim)?;
    let key_pair = key_pair(identity)?;
    let public_key = key_pair.public_key().as_ref();
    let fingerprint = fingerprint(public_key);
    let signature = key_pair.sign(&message);
    Ok(ProjectDeviceRegistrationProof {
        schema_version: REGISTRATION_SCHEMA_VERSION,
        algorithm: "Ed25519".into(),
        key_id: format!("ed25519-sha256:{fingerprint}"),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        claim,
        signature: URL_SAFE_NO_PAD.encode(signature.as_ref()),
    })
}

fn sign_relay_access(
    identity: &StoredIdentity,
    claim: RelayAccessIdentityClaim,
) -> Result<RelayAccessIdentityProof, IdentityError> {
    let message = canonical_relay_access_claim(&claim).map_err(|_| IdentityError::InvalidClaim)?;
    let key_pair = key_pair(identity)?;
    let public_key = key_pair.public_key().as_ref();
    let fingerprint = fingerprint(public_key);
    Ok(RelayAccessIdentityProof {
        schema_version: RELAY_ACCESS_SCHEMA_VERSION,
        algorithm: "Ed25519".into(),
        key_id: format!("ed25519-sha256:{fingerprint}"),
        claim,
        signature: URL_SAFE_NO_PAD.encode(key_pair.sign(&message).as_ref()),
    })
}

pub fn validate_relay_device_identity(key_id: &str, public_key: &str) -> Result<Vec<u8>, String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|_| "Relay member device public key is invalid".to_string())?;
    if decoded.len() != 32
        || URL_SAFE_NO_PAD.encode(&decoded) != public_key
        || key_id != format!("ed25519-sha256:{}", fingerprint(&decoded))
    {
        return Err("Relay member device identity is invalid".into());
    }
    Ok(decoded)
}

pub fn verify_relay_access_signature(
    public_key: &str,
    key_id: &str,
    claim: &RelayAccessIdentityClaim,
    signature: &str,
) -> Result<(), String> {
    let public_key = validate_relay_device_identity(key_id, public_key)?;
    let decoded_signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "Relay member device signature is invalid".to_string())?;
    if decoded_signature.len() != 64 || URL_SAFE_NO_PAD.encode(&decoded_signature) != signature {
        return Err("Relay member device signature is invalid".into());
    }
    let message = canonical_relay_access_claim(claim)?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(&message, &decoded_signature)
        .map_err(|_| "Relay member device signature did not verify".to_string())
}

pub fn verify_presence_proof(proof: &DevicePresenceProof) -> Result<(), String> {
    if proof.schema_version != PRESENCE_SCHEMA_VERSION || proof.algorithm != "Ed25519" {
        return Err("Collaboration device proof header is invalid".into());
    }
    let public_key = URL_SAFE_NO_PAD
        .decode(&proof.public_key)
        .map_err(|_| "Collaboration device public key is invalid".to_string())?;
    let signature = URL_SAFE_NO_PAD
        .decode(&proof.signature)
        .map_err(|_| "Collaboration device signature is invalid".to_string())?;
    if public_key.len() != 32
        || signature.len() != 64
        || proof.key_id != format!("ed25519-sha256:{}", fingerprint(&public_key))
    {
        return Err("Collaboration device proof identity is invalid".into());
    }
    let message = canonical_presence_claim(&proof.claim)?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(&message, &signature)
        .map_err(|_| "Collaboration device signature did not verify".to_string())
}

pub fn verify_registration_proof(proof: &ProjectDeviceRegistrationProof) -> Result<(), String> {
    if proof.schema_version != REGISTRATION_SCHEMA_VERSION || proof.algorithm != "Ed25519" {
        return Err("Project device registration header is invalid".into());
    }
    let public_key = URL_SAFE_NO_PAD
        .decode(&proof.public_key)
        .map_err(|_| "Project device registration public key is invalid".to_string())?;
    let signature = URL_SAFE_NO_PAD
        .decode(&proof.signature)
        .map_err(|_| "Project device registration signature is invalid".to_string())?;
    if public_key.len() != 32
        || signature.len() != 64
        || proof.key_id != format!("ed25519-sha256:{}", fingerprint(&public_key))
    {
        return Err("Project device registration identity is invalid".into());
    }
    let message = canonical_registration_claim(&proof.claim)?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(&message, &signature)
        .map_err(|_| "Project device registration signature did not verify".to_string())
}

pub fn ephemeral_presence_proof(
    claim: PresenceIdentityClaim,
) -> Result<DevicePresenceProof, String> {
    let identity = generate_identity().map_err(|error| error.to_string())?;
    sign_presence(&identity, claim).map_err(|error| error.to_string())
}

pub fn ephemeral_registration_proof(
    claim: ProjectDeviceRegistrationClaim,
) -> Result<ProjectDeviceRegistrationProof, String> {
    let identity = generate_identity().map_err(|error| error.to_string())?;
    sign_registration(&identity, claim).map_err(|error| error.to_string())
}

pub fn ephemeral_identity_interop_proofs(
    presence_claim: PresenceIdentityClaim,
    registration_claim: ProjectDeviceRegistrationClaim,
    relay_access_claim: RelayAccessIdentityClaim,
) -> Result<CollaborationIdentityInteropProofs, String> {
    let identity = generate_identity().map_err(|error| error.to_string())?;
    Ok(CollaborationIdentityInteropProofs {
        presence: sign_presence(&identity, presence_claim).map_err(|error| error.to_string())?,
        registration: sign_registration(&identity, registration_claim)
            .map_err(|error| error.to_string())?,
        relay_access: sign_relay_access(&identity, relay_access_claim)
            .map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
pub fn collaboration_identity_status() -> Result<CollaborationIdentityReport, String> {
    let _guard = IDENTITY_LOCK
        .lock()
        .map_err(|_| "OS collaboration identity storage is unavailable".to_string())?;
    let identity = load_or_create(&OsIdentityStore).map_err(|error| error.to_string())?;
    report(&identity).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn collaboration_identity_sign_presence(
    claim: PresenceIdentityClaim,
) -> Result<DevicePresenceProof, String> {
    let _guard = IDENTITY_LOCK
        .lock()
        .map_err(|_| "OS collaboration identity storage is unavailable".to_string())?;
    let identity = load_or_create(&OsIdentityStore).map_err(|error| error.to_string())?;
    sign_presence(&identity, claim).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn collaboration_identity_sign_registration(
    claim: ProjectDeviceRegistrationClaim,
) -> Result<ProjectDeviceRegistrationProof, String> {
    let _guard = IDENTITY_LOCK
        .lock()
        .map_err(|_| "OS collaboration identity storage is unavailable".to_string())?;
    let identity = load_or_create(&OsIdentityStore).map_err(|error| error.to_string())?;
    sign_registration(&identity, claim).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn collaboration_identity_sign_relay_access(
    claim: RelayAccessIdentityClaim,
) -> Result<RelayAccessIdentityProof, String> {
    let _guard = IDENTITY_LOCK
        .lock()
        .map_err(|_| "OS collaboration identity storage is unavailable".to_string())?;
    let identity = load_or_create(&OsIdentityStore).map_err(|error| error.to_string())?;
    sign_relay_access(&identity, claim).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);

    impl IdentityStore for MemoryStore {
        fn load(&self) -> Result<Option<Zeroizing<String>>, IdentityError> {
            Ok(self
                .0
                .lock()
                .map_err(|_| IdentityError::Unavailable)?
                .clone()
                .map(Zeroizing::new))
        }

        fn save(&self, secret: &str) -> Result<(), IdentityError> {
            *self.0.lock().map_err(|_| IdentityError::Unavailable)? = Some(secret.to_string());
            Ok(())
        }
    }

    fn claim() -> PresenceIdentityClaim {
        PresenceIdentityClaim {
            schema_version: 1,
            project_id: "project-1".into(),
            document_id: "document-1".into(),
            participant_id: "participant-1".into(),
            awareness_client_id: 42,
            session_nonce: "n4FQe-J9xYRu0cXm1pWd7gHo2Lk8BvSz5TaUcEiOjM0".into(),
        }
    }

    fn registration_claim() -> ProjectDeviceRegistrationClaim {
        ProjectDeviceRegistrationClaim {
            schema_version: 1,
            project_id: "project-1".into(),
            participant_id: "participant-1".into(),
        }
    }

    fn relay_access_claim() -> RelayAccessIdentityClaim {
        RelayAccessIdentityClaim {
            schema_version: 1,
            room_id: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            member_id: "member_bbbbbbbbbbbbbbbbbbbbbbbb".into(),
            capability_generation: 3,
            issued_at_ms: 1_700_000_000_000,
            nonce: "n4FQe-J9xYRu0cXm1pWd7gHo2Lk8BvSz5TaUcEiOjM0".into(),
            capability: "ccccccccccccccccccccccccccccccccccccccccccc".into(),
        }
    }

    #[test]
    fn one_vault_identity_is_stable_and_private() {
        let store = MemoryStore::default();
        let first = load_or_create(&store).unwrap();
        let second = load_or_create(&store).unwrap();
        assert_eq!(report(&first).unwrap(), report(&second).unwrap());
        let serialized_report = serde_json::to_string(&report(&first).unwrap()).unwrap();
        assert!(!serialized_report.contains("private"));
        assert!(!serialized_report.contains(&first.private_key_pkcs8));
    }

    #[test]
    fn typed_presence_proof_verifies_and_mutation_or_replay_identity_fails() {
        let identity = generate_identity().unwrap();
        let proof = sign_presence(&identity, claim()).unwrap();
        verify_presence_proof(&proof).unwrap();

        let mut changed = proof.clone();
        changed.claim.participant_id = "participant-2".into();
        assert!(verify_presence_proof(&changed)
            .unwrap_err()
            .contains("did not verify"));
        changed = proof.clone();
        changed.claim.awareness_client_id += 1;
        assert!(verify_presence_proof(&changed)
            .unwrap_err()
            .contains("did not verify"));
        changed = proof.clone();
        changed.key_id = "ed25519-sha256:wrong".into();
        assert!(verify_presence_proof(&changed)
            .unwrap_err()
            .contains("identity"));
    }

    #[test]
    fn claims_and_stored_keys_fail_closed_without_secret_echo() {
        for value in ["", "../escape", "line\nbreak", &"x".repeat(201)] {
            let mut candidate = claim();
            candidate.participant_id = value.into();
            assert_eq!(validate_claim(&candidate), Err(IdentityError::InvalidClaim));
        }
        let mut candidate = claim();
        candidate.session_nonce = "weak".into();
        assert_eq!(validate_claim(&candidate), Err(IdentityError::InvalidClaim));
        assert_eq!(
            parse_identity("private-key-canary")
                .unwrap_err()
                .to_string(),
            "Saved collaboration identity is invalid"
        );
    }

    #[test]
    fn typed_project_registration_is_deterministic_and_project_bound() {
        let identity = generate_identity().unwrap();
        let first = sign_registration(&identity, registration_claim()).unwrap();
        let second = sign_registration(&identity, registration_claim()).unwrap();
        assert_eq!(first, second);
        verify_registration_proof(&first).unwrap();

        let mut changed = first.clone();
        changed.claim.project_id = "project-2".into();
        assert!(verify_registration_proof(&changed)
            .unwrap_err()
            .contains("did not verify"));
        changed = first.clone();
        changed.claim.participant_id = "participant-2".into();
        assert!(verify_registration_proof(&changed)
            .unwrap_err()
            .contains("did not verify"));
    }

    #[test]
    fn typed_relay_access_proof_binds_every_credential_and_freshness_field() {
        let identity = generate_identity().unwrap();
        let identity_report = report(&identity).unwrap();
        let proof = sign_relay_access(&identity, relay_access_claim()).unwrap();
        verify_relay_access_signature(
            &identity_report.public_key,
            &proof.key_id,
            &proof.claim,
            &proof.signature,
        )
        .unwrap();

        for mutate in [
            |claim: &mut RelayAccessIdentityClaim| claim.capability_generation += 1,
            |claim: &mut RelayAccessIdentityClaim| claim.issued_at_ms += 1,
            |claim: &mut RelayAccessIdentityClaim| claim.capability.push('d'),
        ] {
            let mut changed = proof.claim.clone();
            mutate(&mut changed);
            assert!(verify_relay_access_signature(
                &identity_report.public_key,
                &proof.key_id,
                &changed,
                &proof.signature,
            )
            .is_err());
        }
    }
}
