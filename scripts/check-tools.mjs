/**
 * Cross-check of the three halves of the bundle, without a Host:
 * - every `ctx.teamMode.tools.<name>` used by the preset-mounted role row exists in the Host core;
 * - every tool name the role row declares is wired to a backend;
 * - every panel action the Client half calls is implemented in the Host panel object.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')

const failures = []
const require = (condition, message) => {
  if (!condition) failures.push(message)
}

const host = read('index.js')
const roleRow = read('role.js')
const client = read('client.js')

/** Backend names declared in `const tools = { ... }` inside apply(). */
function objectKeys(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) return new Set()
  let depth = 0
  let index = source.indexOf('{', start)
  if (index < 0) return new Set()
  const body = []
  for (let i = index; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        body.push(source.slice(index + 1, i))
        break
      }
    }
  }
  const text = body.join('')
  const keys = new Set()
  for (const match of text.matchAll(/(?:^|\n)\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:\s*\()/g)) {
    keys.add(match[1])
  }
  return keys
}

const hostTools = objectKeys(host, 'const tools = {')
const hostPanel = objectKeys(host, 'const panel = {')

require(hostTools.size >= 8, `Host core exposes too few tool backends (${hostTools.size})`)
require(hostPanel.size >= 10, `Host panel exposes too few actions (${hostPanel.size})`)

const usedBackends = [...roleRow.matchAll(/ctx\.teamMode\.tools\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1])
require(usedBackends.length >= 9, `role row references too few backends (${usedBackends.length})`)
for (const name of new Set(usedBackends)) {
  require(hostTools.has(name), `role row calls teamMode.tools.${name}, which the Host core does not define`)
}

const declaredTools = [...roleRow.matchAll(/name:\s*'(team_[a-z_]+)'/g)].map((match) => match[1])
require(declaredTools.length === 9, `role row declares ${declaredTools.length} tools, expected 9 (${declaredTools.join(', ')})`)
for (const name of ['team_delegate', 'team_profiles', 'team_status', 'team_interrupt', 'team_forward']) {
  require(declaredTools.includes(name), `Manager tool ${name} is not declared in the role row`)
}
for (const name of ['team_tasks', 'team_task_claim', 'team_task_complete', 'team_report']) {
  require(declaredTools.includes(name), `role tool ${name} is not declared in the role row`)
}

const panelActions = new Set([...client.matchAll(/api\('([A-Za-z]+)'/g)].map((match) => match[1]))
require(panelActions.size >= 8, `Client half calls too few panel actions (${panelActions.size})`)
for (const action of panelActions) {
  require(hostPanel.has(action), `Client half calls panel action "${action}", which the Host core does not implement`)
}

if (failures.length) {
  console.error('tool and panel wiring check failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `wiring OK: ${declaredTools.length} role tools -> ${hostTools.size} Host backends; ${panelActions.size} panel actions all implemented`,
)
