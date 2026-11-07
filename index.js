/**
 * @viz/dsh-team-mode — Host core plugin.
 *
 * Owns the persistent team of one workspace: the Manager session binding, the role-profile
 * registry (long-lived continuable subagent sessions), the workspace task board with the
 * declarative stage machine, and the HTTP API consumed by the Team panel in the Web UI.
 *
 * Design decisions (see docs/ARCHITECTURE.md):
 * - A team lives in a workspace, not in one chat. Role profiles are durable sessions that survive
 *   a new Team Mode chat and a Host restart; only the active Manager session is rebound.
 * - A profile is a continuable subagent of the Manager session with a reserved child session id, so
 *   delivery cold-resumes it and the native subagent UI can open it.
 * - Human acceptance is gated on a real UI action in the Team panel, never on a Manager tool call.
 */
import { join } from 'node:path'
import { teamModeHome, newId, fsPromises } from './lib/util.js'
import { configSchema } from './lib/schema.js'
import { WorkspaceStore } from './lib/store.js'
import * as board from './lib/board.js'
import { boardView } from './lib/board.js'
import { cardTitle, cardPayload, transitionComment, cardIdOf, movePayload, toolFailure as kanbanToolFailure, hasLabel as kanbanHasLabel } from './lib/kanban.js'
import { RoleCatalog } from './lib/roles.js'
import { normalizeWorkflow, activeWorkerCount } from './lib/workflow.js'

export const name = 'team-mode'
export const inject = ['agents', 'sessions', 'subagents', 'tools']

export const Config = configSchema({
  /** Session presets that identify a Manager when a session is created with one. */
  managerPresetIds: { type: 'strings', default: ['team-manager'] },
  /** Preset id prefix of role presets (`team-<role>`). */
  presetPrefix: { type: 'string', default: 'team-' },
  /** Registered @deepseek-ai/dsh-subagent provider used to start role profiles. */
  spawnProvider: { type: 'string', default: 'spawn' },
  /** How many role agents may hold an active task at once (local-model friendly). */
  maxConcurrentWorkers: { type: 'number', default: 3 },
  maxProfiles: { type: 'number', default: 8 },
  maxTasks: { type: 'number', default: 256 },
  /** Directory of editable role agent.md files. */
  rolesDir: { type: 'string', default: join(teamModeHome(), 'roles') },
  /** Mirror board tasks into @alpacachen/dsh-kanban cards when that plugin is present. */
  kanbanSync: { type: 'boolean', default: false },
  /** Declarative workflow skeleton (stage machine). */
  workflow: {
    type: 'object',
    default: {},
    shape: {
      stages: {
        type: 'objects',
        default: [],
        shape: {
          id: { type: 'string', required: true },
          role: { type: 'string', required: true },
          requires: { type: 'strings', default: [] },
        },
      },
      humanGate: { type: 'boolean', default: true },
      reworkStage: { type: 'string', default: 'build' },
    },
  },
})

const MAX_BODY = 1024 * 1024

/** `FiberState` is a numeric const enum; the diagnostic names each row's mount state. */
const FIBER_NAMES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']

function toWorkflowConfig(config) {
  return {
    stages: config.workflow.stages,
    accept: { by: 'manager', humanGate: config.workflow.humanGate },
    rework: { onReviewReject: config.workflow.reworkStage || null },
    limits: { maxConcurrentWorkers: config.maxConcurrentWorkers },
  }
}

/** Manager-role mapping helpers are shared with @viz/dsh-team-mode/role. */
export function roleOfAgent(agent, presetPrefix) {
  const header = agent?.session?.header ?? {}
  const preset = header.agentPreset
  if (typeof preset !== 'string' || !preset.startsWith(presetPrefix)) return null
  const role = preset.slice(presetPrefix.length)
  return role === 'manager' ? null : role
}

export function isManagerAgent(agent, managerPresetIds) {
  const preset = agent?.session?.header?.agentPreset
  return typeof preset === 'string' && managerPresetIds.includes(preset)
}

export function taskView(task) {
  return {
    id: task.id,
    subject: task.subject,
    brief: task.brief,
    acceptance: task.acceptance,
    stage: task.stage,
    ownerRole: task.ownerRole,
    status: task.status,
    revision: task.revision,
    iterations: task.iterations,
    verdict: task.verdict,
    blockedBy: task.blockedBy ?? [],
    writeScopes: task.writeScopes ?? [],
    reports: (task.reports ?? []).slice(-6),
  }
}

export function taskBrief(task, created) {
  return [
    created
      ? 'You are this workspace’s persistent role profile: this task and every later one run in your own session.'
      : 'New assignment in your persistent role session.',
    `Task ${task.id} (revision ${task.revision}), stage ${task.stage}.`,
    `Subject: ${task.subject}`,
    task.brief ? `Brief: ${task.brief}` : '',
    task.acceptance
      ? `Acceptance criteria: ${task.acceptance}`
      : 'Acceptance criteria were not specified — ask the Manager with team_report (kind=question).',
    (task.writeScopes ?? []).length ? `Write scopes: ${task.writeScopes.join(', ')}` : '',
    (task.reports ?? []).length ? `Earlier stage reports: ${task.reports.map((report) => `${report.role}/${report.verdict}`).join(', ')}` : '',
    'Rules: claim with team_task_claim before working; finish with team_task_complete plus evidence; blockers and questions go to team_report. Never address the human directly.',
  ]
    .filter(Boolean)
    .join('\n')
}

export function apply(ctx, config) {
  const store = new WorkspaceStore(ctx.logger)
  const roles = new RoleCatalog(config.rolesDir, new URL('./roles/', import.meta.url).pathname)
  const workflowConfig = toWorkflowConfig(config)
  const workflow = normalizeWorkflow(workflowConfig)
  const abortSignal = () => new AbortController().signal

  /**
   * Kanban projection (spec §5.5, `kanbanSync`): the board is a human-readable mirror written
   * through the Kanban plugin's own tools, so its per-workspace rules stay with the Kanban plugin.
   * When the plugin is absent the call is skipped and Team Mode runs without it.
   */
  const kanbanCall = async (agent, toolName, args) => {
    if (!config.kanbanSync) {
      await recordPanelSignal('kanban-skipped', `${toolName}: kanbanSync is off in this profile's teamMode config`)
      return null
    }
    if (!agent) {
      await recordPanelSignal('kanban-skipped', `${toolName}: no live agent to run the projection as`)
      return null
    }
    if (!ctx.tools?.get?.(toolName, agent)) {
      await recordPanelSignal('kanban-skipped', `${toolName}: not visible to agent ${agent.id} (preset ${agent.session?.header?.agentPreset ?? 'none'})`)
      return null
    }
    try {
      const result = await ctx.tools.execute({ callId: newId('call'), name: toolName, arguments: args, agent, signal: abortSignal() })
      if (result?.isError) {
        const error = result?.error?.message ?? `${toolName} failed`
        await recordPanelSignal('kanban-error', `${toolName}: ${error}`)
        return { ok: false, error }
      }
      const refusal = kanbanToolFailure(result?.value)
      if (refusal) {
        await recordPanelSignal('kanban-refused', `${toolName}: ${refusal}`)
        return { ok: false, error: refusal }
      }
      return { ok: true, value: result?.value }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-team-mode: kanban projection "${toolName}" failed: ${error?.message ?? error}`)
      return { ok: false, error: error?.message ?? String(error) }
    }
  }

  /**
   * Kanban tools live in agent compositions, so the mirror has to run as an agent that actually sees
   * them: the caller first, then the Manager session, then any live role profile.
   */
  const mirrorCandidates = async (seedAgent, workspaceId) => {
    const out = []
    const seen = new Set()
    const push = (agent) => {
      if (!agent || seen.has(agent.id)) return
      seen.add(agent.id)
      out.push(agent)
    }
    push(seedAgent)
    const data = await dataOf(workspaceId, undefined)
    push(data.managerSessionId ? ctx.agents.get(data.managerSessionId) : null)
    for (const profile of data.profiles ?? []) push(ctx.agents.get(profile.sessionId))
    return out
  }

  let kanbanLabelReady = false
  /**
   * Card creation fails when the label the mirror tags its cards with does not exist on the board, so the
   * mirror creates that label once and falls back to an unlabelled card when the board refuses it.
   */
  const ensureKanbanLabel = async (agent) => {
    if (kanbanLabelReady) return true
    const read = await kanbanCall(agent, 'kanban_get_label', {})
    if (read?.ok && kanbanHasLabel(read.value, CARD_LABEL)) {
      kanbanLabelReady = true
      return true
    }
    const added = await kanbanCall(agent, 'kanban_add_label', { name: CARD_LABEL, color: '#7c5cff' })
    kanbanLabelReady = Boolean(added?.ok)
    return kanbanLabelReady
  }

  const mirrorCard = async (workspace, task, seedAgent) => {
    const title = cardTitle(task)
    let created = null
    let runner = null
    let lastError = null
    for (const candidate of await mirrorCandidates(seedAgent, workspace.id)) {
      const payload = cardPayload(task)
      if (!(await ensureKanbanLabel(candidate))) delete payload.label
      created = await kanbanCall(candidate, 'kanban_add_card', payload)
      if (created?.ok) { runner = candidate; break }
      lastError = created?.error ?? lastError
      created = null
    }
    if (!created) {
      const note = `kanban mirror failed: ${lastError ?? 'no agent could run the projection'}`
      await recordPanelSignal('kanban-mirror-failed', `task ${task.id}: ${note}`)
      return { kanbanNote: note }
    }
    let cardId = cardIdOf(created.value, title)
    if (!cardId) {
      const read = await kanbanCall(runner, 'kanban_get', {})
      cardId = read?.ok ? cardIdOf(read.value, title) : null
    }
    if (!cardId) {
      await recordPanelSignal('kanban-card-id-missing', `task ${task.id}: the card titled "${title}" was added but its id could not be read`)
      return { kanbanNote: 'the Kanban card was added but its id could not be read, so later transitions are not mirrored' }
    }
    await store.mutate(workspace.id, workspace.path, (data) => board.setKanbanCardId(data, task.id, cardId))
    await mirrorMove(runner, { ...task, kanbanCardId: cardId })
    return { kanbanCardId: cardId }
  }

  /** Move the mirrored card to the column its current stage or status maps to. */
  const mirrorMove = async (agent, task) => {
    if (!config.kanbanSync || !task?.kanbanCardId || !agent) return false
    const read = await kanbanCall(agent, 'kanban_get', {})
    if (!read?.ok) return false
    const move = movePayload(task, read.value?.board)
    if (!move) return false
    const moved = await kanbanCall(agent, 'kanban_move_card', move)
    return Boolean(moved?.ok)
  }

  const mirrorComment = async (workspace, task, event, seedAgent) => {
    if (!workspace || !task?.kanbanCardId) return
    for (const candidate of await mirrorCandidates(seedAgent, workspace.id)) {
      const moved = await mirrorMove(candidate, task)
      const commented = await kanbanCall(candidate, 'kanban_add_comment', { id: task.kanbanCardId, content: transitionComment(task, event) })
      if (commented) return moved
    }
  }

  /** Diagnostic trail for the browser half: the Host log is not journald here, so keep it on disk. */
  const recordPanelSignal = async (kind, detail) => {
    const fs = await fsPromises()
    try {
      await fs.mkdir(teamModeHome(), { recursive: true })
      await fs.appendFile(join(teamModeHome(), 'panel-signals.log'), `${new Date().toISOString()} ${kind} ${String(detail ?? '')}\n`, 'utf8')
    } catch {
      /* diagnostics must never break the panel API */
    }
  }

  const workspaceOfAgent = async (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || !cwd) return null
    const registry = ctx.get('workspaceRegistry')
    if (registry?.resolveByPath) {
      try {
        const workspace = await registry.resolveByPath(cwd)
        if (workspace) return workspace
      } catch {
        /* fall back to the raw cwd below */
      }
    }
    return { id: `cwd:${cwd}`, path: cwd, title: cwd }
  }

  const dataOf = async (workspaceId, workspacePath) => {
    const data = await store.load(workspaceId, workspacePath)
    data.__workflow = workflow
    data.__workflowConfig = workflowConfig
    return data
  }

  const liveStatus = (sessionId) => {
    const agent = ctx.agents?.get?.(sessionId)
    if (!agent) return 'inactive'
    const status = agent.status
    if (typeof status === 'string') return status === 'running' || status === 'busy' ? 'running' : status
    if (status && typeof status === 'object') {
      const kind = status.kind ?? status.state ?? null
      if (kind === 'running' || kind === 'busy' || kind === 'working') return 'running'
      if (kind) return String(kind)
    }
    return 'active'
  }

  const deliver = async (sender, targetSessionId, kind, text) => {
    try {
      const messageId = await ctx.subagents.sendMessage(sender, targetSessionId, [{ type: 'text', text: `[team:${kind}]\n${text}` }], {
        signal: abortSignal(),
      })
      return { ok: true, messageId }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  }

  const ensureManager = (data, agent) => {
    if (data.managerSessionId && data.managerSessionId !== agent.session.id) {
      const note = `Workspace previously had Manager session ${data.managerSessionId}; this chat is now the active Manager. Role profiles were kept.`
      board.bindManager(data, agent.session.id)
      return { ok: true, note }
    }
    board.bindManager(data, agent.session.id)
    return { ok: true }
  }

  const ensureProfile = async ({ data, role, managerAgent, brief }) => {
    const spec = await roles.spec(role)
    if (!spec) return { ok: false, error: `role "${role}" has no agent.md (${config.rolesDir}/${role}.md)` }
    const existing = board.profileOf(data, role)
    if (existing) {
      board.touchProfile(data, role, { personaHash: spec.hash })
      return { ok: true, profile: existing, created: false }
    }
    if ((data.profiles ?? []).length >= config.maxProfiles) {
      return { ok: false, error: `profile limit ${config.maxProfiles} reached for this workspace` }
    }
    if (!ctx.subagents.getProvider?.(config.spawnProvider)) {
      return { ok: false, error: `subagent provider "${config.spawnProvider}" is not registered` }
    }
    const sessionId = newId('tm')
    const presetId = spec.presetId || `${config.presetPrefix}${role}`
    try {
      const activation = await ctx.subagents.startActivation({
        provider: config.spawnProvider,
        label: role,
        childId: sessionId,
        delivery: 'caller',
        signal: abortSignal(),
        request: {
          parent: managerAgent,
          cwd: managerAgent?.session?.header?.cwd,
          agentPreset: presetId,
          prompt: [{ type: 'text', text: openingPrompt(role, brief, spec) }],
        },
      })
      const profile = board.touchProfile(data, role, { sessionId, presetId, personaHash: spec.hash, parentSessionId: managerAgent?.id ?? null })
      // The activation result is that run's eventual outcome; the profile session itself stays durable.
      Promise.resolve(activation?.result).catch(() => undefined)
      return { ok: true, profile, created: true }
    } catch (error) {
      const reason = error?.message ?? String(error)
      const limited = /limit/i.test(reason) || error?.name === 'SubagentLimitsExceeded'
      const hint = limited
        ? ` the profile's @deepseek-ai/dsh-subagent config caps active children (maxActiveSubagents), and a Team Mode workspace needs at least as many as the roles it runs at once (this plugin plans for ${config.maxConcurrentWorkers}).`
        : ''
      return { ok: false, error: `failed to start role profile "${role}": ${reason}${hint}` }
    }
  }

  const handOff = async (data, task, senderAgent) => {
    const role = task.ownerRole
    if (!role) return { ok: true, skipped: true }
    const managerAgent = data.managerSessionId ? ctx.agents.get(data.managerSessionId) : null
    // Every role profile is a direct child of the Manager session: the platform only allows a parent
    // or a direct child to message a continuable child, so keeping one parent for the whole team is
    // what makes `team_forward`, panel interrupt by parent address, and a new Manager chat reusing the
    // profiles all work. The completing role is the fallback authority when the Manager is offline.
    const liveSender = senderAgent && ctx.agents.get(senderAgent.id) === senderAgent ? senderAgent : null
    const authority = managerAgent ?? liveSender
    if (!authority) return { ok: false, error: 'no live Manager session to authorize the hand-off' }
    const brief = `${task.subject}\n${task.brief}`
    let parent = authority
    let profile = await ensureProfile({ data, role, managerAgent: authority, brief })
    if (!profile.ok) {
      // The child capacity is counted per parent session. When the Manager already holds its role
      // sessions, the new profile hangs under the role that finished the previous stage instead: the
      // chain keeps running, only the addressing of that one profile changes.
      const limited = /limit/i.test(profile.error ?? '')
      if (!limited || !liveSender || liveSender === authority) return profile
      const retry = await ensureProfile({ data, role, managerAgent: liveSender, brief })
      if (!retry.ok) return profile
      parent = liveSender
      profile = retry
    }
    const delivered = await deliver(parent, profile.profile.sessionId, 'task', taskBrief(task, profile.created))
    if (!delivered.ok) return { ok: false, error: `task ${task.id} is on the board, but delivery to "${role}" failed: ${delivered.error}` }
    return {
      ok: true,
      profileSessionId: profile.profile.sessionId,
      created: profile.created,
      handOffNote: parent === authority ? null : `role "${role}" was started under the "${parent.session?.header?.agentPreset ?? parent.id}" session because the Manager session reached its child capacity`,
    }
  }

  const snapshot = async (workspaceId, workspacePath) => {
    const data = await dataOf(workspaceId, workspacePath)
    const view = boardView(data, workflowConfig)
    view.workspacePath = data.workspacePath ?? null
    view.profiles = view.profiles.map((profile) => ({ ...profile, activity: liveStatus(profile.sessionId) }))
    view.roles = (await roles.list()).map((role) => ({ id: role.id, name: role.name, description: role.description, presetId: role.presetId }))
    view.workflow = { stages: workflow.stages, humanGate: workflow.accept.humanGate, rework: workflow.rework }
    view.activeWorkers = activeWorkerCount(data)
    view.limits = { maxConcurrentWorkers: config.maxConcurrentWorkers, maxProfiles: config.maxProfiles, maxTasks: config.maxTasks }
    return view
  }

  /**
   * A stage hand-off starts the next role profile, and the platform counts *resident* activations
   * against `maxActiveSubagents` for the whole subagent tree. A role is resident while it calls
   * `team_task_complete`, so at a low cap the next profile cannot start from inside that call. The
   * board has already moved to the next stage; the Host waits until the completing role's turn is over
   * and then repeats the same hand-off from the Manager session, which is free by then.
   */
  const deferredHandOffs = new Set()
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'teamMode.disposal')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const isCapacityRefused = (error) => /limit/i.test(String(error ?? ''))

  const scheduleHandOffRetry = (workspace, taskId, completingRole) => {
    if (!workspace?.id || !taskId || !completingRole || deferredHandOffs.has(taskId)) return { deferred: true }
    deferredHandOffs.add(taskId)
    void (async () => {
      try {
        for (let attempt = 0; attempt < 40 && !disposed; attempt += 1) {
          await sleep(3000)
          if (disposed) return
          const data = await dataOf(workspace.id, workspace.path)
          const task = board.findTask(data, taskId)
          if (!task || task.status !== 'active' || !task.ownerRole) return
          const completing = board.profileOf(data, completingRole)
          if (completing && liveStatus(completing.sessionId) === 'running') continue
          const outcome = await store.mutate(workspace.id, workspace.path, async (current) => {
            current.__workflow = workflow
            current.__workflowConfig = workflowConfig
            const held = board.findTask(current, taskId)
            if (!held || held.status !== 'active' || held.ownerRole !== task.ownerRole) return { ok: false, skipped: true }
            return await handOff(current, held, null)
          })
          if (outcome?.ok) {
            ctx.logger?.info?.(`dsh-team-mode: deferred hand-off of task ${taskId} to "${task.ownerRole}" completed`)
            const fresh = await dataOf(workspace.id, workspace.path)
            const mirrored = board.findTask(fresh, taskId)
            const managerAgent = fresh.managerSessionId ? ctx.agents.get(fresh.managerSessionId) : null
            if (mirrored && managerAgent) {
              await mirrorComment(workspace, mirrored, { kind: 'hand-off', role: completingRole, text: `hand-off to "${task.ownerRole}" completed after the "${completingRole}" turn ended` }, managerAgent)
            }
            return
          }
        }
        ctx.logger?.warn?.(`dsh-team-mode: deferred hand-off of task ${taskId} gave up; the stage stays assigned until the Manager delegates again`)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-team-mode: deferred hand-off of task ${taskId} failed: ${error?.message ?? error}`)
      } finally {
        deferredHandOffs.delete(taskId)
      }
    })()
    return { deferred: true }
  }

  const interruptProfile = (profile, managerSessionId) => {
    // A profile can always be interrupted from its own parent session address, even when the Manager
    // that runs the workflow today is not that parent.
    const parentSessionId = profile?.parentSessionId ?? managerSessionId
    try {
      const parentAgent = parentSessionId ? ctx.agents.get(parentSessionId) : null
      if (parentAgent) {
        ctx.subagents.interrupt(profile.sessionId, { kind: 'ancestor', agent: parentAgent })
      } else {
        ctx.subagents.interrupt(profile.sessionId, { kind: 'user', parentSessionId })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  }

  // ---- Manager / role tool backends ----
  const tools = {
    async delegate({ agent, subject, brief, acceptance, blockedBy, writeScopes }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const result = await store.mutate(workspace.id, workspace.path, async (data) => {
        const bound = await ensureManager(data, agent)
        const created = board.createTask(data, workflowConfig, { subject, brief, acceptance, blockedBy, writeScopes })
        if (!created.ok) return created
        const task = created.task
        let hand = { ok: true }
        if (task.status === 'active') hand = await handOff(data, task, agent)
        return {
          ok: true,
          task: taskView(task),
          queued: created.queued ?? false,
          handOffFailed: !hand.ok,
          queueReason: created.queueReason ?? null,
          note: bound.note ?? (hand.error ? `the task was created, but its first stage could not start: ${hand.error}` : null),
        }
      })
      if (result?.task) {
        const mirror = await mirrorCard(workspace, result.task, agent)
        if (mirror) Object.assign(result, mirror)
      }
      return result
    },

    async status({ agent }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      return { ok: true, ...(await snapshot(workspace.id, workspace.path)) }
    },

    async profiles({ agent }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const view = await snapshot(workspace.id, workspace.path)
      return {
        ok: true,
        profiles: view.profiles.map((profile) => ({
          role: profile.role,
          activity: profile.activity,
          presetId: profile.presetId,
          lastUsedAt: profile.lastUsedAt,
          personaDrift: profile.personaDrift,
        })),
        note: view.profiles.some((profile) => profile.personaDrift)
          ? 'Some role agent.md files changed since their profile session was created; the change applies to new profiles. Ask the user before recreating a profile.'
          : null,
      }
    },

    async interrupt({ agent, role }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const data = await dataOf(workspace.id, workspace.path)
      const profile = board.profileOf(data, role)
      if (!profile) return { ok: false, error: `role "${role}" has no profile in this workspace` }
      return interruptProfile(profile, data.managerSessionId)
    },

    async forward({ agent, role, text }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const data = await dataOf(workspace.id, workspace.path)
      const profile = board.profileOf(data, role)
      if (!profile) return { ok: false, error: `role "${role}" has no profile in this workspace` }
      if (!roleOfAgent(profile, config.presetPrefix) && !(await roles.spec(role))) return { ok: false, error: `unknown role "${role}"` }
      const delivered = await deliver(agent, profile.sessionId, 'answer', text ?? '')
      if (!delivered.ok) {
        const parent = profile.parentSessionId ?? data.managerSessionId ?? 'unknown'
        return { ...delivered, note: `the "${role}" profile was started under session ${parent}; only that session, or the role itself, can message it directly` }
      }
      return delivered
    },

    async claim({ agent, taskId, expectedRevision }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const role = roleOfAgent(agent, config.presetPrefix)
      if (!role) return { ok: false, error: 'this session is not a Team Mode role agent' }
      const claimed = await store.mutate(workspace.id, workspace.path, async (data) => {
        data.__workflow = workflow
        data.__workflowConfig = workflowConfig
        return board.claimTask(data, workflowConfig, taskId, role, expectedRevision)
      })
      if (!claimed.ok) return claimed
      await mirrorComment(workspace, claimed.task, { kind: 'claimed', role, text: `owner ${role}, revision ${claimed.task.revision}` }, agent)
      return { ok: true, task: taskView(claimed.task) }
    },

    async tasks({ agent }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const role = roleOfAgent(agent, config.presetPrefix)
      const data = await dataOf(workspace.id, workspace.path)
      const mine = (data.tasks ?? []).filter(
        (task) => task.status !== 'accepted' && task.status !== 'cancelled' && (task.ownerRole === role || task.stage === null),
      )
      return { ok: true, role, tasks: mine.map(taskView) }
    },

    async complete({ agent, taskId, report, evidence, verdict, expectedRevision }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const role = roleOfAgent(agent, config.presetPrefix)
      if (!role) return { ok: false, error: 'this session is not a Team Mode role agent' }
      const result = await store.mutate(workspace.id, workspace.path, async (data) => {
        const completed = board.completeTask(data, workflowConfig, taskId, role, { report, evidence, verdict, expectedRevision })
        if (!completed.ok) return completed
        const task = completed.task
        let hand = { ok: true }
        if (task.ownerRole && task.ownerRole !== role) {
          hand = await handOff(data, task, agent)
          if (!hand.ok && isCapacityRefused(hand.error)) {
            scheduleHandOffRetry(workspace, task.id, role)
            hand = { ok: true, note: `the "${task.ownerRole}" profile could not start while this turn was still resident; the Host retries the hand-off when this role's turn ends` }
          }
        }
        if (task.status === 'awaiting_approval') {
          const managerId = data.managerSessionId
          const managerAgent = managerId ? ctx.agents.get(managerId) : null
          if (managerAgent) {
            await deliver(agent, managerId, 'awaiting-approval', `Task ${task.id} "${task.subject}" finished every stage and needs human acceptance in the Team panel.`)
          }
        }
        return {
          ok: true,
          task: taskView(task),
          action: completed.action,
          handOffFailed: !hand.ok,
          note: hand.error ? `the stage was completed, but the next role could not be started: ${hand.error}` : null,
        }
      })
      if (result?.task) {
        await mirrorComment(workspace, result.task, { kind: result.action ?? 'completed', role, text: result.note ?? '' }, agent)
      }
      return result
    },

    async report({ agent, taskId, kind, text }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const role = roleOfAgent(agent, config.presetPrefix) ?? 'unknown'
      const result = await store.mutate(workspace.id, workspace.path, async (data) => {
        if (taskId) board.addReport(data, taskId, role, kind, text)
        const managerId = data.managerSessionId
        const managerAgent = managerId ? ctx.agents.get(managerId) : null
        if (!managerAgent) {
          return { ok: false, stored: true, error: 'no live Manager session; the note was stored on the board only' }
        }
        const delivered = await deliver(agent, managerId, kind, `role ${role}, task ${taskId ?? '-'}: ${text}`)
        return delivered.ok ? { ok: true, stored: true } : { ok: false, stored: true, error: delivered.error }
      })
      return result
    },
  }

  // ---- Panel API for @viz/dsh-team-mode/client ----
  const panel = {
    async workspaces() {
      const registry = ctx.get('workspaceRegistry')
      const items = registry?.list ? registry.list() : []
      const out = []
      for (const workspace of items) {
        const data = await dataOf(workspace.id, workspace.path)
        if (!data.managerSessionId && !(data.profiles ?? []).length && !(data.tasks ?? []).length) continue
        out.push({
          workspaceId: workspace.id,
          path: workspace.path,
          title: workspace.title ?? workspace.path,
          managerSessionId: data.managerSessionId,
          managerActivity: data.managerSessionId ? liveStatus(data.managerSessionId) : 'inactive',
          managerHistory: data.managerHistory ?? [],
          profiles: (data.profiles ?? []).length,
          openTasks: (data.tasks ?? []).filter((task) => task.status !== 'accepted' && task.status !== 'cancelled').length,
        })
      }
      return { ok: true, workspaces: out }
    },
    async snapshot(payload) {
      return { ok: true, ...(await snapshot(payload.workspaceId, payload.path)) }
    },
    async roles() {
      return { ok: true, roles: await roles.list() }
    },
    async readRole(payload) {
      const role = await roles.read(payload.roleId)
      return role ? { ok: true, role } : { ok: false, error: `role "${payload.roleId}" not found` }
    },
    async saveRole(payload) {
      return roles.write(payload.roleId, payload)
    },
    async deleteRole(payload) {
      return roles.remove(payload.roleId)
    },
    async interrupt(payload) {
      const data = await dataOf(payload.workspaceId, payload.path)
      const profile = (data.profiles ?? []).find((item) => item.sessionId === payload.sessionId || item.role === payload.role)
      if (!profile) return { ok: false, error: 'profile not found' }
      const managerAgent = data.managerSessionId ? ctx.agents.get(data.managerSessionId) : null
      return interruptProfile(profile, data.managerSessionId)
    },
    async approve(payload) {
      const result = await store.mutate(payload.workspaceId, payload.path, async (data) => {
        const approved = board.approveTask(data, payload.taskId, payload.note)
        if (!approved.ok) return approved
        const managerId = data.managerSessionId
        const managerAgent = managerId ? ctx.agents.get(managerId) : null
        if (managerAgent) {
          await deliver(managerAgent, managerId, 'approval', `The user approved task ${payload.taskId} in the Team panel. Report the outcome and continue the workflow.`)
        }
        return { ok: true, task: taskView(approved.task) }
      })
      return result
    },
    async rejectApproval(payload) {
      const result = await store.mutate(payload.workspaceId, payload.path, async (data) => {
        const rejected = board.rejectApproval(data, payload.taskId, payload.note, payload.stageId)
        if (!rejected.ok) return rejected
        let hand = await handOff(data, rejected.task, null)
        if (!hand.ok && isCapacityRefused(hand.error)) {
          scheduleHandOffRetry({ id: payload.workspaceId, path: payload.path }, rejected.task.id, 'reviewer')
          hand = { ok: true, note: `the "${rejected.task.ownerRole}" profile was refused while the board was busy; the Host retries the hand-off shortly` }
        }
        return { ok: true, task: taskView(rejected.task), note: hand.ok ? null : hand.error }
      })
      return result
    },
    async cancelTask(payload) {
      await store.mutate(payload.workspaceId, payload.path, (data) => board.cancelTask(data, payload.taskId, payload.reason))
      return { ok: true }
    },
    /** Panel keep-alive: proves on the Host side that the browser actually executed the Client half. */
    async ping(payload) {
      await recordPanelSignal('ping', payload?.detail ?? 'apply')
      ctx.logger?.info?.(`dsh-team-mode: panel client alive (${payload?.detail ?? 'apply'})`)
      return { ok: true }
    },
    /** Client-side failure report: the panel reports what threw instead of only failing silently. */
    async clientError(payload) {
      await recordPanelSignal('client-error', payload?.message ?? 'unknown')
      ctx.logger?.warn?.(`dsh-team-mode: client failure: ${payload?.message ?? 'unknown'}`)
      return { ok: true }
    },
    /**
     * Installer self-check (A2): start or reuse one role profile under a live session exactly the way
     * a delegation does, and report what the platform actually created. `parentSessionId` must be a
     * live root session of the workspace; the role child becomes its continuable subagent child, so
     * the workspace keeps that profile after an installer ran this probe.
     */
    async probeRole(payload) {
      const parentId = payload?.parentSessionId
      const parent = parentId ? ctx.agents.get(parentId) : null
      if (!parent) return { ok: false, error: `no live agent for session "${parentId}"` }
      const role = payload?.role ?? 'designer'
      const workspace = await workspaceOfAgent(parent)
      if (!workspace) return { ok: false, error: 'the parent session has no workspace path' }
      const started = Date.now()
      const outcome = await store.mutate(workspace.id, workspace.path, async (data) => {
        const ensured = await ensureProfile({
          data,
          role,
          managerAgent: parent,
          brief: payload?.brief ?? 'Installer probe: no task is assigned yet, only report the tools you can call.',
        })
        if (!ensured.ok) return ensured
        return {
            ok: true,
            created: ensured.created,
            role,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            profile: board.profileOf(data, role),
            profiles: data.profiles ?? [],
        }
      })
      await recordPanelSignal('probe-role', `${role} under ${parentId}: ${outcome?.ok ? 'ok' : outcome?.error ?? 'failed'}`)
      return { ...outcome, elapsedMs: Date.now() - started }
    },
    /**
     * Installer self-check (A6): bind a live session as the workspace Manager and run one real
     * delegation through the same `tools.delegate` backend a Manager agent calls, so an installer can
     * prove the board, profile reuse and delivery to the role session without driving a chat.
     */
    async probeDelegate(payload) {
      const parentId = payload?.parentSessionId
      const agent = parentId ? ctx.agents.get(parentId) : null
      if (!agent) return { ok: false, error: `no live agent for session "${parentId}"` }
      const outcome = await tools.delegate({
        agent,
        subject: payload?.subject ?? 'Team Mode installer probe',
        brief: payload?.brief ?? 'Claim this task, do the smallest possible work, then finish it with team_task_complete verdict pass and the evidence you produced.',
        acceptance: payload?.acceptance ?? 'The role reports what it did and how it verified it.',
      })
      await recordPanelSignal('probe-delegate', outcome?.ok ? 'ok' : outcome?.error ?? 'failed')
      return outcome
    },
    /**
     * Installer self-check (A6): run one real stage hand-off and report exactly why it worked or did
     * not. A hand-off failure is otherwise invisible — the board mutation already happened, and only
     * the note explains why the next role never started.
     */
    async probeHandOff(payload) {
      const workspaceId = payload?.workspaceId
      if (!workspaceId) return { ok: false, error: 'workspaceId is required' }
      const sender = payload?.senderSessionId ? ctx.agents.get(payload.senderSessionId) : null
      const started = Date.now()
      const outcome = await store.mutate(workspaceId, payload?.path, async (current) => {
        current.__workflow = workflow
        current.__workflowConfig = workflowConfig
        const task = board.findTask(current, payload?.taskId)
        if (!task) return { ok: false, error: `task "${payload?.taskId}" not found` }
        return await handOff(current, task, sender ?? undefined)
      })
      const data = await dataOf(workspaceId, payload?.path)
      const task = board.findTask(data, payload?.taskId)
      await recordPanelSignal('probe-handoff', `${payload?.taskId}: ${outcome?.ok ? 'ok' : outcome?.error ?? outcome?.note ?? 'failed'}`)
      return {
        ...outcome,
        elapsedMs: Date.now() - started,
        task: task ? taskView(task) : null,
        profiles: (data.profiles ?? []).map((profile) => ({
          role: profile.role,
          sessionId: profile.sessionId,
          presetId: profile.presetId,
          parentSessionId: profile.parentSessionId ?? null,
          activity: liveStatus(profile.sessionId),
        })),
      }
    },
    /**
     * Install self-check (A17): the preset roster the mode picker will actually offer, with the
     * `broken` marker the picker filters on, plus the Team Mode state on disk. This is what an
     * installer verifies after `install_bundle`, and what tells an agent why no role mode appears.
     */
    async diagnose() {
      const presets = ctx.get('agentPresets')
      const roster = await Promise.resolve(presets?.remoteExportList?.()).catch((error) => ({ error: String(error?.message ?? error) }))
      const inventory = await Promise.resolve(presets?.compositionInventory?.()).catch(() => [])
      const rows = Array.isArray(roster?.presets) ? roster.presets : []
      const compositions = (inventory ?? []).map((item) => ({
        id: item?.id ?? null,
        name: item?.name ?? null,
        isDefault: item?.isDefault ?? null,
        broken: item?.broken ?? null,
        rows: (item?.rows ?? []).map((row) => ({
          module: row?.moduleName,
          enabled: row?.enabled,
          fiber: FIBER_NAMES[row?.fiberState] ?? row?.fiberState ?? null,
        })),
      }))
      const fs = await fsPromises()
      let workspaceFiles = []
      let roleFiles = []
      try {
        workspaceFiles = await fs.readdir(join(teamModeHome(), 'workspaces'))
      } catch {
        /* no workspace has bound a Manager yet */
      }
      try {
        roleFiles = await fs.readdir(config.rolesDir)
      } catch {
        /* no role overrides written yet */
      }
      return {
        ok: true,
        managerPresetIds: config.managerPresetIds,
        liveAgents: (ctx.agents.list?.() ?? []).map((agent) => ({
          id: agent?.id ?? null,
          cwd: agent?.session?.header?.cwd ?? null,
          agentPreset: agent?.session?.header?.agentPreset ?? null,
          origin: agent?.session?.header?.origin ?? null,
        })),
        selectablePresets: rows.map((row) => ({
          id: row?.id ?? null,
          name: row?.name ?? null,
          isDefault: row?.isDefault ?? false,
          broken: row?.broken ?? null,
        })),
        teamCompositions: compositions.filter((row) => String(row.id ?? '').startsWith('team-')),
        brokenCompositions: compositions.filter((row) => row.broken),
        spawnProviderRegistered: Boolean(ctx.subagents?.getProvider?.(config.spawnProvider)),
        workspaceFiles,
        userRoleFiles: roleFiles,
      }
    },
  }

  const service = {
    version: 1,
    config,
    workflow,
    // The catalog methods are class methods: expose them bound to the catalog so a consumer can call
    // them straight off the Service without losing `this`.
    roles: {
      list: (...args) => roles.list(...args),
      read: (...args) => roles.read(...args),
      write: (...args) => roles.write(...args),
      remove: (...args) => roles.remove(...args),
      spec: (...args) => roles.spec(...args),
    },
    tools,
    panel,
    snapshot,
    store,
  }

  ctx.effect(() => ctx.provide('teamMode', service), 'teamMode')

  // Bind the Manager session of a workspace when a chat starts with a Manager preset.
  ctx.on('session/created', (session) => {
    const preset = session?.header?.agentPreset
    if (typeof preset !== 'string' || !config.managerPresetIds.includes(preset)) return
    const cwd = session?.header?.cwd
    if (!cwd) return
    const workspaceId = `cwd:${cwd}`
    const registry = ctx.get('workspaceRegistry')
    void (async () => {
      let id = workspaceId
      let path = cwd
      if (registry?.resolveByPath) {
        try {
          const workspace = await registry.resolveByPath(cwd)
          if (workspace) {
            id = workspace.id
            path = workspace.path
          }
        } catch {
          /* keep the cwd-derived id */
        }
      }
      await store.mutate(id, path, (data) => {
        board.bindManager(data, session.id)
        data.__workflow = workflow
        data.__workflowConfig = workflowConfig
        // A Manager chat reopening the workspace is the moment to surface tasks nobody is holding.
        const reopened = board.reconcileInterrupted(data, (sessionId) => Boolean(ctx.agents.get(sessionId)))
        if (reopened.length) ctx.logger?.info?.(`dsh-team-mode: ${reopened.length} task(s) need attention in workspace ${id}: ${reopened.join(', ')}`)
        return reopened
      })
    })().catch((error) => ctx.logger?.warn?.(`dsh-team-mode: manager binding failed: ${error?.message ?? error}`))
  })

  // Panel transport: authenticated package-private HTTP route, same pattern as @alpacachen/dsh-kanban.
  ctx.inject(['connection'], (routeCtx) => {
    const sendJson = (status, value) => Response.json(value, { status })
    const handler = async (request) => {
      try {
        const chunks = []
        let size = 0
        for await (const chunk of request.body ?? []) {
          size += chunk.length ?? 0
          if (size <= MAX_BODY) chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk))
        }
        if (size > MAX_BODY) return sendJson(413, { ok: false, error: 'Request body too large' })
        const contentType = (request.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (contentType !== 'application/json') return sendJson(415, { ok: false, error: 'Expected application/json' })
        const raw = Buffer.concat(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))).toString('utf8')
        const body = raw ? JSON.parse(raw) : {}
        const action = typeof body?.action === 'string' ? body.action : 'workspaces'
        const method = panel[action]
        if (!method) return sendJson(400, { ok: false, error: `unknown action "${action}"` })
        const result = await method(body)
        return sendJson(result?.ok ? 200 : 400, result)
      } catch (error) {
        return sendJson(400, { ok: false, error: error?.message ?? String(error) })
      }
    }
    const dispose = routeCtx.connection.fetch.register({
      path: '/api/team-mode',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: handler,
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })
}

function openingPrompt(role, brief, spec) {
  return [
    `You are the ${spec.name ?? role} of this workspace's team — a persistent role profile, not a one-off helper.`,
    brief ? `First assignment:\n${brief}` : 'No assignment yet: wait for a task from the Manager.',
    'Stay inside your role boundaries from your role specification.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
