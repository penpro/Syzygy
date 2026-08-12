# Citation auditor executable plugin example

This independently packaged example is an executable zero-import WebAssembly component. It reads
the bounded project identity and revision supplied by Syzygy and returns one append proposal for
human review. The proposal borrows the exact plugin, project, and revision fields from each
invocation, so the host can reject stale or cross-target output. It receives no network, model,
Drive, filesystem, environment, clock, random, or direct document-write authority.

`citation-auditor.wat` is the reviewable source. Rebuild the checked-in component from `frontend`:

```powershell
npm run build:plugin-example
```

The package also contains a public Ed25519 publisher proof. The corresponding private test key is
deliberately not retained. `npm run test:plugin-example` rebuilds the component, verifies that exact
artifact in the native Wasmtime boundary with two distinct project revisions, contract-certifies
it, and installs the signed package into two isolated IndexedDB catalogs. These tests do not claim
certification by an external auditor or execution on two physical computers.
