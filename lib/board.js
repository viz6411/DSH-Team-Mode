/** Workspace task board and role-profile registry operations (CAS revisions, journal, gates applied by callers). */
import { newId } from './util.js'
import { gateClaim, gateComplete, gateDelegate, gateConcurrency, normalizeWorkflow } from './workflow.js'

export function boardView(data, workflowRaw) {
  const workflow = normalizeWorkflow(workflowRaw)
  return {
    workspaceId: data.workspaceId,
    managerSessionId: data.managerSessionId,
    managerHistory: data.managerHistory,
    profiles: (data.profiles ?? []).map((profile) => ({
      role: profile.role,
      sessionId: profile.sessionId,
      presetId: profile.presetId,
      createdAt: profile.createdAt,
      lastUsedAt: profile.lastUsedAt,
      personaDrift: profile.personaDrift === true,
    })),
    tasks: (data.tasks ?? []).map((task) => ({
      id: task.id,
      subject: task.subject,
      stage: task.stage,
      stageRole: workflow.stageById.get(task.stage)?.role ?? null,
      ownerRole: task.ownerRole ?? null,
      status: task.status,
      revision: task.revision,
      iterations: task.iterations ?? 0,
      blockedBy: task.blockedBy ?? [],
      verdict: task.verdict ?? null,
      acceptance: task.acceptance ?? '',
      updatedAt: task.updatedAt,
    })),
    events: (data.events ?? []).slice(-40),
  }
}

export function createTask(data, workflowRaw, input) {
  const workflow = normalizeWorkflow(workflowRaw)
  const gate = gateDelegate(workflow)
  if (!gate.ok) return { ok: false, error: gate.reason }
  const concurrency = gateConcurrency(workflow, data, gate.role)
  const now = new Date().toISOString()
  const task = {
    id: newId('t'),
    subject: String(input.subject ?? '').trim(),
    brief: String(input.brief ?? '').trim(),
    acceptance: String(input.acceptance ?? '').trim(),
    stage: gate.stage,
    status: concurrency.ok ? 'active' : 'queued',
    ownerRole: concurrency.ok ? gate.role : null,
    revision: 1,
    blockedBy: (input.blockedBy ?? []).map(String),
    writeScopes: (input.writeScopes ?? []).map(String),
    completedStages: [],
    reports: [],
    verdict: null,
    iterations: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (!task.subject) return { ok: false, error: 'subject is required' }
  data.tasks = [...(data.tasks ?? []), task]
  data.log?.(data, 'task/create', { taskId: task.id, stage: task.stage, role: task.ownerRole })
  return { ok: true, task, queued: !concurrency.ok, queueReason: concurrency.ok ? null : concurrency.reason }
}

export function findTask(data, taskId) {
  return (data.tasks ?? []).find((task) => task.id === taskId) ?? null
}

export function listTasks(data, { status, role } = {}) {
  return (data.tasks ?? []).filter((task) => (status ? task.status === status : true) && (role ? task.stage && workflowRoleOf(data, task) === role : true))
}

function workflowRoleOf(data, task) {
  const profile = null
  return profile ?? task.ownerRole ?? null
}

export function claimTask(data, workflowRaw, taskId, role, expectedRevision) {
  const workflow = normalizeWorkflow(workflowRaw)
  const task = findTask(data, taskId)
  if (!task) return { ok: false, error: `task ${taskId} not found` }
  if (expectedRevision != null && expectedRevision !== task.revision) {
    return { ok: false, error: `revision conflict: expected ${expectedRevision}, current ${task.revision}` }
  }
  const gate = gateClaim(workflow, task, role)
  if (!gate.ok) return { ok: false, error: gate.reason }
  task.status = 'active'
  task.ownerRole = role
  task.stage = gate.stage
  task.revision += 1
  task.updatedAt = new Date().toISOString()
  data.log?.(data, 'task/claim', { taskId, role, stage: gate.stage })
  return { ok: true, task }
}

export function completeTask(data, workflowRaw, taskId, role, payload = {}) {
  const workflow = normalizeWorkflow(workflowRaw)
  const task = findTask(data, taskId)
  if (!task) return { ok: false, error: `task ${taskId} not found` }
  const verdict = payload.verdict ?? 'pass'
  if (payload.expectedRevision != null && payload.expectedRevision !== task.revision) {
    return { ok: false, error: `revision conflict: expected ${payload.expectedRevision}, current ${task.revision}` }
  }
  const gate = gateComplete(workflow, task, role, verdict)
  if (!gate.ok) return { ok: false, error: gate.reason }
  task.reports = [
    ...(task.reports ?? []),
    { at: new Date().toISOString(), role, verdict, evidence: String(payload.evidence ?? '').trim(), text: String(payload.report ?? '').trim() },
  ].slice(-20)
  task.completedStages = [...(task.completedStages ?? []), task.stage]
  task.verdict = verdict
  if (gate.action === 'rework') {
    task.stage = gate.stage
    task.ownerRole = gate.role
    task.status = 'active'
    task.iterations = (task.iterations ?? 0) + 1
    data.log?.(data, 'task/rework', { taskId, role, stage: gate.stage, iterations: task.iterations })
  } else if (gate.action === 'advance') {
    task.stage = gate.stage
    task.ownerRole = gate.role
    task.status = 'active'
    data.log?.(data, 'task/advance', { taskId, role, stage: gate.stage })
  } else if (gate.action === 'await_approval') {
    task.stage = null
    task.ownerRole = null
    task.status = 'awaiting_approval'
    data.log?.(data, 'task/await_approval', { taskId, role })
  } else {
    task.stage = null
    task.ownerRole = null
    task.status = 'accepted'
    data.log?.(data, 'task/accept', { taskId, role, auto: true })
  }
  task.revision += 1
  task.updatedAt = new Date().toISOString()
  promoteQueued(data, workflowRaw)
  return { ok: true, task, action: gate.action }
}

/** Move one queued task into its stage role when a worker slot frees up. */
export function promoteQueued(data, workflowRaw) {
  const workflow = normalizeWorkflow(workflowRaw)
  const queued = (data.tasks ?? []).filter((task) => task.status === 'queued')
  for (const task of queued) {
    const stage = workflow.stageById.get(task.stage)
    if (!stage) continue
    if (!gateConcurrency(workflow, data, stage.role).ok) continue
    const blocked = (task.blockedBy ?? []).some((id) => {
      const blocker = findTask(data, id)
      return blocker && blocker.status !== 'accepted'
    })
    if (blocked) continue
    task.status = 'active'
    task.ownerRole = stage.role
    task.revision += 1
    task.updatedAt = new Date().toISOString()
    data.log?.(data, 'task/promote', { taskId: task.id, role: stage.role, stage: task.stage })
  }
  return data.tasks ?? []
}

export function approveTask(data, taskId, note) {
  const task = findTask(data, taskId)
  if (!task) return { ok: false, error: `task ${taskId} not found` }
  if (task.status !== 'awaiting_approval') return { ok: false, error: `task ${taskId} is ${task.status}, not awaiting approval` }
  task.status = 'accepted'
  task.revision += 1
  task.updatedAt = new Date().toISOString()
  task.approvedBy = 'human'
  task.approvalNote = String(note ?? '')
  data.log?.(data, 'task/approve', { taskId, by: 'human' })
  promoteQueued(data, data.__workflow)
  return { ok: true, task }
}

export function rejectApproval(data, taskId, note, stageId) {
  const task = findTask(data, taskId)
  if (!task) return { ok: false, error: `task ${taskId} not found` }
  if (task.status !== 'awaiting_approval') return { ok: false, error: `task ${taskId} is ${task.status}, not awaiting approval` }
  const target = stageId ?? task.completedStages?.[task.completedStages.length - 1] ?? data.__workflow?.stages?.[0]?.id
  const stage = data.__workflow?.stageById?.get(target)
  if (!stage) return { ok: false, error: 'no stage to send the task back to' }
  task.status = 'active'
  task.stage = stage.id
  task.ownerRole = stage.role
  task.iterations = (task.iterations ?? 0) + 1
  task.revision += 1
  task.verdict = 'reject'
  task.reports = [...(task.reports ?? []), { at: new Date().toISOString(), role: 'human', verdict: 'reject', text: String(note ?? '') }].slice(-20)
  task.completedStages = (task.completedStages ?? []).filter((id) => id !== stage.id)
  task.updatedAt = new Date().toISOString()
  data.log?.(data, 'task/reject_approval', { taskId, stage: stage.id, by: 'human' })
  return { ok: true, task }
}

export function cancelTask(data, taskId, reason) {
  const task = findTask(data, taskId)
  if (!task) return { ok: false, error: `task ${taskId} not found` }
  if (task.status === 'accepted' || task.status === 'cancelled') return { ok: false, error: `task ${taskId} is ${task.status}` }
  task.status = 'cancelled'
  task.ownerRole = null
  task.revision += 1
  task.updatedAt = new Date().toISOString()
  data.log?.(data, 'task/cancel', { taskId, reason: String(reason ?? '') })
  promoteQueued(data, data.__workflow)
  return { ok: true, task }
}

export function addReport(data, taskId, role, kind, text) {
  const task = findTask(data, taskId)
  if (!task) return { ok: false, error: `task ${taskId} not found` }
  task.reports = [...(task.reports ?? []), { at: new Date().toISOString(), role, verdict: kind, text: String(text ?? '') }].slice(-20)
  task.updatedAt = new Date().toISOString()
  data.log?.(data, 'task/report', { taskId, role, kind })
  return { ok: true, task }
}

export function touchProfile(data, role, { sessionId, presetId, personaHash }) {
  const now = new Date().toISOString()
  const existing = (data.profiles ?? []).find((profile) => profile.role === role)
  if (existing) {
    existing.lastUsedAt = now
    if (personaHash) existing.personaDrift = existing.personaHash !== personaHash
    if (existing.personaHash == null) existing.personaHash = personaHash
    return existing
  }
  const profile = { role, sessionId, presetId, createdAt: now, lastUsedAt: now, personaHash, personaDrift: false }
  data.profiles = [...(data.profiles ?? []), profile]
  data.log?.(data, 'profile/create', { role, sessionId })
  return profile
}

export function profileOf(data, role) {
  return (data.profiles ?? []).find((profile) => profile.role === role) ?? null
}

export function bindManager(data, sessionId) {
  if (data.managerSessionId === sessionId) return data
  if (data.managerSessionId && !data.managerHistory.includes(data.managerSessionId)) {
    data.managerHistory = [...data.managerHistory, data.managerSessionId]
  }
  data.managerSessionId = sessionId
  data.log?.(data, 'manager/bind', { sessionId })
  return data
}

/** Remember the Kanban card that mirrors this task (projection is one-way, spec §5.5). */
export function setKanbanCardId(data, taskId, cardId) {
  const task = findTask(data, taskId)
  if (!task || !cardId || task.kanbanCardId === cardId) return data
  task.kanbanCardId = String(cardId)
  data.log?.(data, 'task/kanban-card', { taskId: task.id, cardId: task.kanbanCardId })
  return data
}

/**
 * Reopen tasks whose owning role was not live when the team resumed (spec A10).
 *
 * A Host restart or an interrupted turn does not lose a task: the stage, the owner and the revision
 * stay in the board. What has to happen is that the *Manager* learns which tasks were left
 * unattended, so the report and the event are written once per revision: a new claim or completion
 * bumps the revision and the task becomes reconcilable again.
 */
export function reconcileInterrupted(data) {
  const reopened = []
  for (const task of data.tasks ?? []) {
    if (task.status !== 'active' || !task.ownerRole) continue
    const profile = profileOf(data, task.ownerRole)
    if (!profile) continue
    if (task.reconciledRevision === task.revision) continue
    task.reconciledRevision = task.revision
    addReport(data, task.id, task.ownerRole, 'blocked', 'the role session was not live when this workspace resumed: the task is still owned by the role, so re-brief it or wait for its queued delivery')
    data.log?.(data, 'task/reopened', { taskId: task.id, role: task.ownerRole, revision: task.revision })
    reopened.push(task.id)
  }
  return reopened
}
