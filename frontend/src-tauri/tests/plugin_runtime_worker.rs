use app_lib::plugin_runtime::{
    plugin_component_run_with_executable, PluginRuntimeInvocation, PluginRuntimeOutput,
    PluginRuntimeProjectSnapshot, PluginRuntimeSourceSnapshot,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::path::Path;
use std::time::{Duration, Instant};

fn invocation() -> PluginRuntimeInvocation {
    PluginRuntimeInvocation {
        invocation_version: 1,
        plugin_id: "org.example.citation-auditor".into(),
        contribution_id: "citation-coverage".into(),
        project: Some(PluginRuntimeProjectSnapshot {
            project_id: "project-1".into(),
            revision: "revision-7".into(),
            document_text: "Policy text".into(),
            sources: vec![PluginRuntimeSourceSnapshot {
                snapshot_id: "source-1".into(),
                label: "Source".into(),
                content: "Evidence".into(),
            }],
        }),
    }
}

fn component_wat(run_body: &str, reason: &str) -> Vec<u8> {
    let reason_bytes = reason
        .as_bytes()
        .iter()
        .map(|byte| format!("\\{:02x}", byte))
        .collect::<String>();
    wat::parse_str(format!(
        r#"(component
          (core module $m
            (memory (export "memory") 2 512)
            (global $heap (mut i32) (i32.const 1024))
            (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
              (local $ptr i32)
              global.get $heap
              local.get 2
              i32.const 1
              i32.sub
              i32.add
              i32.const 0
              local.get 2
              i32.sub
              i32.and
              local.tee $ptr
              local.get 3
              i32.add
              global.set $heap
              local.get $ptr)
            (data (i32.const 64) "{reason_bytes}")
            (func (export "run")
              (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
              (result i32)
              {run_body}
              i32.const 0
              i32.const 0
              i32.store
              i32.const 4
              i32.const 0
              i32.store
              i32.const 8
              i32.const 64
              i32.store
              i32.const 12
              i32.const {reason_len}
              i32.store
              i32.const 0))
          (core instance $i (instantiate $m))
          (alias core export $i "memory" (core memory $memory))
          (alias core export $i "cabi_realloc" (core func $realloc))
          (alias core export $i "run" (core func $run))
          (type $source (record
            (field "snapshot-id" string)
            (field "label" string)
            (field "content" string)))
          (type $project (record
            (field "project-id" string)
            (field "revision" string)
            (field "document-text" string)
            (field "sources" (list $source))))
          (type $invocation (record
            (field "invocation-version" u32)
            (field "plugin-id" string)
            (field "contribution-id" string)
            (field "project" (option $project))))
          (type $operation (enum "append" "replace"))
          (type $proposal (record
            (field "proposal-version" u32)
            (field "proposal-id" string)
            (field "plugin-id" string)
            (field "project-id" string)
            (field "expected-revision" string)
            (field "summary" string)
            (field "content" string)
            (field "operation" $operation)))
          (type $output (variant
            (case "no-change" string)
            (case "proposals" (list $proposal))))
          (type $run-type (func
            (param "input" $invocation)
            (result (result $output (error string)))))
          (func $lifted-run (type $run-type)
            (canon lift (core func $run) (memory $memory) (realloc $realloc)))
          (instance $research-plugin
            (export "source-snapshot" (type $source))
            (export "project-snapshot" (type $project))
            (export "invocation" (type $invocation))
            (export "proposal-operation" (type $operation))
            (export "change-proposal" (type $proposal))
            (export "output" (type $output))
            (export "run" (func $lifted-run)))
          (export "syzygy:research/research-plugin@1.0.0"
            (instance $research-plugin)))"#,
        reason_len = reason.len(),
    ))
    .expect("test component WAT should compile")
}

fn encoded_component(run_body: &str, reason: &str) -> String {
    BASE64_STANDARD.encode(component_wat(run_body, reason))
}

#[test]
fn plugin_runtime_worker_abort_is_reaped_and_the_host_remains_reusable() {
    let executable = Path::new(env!("CARGO_BIN_EXE_plugin-runtime-harness"));
    let started = Instant::now();
    let hostile = plugin_component_run_with_executable(
        executable,
        encoded_component("(loop br 0)", "unreachable"),
        invocation(),
    );
    assert!(matches!(
        hostile.as_ref().err().map(String::as_str),
        Some("plugin-runtime:worker-failed") | Some("plugin-runtime:worker-deadline")
    ));
    assert!(started.elapsed() < Duration::from_secs(7));

    let recovered = plugin_component_run_with_executable(
        executable,
        encoded_component("", "No findings"),
        invocation(),
    )
    .expect("a fresh bounded worker should run after the hostile worker exits");
    assert_eq!(
        recovered.output,
        PluginRuntimeOutput::NoChange {
            reason: "No findings".into(),
        }
    );
}

#[test]
fn plugin_runtime_parent_deadline_covers_a_worker_that_never_reads_stdin() {
    let executable = Path::new(env!("CARGO_BIN_EXE_plugin-runtime-hanging-harness"));
    let started = Instant::now();
    let result = plugin_component_run_with_executable(
        executable,
        encoded_component("", "No findings"),
        invocation(),
    );
    assert_eq!(result, Err("plugin-runtime:worker-deadline".into()));
    assert!(started.elapsed() >= Duration::from_secs(4));
    assert!(started.elapsed() < Duration::from_secs(7));
}
