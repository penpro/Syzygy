# ADR-0001: Direct Drive workspace authorization

- **Status:** accepted for implementation; live reauthorization gate outstanding
- **Date:** 2026-07-14
- **Owners:** Penumbra / Syzygy
- **Capabilities:** S-01, S-02

## Decision

Syzygy requests Google's restricted `https://www.googleapis.com/auth/drive` scope for the
optional collaboration feature. After authorization, it stores one selected folder ID locally
and applies that boundary to every product operation:

- direct Ask retrieval recursively lists only descendants of the selected folder;
- native Docs, Sheets, and Slides are exported in memory;
- direct file reads reject IDs outside the selected folder tree;
- transcripts are created inside the selected folder;
- a local mirror is created or refreshed only when the user clicks **Sync**; and
- OAuth credentials and tokens remain in Rust-owned app data.

This is not a claim that Google technically limits the token to one folder. The token is broad;
Syzygy's code enforces the narrower product boundary. The UI discloses that distinction before
re-linking.

## Evidence that forced the decision

The v0.1.4 token used `drive.file`. A live, read-only comparison on 2026-07-14 found:

- the app-scoped Drive API saw the `Syzygy` folder plus three app-created Markdown/text files;
- the connected full Drive view saw the same folder plus a collaborator-created native Google
  Doc, `test file for syzygy`; and
- the app-scoped token could not enumerate that Doc, so retrieval returned no relevant evidence
  and the model asked for a public link.

Google documents `drive.file` as per-file access for files created by the app or explicitly
shared/opened through a picker. Google classifies `drive` and `drive.readonly` as restricted
scopes and lists productivity/workgroup collaboration as a qualifying use case:

- <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- <https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker>

## Alternatives considered

### Keep `drive.file` and the app-created folder

Rejected for the collaboration goal. It works for Syzygy-created transcript files but does not
make arbitrary collaborator-created Docs visible. Calling that a shared folder is misleading.

### Google Picker with `drive.file`

Preferred in principle, but not sufficient for the current desktop architecture. Google's
desktop/mobile Picker flow returns selected file IDs, permits only `drive.file`, and documents a
public HTTPS redirect requirement. It does not document recursive authorization of every present
and future child of a picked folder. Syzygy currently uses an RFC-8252 loopback redirect and has
no mandatory hosted callback service. A picker that requires users to select every new file does
not meet the folder-collaboration contract.

Revisit when Google documents recursive folder grants for `drive.file` with an installed-app
loopback callback, or when a self-hostable callback can be offered without becoming mandatory.

### `drive.readonly` plus a separate write scope

Rejected for now. It is still restricted, reads the same broad corpus, complicates creation and
updates inside a selected pre-existing folder, and does not materially reduce verification work.

### Require public links

Rejected. It weakens privacy, breaks normal private/shared-folder workflows, and makes the model
responsible for web access it does not have.

## Verification and publication obligations

1. The Google Cloud consent configuration must include the `drive` scope.
2. Public distribution must complete Google's restricted-scope verification requirements.
3. Because Syzygy keeps Drive content and tokens on the user's machine rather than transmitting
   them to Penumbra servers, document that architecture in the verification submission; do not
   claim that this automatically waives Google's review.
4. Existing users must explicitly re-link. Legacy grants remain marked app-file-only and direct
   Shared mode fails closed.
5. Run `npm run test:drive-live` after re-linking. S-01 cannot become `verified` until that harness
   sees at least one native Google file and the local model returns the canary extracted from the
   same Drive context.

### Validation update — 2026-07-14

The reauthorized primary Windows account passed the live harness against a collaborator-created
native Google file. The model returned the redacted canary from direct Drive evidence without a
mirror. Evidence: `docs/audits/runs/DRIVE-LIVE-2026-07-14.json`. S-01 remains
`implemented_unverified` until the planned second-account/second-install reproduction passes.

## Falsification tests

- Supply a file ID outside the selected tree: `google_drive_read_file` must reject it.
- Add a Google Doc through Drive, without using Syzygy: the live harness must enumerate/export it.
- Remove or revoke the scope: Shared Ask must error before calling the model.
- Ask a query with no matching passage: the model prompt must say the folder was checked and must
  not request a public link.
- Use a folder larger than the 2,000-file/12-level safety bounds: retrieval must stop with a clear
  error rather than crawl without limit.
