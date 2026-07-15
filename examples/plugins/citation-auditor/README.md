# Citation auditor plugin contract example

This is an interface and certification example, not an executable plugin. It demonstrates a
least-authority manifest, one accepted and one rejected proposal fixture, declared network hosts,
and explicit allow/deny probes. The runtime artifact is a text marker so the contract certifier can
prove package containment; it is intentionally not a WebAssembly component.

Passing `npm run certify:plugin -- ..\examples\plugins\citation-auditor` proves only schemas,
paths, fixtures, and requested-authority behavior. It does not prove runtime safety or usefulness.
