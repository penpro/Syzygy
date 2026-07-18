export const AUTOMATION_CAPABILITIES = {
  available: [
    'local project identity',
    'local collaborative rich-text draft',
    'automatic IndexedDB persistence',
    'Drive-backed project sharing with append-only Yjs merge and local offline persistence',
    'revision-guarded semantic MCP reads and writes',
    'read-only MCP integrity inspection for scenarios, votes, annotations, labels, heuristics, and immutable version history',
    'dual-revision-guarded MCP creation and restore-as-new-head of immutable policy checkpoints',
    'product version save, restore-as-new-head, and engine-free diff controls',
    'research-revision-guarded MCP scenario creation, turn editing, aggregate voting, annotation lifecycle, and shared labels',
    'product scenario gallery, editing, voting, and stable-ID scenario links',
  ],
  unavailable: [
    'scenario generation, response evaluation, and spotlight/embed workflows',
    'real-time collaborator presence',
  ],
} as const