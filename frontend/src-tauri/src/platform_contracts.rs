//! Self-describing research extension contracts shared with headless MCP clients.
//!
//! These are capability contracts and truthful implementation states, not a plugin loader or
//! remote-provider implementation. Keeping them callable without the GUI lets CI and external
//! reviewers inspect the same boundary the future runtime must honor.

use serde_json::{json, Value};

const PLUGIN_MANIFEST_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-research-plugin-v1.schema.json");
const PLUGIN_PROPOSAL_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-plugin-proposal-v1.schema.json");
const ADVERSARIAL_RUN_SCHEMA: &str =
    include_str!("../../../docs/schemas/syzygy-adversarial-run-v1.schema.json");

pub fn current() -> Result<Value, String> {
    let manifest_schema: Value = serde_json::from_str(PLUGIN_MANIFEST_SCHEMA)
        .map_err(|error| format!("Embedded research plugin schema is invalid: {error}"))?;
    let proposal_schema: Value = serde_json::from_str(PLUGIN_PROPOSAL_SCHEMA)
        .map_err(|error| format!("Embedded plugin proposal schema is invalid: {error}"))?;
    let adversarial_run_schema: Value = serde_json::from_str(ADVERSARIAL_RUN_SCHEMA)
        .map_err(|error| format!("Embedded adversarial run schema is invalid: {error}"))?;
    Ok(json!({
        "contractVersion": 1,
        "implementationStatus": {
            "localProvider": "available",
            "remoteProviderAdapters": "contract-only",
            "credentialVault": "implemented-unverified",
            "adversarialRecordValidator": "implemented",
            "adversarialRunner": "contract-only",
            "pluginCertifier": "contract-certified-runner",
            "pluginLoader": "contract-only"
        },
        "providerAdapterStatus": {
            "openai-responses": crate::model_provider::OPENAI_ADAPTER_STATUS,
            "anthropic-messages": crate::model_provider::ANTHROPIC_ADAPTER_STATUS,
            "gemini-interactions": crate::model_provider::GEMINI_ADAPTER_STATUS,
            "xai-responses": "contract-only",
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
        "adversarialRunRecordSchema": adversarial_run_schema,
        "selfCheck": {
            "command": "npm run test:contracts",
            "providerCommand": "npm run test:providers",
            "providerStreamCommand": "npm run test:provider-streams",
            "credentialCommand": "npm run test:credentials",
            "credentialLiveCommand": "npm run test:credentials:live",
            "pluginCertifierCommand": "npm run test:plugin-sdk",
            "adversarialCommand": "npm run test:adversarial",
            "mcpCommand": "npm run test:mcp",
            "auditCommand": "npm run audit"
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_contracts_are_strict_and_truthful() {
        let contracts = current().expect("contracts should parse");
        assert_eq!(contracts["contractVersion"], 1);
        assert_eq!(
            contracts["implementationStatus"]["remoteProviderAdapters"],
            "contract-only"
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
            contracts["implementationStatus"]["credentialVault"],
            "implemented-unverified"
        );
        assert_eq!(
            contracts["implementationStatus"]["pluginCertifier"],
            "contract-certified-runner"
        );
        assert_eq!(
            contracts["implementationStatus"]["adversarialRecordValidator"],
            "implemented"
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
    }
}
