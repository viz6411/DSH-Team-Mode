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
export function transitionComment(task, event, board) {
  const status = STAGE_LABEL[task.status] ?? task.status
  const stageColumn = board ? stageColumnTitle(task, board) : null
  const head = `[TM ${task.id}] ${event.kind}: ${status} @ ${task.stage}${stageColumn ? ` (stage column: ${stageColumn})` : ''}`
  const detail = String(event.text ?? '').trim()
  const suffix =
    event.role ? ` (by ${event.role}${task.iterations ? `, iteration ${task.iterations}` : ''})` : task.iterations ? ` (iteration ${task.iterations})` : ''
  const line = detail ? `${head}${suffix} — ${detail}` : `${head}${suffix}`
  return line.length > 1900 ? `${line.slice(0, 1899)}…` : line
}

/** Extract the created card id out of whatever shape the Kanban tool returned. */
export function cardIdOf(value, matchTitle) {
  if (!value || typeof value !== 'object') return null
  for (const candidate of [value.card?.id, value.id, value.cardId]) {
    if (typeof candidate === 'string' && candidate) return candidate
    if (typeof candidate === 'number') return String(candidate)
  }
  // The Kanban tool answer carries the whole board rather than the card it changed, so the card has
  // to be found by the title the mirror wrote. Without this the id is never recorded and every later
  // transition comment is silently skipped.
  if (typeof matchTitle === 'string' && matchTitle) {
    const lists = [value.board?.cards, value.cards, value.board?.board?.cards]
    for (const cards of lists) {
      if (!Array.isArray(cards)) continue
      const hit = cards.find((card) => typeof card?.title === 'string' && card.title === matchTitle)
      if (hit && (typeof hit.id === 'string' || typeof hit.id === 'number')) return String(hit.id)
    }
  }
  return null
}

/**
 * The Kanban tools answer with `ok: false` inside the tool *value* (for example "Label not found"),
 * which is a refusal, not a success: treating it as success hides the mirror's failures.
 */
export function toolFailure(value) {
  if (value && typeof value === 'object' && value.ok === false) {
    return typeof value.message === 'string' && value.message ? value.message : 'the Kanban tool refused the call'
  }
  return null
}

/** Does the board already carry the mirror's own label? Card creation fails without it. */
export function hasLabel(value, name) {
  const labels = value?.labels ?? value?.board?.labels ?? []
  return Array.isArray(labels) && labels.some((label) => (typeof label === 'string' ? label : label?.name) === name)
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
/**
 * The board's own automation pulls cards out of its configured source column, moves them into the entry
 * column and starts a role session for that column's role. A Team Mode mirror must not feed that engine,
 * or the board would start workers that Team Mode does not own. Mirrored cards therefore live in one
 * lane of their own, and the stage is carried in the comment.
 */
export const LANE_TITLE = 'Team Mode'

/** The mirror lane column, or null when the board does not have one yet. */
export function laneColumnId(board) {
  if (!board || !Array.isArray(board.columns)) return null
  const hit = board.columns.find((column) => String(column?.title ?? '').trim() === LANE_TITLE)
  return hit ? String(hit.id) : null
}

export function movePayload(task, board) {
  const columnId = laneColumnId(board)
  if (!columnId || !task.kanbanCardId) return null
  return { id: task.kanbanCardId, columnId }
}

/** The human-facing column this stage would belong to, named in the transition comment. */
export function stageColumnTitle(task, board) {
  const columnId = resolveColumnId(board, columnKeyFor(task))
  if (!columnId || !Array.isArray(board?.columns)) return null
  const column = board.columns.find((item) => String(item?.id) === String(columnId))
  return column ? String(column.title ?? '') : null
}
