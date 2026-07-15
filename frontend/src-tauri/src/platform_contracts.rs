//! Self-describing research extension contracts shared with headless MCP clients.
//!
//! These are capability contracts and truthful implementation states, not a plugin loader or a
//! claim that every contract has a product UI. Keeping them callable without the GUI lets CI and
//! external reviewers inspect the same boundaries the typed Tauri commands must honor.

use serde_json::{json, Value};

const PLUGIN_MANIFEST_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-research-plugin-v1.schema.json");
const PLUGIN_PROPOSAL_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-plugin-proposal-v1.schema.json");
const ADVERSARIAL_RUN_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-adversarial-run-v1.schema.json");
const PROVIDER_RUN_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-provider-run-v1.schema.json");
const MODEL_ADAPTER_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-model-adapter-v1.schema.json");
const MODEL_ADAPTER_CERTIFICATION_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-model-adapter-certification-v1.schema.json");
const PLUGIN_WIT_CONTRACT: &str = include_str!("../../../docs/wit/syzygy-research-plugin-v1.wit");

pub fn current() -> Result<Value, String> {
    let manifest_schema: Value = serde_json::from_str(PLUGIN_MANIFEST_SCHEMA)
        .map_err(|error| format!("Embedded research plugin schema is invalid: {error}"))?;
    let proposal_schema: Value = serde_json::from_str(PLUGIN_PROPOSAL_SCHEMA)
        .map_err(|error| format!("Embedded plugin proposal schema is invalid: {error}"))?;
    let adversarial_run_schema: Value = serde_json::from_str(ADVERSARIAL_RUN_SCHEMA)
        .map_err(|error| format!("Embedded adversarial run schema is invalid: {error}"))?;
    let provider_run_schema: Value = serde_json::from_str(PROVIDER_RUN_SCHEMA)
        .map_err(|error| format!("Embedded provider run schema is invalid: {error}"))?;
    let model_adapter_schema: Value = serde_json::from_str(MODEL_ADAPTER_SCHEMA)
        .map_err(|error| format!("Embedded model adapter schema is invalid: {error}"))?;
    let model_adapter_certification_schema: Value =
        serde_json::from_str(MODEL_ADAPTER_CERTIFICATION_SCHEMA).map_err(|error| {
            format!("Embedded model adapter certification schema is invalid: {error}")
        })?;
    Ok(json!({
        "contractVersion": 1,
        "implementationStatus": {
            "localProvider": "available",
            "remoteProviderAdapters": "native-disclosure-single-review-ui-no-live-proof",
            "providerTaskRuntime": "native-disclosure-research-envelope",
            "providerBatchAuthorization": "native-scoped-authorizer-no-product-executor",
            "providerBatchReservation": "internal-atomic-reservation-no-executor",
            "providerRunRecordValidator": "implemented",
            "modelAdapterCertifier": "contract-certified-runner",
            "credentialVault": "settings-vault-ui",
            "adversarialRecordValidator": "implemented",
            "adversarialRunner": "injected-runner-no-product-executor",
            "pluginCertifier": "contract-certified-runner",
            "pluginAuthorityBroker": "implemented-non-executing",
            "pluginWitContract": "published-zero-imports-no-runtime",
            "pluginLoader": "contract-only"
        },
        "providerAdapterStatus": {
            "openai-responses": crate::model_provider::OPENAI_ADAPTER_STATUS,
            "anthropic-messages": crate::model_provider::ANTHROPIC_ADAPTER_STATUS,
            "gemini-interactions": crate::model_provider::GEMINI_ADAPTER_STATUS,
            "xai-responses": crate::model_provider::XAI_ADAPTER_STATUS,
            "custom": "contract-only"
        },
        "providerTransports": [
            "local-openai-compatible",
            "openai-responses",
            "anthropic-messages",
            "gemini-interactions",
            "xai-responses",
            "custom"
        ],
        "adversarialProtocol": {
            "version": 1,
            "phases": [
                "independent-proposals",
                "cross-critiques",
                "evidence-audit",
                "order-swapped-judgment",
                "minority-report",
                "human-acceptance"
            ],
            "requiresComputeMatchedBaseline": true,
            "automaticSharedMutation": false
        },
        "pluginRuntimes": [
            { "kind": "wasi-component", "trustTier": "capability-sandboxed", "preferred": true },
            { "kind": "mcp-stdio", "trustTier": "native-process", "preferred": false }
        ],
        "pluginPermissions": [
            "project.read",
            "project.propose",
            "drive.read",
            "drive.propose",
            "network.fetch",
            "model.invoke"
        ],
        "pluginManifestSchema": manifest_schema,
        "pluginProposalSchema": proposal_schema,
        "pluginWitWorld": "syzygy:research/plugin@1.0.0",
        "pluginWitContract": PLUGIN_WIT_CONTRACT,
        "adversarialRunRecordSchema": adversarial_run_schema,
        "providerRunRecordSchema": provider_run_schema,
        "modelAdapterProfileSchema": model_adapter_schema,
        "modelAdapterCertificationSchema": model_adapter_certification_schema,
        "selfCheck": {
            "command": "npm run test:contracts",
            "providerCommand": "npm run test:providers",
            "providerRuntimeCommand": "npm run test:provider-runtime",
            "providerRuntimeInteropCommand": "npm run test:provider-runtime-interop",
            "providerStreamCommand": "npm run test:provider-streams",
            "credentialCommand": "npm run test:credentials",
            "credentialLiveCommand": "npm run test:credentials:live",
            "pluginCertifierCommand": "npm run test:plugin-sdk",
            "pluginAuthorityBrokerCommand": "npm run test:plugin-host",
            "modelAdapterCertifierCommand": "npm run test:model-adapter-sdk",
            "adversarialCommand": "npm run test:adversarial",
            "mcpCommand": "npm run test:mcp",
            "auditCommand": "npm run audit"
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn embedded_contracts_are_strict_and_truthful() {
        let contracts = current().expect("contracts should parse");
        assert_eq!(contracts["contractVersion"], 1);
        assert_eq!(
            contracts["implementationStatus"]["remoteProviderAdapters"],
            "native-disclosure-single-review-ui-no-live-proof"
        );
        assert_eq!(
            contracts["implementationStatus"]["providerTaskRuntime"],
            "native-disclosure-research-envelope"
        );
        assert_eq!(
            contracts["implementationStatus"]["providerBatchAuthorization"],
            "native-scoped-authorizer-no-product-executor"
        );
        assert_eq!(
            contracts["implementationStatus"]["providerBatchReservation"],
            "internal-atomic-reservation-no-executor"
        );
        assert_eq!(
            contracts["implementationStatus"]["credentialVault"],
            "settings-vault-ui"
        );
        assert_eq!(
            contracts["providerAdapterStatus"]["openai-responses"],
            "request-and-stream-control-conformance"
        );
        assert_eq!(
            contracts["providerAdapterStatus"]["anthropic-messages"],
            "request-control-conformance"
        );
        assert_eq!(
            contracts["providerAdapterStatus"]["gemini-interactions"],
            "request-control-conformance"
        );
        assert_eq!(
            contracts["providerAdapterStatus"]["xai-responses"],
            "request-control-conformance"
        );
        assert_eq!(
            contracts["implementationStatus"]["pluginCertifier"],
            "contract-certified-runner"
        );
        assert_eq!(
            contracts["implementationStatus"]["pluginAuthorityBroker"],
            "implemented-non-executing"
        );
        assert_eq!(
            contracts["implementationStatus"]["pluginWitContract"],
            "published-zero-imports-no-runtime"
        );
        assert_eq!(contracts["pluginWitWorld"], "syzygy:research/plugin@1.0.0");
        assert!(contracts["pluginWitContract"]
            .as_str()
            .is_some_and(|wit| wit.contains("world plugin")
                && !wit
                    .lines()
                    .any(|line| line.trim_start().starts_with("import "))));
        assert_eq!(
            contracts["implementationStatus"]["adversarialRecordValidator"],
            "implemented"
        );
        assert_eq!(
            contracts["implementationStatus"]["adversarialRunner"],
            "injected-runner-no-product-executor"
        );
        assert_eq!(
            contracts["implementationStatus"]["providerRunRecordValidator"],
            "implemented"
        );
        assert_eq!(
            contracts["implementationStatus"]["modelAdapterCertifier"],
            "contract-certified-runner"
        );
        assert_eq!(
            contracts["pluginManifestSchema"]["additionalProperties"],
            false
        );
        assert_eq!(
            contracts["adversarialProtocol"]["automaticSharedMutation"],
            false
        );
        assert_eq!(
            contracts["adversarialRunRecordSchema"]["additionalProperties"],
            false
        );
        assert_eq!(
            contracts["adversarialRunRecordSchema"]["properties"]["recordVersion"]["const"],
            1
        );
        assert_eq!(
            contracts["providerRunRecordSchema"]["additionalProperties"],
            false
        );
        assert_eq!(
            contracts["providerRunRecordSchema"]["properties"]["recordVersion"]["const"],
            1
        );
        assert_eq!(
            contracts["modelAdapterProfileSchema"]["additionalProperties"],
            false
        );
        assert_eq!(
            contracts["modelAdapterCertificationSchema"]["additionalProperties"],
            false
        );
    }

    #[test]
    fn plugin_wit_parses_as_one_zero_import_world() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/wit/syzygy-research-plugin-v1.wit");
        let mut resolve = wit_parser::Resolve::default();
        let (package_id, _) = resolve
            .push_path(&path)
            .expect("WIT should parse and resolve");
        let world_id = *resolve.packages[package_id]
            .worlds
            .get("plugin")
            .expect("plugin world should exist");
        let world = &resolve.worlds[world_id];
        assert!(
            world.imports.is_empty(),
            "baseline world must import no authority"
        );
        assert_eq!(
            world.exports.len(),
            1,
            "baseline world exports one interface"
        );
    }
}
