/**
 * One-way projection of a Team Mode task onto the workspace Kanban board (spec §5.5).
 *
 * The Kanban board is the human-readable mirror; the Host board stays authoritative. Nothing here
 * touches DSH: these are pure payload builders, so the mapping is testable without a Host.
 * The card is created once, later transitions arrive as comments on the same card.
 */

export const CARD_LABEL = 'team-mode'
export const TITLE_LIMIT = 120
export const NOTE_LIMIT = 1900

const STAGE_LABEL = {
  queued: 'queued',
  active: 'in progress',
  awaiting_approval: 'awaiting acceptance',
  accepted: 'accepted',
  cancelled: 'cancelled',
}

/** Card title: the task id stays inside the title so a human can match a card to a Team task. */
export function cardTitle(task) {
  const base = `[TM ${task.id}] ${task.subject}`
  return base.length > TITLE_LIMIT ? `${base.slice(0, TITLE_LIMIT - 1)}…` : base
}

/** Card note: the brief the role works from, plus the acceptance criteria and the DAG links. */
export function cardNote(task) {
  const lines = [
    `Team Mode task \`${task.id}\` — stage \`${task.stage}\`, owner \`${task.ownerRole ?? 'unassigned'}\`.`,
    '',
    '## Brief',
    String(task.brief ?? '').trim() || '(none)',
    '',
    '## Acceptance',
    String(task.acceptance ?? '').trim() || '(none)',
  ]
  if ((task.blockedBy ?? []).length) {
    lines.push('', `Blocked by: ${task.blockedBy.map((id) => `\`${id}\``).join(', ')}`)
  }
  if ((task.writeScopes ?? []).length) {
    lines.push('', `Write scopes: ${task.writeScopes.join(', ')}`)
  }
  lines.push('', '_The Kanban card is a mirror. Status changes are written as comments; the Team Mode board stays authoritative._')
  const note = lines.join('\n')
  return note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT - 1)}…` : note
}

/** `kanban_add_card` arguments for a freshly created task. */
export function cardPayload(task) {
  return {
    title: cardTitle(task),
    note: cardNote(task),
    assignee: task.ownerRole ?? task.stage,
    label: CARD_LABEL,
  }
}

/** Comment text for one transition of a mirrored task. */
export function transitionComment(task, event) {
  const status = STAGE_LABEL[task.status] ?? task.status
  const head = `[TM ${task.id}] ${event.kind}: ${status} @ ${task.stage}`
  const detail = String(event.text ?? '').trim()
  const suffix =
    event.role ? ` (by ${event.role}${task.iterations ? `, iteration ${task.iterations}` : ''})` : task.iterations ? ` (iteration ${task.iterations})` : ''
  const line = detail ? `${head}${suffix} — ${detail}` : `${head}${suffix}`
  return line.length > 1900 ? `${line.slice(0, 1899)}…` : line
}

/** Extract the created card id out of whatever shape the Kanban tool returned. */
export function cardIdOf(value) {
  if (!value || typeof value !== 'object') return null
  for (const candidate of [value.card?.id, value.id, value.cardId, value.task?.id]) {
    if (typeof candidate === 'string' && candidate) return candidate
    if (typeof candidate === 'number') return String(candidate)
  }
  return null
}

/**
 * Stage / status → Kanban column key. The board stays the human-facing mirror, so a Team Mode task is
 * visible in the column its workflow stage actually corresponds to.
 */
export const COLUMN_KEYS = {
  queued: 'ready',
  spec: 'ready',
  build: 'in-progress',
  verify: 'test',
  review: 'review',
  awaiting_approval: 'review',
  accepted: 'done',
  cancelled: 'done',
}

const COLUMN_ALIASES = {
  ready: ['ready', 'backlog', 'todo', 'готово', 'очередь', 'к работе'],
  'in-progress': ['in progress', 'in-progress', 'doing', 'active', 'build', 'в работе', 'делается'],
  test: ['test', 'testing', 'qa', 'verify', 'тест', 'проверка'],
  review: ['review', 'reviewing', 'acceptance', 'awaiting', 'ревью', 'приёмка'],
  done: ['done', 'accepted', 'completed', 'closed', 'готово', 'принято'],
}

/** The column key a task belongs to right now. */
export function columnKeyFor(task) {
  if (task.status === 'awaiting_approval') return COLUMN_KEYS.awaiting_approval
  if (task.status === 'accepted' || task.status === 'cancelled') return task.status === 'accepted' ? COLUMN_KEYS.accepted : COLUMN_KEYS.cancelled
  if (task.status === 'queued') return COLUMN_KEYS.queued
  return COLUMN_KEYS[task.stage] ?? COLUMN_KEYS['in-progress']
}

/**
 * Resolve a column key to a real column id from a `kanban_get` board value. Titles are matched
 * case-insensitively against the aliases; an unmatched key yields `null`, and the mirror then leaves
 * the card where it is instead of guessing a column.
 */
export function resolveColumnId(board, key) {
  const columns = Array.isArray(board?.columns) ? board.columns : []
  const aliases = COLUMN_ALIASES[key] ?? []
  for (const alias of aliases) {
    const hit = columns.find((column) => String(column?.title ?? '').trim().toLowerCase() === alias)
    if (hit) return hit.id
  }
  for (const alias of aliases) {
    const hit = columns.find((column) => String(column?.title ?? '').trim().toLowerCase().includes(alias))
    if (hit) return hit.id
  }
  return null
}

/** `kanban_move_card` arguments, or `null` when the board has no matching column. */
export function movePayload(task, board) {
  const columnId = resolveColumnId(board, columnKeyFor(task))
  if (!columnId || !task.kanbanCardId) return null
  return { id: task.kanbanCardId, columnId }
}
