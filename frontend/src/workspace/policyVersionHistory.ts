import type * as Y from 'yjs'
import {
  commitPolicyVersion,
  readPolicyVersionLineage,
  type CommitPolicyVersionInput,
  type PolicyVersion,
  type VersionPolicyBlock,
} from './policyVersionModel'

export interface RestorePolicyVersionInput {
  targetVersionId: string
  expectedHeadVersionId: string
  participantId: string
  displayName: string
  createdAt: number
  note?: string | null
}

export type PolicyVersionChangeKind = 'added' | 'removed' | 'changed' | 'moved'

export interface PolicyVersionBlockChange {
  kind: PolicyVersionChangeKind
  identity: string
  beforeIndex: number | null
  afterIndex: number | null
  before: VersionPolicyBlock | null
  after: VersionPolicyBlock | null
}

export interface PolicyVersionDiff {
  baseVersionId: string
  targetVersionId: string
  added: number
  removed: number
  changed: number
  moved: number
  unchanged: number
  changes: PolicyVersionBlockChange[]
}

const cloneBlock = (block: VersionPolicyBlock): VersionPolicyBlock => ({ ...block })
const blockValue = (block: VersionPolicyBlock) => JSON.stringify(block)
const fnv1a = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function indexedBlocks(blocks: VersionPolicyBlock[]): Map<string, { identity: string; index: number; block: VersionPolicyBlock }> {
  const occurrences = new Map<string, number>()
  const indexed = new Map<string, { identity: string; index: number; block: VersionPolicyBlock }>()
  blocks.forEach((block, index) => {
    let matchKey: string
    let identity: string
    if (block.kind === 'policy') matchKey = identity = `policy:${block.policyId}`
    else {
      const value = blockValue(block)
      const occurrence = occurrences.get(value) ?? 0
      occurrences.set(value, occurrence + 1)
      matchKey = `content:${value}:${occurrence}`
      identity = `content:${block.kind}:${fnv1a(value)}:${occurrence}`
    }
    indexed.set(matchKey, { identity, index, block })
  })
  return indexed
}

export async function restorePolicyVersion(
  versions: Y.Map<unknown>,
  metadata: Y.Map<unknown>,
  input: RestorePolicyVersionInput,
): Promise<PolicyVersion> {
  const lineage = await readPolicyVersionLineage(versions, input.targetVersionId)
  const target = lineage?.[0]
  if (!target) throw new Error('Restore target policy version not found or has invalid lineage')
  const commit: CommitPolicyVersionInput = {
    projectId: target.projectId,
    expectedHeadVersionId: input.expectedHeadVersionId,
    blocks: target.policy.blocks.map(cloneBlock),
    scenarioIds: [...target.scenarioIds],
    participantId: input.participantId,
    displayName: input.displayName,
    createdAt: input.createdAt,
    note: input.note ?? `Restored ${target.versionId.slice(0, 12)}`,
  }
  return commitPolicyVersion(versions, metadata, commit)
}

export function diffPolicyVersions(base: PolicyVersion, target: PolicyVersion): PolicyVersionDiff {
  if (base.projectId !== target.projectId) throw new Error('Cannot diff policy versions from different projects')
  const before = indexedBlocks(base.policy.blocks)
  const after = indexedBlocks(target.policy.blocks)
  const identities = new Set([...before.keys(), ...after.keys()])
  const changes: PolicyVersionBlockChange[] = []
  let unchanged = 0
  for (const matchKey of identities) {
    const left = before.get(matchKey)
    const right = after.get(matchKey)
    let kind: PolicyVersionChangeKind | null = null
    if (!left) kind = 'added'
    else if (!right) kind = 'removed'
    else if (blockValue(left.block) !== blockValue(right.block)) kind = 'changed'
    else if (left.index !== right.index) kind = 'moved'
    else unchanged += 1
    if (kind) changes.push({
      kind,
      identity: left?.identity ?? right!.identity,
      beforeIndex: left?.index ?? null,
      afterIndex: right?.index ?? null,
      before: left ? cloneBlock(left.block) : null,
      after: right ? cloneBlock(right.block) : null,
    })
  }
  changes.sort((left, right) =>
    (left.afterIndex ?? Number.MAX_SAFE_INTEGER) - (right.afterIndex ?? Number.MAX_SAFE_INTEGER) ||
    (left.beforeIndex ?? Number.MAX_SAFE_INTEGER) - (right.beforeIndex ?? Number.MAX_SAFE_INTEGER) ||
    left.identity.localeCompare(right.identity),
  )
  return {
    baseVersionId: base.versionId,
    targetVersionId: target.versionId,
    added: changes.filter((change) => change.kind === 'added').length,
    removed: changes.filter((change) => change.kind === 'removed').length,
    changed: changes.filter((change) => change.kind === 'changed').length,
    moved: changes.filter((change) => change.kind === 'moved').length,
    unchanged,
    changes,
  }
}

export function deterministicChangeNote(diff: PolicyVersionDiff): string {
  const total = diff.added + diff.removed + diff.changed + diff.moved
  const noun = total === 1 ? 'change' : 'changes'
  return `${total} ${noun}: ${diff.added} added, ${diff.removed} removed, ${diff.changed} changed, ${diff.moved} moved; ${diff.unchanged} unchanged.`
}
