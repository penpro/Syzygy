import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyProviderStreamEvent, initialProviderStreamState } from '../providerStream'
import type { ProviderTaskOutcome } from '../tauri'
import {
  providerUsesNativeStreaming,
  ProviderReviewHistoryView,
  reconcileSourceLocatorContinuation,
  RemoteResearchReviewResult,
} from './RemoteResearchReview'
import type { ProviderReviewArchive } from './providerReviewHistory'

describe('remote research streaming result', () => {
  it('routes every built-in remote provider through the native streaming channel', () => {
    expect(providerUsesNativeStreaming('openai')).toBe(true)
    expect(providerUsesNativeStreaming('anthropic')).toBe(true)
    expect(providerUsesNativeStreaming('gemini')).toBe(true)
    expect(providerUsesNativeStreaming('xai')).toBe(true)
  })

  it('renders incremental text as a transient review without implying a shared-draft mutation', () => {
    let streamState = initialProviderStreamState()
    streamState = applyProviderStreamEvent(streamState, {
      type: 'message-start',
      provider: 'openai',
      responseId: 'response-001',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'text-delta',
      text: 'Incremental adversarial finding.',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'usage',
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    })

    const html = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="openai"
        model="fixture-model"
        outcome={null}
        streamState={streamState}
      />,
    )

    expect(html).toContain('openai · fixture-model · 12 tokens')
    expect(html).toContain('Incremental adversarial finding.')
    expect(html).toContain('Transient review · never applied to the shared draft automatically')
    expect(html).toContain('aria-live="polite"')
  })

  it('renders tool calls as proposal-only artifacts even when no prose is returned', () => {
    let streamState = initialProviderStreamState()
    streamState = applyProviderStreamEvent(streamState, {
      type: 'message-start', provider: 'xai', responseId: 'response-tool',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'tool-call-start', callId: 'call-tool', name: 'lookup_source',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'tool-call-delta', callId: 'call-tool', argumentsDelta: '{"query":"budget"}',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'tool-call-complete', callId: 'call-tool', name: 'lookup_source', arguments: { query: 'budget' },
    })

    const html = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="xai"
        model="fixture-model"
        outcome={null}
        streamState={streamState}
        toolDefinitions={[{
          name: 'lookup_source',
          description: 'Propose a bounded source lookup.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        }]}
      />,
    )
    expect(html).toContain('Tool proposals · inspect only · not executed')
    expect(html).toContain('lookup_source')
    expect(html).toContain('&quot;query&quot;: &quot;budget&quot;')
    expect(html).toContain('Schema matches · domain unreviewed · not executable')
    expect(html).not.toContain('Run tool')
  })

  it('renders schema failure and missing-definition state without creating an execution control', () => {
    let streamState = initialProviderStreamState()
    for (const event of [
      { type: 'message-start' as const, provider: 'anthropic', responseId: 'response-invalid' },
      { type: 'tool-call-start' as const, callId: 'call-invalid', name: 'lookup_source' },
      { type: 'tool-call-delta' as const, callId: 'call-invalid', argumentsDelta: '{"query":42}' },
      { type: 'tool-call-complete' as const, callId: 'call-invalid', name: 'lookup_source', arguments: { query: 42 } },
    ]) streamState = applyProviderStreamEvent(streamState, event)

    const invalid = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="anthropic"
        model="fixture-model"
        outcome={null}
        streamState={streamState}
        toolDefinitions={[{
          name: 'lookup_source',
          description: 'Propose a bounded source lookup.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }]}
      />,
    )
    expect(invalid).toContain('Schema mismatch · domain unreviewed · not executable')
    expect(invalid).toContain('Schema issues:')

    const missing = renderToStaticMarkup(
      <RemoteResearchReviewResult provider="anthropic" model="fixture-model" outcome={null} streamState={streamState} />,
    )
    expect(missing).toContain('Definition missing · domain unreviewed · not executable')
    expect(missing).not.toContain('Run tool')
  })

  it('renders only a Rust-authorized frozen-source proposal as continuable', () => {
    const outcome: ProviderTaskOutcome = {
      response: {
        provider: 'gemini',
        id: 'native-tool-response',
        status: 'requires_action',
        model: 'fixture-model',
        text: '',
        refusals: [],
        unknownOutputTypes: [],
        toolProposals: [{
          callId: 'native-call-exact',
          name: 'syzygy_locate_exact_source_text',
          arguments: {
            snapshotId: 'snapshot-1', exactText: 'bounded evidence', maxMatches: 2,
          },
          validation: {
            schemaStatus: 'valid',
            domainStatus: 'source-snapshot-approved',
            executable: true,
            errors: [],
          },
        }],
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
      zeroDataRetention: null,
      errorCode: null,
      runRecord: {} as ProviderTaskOutcome['runRecord'],
      toolContinuationAvailable: true,
      toolContinuationTurn: 1,
    }
    const html = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="gemini"
        model="fixture-model"
        outcome={outcome}
        streamState={null}
        onContinueTools={() => undefined}
      />,
    )
    expect(html).toContain('native source scope reviewed · execution requires confirmation')
    expect(html).toContain('Schema matches · frozen snapshot approved · native read only')
    expect(html).toContain('Run native source locator and continue · turn 1')
  })

  it('retains the reviewed native proposal when fresh result disclosure is cancelled', () => {
    const previous: ProviderTaskOutcome = {
      response: {
        provider: 'openai',
        id: 'response-tool',
        status: 'completed',
        model: 'fixture-model',
        text: '',
        refusals: [],
        toolProposals: [],
        unknownOutputTypes: [],
        usage: null,
      },
      zeroDataRetention: null,
      errorCode: null,
      runRecord: {} as ProviderTaskOutcome['runRecord'],
      toolContinuationAvailable: true,
      toolContinuationTurn: 1,
    }
    const cancelled: ProviderTaskOutcome = {
      response: null,
      zeroDataRetention: null,
      errorCode: 'disclosure-required',
      runRecord: {} as ProviderTaskOutcome['runRecord'],
      toolContinuationAvailable: false,
      toolContinuationTurn: null,
    }
    expect(reconcileSourceLocatorContinuation(previous, cancelled)).toEqual({
      displayedOutcome: previous,
      continuationAvailable: true,
      disclosureCancelled: true,
    })
  })

  it('distinguishes a shared immutable archive from a transient result without claiming draft mutation', () => {
    const html = renderToStaticMarkup(<RemoteResearchReviewResult
      provider="openai"
      model="fixture-model"
      outcome={{
        response: {
          provider: 'openai', id: 'shared-response', status: 'completed', model: 'fixture-model',
          text: 'A retained challenge.', refusals: [], unknownOutputTypes: [], toolProposals: [], usage: null,
        },
        zeroDataRetention: null,
        errorCode: null,
        runRecord: {} as ProviderTaskOutcome['runRecord'],
        toolContinuationAvailable: false,
        toolContinuationTurn: null,
      }}
      streamState={null}
      shared
    />)
    expect(html).toContain('Shared immutable review archive')
    expect(html).toContain('never applied to the shared draft automatically')
    expect(html).not.toContain('Transient review')
  })

  it('keeps shared history content-free until an exact verified archive is selected', () => {
    const inspection = {
      healthy: true,
      archiveCount: 1,
      items: [{
        runId: 'shared-run', recordSha256: 'a'.repeat(64), sourceDocumentRevision: '1.2',
        providerId: 'openai', model: 'fixture-model',
        createdBy: { participantId: 'researcher-a', displayName: 'Researcher A' },
        createdAt: 1_700_000_000_000, sourceCount: 1, totalTokens: 20,
      }],
      conflictedRunIds: [], issues: [], totalBytes: 100,
    }
    const summary = renderToStaticMarkup(<ProviderReviewHistoryView
      inspection={inspection}
      loading={false}
      selectedRunId={null}
      selectedArchive={null}
      onSelect={() => undefined}
    />)
    expect(summary).toContain('Shared provider review history')
    expect(summary).toContain('openai · fixture-model')
    expect(summary).not.toContain('Sensitive frozen passage')

    const archive = {
      schemaVersion: 1,
      recordSha256: 'a'.repeat(64),
      runId: 'shared-run',
      projectId: 'project-a',
      documentId: 'document-a',
      sourceDocumentRevision: '1.2',
      researchRevisionAtSave: '3.4',
      request: {
        runId: 'shared-run', callId: 'shared-call', taskType: 'research.remote-review', provider: 'openai',
        timeoutMs: 120_000, model: 'fixture-model', developerInstructions: 'Audit.',
        question: 'What is unsupported?',
        sources: [{ snapshotId: 'source-a', label: 'Draft', excerpt: 'Sensitive frozen passage' }],
        maxOutputTokens: 1_200, toolDefinitions: [], enableSourceLocator: false,
      },
      response: {
        provider: 'openai', id: 'response-a', status: 'completed', model: 'fixture-model',
        text: 'The baseline is missing.', refusals: [], unknownOutputTypes: [], toolProposals: [],
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      },
      runRecord: {
        recordVersion: 1,
        runId: 'shared-run',
        callId: 'shared-call',
        executionMode: 'product',
        provider: {
          id: 'openai', transport: 'openai-responses', model: 'fixture-model',
          adapterStatus: 'request-stream-and-schema-validated-tool-proposal-conformance', remote: true,
        },
        request: {
          taskType: 'research.remote-review',
          startedAt: '2026-08-11T19:00:00.000Z',
          completedAt: '2026-08-11T19:00:01.000Z',
          sourceSnapshotIds: ['source-a'],
          inputSha256: 'b'.repeat(64),
          maxOutputTokens: 1_200,
          timeoutMs: 120_000,
          stream: true,
        },
        disclosure: {
          required: true, approved: true, approvedAt: '2026-08-11T18:59:59.000Z',
          destination: 'https://api.openai.com/v1/responses',
          policyUrl: 'https://openai.com/policies/privacy-policy/',
          policyCheckedAt: '2026-08-11T00:00:00.000Z',
        },
        dataHandling: { storageRequest: 'disabled', zeroRetention: 'not-attested', attestation: null },
        result: { status: 'completed', outputSha256: 'c'.repeat(64), errorCode: null },
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, costUsd: null },
      },
      createdBy: { participantId: 'researcher-a', displayName: 'Researcher A' },
      createdAt: 1_700_000_000_000,
    } as ProviderReviewArchive
    const detail = renderToStaticMarkup(<ProviderReviewHistoryView
      inspection={inspection}
      loading={false}
      selectedRunId="shared-run"
      selectedArchive={archive}
      onSelect={() => undefined}
    />)
    expect(detail).toContain('Sensitive frozen passage')
    expect(detail).toContain('The baseline is missing.')
    expect(detail).toContain('not authenticated human identity')
  })

  it('renders same-run divergence as a blocking shared-history conflict', () => {
    const html = renderToStaticMarkup(<ProviderReviewHistoryView
      inspection={{
        healthy: false, archiveCount: 2, items: [], conflictedRunIds: ['shared-run'],
        issues: ['1 provider review run identity conflict(s) require inspection'], totalBytes: 200,
      }}
      loading={false}
      selectedRunId={null}
      selectedArchive={null}
      onSelect={() => undefined}
    />)
    expect(html).toContain('New archives are disabled until history integrity is repaired')
    expect(html).toContain('Provider review conflict · shared-run')
    expect(html).toContain('No archive was selected')
  })
})
