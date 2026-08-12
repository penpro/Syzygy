(component
  (core module $implementation
    (memory (export "memory") 2 512)
    (global $heap (mut i32) (i32.const 1024))
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      (local $pointer i32)
      global.get $heap
      local.get 2
      i32.const 1
      i32.sub
      i32.add
      i32.const 0
      local.get 2
      i32.sub
      i32.and
      local.tee $pointer
      local.get 3
      i32.add
      global.set $heap
      local.get $pointer)

    ;; Static proposal text. Identity and revision fields are borrowed from the invocation.
    (data (i32.const 64) "citation-review-1")
    (data (i32.const 96) "Review citation coverage")
    (data (i32.const 128) "Review this draft's citation coverage before accepting its claims.")

    (func (export "run")
      (param $invocation-version i32)
      (param $plugin-id-pointer i32)
      (param $plugin-id-length i32)
      (param $contribution-id-pointer i32)
      (param $contribution-id-length i32)
      (param $project-present i32)
      (param $project-id-pointer i32)
      (param $project-id-length i32)
      (param $revision-pointer i32)
      (param $revision-length i32)
      (param $document-pointer i32)
      (param $document-length i32)
      (param $sources-pointer i32)
      (param $sources-length i32)
      (result i32)

      ;; The host only invokes this contribution with project.read authority. Trap closed if a
      ;; caller violates that contract instead of constructing a cross-target proposal.
      local.get $project-present
      i32.eqz
      if
        unreachable
      end

      ;; Canonical ABI record for one change-proposal at byte 256.
      i32.const 256
      i32.const 1
      i32.store
      i32.const 260
      i32.const 64
      i32.store
      i32.const 264
      i32.const 17
      i32.store
      i32.const 268
      local.get $plugin-id-pointer
      i32.store
      i32.const 272
      local.get $plugin-id-length
      i32.store
      i32.const 276
      local.get $project-id-pointer
      i32.store
      i32.const 280
      local.get $project-id-length
      i32.store
      i32.const 284
      local.get $revision-pointer
      i32.store
      i32.const 288
      local.get $revision-length
      i32.store
      i32.const 292
      i32.const 96
      i32.store
      i32.const 296
      i32.const 24
      i32.store
      i32.const 300
      i32.const 128
      i32.store
      i32.const 304
      i32.const 66
      i32.store
      i32.const 308
      i32.const 0
      i32.store

      ;; result<output, string>::ok(output::proposals([proposal])).
      i32.const 0
      i32.const 0
      i32.store
      i32.const 4
      i32.const 1
      i32.store
      i32.const 8
      i32.const 256
      i32.store
      i32.const 12
      i32.const 1
      i32.store
      i32.const 0))

  (core instance $instance (instantiate $implementation))
  (alias core export $instance "memory" (core memory $memory))
  (alias core export $instance "cabi_realloc" (core func $realloc))
  (alias core export $instance "run" (core func $run))
  (type $source-snapshot (record
    (field "snapshot-id" string)
    (field "label" string)
    (field "content" string)))
  (type $project-snapshot (record
    (field "project-id" string)
    (field "revision" string)
    (field "document-text" string)
    (field "sources" (list $source-snapshot))))
  (type $invocation (record
    (field "invocation-version" u32)
    (field "plugin-id" string)
    (field "contribution-id" string)
    (field "project" (option $project-snapshot))))
  (type $proposal-operation (enum "append" "replace"))
  (type $change-proposal (record
    (field "proposal-version" u32)
    (field "proposal-id" string)
    (field "plugin-id" string)
    (field "project-id" string)
    (field "expected-revision" string)
    (field "summary" string)
    (field "content" string)
    (field "operation" $proposal-operation)))
  (type $output (variant
    (case "no-change" string)
    (case "proposals" (list $change-proposal))))
  (type $run-type (func
    (param "input" $invocation)
    (result (result $output (error string)))))
  (func $lifted-run (type $run-type)
    (canon lift (core func $run) (memory $memory) (realloc $realloc)))
  (instance $research-plugin
    (export "source-snapshot" (type $source-snapshot))
    (export "project-snapshot" (type $project-snapshot))
    (export "invocation" (type $invocation))
    (export "proposal-operation" (type $proposal-operation))
    (export "change-proposal" (type $change-proposal))
    (export "output" (type $output))
    (export "run" (func $lifted-run)))
  (export "syzygy:research/research-plugin@1.0.0"
    (instance $research-plugin)))
