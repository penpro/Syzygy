import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { getProjectSharedTypes } from './projectModel'
import { LocalProjectProvider } from './localProvider'

const providers: LocalProjectProvider[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.clearData().catch(() => undefined)))
})

describe('local project persistence provider', () => {
  it('reopens acknowledged project state from IndexedDB', async () => {
    const key = `syzygy-headless-${Date.now()}-${Math.random()}`
    const firstDoc = new Y.Doc({ guid: 'document-1' })
    const first = new LocalProjectProvider(firstDoc, key)
    providers.push(first)
    first.connect()
    await first.whenReady()
    getProjectSharedTypes(firstDoc).scenarios.set('persisted-scenario', { title: 'Reopen me' })
    await first.flush()
    await first.destroy()
    providers.splice(providers.indexOf(first), 1)

    const reopenedDoc = new Y.Doc({ guid: 'document-1' })
    const reopened = new LocalProjectProvider(reopenedDoc, key)
    providers.push(reopened)
    reopened.connect()
    await reopened.whenReady()
    expect(getProjectSharedTypes(reopenedDoc).scenarios.get('persisted-scenario')).toEqual({ title: 'Reopen me' })
  })
})
