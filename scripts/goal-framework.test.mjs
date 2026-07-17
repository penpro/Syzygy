import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const text = (path) => readFileSync(join(root, path), 'utf8')
const squash = (value) => value.replace(/\s+/g, ' ').trim()

test('runbook retains the unattended recovery contract', () => {
  const runbook = squash(text('docs/UNATTENDED-GOAL-FRAMEWORK.md'))
  for (const phrase of [
    'Two consecutive checks without concrete progress trigger recovery',
    'last verified Git checkpoint',
    'An unattended permission request is not a reason to wait forever',
    'If the user is interacting and the goal is paused, the supervisor does nothing',
    'The supervisor notifies the user only when recovery occurred',
    'The supervisor automation is deleted when the goal is complete',
  ]) {
    assert.ok(runbook.includes(phrase), `missing runbook clause: ${phrase}`)
  }
})

test('goal template requires scope, gates, budgets, recovery, and cleanup', () => {
  const template = text('docs/templates/UNATTENDED-GOAL.md')
  for (const heading of [
    '## Objective',
    '## Non-goals',
    '## Authority boundary',
    '## Acceptance criteria',
    '## Checkpoints',
    '## Operation budget',
    '## Recovery note',
    '## Completion record',
  ]) assert.ok(template.includes(heading), `missing ${heading}`)
  assert.match(template, /No relevant processes or temporary artifacts remain/)
})

test('supervisor prompt is quiet, read-only, and recovery-capable', () => {
  const prompt = squash(text('docs/templates/GOAL-SUPERVISOR-PROMPT.md'))
  for (const phrase of [
    'without doing repository work concurrently',
    'two consecutive one-minute checks',
    'terminate only that stale active operation',
    'preserve unrelated and user-owned changes',
    'Never wait unattended for a permission request',
    'Do not emit routine healthy updates',
    'delete this supervisor automation',
  ]) assert.ok(prompt.includes(phrase), `missing supervisor clause: ${phrase}`)
})

test('watchdog and package entry enforce the documented timing contract', () => {
  const watchdog = text('scripts/run-with-heartbeat.mjs')
  const packageJson = JSON.parse(text('frontend/package.json'))
  assert.match(watchdog, /DEFAULT_HEARTBEAT_SECONDS = 30/)
  assert.match(watchdog, /MAX_HEARTBEAT_SECONDS = 60/)
  assert.equal(
    packageJson.scripts['test:goal-framework'],
    'node --test ../scripts/goal-framework.test.mjs',
  )
})
