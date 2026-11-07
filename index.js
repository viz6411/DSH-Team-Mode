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
import { teamModeHome, newId } from './lib/util.js'
import { configSchema } from './lib/schema.js'
import { WorkspaceStore } from './lib/store.js'
import * as board from './lib/board.js'
import { boardView } from './lib/board.js'
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
    const spec = roles.spec(role)
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
      const profile = board.touchProfile(data, role, { sessionId, presetId, personaHash: spec.hash })
      // The activation result is that run's eventual outcome; the profile session itself stays durable.
      Promise.resolve(activation?.result).catch(() => undefined)
      return { ok: true, profile, created: true }
    } catch (error) {
      return { ok: false, error: `failed to start role profile "${role}": ${error?.message ?? String(error)}` }
    }
  }

  const handOff = async (data, task, senderAgent) => {
    const role = task.ownerRole
    if (!role) return { ok: true, skipped: true }
    const managerAgent = data.managerSessionId ? ctx.agents.get(data.managerSessionId) : null
    const authority = senderAgent && ctx.agents.get(senderAgent.id) === senderAgent ? senderAgent : managerAgent
    if (!authority) return { ok: false, error: 'no live Manager session to authorize the hand-off' }
    const profile = await ensureProfile({ data, role, managerAgent: authority, brief: `${task.subject}\n${task.brief}` })
    if (!profile.ok) return profile
    const delivered = await deliver(authority, profile.profile.sessionId, 'task', taskBrief(task, profile.created))
    if (!delivered.ok) return { ok: false, error: `task ${task.id} is on the board, but delivery to "${role}" failed: ${delivered.error}` }
    return { ok: true, profileSessionId: profile.profile.sessionId, created: profile.created }
  }

  const snapshot = async (workspaceId, workspacePath) => {
    const data = await dataOf(workspaceId, workspacePath)
    const view = boardView(data, workflowConfig)
    view.workspacePath = data.workspacePath ?? null
    view.profiles = view.profiles.map((profile) => ({ ...profile, activity: liveStatus(profile.sessionId) }))
    view.roles = roles.list().map((role) => ({ id: role.id, name: role.name, description: role.description, presetId: role.presetId }))
    view.workflow = { stages: workflow.stages, humanGate: workflow.accept.humanGate, rework: workflow.rework }
    view.activeWorkers = activeWorkerCount(data)
    view.limits = { maxConcurrentWorkers: config.maxConcurrentWorkers, maxProfiles: config.maxProfiles, maxTasks: config.maxTasks }
    return view
  }

  const interruptProfile = (profileSessionId, managerAgent, managerSessionId) => {
    try {
      if (managerAgent && ctx.agents.get(managerAgent.id) === managerAgent) {
        ctx.subagents.interrupt(profileSessionId, { kind: 'ancestor', agent: managerAgent })
      } else {
        ctx.subagents.interrupt(profileSessionId, { kind: 'user', parentSessionId: managerSessionId })
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
      const data = await store.mutate(workspace.id, workspace.path, async (data) => {
        const bound = ensureManager(data, agent)
        const created = board.createTask(data, workflowConfig, { subject, brief, acceptance, blockedBy, writeScopes })
        if (!created.ok) return { data, result: created }
        const task = created.task
        let hand = { ok: true }
        if (task.status === 'active') hand = await handOff(data, task, agent)
        return {
          data,
          result: {
            ok: hand.ok,
            task: taskView(task),
            queued: created.queued,
            queueReason: created.queueReason ?? null,
            note: bound.note ?? hand.error ?? null,
          },
        }
      })
      return data.result
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
      return interruptProfile(profile.sessionId, agent, data.managerSessionId)
    },

    async forward({ agent, role, text }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const data = await dataOf(workspace.id, workspace.path)
      const profile = board.profileOf(data, role)
      if (!profile) return { ok: false, error: `role "${role}" has no profile in this workspace` }
      if (!roleOfAgent(profile, config.presetPrefix) && !roles.spec(role)) return { ok: false, error: `unknown role "${role}"` }
      return deliver(agent, profile.sessionId, 'answer', text ?? '')
    },

    async claim({ agent, taskId, expectedRevision }) {
      const workspace = await workspaceOfAgent(agent)
      if (!workspace) return { ok: false, error: 'cannot resolve the workspace of this session' }
      const role = roleOfAgent(agent, config.presetPrefix)
      if (!role) return { ok: false, error: 'this session is not a Team Mode role agent' }
      const data = await store.load(workspace.id, workspace.path)
      const claimed = board.claimTask(data, workflowConfig, taskId, role, expectedRevision)
      if (!claimed.ok) return claimed
      await store.mutate(workspace.id, workspace.path, () => undefined)
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
        if (!completed.ok) return { data, result: completed }
        const task = completed.task
        let hand = { ok: true }
        if (task.ownerRole && task.ownerRole !== role) hand = await handOff(data, task, agent)
        if (task.status === 'awaiting_approval') {
          const managerId = data.managerSessionId
          const managerAgent = managerId ? ctx.agents.get(managerId) : null
          if (managerAgent) {
            await deliver(agent, managerId, 'awaiting-approval', `Task ${task.id} "${task.subject}" finished every stage and needs human acceptance in the Team panel.`)
          }
        }
        return { data, result: { ok: hand.ok, task: taskView(task), action: completed.action, note: hand.error ?? null } }
      })
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
          return { data, result: { ok: false, stored: true, error: 'no live Manager session; the note was stored on the board only' } }
        }
        const delivered = await deliver(agent, managerId, kind, `role ${role}, task ${taskId ?? '-'}: ${text}`)
        return { data, result: delivered.ok ? { ok: true, stored: true } : { ok: false, stored: true, error: delivered.error } }
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
      return { ok: true, roles: roles.list() }
    },
    async readRole(payload) {
      const role = roles.read(payload.roleId)
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
      return interruptProfile(profile.sessionId, managerAgent, data.managerSessionId)
    },
    async approve(payload) {
      const result = await store.mutate(payload.workspaceId, payload.path, async (data) => {
        const approved = board.approveTask(data, payload.taskId, payload.note)
        if (!approved.ok) return { data, result: approved }
        const managerId = data.managerSessionId
        const managerAgent = managerId ? ctx.agents.get(managerId) : null
        if (managerAgent) {
          await deliver(managerAgent, managerId, 'approval', `The user approved task ${payload.taskId} in the Team panel. Report the outcome and continue the workflow.`)
        }
        return { data, result: { ok: true, task: taskView(approved.task) } }
      })
      return result
    },
    async rejectApproval(payload) {
      const result = await store.mutate(payload.workspaceId, payload.path, async (data) => {
        const rejected = board.rejectApproval(data, payload.taskId, payload.note, payload.stageId)
        if (!rejected.ok) return { data, result: rejected }
        const hand = await handOff(data, rejected.task, null)
        return { data, result: { ok: true, task: taskView(rejected.task), note: hand.ok ? null : hand.error } }
      })
      return result
    },
    async cancelTask(payload) {
      await store.mutate(payload.workspaceId, payload.path, (data) => board.cancelTask(data, payload.taskId, payload.reason))
      return { ok: true }
    },
  }

  const service = {
    version: 1,
    config,
    workflow,
    roles: { list: roles.list, read: roles.read, write: roles.write, remove: roles.remove, spec: roles.spec },
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
      await store.mutate(id, path, (data) => board.bindManager(data, session.id))
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
