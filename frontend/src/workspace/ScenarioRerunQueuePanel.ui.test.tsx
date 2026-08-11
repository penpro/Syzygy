import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createProjectDocument } from './projectModel'
import {
  scenarioRerunAttributionMessage,
  ScenarioRerunAttributionStatus,
  ScenarioRerunQueuePanel,
} from './ScenarioRerunQueuePanel'
import { createProjectManifest } from './schema'

describe('scenario rerun queue product surface', () => {
  it('explains immutable reruns, local-off behavior, and per-item remote disclosure', () => {
    const project = createProjectManifest({ id: 'rerun-ui-project', documentId: 'rerun-ui-document', timestamp: 1 })
    const html = renderToStaticMarkup(<ScenarioRerunQueuePanel project={project} doc={createProjectDocument(project)} />)
    expect(html).toContain('Versioned scenario reruns')
    expect(html).toContain('exact shared scenario revisions')
    expect(html).toContain('Create paused queue')
    expect(html).toContain('Send once per item')
    expect(html).toContain('Local AI is off or no text model is loaded')
    expect(html).toContain('identity is not authenticated')
  })

  it('distinguishes installation signing from explicit unsigned persistence', () => {
    const signed = scenarioRerunAttributionMessage({
      status: 'signed-device', keyId: `ed25519-sha256:${'a'.repeat(43)}`,
      eventKind: 'scenario-rerun', eventId: 'd:3:job', eventSha256: 'b'.repeat(43),
      attestationCount: 1, authority: 'installation-device-not-human-identity',
    })
    const unsigned = scenarioRerunAttributionMessage({
      status: 'unsigned', reason: 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    })
    const html = renderToStaticMarkup(<>
      <ScenarioRerunAttributionStatus message={signed} />
      <ScenarioRerunAttributionStatus message={unsigned} />
    </>)
    expect(html).toContain('this installation’s signature')
    expect(html).toContain('without a device signature')
    expect(html).not.toContain('authenticated identity')
  })
})
