/** Declarative workflow skeleton: stage machine, gates and rework rules. Pure functions (unit-testable). */

export const TASK_STATUSES = ['queued', 'active', 'awaiting_approval', 'accepted', 'blocked', 'cancelled']

export function normalizeWorkflow(raw) {
  const stages = (raw?.stages ?? []).map((stage) => ({
    id: String(stage.id),
    role: String(stage.role),
    requires: (stage.requires ?? []).map(String),
  }))
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const order = raw?.order?.length ? raw.order.map(String).filter((id) => stageById.has(id)) : stages.map((stage) => stage.id)
  return {
    stages,
    stageById,
    order,
    firstStageId: order[0] ?? null,
    accept: { by: raw?.accept?.by ?? 'manager', humanGate: raw?.accept?.humanGate !== false },
    rework: { onReviewReject: raw?.rework?.onReviewReject ?? null },
    limits: {
      maxConcurrentWorkers: Number.isFinite(raw?.limits?.maxConcurrentWorkers) ? Math.max(1, raw.limits.maxConcurrentWorkers) : 3,
    },
  }
}

export function stageOf(workflow, task) {
  return task.stage ? workflow.stageById.get(task.stage) ?? null : null
}

export function nextStageOf(workflow, task) {
  const index = workflow.order.indexOf(task.stage)
  if (index < 0) return null
  for (const id of workflow.order.slice(index + 1)) {
    const stage = workflow.stageById.get(id)
    if (!stage) continue
    if (stage.requires.every((required) => (task.completedStages ?? []).includes(required) || required === task.stage)) return id
  }
  return null
}

/** Manager may delegate only at the workflow's first stage. */
export function gateDelegate(workflow) {
  if (!workflow.firstStageId) return { ok: false, reason: 'workflow has no stages' }
  const stage = workflow.stageById.get(workflow.firstStageId)
  return { ok: true, stage: stage.id, role: stage.role }
}

/** A role may claim only the task whose current stage belongs to that role. */
export function gateClaim(workflow, task, role) {
  if (!task) return { ok: false, reason: 'task not found' }
  if (task.status !== 'active' && task.status !== 'queued' && task.status !== 'blocked') return { ok: false, reason: `task ${task.id} is ${task.status}` }
  const stage = stageOf(workflow, task)
  if (!stage) return { ok: false, reason: `task ${task.id} has no current stage` }
  if (stage.role !== role) return { ok: false, reason: `stage "${stage.id}" belongs to role "${stage.role}", not "${role}"` }
  if (task.ownerRole && task.ownerRole !== role) return { ok: false, reason: `task ${task.id} is owned by "${task.ownerRole}"` }
  const openBlockers = task.blockedBy ?? []
  return { ok: true, stage: stage.id }
}

/** Complete the current stage: advance, rework, or move to human acceptance. */
export function gateComplete(workflow, task, role, verdict) {
  const claimed = gateClaim(workflow, task, role)
  if (!claimed.ok) return claimed
  const stage = stageOf(workflow, task)
  const isReviewLike = verdict === 'reject' && stage?.id === workflow.rework?.onReviewReject ? false : verdict === 'reject'
  if (isReviewLike) {
    const target = workflow.rework?.onReviewReject
    if (!target || !workflow.stageById.has(target)) return { ok: false, reason: 'reject requested but rework stage is not configured' }
    return { ok: true, action: 'rework', stage: target, role: workflow.stageById.get(target).role }
  }
  const following = nextStageOf(workflow, task)
  if (following) return { ok: true, action: 'advance', stage: following, role: workflow.stageById.get(following).role }
  return { ok: true, action: workflow.accept.humanGate ? 'await_approval' : 'accept' }
}

export function activeWorkerCount(data) {
  const roles = new Set()
  for (const task of data.tasks ?? []) {
    if (task.status === 'active' && task.ownerRole) roles.add(task.ownerRole)
  }
  return roles.size
}

export function gateConcurrency(workflow, data, role) {
  if (activeWorkerCount(data) >= workflow.limits.maxConcurrentWorkers) {
    const busy = new Set((data.tasks ?? []).filter((task) => task.status === 'active').map((task) => task.ownerRole))
    if (!busy.has(role)) return { ok: false, reason: `concurrency limit ${workflow.limits.maxConcurrentWorkers} reached; the task is queued` }
  }
  return { ok: true }
}
