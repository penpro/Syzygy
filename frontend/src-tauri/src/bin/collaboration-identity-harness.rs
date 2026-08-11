use app_lib::collaboration_identity::{
    ephemeral_identity_interop_proofs, PresenceIdentityClaim, ProjectDeviceRegistrationClaim,
    RelayAccessIdentityClaim,
};

fn main() {
    let claim = PresenceIdentityClaim {
        schema_version: 1,
        project_id: "project-cross-language".into(),
        document_id: "document-cross-language".into(),
        participant_id: "participant-cross-language".into(),
        awareness_client_id: 4_294_967_000,
        session_nonce: "n4FQe-J9xYRu0cXm1pWd7gHo2Lk8BvSz5TaUcEiOjM0".into(),
    };
    let registration_claim = ProjectDeviceRegistrationClaim {
        schema_version: 1,
        project_id: "project-cross-language".into(),
        participant_id: "participant-cross-language".into(),
    };
    let relay_access_claim = RelayAccessIdentityClaim {
        schema_version: 1,
        room_id: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        member_id: "member_bbbbbbbbbbbbbbbbbbbbbbbb".into(),
        capability_generation: 7,
        issued_at_ms: 1_700_000_000_000,
        nonce: "6LwS4YgM5oHd7RjP0eQt9VxN2cBk8UaF3iZm1KpJvXs".into(),
        capability: "ccccccccccccccccccccccccccccccccccccccccccc".into(),
    };
    match ephemeral_identity_interop_proofs(claim, registration_claim, relay_access_claim).and_then(
        |proof| serde_json::to_string(&proof).map_err(|_| "Could not encode identity proof".into()),
    ) {
        Ok(proof) => println!("{proof}"),
        Err(error) => {
            eprintln!("Syzygy collaboration identity harness failed: {error}");
            std::process::exit(1);
        }
    }
}
