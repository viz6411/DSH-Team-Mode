import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseFrontmatter, serializeFrontmatter, newId } from '../lib/util.js'
import { normalizeWorkflow, gateDelegate, gateClaim, gateComplete, gateConcurrency, activeWorkerCount } from '../lib/workflow.js'
import { WorkspaceStore, emptyWorkspace } from '../lib/store.js'
import * as board from '../lib/board.js'
import { RoleCatalog } from '../lib/roles.js'
import { cardPayload, transitionComment, cardIdOf, cardTitle, toolFailure, hasLabel } from '../lib/kanban.js'

const WORKFLOW = {
  stages: [
    { id: 'spec', role: 'designer', requires: [] },
    { id: 'build', role: 'developer', requires: ['spec'] },
    { id: 'verify', role: 'tester', requires: ['build'] },
    { id: 'review', role: 'reviewer', requires: ['verify'] },
  ],
  accept: { by: 'manager', humanGate: true },
  rework: { onReviewReject: 'build' },
  limits: { maxConcurrentWorkers: 2 },
}

test('frontmatter round-trip keeps scalar and list fields', () => {
  const text = '---\nid: developer\nname: Team Developer\ndeny: [ask_user_question, plugin_manager]\ntools:\n  - read\n  - edit\n---\n\nBody text.\n'
  const { meta, body } = parseFrontmatter(text)
  assert.equal(meta.id, 'developer')
  assert.equal(meta.name, 'Team Developer')
  assert.deepEqual(meta.deny, ['ask_user_question', 'plugin_manager'])
  assert.deepEqual(meta.tools, ['read', 'edit'])
  assert.equal(body.trim(), 'Body text.')
  const again = parseFrontmatter(serializeFrontmatter(meta, body))
  assert.deepEqual(again.meta.deny, meta.deny)
  assert.equal(again.body.trim(), 'Body text.')
})

test('workflow normalisation and delegate gate', () => {
  const workflow = normalizeWorkflow(WORKFLOW)
  assert.deepEqual(workflow.order, ['spec', 'build', 'verify', 'review'])
  assert.deepEqual(gateDelegate(workflow), { ok: true, stage: 'spec', role: 'designer' })
  assert.equal(normalizeWorkflow({ stages: [] }).firstStageId, null)
  assert.equal(gateDelegate(normalizeWorkflow({ stages: [] })).ok, false)
})

test('a full stage chain ends in human acceptance, not auto-accept', () => {
  const workflow = normalizeWorkflow(WORKFLOW)
  const data = emptyWorkspace('ws-1', '/tmp/ws-1')
  data.__workflow = workflow
  const created = board.createTask(data, WORKFLOW, { subject: 'Ship panel', brief: 'build it', acceptance: 'works' })
  assert.equal(created.ok, true)
  assert.equal(created.task.stage, 'spec')
  assert.equal(created.task.ownerRole, 'designer')

  for (const [role, next] of [['designer', 'build'], ['developer', 'verify'], ['tester', 'review']]) {
    const claimed = board.claimTask(data, WORKFLOW, created.task.id, role, created.task.revision)
    assert.equal(claimed.ok, true, `claim by ${role}`)
    const completed = board.completeTask(data, WORKFLOW, created.task.id, role, { report: 'done', evidence: 'ls', expectedRevision: claimed.task.revision })
    assert.equal(completed.ok, true)
    assert.equal(completed.task.stage, next)
    assert.equal(completed.task.ownerRole, workflow.stageById.get(next).role)
  }

  const claimed = board.claimTask(data, WORKFLOW, created.task.id, 'reviewer', created.task.revision)
  const completed = board.completeTask(data, WORKFLOW, created.task.id, 'reviewer', { report: 'ready', verdict: 'pass', expectedRevision: claimed.task.revision })
  assert.equal(completed.action, 'await_approval')
  assert.equal(completed.task.status, 'awaiting_approval')
  assert.equal(completed.task.ownerRole, null)

  const approved = board.approveTask(data, created.task.id, 'looks good')
  assert.equal(approved.ok, true)
  assert.equal(approved.task.status, 'accepted')
  assert.equal(approved.task.approvedBy, 'human')
})

test('stage ownership is enforced: a developer cannot claim the designer stage', () => {
  const data = emptyWorkspace('ws-2')
  const created = board.createTask(data, WORKFLOW, { subject: 'x' })
  const claimed = board.claimTask(data, WORKFLOW, created.task.id, 'developer', created.task.revision)
  assert.equal(claimed.ok, false)
  assert.match(claimed.error, /belongs to role "designer"/)
})

test('revision conflicts are refused instead of silently overwriting', () => {
  const data = emptyWorkspace('ws-3')
  const created = board.createTask(data, WORKFLOW, { subject: 'x' })
  const stale = board.claimTask(data, WORKFLOW, created.task.id, 'designer', created.task.revision + 5)
  assert.equal(stale.ok, false)
  assert.match(stale.error, /revision conflict/)
})

test('reviewer reject sends the task back to the configured rework stage', () => {
  const workflow = normalizeWorkflow(WORKFLOW)
  const data = emptyWorkspace('ws-4')
  data.__workflow = workflow
  const created = board.createTask(data, WORKFLOW, { subject: 'x' })
  let revision = created.task.revision
  for (const role of ['designer', 'developer', 'tester']) {
    const claimed = board.claimTask(data, WORKFLOW, created.task.id, role, revision)
    const completed = board.completeTask(data, WORKFLOW, created.task.id, role, { report: 'ok', expectedRevision: claimed.task.revision })
    revision = completed.task.revision
  }
  const claimed = board.claimTask(data, WORKFLOW, created.task.id, 'reviewer', revision)
  const rejected = board.completeTask(data, WORKFLOW, created.task.id, 'reviewer', { verdict: 'reject', report: 'two defects', expectedRevision: claimed.task.revision })
  assert.equal(rejected.action, 'rework')
  assert.equal(rejected.task.stage, 'build')
  assert.equal(rejected.task.ownerRole, 'developer')
  assert.equal(rejected.task.iterations, 1)
  assert.equal(rejected.task.status, 'active')
})

test('concurrency counts busy roles, queues the extra task and promotes it when a role frees', () => {
  const workflow = normalizeWorkflow(WORKFLOW)
  const data = emptyWorkspace('ws-5')
  data.__workflow = workflow
  const now = new Date().toISOString()
  // Two different roles already hold an active task: the limit of 2 busy roles is reached.
  data.tasks = [
    { id: 't-dev', subject: 'dev work', stage: 'build', ownerRole: 'developer', status: 'active', revision: 1, blockedBy: [], writeScopes: [], completedStages: [], reports: [], iterations: 0, createdAt: now, updatedAt: now },
    { id: 't-test', subject: 'test work', stage: 'verify', ownerRole: 'tester', status: 'active', revision: 1, blockedBy: [], writeScopes: [], completedStages: [], reports: [], iterations: 0, createdAt: now, updatedAt: now },
  ]
  assert.equal(activeWorkerCount(data), 2)
  assert.equal(gateConcurrency(workflow, data, 'reviewer').ok, false)
  // A task for an already busy role is still accepted: that role's session runs its inbox serially.
  assert.equal(gateConcurrency(workflow, data, 'developer').ok, true)

  const created = board.createTask(data, WORKFLOW, { subject: 'needs a free role' })
  assert.equal(created.task.status, 'queued')
  assert.equal(created.task.ownerRole, null)
  assert.equal(created.queued, true)

  const developerTask = data.tasks.find((task) => task.id === 't-dev')
  const completed = board.completeTask(data, WORKFLOW, 't-dev', 'developer', { report: 'ok', expectedRevision: developerTask.revision })
  assert.equal(completed.ok, true)
  const promoted = data.tasks.find((task) => task.id === created.task.id)
  assert.equal(promoted.status, 'active')
  assert.equal(promoted.ownerRole, 'designer')
})

test('human rejection of an approval returns the task to its last stage role', () => {
  const data = emptyWorkspace('ws-6')
  data.__workflow = normalizeWorkflow(WORKFLOW)
  const created = board.createTask(data, WORKFLOW, { subject: 'x' })
  let revision = created.task.revision
  for (const role of ['designer', 'developer', 'tester', 'reviewer']) {
    const claimed = board.claimTask(data, WORKFLOW, created.task.id, role, revision)
    const completed = board.completeTask(data, WORKFLOW, created.task.id, role, { report: 'ok', expectedRevision: claimed.task.revision })
    revision = completed.task.revision
  }
  assert.equal(created.task.status, 'awaiting_approval')
  const rejected = board.rejectApproval(data, created.task.id, 'not acceptable', 'verify')
  assert.equal(rejected.ok, true)
  assert.equal(rejected.task.stage, 'verify')
  assert.equal(rejected.task.ownerRole, 'tester')
  assert.equal(rejected.task.status, 'active')
})

test('workspace store persists and reloads, and survives a corrupt file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-mode-test-'))
  const store = new WorkspaceStore({ log() {} })
  store.dir = dir
  await store.mutate('ws-a', '/tmp/ws-a', (data) => {
    board.bindManager(data, 'session-1')
    board.createTask(data, WORKFLOW, { subject: 'persisted' })
    return undefined
  })
  const reloaded = await store.load('ws-a', '/tmp/ws-a')
  assert.equal(reloaded.managerSessionId, 'session-1')
  assert.equal(reloaded.tasks.length, 1)
  assert.equal(reloaded.tasks[0].subject, 'persisted')

  const { writeFileSync } = await import('node:fs')
  store.cache.clear()
  writeFileSync(join(dir, 'ws-a.json'), '{ not json')
  const recovered = await store.load('ws-a', '/tmp/ws-a')
  assert.equal(recovered.managerSessionId, null)
  assert.equal(recovered.tasks.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('role catalog merges the packaged default with a user override', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-mode-roles-'))
  const packaged = new URL('../roles/', import.meta.url).pathname
  const catalog = new RoleCatalog(dir, packaged)
  const defaults = await catalog.list()
  assert.ok(defaults.some((role) => role.id === 'manager'))
  assert.ok(defaults.some((role) => role.id === 'tester'))
  assert.equal(defaults.every((role) => role.source === 'package'), true)

  const saved = await catalog.write('tester', { meta: { name: 'QA Engineer', description: 'strict' }, body: 'New behaviour.' })
  assert.equal(saved.ok, true)
  const spec = await catalog.spec('tester')
  assert.equal(spec.source, 'user')
  assert.equal(spec.name, 'QA Engineer')
  assert.equal(spec.text, 'New behaviour.')

  const custom = await catalog.write('docs-writer', { meta: { name: 'Docs' }, body: 'Write docs.' })
  assert.equal(custom.ok, true)
  assert.equal((await catalog.list()).some((role) => role.id === 'docs-writer'), true)

  assert.equal((await catalog.write('Bad Id', { body: 'x' })).ok, false)
  const removed = await catalog.remove('tester')
  assert.equal(removed.ok, true)
  assert.equal((await catalog.spec('tester')).source, 'package')
  rmSync(dir, { recursive: true, force: true })
})

test('ids are unique and prefixed', () => {
  const a = newId('tm')
  const b = newId('tm')
  assert.match(a, /^tm-[0-9a-f-]{36}$/)
  assert.notEqual(a, b)
})

test('kanban projection payload is a readable mirror of the task', () => {
  const task = {
    id: 'task-1',
    subject: 'Add an “Ограничения” section to README',
    brief: 'Five lines about environment limits.',
    acceptance: 'Section exists and names RAM, model speed, concurrency.',
    stage: 'build',
    ownerRole: 'developer',
    status: 'active',
    iterations: 1,
    blockedBy: ['task-0'],
    writeScopes: ['README.md'],
    kanbanCardId: 'card-9',
  }
  const payload = cardPayload(task)
  assert.equal(payload.title, '[TM task-1] Add an “Ограничения” section to README')
  assert.equal(payload.assignee, 'developer')
  assert.equal(payload.label, 'team-mode')
  assert.ok(payload.note.includes('Five lines about environment limits.'))
  assert.ok(payload.note.includes('`task-0`'))
  assert.ok(payload.note.includes('README.md'))
  assert.ok(payload.note.includes('mirror'))
  assert.ok(payload.title.length <= 120 && payload.note.length <= 1900)

  const comment = transitionComment(task, { kind: 'advance', role: 'developer', text: 'stage build done' })
  assert.ok(comment.startsWith('[TM task-1] advance: in progress @ build'))
  assert.ok(comment.includes('by developer'))
  assert.ok(comment.includes('iteration 1'))
  assert.ok(comment.includes('stage build done'))
})

test('kanban projection stays off unless configured, and never invents a card id', async () => {
  const task = { id: 'task-2', subject: 'x', brief: '', acceptance: '', stage: 'spec', ownerRole: 'designer', status: 'active' }
  assert.equal(cardIdOf(undefined), null)
  assert.equal(cardIdOf({ ok: true }), null)
  assert.equal(cardIdOf({ card: { id: 'c1' } }), 'c1')
  assert.equal(cardIdOf({ id: 7 }), '7')
  assert.equal(cardPayload(task).assignee, 'designer')
})

test('the mirrored card id is stored on the task and survives a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-board-'))
  const store = new WorkspaceStore({ info() {}, warn() {} })
  store.dir = dir
  const created = await store.mutate('ws-kanban', '/tmp/ws-kanban', (data) => {
    const made = board.createTask(data, WORKFLOW, { subject: 'mirror me', brief: 'b', acceptance: 'a' })
    board.setKanbanCardId(data, made.task.id, 'card-42')
    board.setKanbanCardId(data, made.task.id, 'card-43')
    return made.task.id
  })
  const reloaded = await store.load('ws-kanban')
  const task = reloaded.tasks.find((item) => item.id === created)
  assert.equal(task.kanbanCardId, 'card-43')
  await store.mutate('ws-kanban', '/tmp/ws-kanban', (data) => board.setKanbanCardId(data, 'missing-task', 'card-1'))
  assert.equal((await store.load('ws-kanban')).tasks[0].kanbanCardId, 'card-43')
  rmSync(dir, { recursive: true, force: true })
})

test('tool results are lossless JSON: undefined keys are removed, null and finite numbers are kept', async () => {
  const { jsonValue, toolResult } = await import('../lib/json.js')
  assert.deepEqual(jsonValue({ ok: true, error: undefined, note: null, n: 3, bad: Number.NaN }), { ok: true, note: null, n: 3, bad: null })
  assert.deepEqual(jsonValue([{ a: 1, b: undefined }, undefined]), [{ a: 1 }, null])
  assert.equal(jsonValue(new Date('2026-11-07T00:00:00.000Z')), '2026-11-07T00:00:00.000Z')
  assert.equal(jsonValue(() => 1), '() => 1')
  const cycle = { ok: true }
  cycle.self = cycle
  assert.deepEqual(jsonValue(cycle), { ok: true, self: null })
  const value = toolResult({ ok: false, error: undefined, note: 'no live Manager session', task: undefined }, 'Delegation failed: no live Manager session')
  assert.deepEqual(value, { ok: false, note: 'no live Manager session', message: 'Delegation failed: no live Manager session' })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('a role profile keeps the parent session that started it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-parent-'))
  const store = new WorkspaceStore({ info() {}, warn() {} })
  store.dir = dir
  const data = await store.load('ws-parent', dir)
  board.touchProfile(data, 'developer', { sessionId: 'tm-dev', presetId: 'team-developer', personaHash: 'h1', parentSessionId: 'session-manager-1' })
  board.touchProfile(data, 'developer', { sessionId: 'tm-dev', presetId: 'team-developer', personaHash: 'h1', parentSessionId: 'session-designer' })
  board.touchProfile(data, 'tester', { sessionId: 'tm-test', presetId: 'team-tester', personaHash: 'h2', parentSessionId: 'session-developer' })
  assert.equal(data.profiles.find((profile) => profile.role === 'developer').parentSessionId, 'session-manager-1')
  assert.equal(data.profiles.find((profile) => profile.role === 'tester').parentSessionId, 'session-developer')
  const saved = await store.load('ws-parent', dir)
  assert.equal(saved.profiles.find((profile) => profile.role === 'tester').parentSessionId, 'session-developer')
  assert.equal(saved.profiles.find((profile) => profile.role === 'developer').parentSessionId, 'session-manager-1')
  rmSync(dir, { recursive: true, force: true })
})

test('the Kanban mirror maps a task stage or status onto a real board column', async () => {
  const kanban = await import('../lib/kanban.js')
  const board = { columns: [{ id: 'c1', title: 'Todo' }, { id: 'c60', title: 'Ready' }, { id: 'c2', title: 'In Progress' }, { id: 'c5', title: 'Test' }, { id: 'c3', title: 'Review' }, { id: 'c4', title: 'Done' }], completedColumnId: 'c4' }
  assert.equal(kanban.columnKeyFor({ status: 'queued', stage: 'spec' }), 'ready')
  assert.equal(kanban.columnKeyFor({ status: 'active', stage: 'build' }), 'in-progress')
  assert.equal(kanban.columnKeyFor({ status: 'active', stage: 'verify' }), 'test')
  assert.equal(kanban.columnKeyFor({ status: 'awaiting_approval', stage: null }), 'review')
  assert.equal(kanban.columnKeyFor({ status: 'accepted', stage: null }), 'done')
  assert.equal(kanban.resolveColumnId(board, 'in-progress'), 'c2')
  assert.equal(kanban.resolveColumnId(board, 'review'), 'c3')
  assert.equal(kanban.resolveColumnId(board, 'done'), 'c4')
  assert.equal(kanban.resolveColumnId({ columns: [{ id: 'x', title: 'Свои дела' }] }, 'in-progress'), null)
  // Mirrored cards live in their own lane so the board's orchestrator never pulls them into a role column.
  const laneBoard = { columns: [...board.columns, { id: 'c9', title: kanban.LANE_TITLE }] }
  assert.equal(kanban.laneColumnId(laneBoard), 'c9')
  assert.equal(kanban.laneColumnId(board), null, 'a board without the lane has no mirror column')
  assert.deepEqual(kanban.movePayload({ id: 't1', status: 'active', stage: 'verify', kanbanCardId: 'k7' }, laneBoard), { id: 'k7', columnId: 'c9' })
  assert.equal(kanban.movePayload({ id: 't1', status: 'active', stage: 'verify', kanbanCardId: 'k7' }, board), null, 'without a lane the mirror does not move the card into a role column')
  assert.equal(kanban.movePayload({ id: 't1', status: 'active', stage: 'verify' }, laneBoard), null, 'a task without a mirrored card is not moved')
  assert.equal(kanban.stageColumnTitle({ id: 't1', status: 'active', stage: 'verify', kanbanCardId: 'k7' }, board), 'Test')
  assert.ok(kanban.transitionComment({ id: 't1', status: 'active', stage: 'verify' }, { kind: 'claimed', role: 'tester' }, board).includes('stage column: Test'))
})

test('store.mutate returns exactly what its callback returns and persists the mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-mutate-'))
  const store = new WorkspaceStore({ info() {}, warn() {} })
  store.dir = dir
  const outcome = await store.mutate('ws-mutate', dir, async (data) => {
    board.touchProfile(data, 'reviewer', { sessionId: 'tm-rev', presetId: 'team-reviewer', personaHash: 'h', parentSessionId: 'session-m' })
    return { ok: true, value: 7, nested: { kept: true } }
  })
  assert.deepEqual(outcome, { ok: true, value: 7, nested: { kept: true } })
  const saved = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'ws-mutate.json'), 'utf8'))
  assert.equal(saved.profiles[0].role, 'reviewer')
  assert.equal(saved.profiles[0].parentSessionId, 'session-m')
  rmSync(dir, { recursive: true, force: true })
})

test('reconcileInterrupted only reopens tasks whose role session is not resident, once per revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-reconcile-'))
  const store = new WorkspaceStore({ info() {}, warn() {} })
  store.dir = dir
  const data = await store.load('ws-reconcile', dir)
  data.__workflow = WORKFLOW
  data.__workflowConfig = WORKFLOW
  board.touchProfile(data, 'designer', { sessionId: 'tm-designer', presetId: 'team-designer', personaHash: 'h' })
  const created = board.createTask(data, WORKFLOW, { subject: 'A', brief: 'b', acceptance: 'a' })
  assert.ok(created.ok)
  board.claimTask(data, WORKFLOW, created.task.id, 'designer', 1)
  const live = new Set(['tm-designer'])
  const isLive = (sessionId) => live.has(sessionId)
  assert.deepEqual(board.reconcileInterrupted(data, isLive), [], 'a live owner session is left alone')
  live.clear()
  const first = board.reconcileInterrupted(data, isLive)
  assert.deepEqual(first, [created.task.id])
  assert.equal(data.tasks[0].reports.at(-1).verdict, 'blocked', 'the reopened task carries a blocked report')
  assert.deepEqual(board.reconcileInterrupted(data, isLive), [], 'the same revision is not reported twice')
  const reClaimed = board.claimTask(data, WORKFLOW, created.task.id, 'designer', data.tasks[0].revision)
  assert.ok(reClaimed.ok, reClaimed.error)
  assert.deepEqual(board.reconcileInterrupted(data, isLive), [created.task.id], 'a new revision is reported again')
  rmSync(dir, { recursive: true, force: true })
})

test('the Kanban mirror treats a tool-level refusal as a failure', () => {
  assert.equal(toolFailure({ ok: false, message: 'Label not found: team-mode' }), 'Label not found: team-mode')
  assert.equal(toolFailure({ ok: false }), 'the Kanban tool refused the call')
  assert.equal(toolFailure({ ok: true, board: { cards: [] } }), null)
  assert.equal(hasLabel({ labels: [{ name: 'team-mode' }] }, 'team-mode'), true)
  assert.equal(hasLabel({ board: { labels: ['bug'] } }, 'team-mode'), false)
})

test('the mirrored card id is recovered from the board answer by its title', () => {
  const title = cardTitle({ id: 't-1', subject: 'Mirror' })
  // The Kanban tool answers with the whole board, not with the card it created.
  const value = { ok: true, message: 'Card added', board: { cards: [{ id: 'k930', title: 'unrelated' }, { id: 'k931', title }] } }
  assert.equal(cardIdOf(value, title), 'k931')
  assert.equal(cardIdOf({ ok: true, card: { id: 'k7' } }, title), 'k7')
  assert.equal(cardIdOf(value, '[TM missing] subject'), null)
})
