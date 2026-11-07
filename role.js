/**
 * @viz/dsh-team-mode/role — preset-mounted row.
 *
 * Mounted inside one role preset, it gives that preset:
 * - the role's agent.md text as persona (loaded from rolesDir with packaged fallback),
 * - the Team Mode tools the role may call (Manager set vs worker set),
 * - a tool restriction that removes delegation/plugin-management tools and, for workers,
 *   the direct question channel to the human (all escalation goes through the Manager).
 */
import { configSchema } from './lib/schema.js'
import { toolResult } from './lib/json.js'

export const name = 'team-mode-role'
export const inject = ['tools', 'systemPrompt', 'teamMode']

export const Config = configSchema({
  /** Role id from the role catalog (`<rolesDir>/<role>.md`). */
  role: { type: 'string', required: true },
})

/**
 * Tool adapter: authors keep the compact descriptor map and hand Cordis a plain tool object with
 * a JSON-Schema `parameters` map, the same shape the bundled plugins register.
 */
function toJsonSchema(shape) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(shape)) {
    const entry = { type: spec.type, description: spec.description ?? '' }
    if (Array.isArray(spec.enum)) entry.enum = spec.enum
    if (spec.items) entry.items = spec.items
    properties[key] = entry
    if (spec.required) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

const defineTool = (definition) => ({ ...definition, parameters: toJsonSchema(definition.parameters ?? {}) })

const okText = (text) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value?.message === 'string' ? value.message : text }],
})

function message(value, fallback) {
  if (typeof value?.message === 'string') return value.message
  return fallback
}

const MANAGER_DENY = ['subagent', 'subagent_fork', 'spawn_teammate', 'send_message', 'workflow', 'plugin_manager']
const WORKER_DENY = [...MANAGER_DENY, 'ask_user_question', 'exit_plan_mode']

export async function apply(ctx, config) {
  const role = config.role
  const isManager = role === 'manager'
  const spec = await ctx.teamMode.roles.spec(role)
  if (!spec) ctx.logger?.warn?.(`dsh-team-mode: role spec "${role}" not found; the preset runs with a placeholder identity`)

  // `tools.restrict()` accepts only names the host registers *globally*: an unknown name or a
  // preset-scope name is rejected, and a rejected restriction marks the whole preset broken, which
  // silently removes it from the mode picker. The deny list is therefore filtered against the live
  // tool registry, and a failed restriction degrades to a warning instead of breaking the role.
  // Boundaries that the preset itself controls (for example the worker's direct question tool) are
  // enforced by the preset YAML simply not mounting that tool.
  ctx.effect(() => {
    const wanted = isManager ? MANAGER_DENY : WORKER_DENY
    const known = new Set((ctx.tools.schemas?.() ?? []).map((schema) => schema?.name))
    const deny = wanted.filter((toolName) => known.has(toolName))
    const skipped = wanted.filter((toolName) => !known.has(toolName))
    if (skipped.length) {
      ctx.logger?.info?.(`dsh-team-mode: role "${role}" restriction skipped tools that are not global here: ${skipped.join(', ')}`)
    }
    if (!deny.length) return () => undefined
    try {
      return ctx.tools.restrict({ deny })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-team-mode: role "${role}" tool restriction failed: ${error?.message ?? error}`)
      return () => undefined
    }
  }, `teamMode.role(${role}).restrict`)

  // Persona: prefer the bundled persona package, fall back to raw prompt sections when the
  // host resolves the plugin without access to that package.
  const personaModule = await import('@deepseek-ai/dsh-persona').catch(() => null)
  ctx.effect(
    () => {
      const prefix = personaText(role, isManager, spec)
      const suffix = isManager ? managerSuffix() : workerSuffix(role)
      if (personaModule?.apply) return personaModule.apply(ctx, { prefix, suffix })
      const disposePrefix = ctx.systemPrompt.section({
        name: `team-mode:role:${role}`,
        order: sectionOrder(ctx, 'DEPLOYMENT_PERSONA_PREFIX', 30),
        text: prefix,
      })
      const disposeRules = ctx.systemPrompt.section({
        name: `team-mode:role:${role}:rules`,
        order: sectionOrder(ctx, 'DEPLOYMENT_PERSONA_SUFFIX', 40),
        text: suffix,
      })
      return () => {
        disposePrefix()
        disposeRules()
      }
    },
    `teamMode.role(${role}).persona`,
  )

  const register = (definition) => ctx.effect(() => ctx.tools.register(definition), `teamMode.role(${role}).tool(${definition.name})`)

  if (isManager) {
    register(defineTool({
      name: 'team_delegate',
      description:
        'Delegate work to a role agent of this workspace. Creates a board task at the workflow’s first stage and delivers it to that role’s persistent session. The role claims and completes the task; stages advance automatically.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Short task title.' },
        brief: { type: 'string', required: true, description: 'What to do, constraints, links to files or requirements.' },
        acceptance: { type: 'string', required: false, description: 'Objective acceptance criteria for this task.' },
        blockedBy: { type: 'array', required: false, items: { type: 'string' }, description: 'Task ids that must complete first.' },
        writeScopes: { type: 'array', required: false, items: { type: 'string' }, description: 'Paths this task is expected to modify.' },
      },
      output: okText('Task delegated.'),
      async execute(args, exec) {
        const result = await ctx.teamMode.tools.delegate({
          agent: exec.agent,
          subject: args.subject,
          brief: args.brief ?? '',
          acceptance: args.acceptance ?? '',
          blockedBy: args.blockedBy ?? [],
          writeScopes: args.writeScopes ?? [],
        })
        return toolResult(result, message(result, result.ok ? `Task ${result.task?.id} delegated to ${result.task?.ownerRole}.` : `Delegation failed: ${result.error ?? result.note}`))
      },
    }))

    register(defineTool({
      name: 'team_profiles',
      description: 'List the persistent role profiles of this workspace with their live activity (running, inactive) and persona-drift warnings.',
      parameters: {},
      output: okText('Role profiles listed.'),
      async execute(_args, exec) {
        const result = await ctx.teamMode.tools.profiles({ agent: exec.agent })
        return toolResult(result, message(result, JSON.stringify(result.profiles ?? result.error)))
      },
    }))

    register(defineTool({
      name: 'team_status',
      description: 'Read the workspace team state: workflow stages, board tasks with revisions, profiles and their activity, concurrency used.',
      parameters: {},
      output: okText('Team status read.'),
      async execute(_args, exec) {
        const result = await ctx.teamMode.tools.status({ agent: exec.agent })
        return toolResult(result, message(result, JSON.stringify({ tasks: result.tasks, profiles: result.profiles })))
      },
    }))

    register(defineTool({
      name: 'team_interrupt',
      description: 'Stop the current turn of a role agent in this workspace (its queued inbox work is preserved). Use when the user reports a problem with a running role.',
      parameters: {
        role: { type: 'string', required: true, description: 'Role whose current execution is interrupted.' },
      },
      output: okText('Interrupt requested.'),
      async execute(args, exec) {
        const result = await ctx.teamMode.tools.interrupt({ agent: exec.agent, role: args.role })
        return toolResult(result, message(result, result.ok ? `Interrupted ${args.role}.` : `Interrupt failed: ${result.error}`))
      },
    }))

    register(defineTool({
      name: 'team_forward',
      description: 'Forward the user’s answer or instruction into a role agent’s persistent session (use after resolving a question the role escalated).',
      parameters: {
        role: { type: 'string', required: true, description: 'Role to message.' },
        text: { type: 'string', required: true, description: 'Answer or instruction for the role.' },
      },
      output: okText('Message delivered to the role session.'),
      async execute(args, exec) {
        const result = await ctx.teamMode.tools.forward({ agent: exec.agent, role: args.role, text: args.text })
        return toolResult(result, message(result, result.ok ? `Delivered to ${args.role}.` : `Delivery failed: ${result.error}`))
      },
    }))
    return
  }

  register(defineTool({
    name: 'team_tasks',
    description: 'List this workspace’s open board tasks assigned to your role (id, stage, status, revision, brief, acceptance criteria, earlier reports).',
    parameters: {},
    output: okText('Tasks listed.'),
    async execute(_args, exec) {
      const result = await ctx.teamMode.tools.tasks({ agent: exec.agent })
      return toolResult(result, message(result, JSON.stringify(result.tasks ?? result.error)))
    },
  }))

  register(defineTool({
    name: 'team_task_claim',
    description: 'Claim a board task for your role before working on it. Only the task’s current stage role may claim it; a revision conflict means someone else changed it first.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Board task id.' },
      expectedRevision: { type: 'integer', required: false, description: 'Revision observed in team_tasks; guards against concurrent changes.' },
    },
    output: okText('Task claimed.'),
    async execute(args, exec) {
      const result = await ctx.teamMode.tools.claim({ agent: exec.agent, taskId: args.taskId, expectedRevision: args.expectedRevision })
      return toolResult(result, message(result, result.ok ? `Claimed ${args.taskId}.` : `Claim failed: ${result.error ?? result.note}`))
    },
  }))

  register(defineTool({
    name: 'team_task_complete',
    description:
      'Report the result of the claimed stage: verdict pass (advance to the next stage) or reject (send the task back for rework). Include proof: commands, file paths, test output. Human acceptance is a separate gate in the Team panel.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Board task id.' },
      verdict: { type: 'string', required: false, enum: ['pass', 'reject'], description: 'Default pass. reject sends the task to the rework stage.' },
      report: { type: 'string', required: true, description: 'What was done and what remains.' },
      evidence: { type: 'string', required: false, description: 'Commands run, files touched, test output, links.' },
      expectedRevision: { type: 'integer', required: false, description: 'Revision guard from team_tasks.' },
    },
    output: okText('Task stage completed.'),
    async execute(args, exec) {
      const result = await ctx.teamMode.tools.complete({
        agent: exec.agent,
        taskId: args.taskId,
        verdict: args.verdict ?? 'pass',
        report: args.report ?? '',
        evidence: args.evidence ?? '',
        expectedRevision: args.expectedRevision,
      })
      return toolResult(result, message(result, result.ok ? `Task ${args.taskId}: ${result.action}.` : `Completion rejected: ${result.error ?? result.note}`))
    },
  }))

  register(defineTool({
    name: 'team_report',
    description:
      'Send a short note to the Manager from your role session: kind=question for a decision you need, kind=blocked for a blocker you cannot resolve, kind=note for progress. The Manager answers you with team_forward.',
    parameters: {
      taskId: { type: 'string', required: false, description: 'Related board task id.' },
      kind: { type: 'string', required: true, enum: ['question', 'blocked', 'note'], description: 'What the Manager should act on.' },
      text: { type: 'string', required: true, description: 'The question, blocker or progress note.' },
    },
    output: okText('Report sent to the Manager.'),
    async execute(args, exec) {
      const result = await ctx.teamMode.tools.report({ agent: exec.agent, taskId: args.taskId, kind: args.kind, text: args.text })
      return toolResult(result, message(result, result.ok ? `Reported ${args.kind}.` : `Report stored on the board only: ${result.error}`))
    },
  }))
}

function sectionOrder(ctx, name, fallback) {
  try {
    const order = ctx.systemPrompt.getSectionOrder?.(name)
    return typeof order === 'number' && Number.isFinite(order) ? order : fallback
  } catch {
    return fallback
  }
}

function personaText(role, isManager, spec) {
  const protocol = isManager
    ? 'You are the Manager of a persistent agent team in this workspace. Roles (developer, tester, reviewer, designer, researcher) are long-lived sessions that survive chats and restarts.'
    : `You are the ${spec.name ?? role} of a persistent agent team in this workspace. Your session is your role profile: it keeps your history between tasks and chats.`
  const body = spec.text || `You are the ${spec.name ?? role}. Follow the team workflow and stay inside your specialization.`
  return `${protocol}\n\n${body}`
}

function managerSuffix() {
  return [
    'Team protocol: start every working exchange by calling team_status to see the board, then team_profiles to see which role agents exist and are busy.',
    'Delegate with team_delegate (one task per deliverable); never do the implementation yourself and never spawn subagents.',
    'When a role reports kind=question or kind=blocked, decide yourself when you can, otherwise ask the user with ask_user_question and deliver the answer with team_forward.',
    'A task reaches accepted only when the user approves it in the Team panel; your job is to get work to awaiting_approval with evidence, then report and ask the user to review it in the panel.',
    'Keep the user informed with one short line per role action ("-> developer: build X", "<- tester: 2 defects").',
  ].join('\n')
}

function workerSuffix(role) {
  return [
    `Team protocol for role "${role}": check team_tasks first and team_task_claim before doing any work.`,
    'Finish each stage with team_task_complete including evidence (commands, files, test output); use verdict reject only when the previous stage’s output is genuinely unusable.',
    'Questions and blockers go to the Manager through team_report — never to the user directly.',
    'If the user writes to you directly, answer them, then notify the Manager with team_report(kind=note) about anything that changes the task.',
  ].join('\n')
}
