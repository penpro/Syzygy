use app_lib::collaboration_identity::{ephemeral_presence_proof, PresenceIdentityClaim};

fn main() {
    let claim = PresenceIdentityClaim {
        schema_version: 1,
        project_id: "project-cross-language".into(),
        document_id: "document-cross-language".into(),
        participant_id: "participant-cross-language".into(),
        awareness_client_id: 4_294_967_000,
        session_nonce: "n4FQe-J9xYRu0cXm1pWd7gHo2Lk8BvSz5TaUcEiOjM0".into(),
    };
    match ephemeral_presence_proof(claim).and_then(|proof| {
        serde_json::to_string(&proof).map_err(|_| "Could not encode identity proof".into())
    }) {
        Ok(proof) => println!("{proof}"),
        Err(error) => {
            eprintln!("Syzygy collaboration identity harness failed: {error}");
            std::process::exit(1);
        }
    }
}
