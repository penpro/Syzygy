import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const writeProof = process.argv.includes('--write-proof')
const executableFlag = process.argv.indexOf('--executable')
const executable = executableFlag >= 0
  ? path.resolve(process.argv[executableFlag + 1])
  : path.join(frontend, 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'Syzygy.exe' : 'Syzygy')

if (!existsSync(executable)) {
  throw new Error(`Syzygy executable not found at ${executable}. Build it first or pass --executable <path>.`)
}

class McpSession {
  constructor(command) {
    this.child = spawn(command, ['--mcp'], {
      cwd: path.dirname(command),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.buffer = ''
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('exit', resolve)
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.child.once('exit', (code) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(`Syzygy MCP exited ${code}: ${this.stderr}`))
      }
      this.pending.clear()
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line)
        const waiter = this.pending.get(message.id)
        if (!waiter) throw new Error(`Unexpected MCP response ID ${message.id}`)
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async tool(name, args = {}, allowError = false) {
    const result = await this.request('tools/call', { name, arguments: args })
    if (result.isError && !allowError) {
      throw new Error(result.structuredContent?.error ?? `${name} failed`)
    }
    return result
  }

  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    const code = await this.closed
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    if (code !== 0) throw new Error(`Syzygy MCP exited ${code}: ${this.stderr}`)
  }
}

const session = new McpSession(executable)
const evidence = { passed: false, executable, writeProof }
try {
  const initialized = await session.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'syzygy-live-harness', version: '1' },
  })
  session.notify('notifications/initialized')
  evidence.protocolVersion = initialized.protocolVersion

  let status = await session.tool('syzygy_status', {}, true)
  if (status.isError) {
    await session.tool('launch_syzygy')
    status = await session.tool('syzygy_status')
  }
  evidence.appVersion = status.structuredContent.version
  evidence.editorReadyBefore = status.structuredContent.editorReady

  const walkthrough = await session.tool('workspace_walkthrough')
  const projects = await session.tool('list_projects')
  evidence.walkthroughSteps = walkthrough.structuredContent.steps.length
  evidence.projectCountBefore = projects.structuredContent.projects.length

  if (writeProof) {
    const proofTitle = 'MCP pilot — revision-safe policy walkthrough'
    const existing = projects.structuredContent.projects.find((project) => !project.archivedAt && project.title === proofTitle)
    const created = existing
      ? await session.tool('open_project', { projectId: existing.id })
      : await session.tool('create_project', { title: proofTitle })
    const projectId = created.structuredContent.project.id
    const starterRevision = created.structuredContent.document.revision
    const replaced = await session.tool('replace_active_document', {
      expectedRevision: starterRevision,
      content: [
        '# Community research access policy',
        '## Rule',
        'Research materials may be edited by collaborators who record the purpose of each change.',
        '## Rationale',
        'A visible reason makes review easier without requiring a hosted editor service.',
        '> Proposed changes remain reviewable evidence until a person accepts them.',
      ].join('\n'),
    })
    const replacedRevision = replaced.structuredContent.document.revision
    const appended = await session.tool('append_active_document', {
      expectedRevision: replacedRevision,
      content: '## Testable example\nA collaborator adds a source and records why it changes the draft.',
    })
    const staleWrite = await session.tool('replace_active_document', {
      expectedRevision: starterRevision,
      content: 'This stale write must not land.',
    }, true)
    if (!staleWrite.isError || !/Revision conflict/.test(staleWrite.structuredContent?.error ?? '')) {
      throw new Error('The live app did not reject the stale MCP write')
    }
    const readback = await session.tool('read_active_project')
    const researchState = await session.tool('inspect_research_state')
    if (readback.structuredContent.project.id !== projectId) throw new Error('Live project identity changed')
    if (!readback.structuredContent.document.text.includes('Testable example')) throw new Error('Live append was not readable')
    if (readback.structuredContent.document.text.includes('stale write')) throw new Error('Stale write reached the live draft')
    if (researchState.structuredContent.researchState.projectId !== projectId) throw new Error('Research-state inspection targeted the wrong project')
    if (researchState.structuredContent.researchState.selfCheck.healthy !== true) throw new Error('Live research-state integrity check failed')
    const scenarioId = `mcp-live-${Date.now().toString(36)}`
    const createdScenario = await session.tool('create_scenario', {
      expectedResearchRevision: researchState.structuredContent.researchState.revision,
      scenarioId,
      title: 'MCP live harness scenario',
      background: 'Verify guarded scenario creation through the semantic live bridge.',
      participantId: 'mcp-live-harness',
    })
    const staleScenarioCreate = await session.tool('create_scenario', {
      expectedResearchRevision: researchState.structuredContent.researchState.revision,
      scenarioId: `${scenarioId}-stale`,
      title: 'This stale scenario must not land',
      background: '',
      participantId: 'mcp-live-harness',
    }, true)
    if (!staleScenarioCreate.isError || !/Research state revision conflict/.test(staleScenarioCreate.structuredContent?.error ?? '')) {
      throw new Error('The live app did not reject stale MCP scenario creation')
    }
    const stateAfterScenario = await session.tool('inspect_research_state')
    if (createdScenario.structuredContent.scenario.id !== scenarioId) throw new Error('Scenario creation returned the wrong identity')
    const addedTurn = await session.tool('add_scenario_turn', {
      expectedResearchRevision: createdScenario.structuredContent.researchRevision,
      scenarioId,
      turnId: 'answer-turn',
      role: 'assistant',
      content: 'Initial harness answer.',
      participantId: 'mcp-live-harness',
    })
    const revisedTurn = await session.tool('revise_scenario_turn', {
      expectedResearchRevision: addedTurn.structuredContent.researchRevision,
      scenarioId,
      turnId: 'answer-turn',
      role: 'assistant',
      content: 'Revised harness answer with retained history.',
      participantId: 'mcp-live-harness-reviewer',
    })
    if (stateAfterScenario.structuredContent.researchState.scenarios.totalRecords !== researchState.structuredContent.researchState.scenarios.totalRecords + 1) throw new Error('Scenario creation did not add exactly one record')
    if (stateAfterScenario.structuredContent.researchState.scenarios.items.some((item) => item.id === `${scenarioId}-stale`)) throw new Error('Stale scenario creation reached live state')
    const stateAfterTurns = await session.tool('inspect_research_state')
    const inspectedScenario = stateAfterTurns.structuredContent.researchState.scenarios.items.find((item) => item.id === scenarioId)
    if (addedTurn.structuredContent.turn.revisionCount !== 1) throw new Error('Scenario turn add did not create one revision')
    if (revisedTurn.structuredContent.turn.revisionCount !== 2 || revisedTurn.structuredContent.turn.content !== 'Revised harness answer with retained history.') throw new Error('Scenario turn revision did not retain and project history')
    if (inspectedScenario?.turnCount !== 1 || inspectedScenario?.turnRevisionCount !== 2) throw new Error('Scenario turn state was not visible through inspection')
    const supportVote = await session.tool('cast_scenario_vote', {
      expectedResearchRevision: revisedTurn.structuredContent.researchRevision,
      scenarioId,
      participantId: 'mcp-live-voter',
      displayName: 'MCP live voter',
      choice: 'support',
    })
    const opposeVote = await session.tool('cast_scenario_vote', {
      expectedResearchRevision: supportVote.structuredContent.researchRevision,
      scenarioId,
      participantId: 'mcp-live-voter',
      displayName: 'MCP live voter revised',
      choice: 'oppose',
    })
    const staleVote = await session.tool('cast_scenario_vote', {
      expectedResearchRevision: revisedTurn.structuredContent.researchRevision,
      scenarioId,
      participantId: 'mcp-live-stale-voter',
      displayName: 'This stale voter must not land',
      choice: 'support',
    }, true)
    if (!staleVote.isError || !/Research state revision conflict/.test(staleVote.structuredContent?.error ?? '')) {
      throw new Error('The live app did not reject the stale MCP scenario vote')
    }
    const stateAfterVotes = await session.tool('inspect_research_state')
    const inspectedVotes = stateAfterVotes.structuredContent.researchState.scenarioVotes.items.find((item) => item.scenarioId === scenarioId)
    if (supportVote.structuredContent.vote.counts.support !== 1 || supportVote.structuredContent.vote.eventCount !== 1) throw new Error('Initial scenario vote was not projected correctly')
    if (opposeVote.structuredContent.vote.counts.support !== 0 || opposeVote.structuredContent.vote.counts.oppose !== 1 || opposeVote.structuredContent.vote.eventCount !== 2) throw new Error('Scenario re-vote did not preserve history and update the projection')
    if (inspectedVotes?.counts.support !== 0 || inspectedVotes?.counts.oppose !== 1 || inspectedVotes?.activeVoteCount !== 1 || inspectedVotes?.eventCount !== 2) throw new Error('Scenario vote state was not visible through bounded inspection')
    const createdAnnotation = await session.tool('create_scenario_annotation', {
      expectedResearchRevision: opposeVote.structuredContent.researchRevision,
      annotationId: 'source-note',
      scenarioId,
      turnId: 'answer-turn',
      kind: 'note',
      body: 'Verify the cited source before accepting this answer.',
      participantId: 'mcp-live-reviewer',
      displayName: 'MCP live reviewer',
    })
    const updatedAnnotation = await session.tool('update_scenario_annotation', {
      expectedResearchRevision: createdAnnotation.structuredContent.researchRevision,
      annotationId: 'source-note',
      scenarioId,
      expectedCurrentEventId: createdAnnotation.structuredContent.annotation.currentEventId,
      body: 'Source verified against the shared evidence.',
      participantId: 'mcp-live-reviewer',
      displayName: 'MCP live reviewer',
    })
    const resolvedAnnotation = await session.tool('set_scenario_annotation_resolution', {
      expectedResearchRevision: updatedAnnotation.structuredContent.researchRevision,
      annotationId: 'source-note',
      scenarioId,
      expectedCurrentEventId: updatedAnnotation.structuredContent.annotation.currentEventId,
      resolved: true,
      participantId: 'mcp-live-reviewer',
      displayName: 'MCP live reviewer',
    })
    const reopenedAnnotation = await session.tool('set_scenario_annotation_resolution', {
      expectedResearchRevision: resolvedAnnotation.structuredContent.researchRevision,
      annotationId: 'source-note',
      scenarioId,
      expectedCurrentEventId: resolvedAnnotation.structuredContent.annotation.currentEventId,
      resolved: false,
      participantId: 'mcp-live-reviewer',
      displayName: 'MCP live reviewer',
    })
    const staleAnnotationResearch = await session.tool('update_scenario_annotation', {
      expectedResearchRevision: opposeVote.structuredContent.researchRevision,
      annotationId: 'source-note',
      scenarioId,
      expectedCurrentEventId: reopenedAnnotation.structuredContent.annotation.currentEventId,
      body: 'This stale research edit must not land.',
      participantId: 'mcp-live-stale-reviewer',
      displayName: 'MCP live stale reviewer',
    }, true)
    if (!staleAnnotationResearch.isError || !/Research state revision conflict/.test(staleAnnotationResearch.structuredContent?.error ?? '')) throw new Error('The live app did not reject stale research for an annotation edit')
    const staleAnnotationEvent = await session.tool('update_scenario_annotation', {
      expectedResearchRevision: reopenedAnnotation.structuredContent.researchRevision,
      annotationId: 'source-note',
      scenarioId,
      expectedCurrentEventId: createdAnnotation.structuredContent.annotation.currentEventId,
      body: 'This stale lifecycle edit must not land.',
      participantId: 'mcp-live-stale-reviewer',
      displayName: 'MCP live stale reviewer',
    }, true)
    if (!staleAnnotationEvent.isError || !/Scenario annotation revision conflict/.test(staleAnnotationEvent.structuredContent?.error ?? '')) throw new Error('The live app did not reject a stale annotation lifecycle event')
    const stateAfterAnnotations = await session.tool('inspect_research_state')
    const inspectedAnnotation = stateAfterAnnotations.structuredContent.researchState.scenarioAnnotations.items.find((item) => item.id === 'source-note' && item.scenarioId === scenarioId)
    if (reopenedAnnotation.structuredContent.annotation.status !== 'open' || reopenedAnnotation.structuredContent.annotation.eventCount !== 4) throw new Error('Annotation reopen did not retain the full lifecycle')
    if (inspectedAnnotation?.status !== 'open' || inspectedAnnotation?.eventCount !== 4 || inspectedAnnotation?.currentEventId !== reopenedAnnotation.structuredContent.annotation.currentEventId) throw new Error('Annotation lifecycle was not visible through bounded inspection')
    const labelId = `${scenarioId}-label`
    const createdLabel = await session.tool('create_scenario_label', {
      expectedResearchRevision: reopenedAnnotation.structuredContent.researchRevision,
      labelId,
      name: 'Source review',
      participantId: 'mcp-live-reviewer',
    })
    const renamedLabel = await session.tool('rename_scenario_label', {
      expectedResearchRevision: createdLabel.structuredContent.researchRevision,
      labelId,
      expectedCurrentEventId: createdLabel.structuredContent.label.currentEventId,
      name: 'Source verified',
      participantId: 'mcp-live-reviewer',
    })
    const assignedLabel = await session.tool('set_scenario_label_assignment', {
      expectedResearchRevision: renamedLabel.structuredContent.researchRevision,
      scenarioId,
      labelId,
      assigned: true,
      participantId: 'mcp-live-reviewer',
    })
    const removedLabel = await session.tool('set_scenario_label_assignment', {
      expectedResearchRevision: assignedLabel.structuredContent.researchRevision,
      scenarioId,
      labelId,
      expectedCurrentEventId: assignedLabel.structuredContent.assignment.currentEventId,
      assigned: false,
      participantId: 'mcp-live-reviewer',
    })
    const staleLabelResearch = await session.tool('rename_scenario_label', {
      expectedResearchRevision: reopenedAnnotation.structuredContent.researchRevision,
      labelId,
      expectedCurrentEventId: renamedLabel.structuredContent.label.currentEventId,
      name: 'This stale research rename must not land',
      participantId: 'mcp-live-stale-reviewer',
    }, true)
    if (!staleLabelResearch.isError || !/Research state revision conflict/.test(staleLabelResearch.structuredContent?.error ?? '')) throw new Error('The live app did not reject stale research for a label rename')
    const staleLabelEvent = await session.tool('rename_scenario_label', {
      expectedResearchRevision: removedLabel.structuredContent.researchRevision,
      labelId,
      expectedCurrentEventId: createdLabel.structuredContent.label.currentEventId,
      name: 'This stale label event must not land',
      participantId: 'mcp-live-stale-reviewer',
    }, true)
    if (!staleLabelEvent.isError || !/Scenario label revision conflict/.test(staleLabelEvent.structuredContent?.error ?? '')) throw new Error('The live app did not reject a stale label lifecycle event')
    const stateAfterLabels = await session.tool('inspect_research_state')
    const inspectedLabel = stateAfterLabels.structuredContent.researchState.scenarioLabels.items.find((item) => item.id === labelId)
    if (renamedLabel.structuredContent.label.name !== 'Source verified' || renamedLabel.structuredContent.label.eventCount !== 2) throw new Error('Label rename did not retain the full lifecycle')
    if (removedLabel.structuredContent.assignment.assigned !== false || removedLabel.structuredContent.assignment.eventCount !== 2) throw new Error('Label removal did not retain assignment history')
    if (inspectedLabel?.name !== 'Source verified' || inspectedLabel?.eventCount !== 2 || inspectedLabel?.currentEventId !== renamedLabel.structuredContent.label.currentEventId || inspectedLabel?.scenarioIds.length !== 0) throw new Error('Label lifecycle was not visible through bounded inspection')
    const saveArguments = {
      expectedDocumentRevision: readback.structuredContent.document.revision,
      participantId: 'mcp-live-harness',
      displayName: 'MCP live harness',
      note: 'Headless MCP revision checkpoint',
    }
    const previousHead = stateAfterScenario.structuredContent.researchState.versions.headVersionId
    if (previousHead) saveArguments.expectedHeadVersionId = previousHead
    const savedVersion = await session.tool('save_active_policy_version', saveArguments)
    const stateAfterSave = await session.tool('inspect_research_state')
    if (savedVersion.structuredContent.documentRevision !== readback.structuredContent.document.revision) throw new Error('Saved version was not bound to the read document revision')
    if (stateAfterSave.structuredContent.researchState.versions.headVersionId !== savedVersion.structuredContent.version.versionId) throw new Error('Saved version did not become the inspected head')
    if (stateAfterSave.structuredContent.researchState.versions.totalRecords !== researchState.structuredContent.researchState.versions.totalRecords + 1) throw new Error('Version checkpoint did not add exactly one immutable record')
    if (stateAfterSave.structuredContent.researchState.selfCheck.healthy !== true) throw new Error('Research-state integrity failed after version checkpoint')
    const diverged = await session.tool('append_active_document', {
      expectedRevision: readback.structuredContent.document.revision,
      content: '## Temporary divergence\nThis block must disappear when the earlier checkpoint is restored.',
    })
    const divergentVersion = await session.tool('save_active_policy_version', {
      expectedDocumentRevision: diverged.structuredContent.document.revision,
      expectedHeadVersionId: savedVersion.structuredContent.version.versionId,
      participantId: 'mcp-live-harness',
      displayName: 'MCP live harness',
      note: 'Temporary divergence before restore proof',
    })
    const restoredVersion = await session.tool('restore_active_policy_version', {
      targetVersionId: savedVersion.structuredContent.version.versionId,
      expectedDocumentRevision: diverged.structuredContent.document.revision,
      expectedHeadVersionId: divergentVersion.structuredContent.version.versionId,
      participantId: 'mcp-live-harness',
      displayName: 'MCP live harness',
      note: 'Packaged MCP restore proof',
    })
    const staleDocumentRestore = await session.tool('restore_active_policy_version', {
      targetVersionId: savedVersion.structuredContent.version.versionId,
      expectedDocumentRevision: diverged.structuredContent.document.revision,
      expectedHeadVersionId: restoredVersion.structuredContent.version.versionId,
      participantId: 'mcp-live-harness',
      displayName: 'MCP live harness',
    }, true)
    if (!staleDocumentRestore.isError || !/Document revision conflict/.test(staleDocumentRestore.structuredContent?.error ?? '')) {
      throw new Error('The live app did not reject stale-document MCP restore')
    }
    const staleHeadRestore = await session.tool('restore_active_policy_version', {
      targetVersionId: savedVersion.structuredContent.version.versionId,
      expectedDocumentRevision: restoredVersion.structuredContent.document.revision,
      expectedHeadVersionId: divergentVersion.structuredContent.version.versionId,
      participantId: 'mcp-live-harness',
      displayName: 'MCP live harness',
    }, true)
    if (!staleHeadRestore.isError || !/Policy version head conflict/.test(staleHeadRestore.structuredContent?.error ?? '')) {
      throw new Error('The live app did not reject stale-head MCP restore')
    }
    const restoredReadback = await session.tool('read_active_project')
    const stateAfterRestore = await session.tool('inspect_research_state')
    if (restoredVersion.structuredContent.previousDocumentRevision !== diverged.structuredContent.document.revision) {
      throw new Error('Restore was not bound to the diverged document revision')
    }
    if (restoredVersion.structuredContent.version.parentVersionId !== divergentVersion.structuredContent.version.versionId) {
      throw new Error('Restore did not append to the exact current immutable head')
    }
    if (restoredVersion.structuredContent.document.revision !== restoredReadback.structuredContent.document.revision) {
      throw new Error('Restore result and live readback revisions differ')
    }
    if (restoredReadback.structuredContent.document.text !== readback.structuredContent.document.text) {
      throw new Error('Restore did not recover the exact checkpointed semantic document')
    }
    if (restoredReadback.structuredContent.document.text.includes('Temporary divergence')) {
      throw new Error('Temporary divergence survived the restore')
    }
    if (stateAfterRestore.structuredContent.researchState.versions.headVersionId !== restoredVersion.structuredContent.version.versionId) {
      throw new Error('Restored version did not become the inspected head')
    }
    if (stateAfterRestore.structuredContent.researchState.versions.totalRecords !== researchState.structuredContent.researchState.versions.totalRecords + 3) {
      throw new Error('Checkpoint, divergence, and restore did not add exactly three immutable versions')
    }
    if (stateAfterRestore.structuredContent.researchState.selfCheck.healthy !== true) {
      throw new Error('Research-state integrity failed after packaged MCP restore')
    }
    evidence.write = {
      projectId,
      reusedProject: !!existing,
      starterRevision,
      replacedRevision,
      finalRevision: appended.structuredContent.document.revision,
      finalBlockCount: readback.structuredContent.document.blocks.length,
      staleWriteRejected: true,
      researchStateHealthy: true,
      scenarioId,
      scenarioCreateRevisionGuarded: true,
      staleScenarioCreateRejected: true,
      scenarioTurnAddAndRevisionGuarded: true,
      scenarioVoteRevisionGuarded: true,
      staleScenarioVoteRejected: true,
      scenarioAnnotationLifecycleGuarded: true,
      staleScenarioAnnotationRejected: true,
      scenarioLabelLifecycleGuarded: true,
      staleScenarioLabelRejected: true,
      restoredVersionId: restoredVersion.structuredContent.version.versionId,
      policyRestoreRevisionGuarded: true,
      staleRestoreDocumentRejected: true,
      staleRestoreHeadRejected: true,
      restoredReadbackMatchedCheckpoint: true,
      finalVersionRecords: stateAfterRestore.structuredContent.researchState.versions.totalRecords,
      heuristicRecords: researchState.structuredContent.researchState.heuristics.totalRecords,
      versionRecords: researchState.structuredContent.researchState.versions.totalRecords,
      savedVersionId: savedVersion.structuredContent.version.versionId,
      dualRevisionCheckpoint: true,
    }
  }
  evidence.passed = true
} finally {
  await session.close()
}

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
