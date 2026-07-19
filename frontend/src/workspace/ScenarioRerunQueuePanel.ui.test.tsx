import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createProjectDocument } from './projectModel'
import { ScenarioRerunQueuePanel } from './ScenarioRerunQueuePanel'
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
})
