/** Shared helpers for dsh-team-mode: ids, atomic JSON storage, role-file parsing. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const fsModule = () => (process.getBuiltinModule ? process.getBuiltinModule('node:fs') : require('node:fs'))
const fsPromises = () => (process.getBuiltinModule ? process.getBuiltinModule('node:fs/promises') : require('node:fs/promises'))

export { fsModule, fsPromises }

/** DSH home directory: $DSH_HOME or ~/.dsh (same resolution as @deepseek-ai/dsh-home-paths). */
export function dshHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim()) return override
  return join(homedir(), '.dsh')
}

export function teamModeHome() {
  return join(dshHome(), 'team-mode')
}

/** Mint a durable session-like id. DSH session ids are branded strings at type level only. */
export function newId(prefix) {
  return `${prefix}-${randomUUID()}`
}

export async function readJson(path) {
  const fs = await fsPromises()
  try {
    const text = await fs.readFile(path, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return null
    if (error instanceof SyntaxError) return { __corrupt: true, text: String(error.message) }
    throw error
  }
}

/** Atomic write: tmp file in the same directory + rename. Returns false when the write failed. */
export async function writeJsonAtomic(path, value) {
  const fs = await fsPromises()
  const dir = path.slice(0, path.lastIndexOf('/'))
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(tmp, path)
    return true
  } catch (error) {
    try {
      await fs.unlink(tmp)
    } catch {
      /* tmp already gone */
    }
    return false
  }
}

export function sha1(text) {
  // Cheap non-cryptographic content fingerprint is enough for persona-drift detection.
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

/**
 * Minimal frontmatter parser for role agent.md files.
 * Supports `key: value`, `key: [a, b]`, and block lists (`key:` then `- item` lines).
 * Values are strings, arrays of strings, or nested one-level maps for `workflow` style keys are not supported here.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { meta: {}, body: source }
  const meta = {}
  const lines = match[1].split(/\r?\n/)
  let pendingList = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      pendingList = null
      continue
    }
    if (pendingList && /^\s+-\s+/.test(line)) {
      pendingList.push(line.replace(/^\s+-\s+/, '').trim())
      continue
    }
    pendingList = null
    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]
    const value = pair[2]
    if (value === '') {
      const list = []
      meta[key] = list
      pendingList = list
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      continue
    }
    meta[key] = value.replace(/^["']|["']$/g, '')
  }
  return { meta, body: source.slice(match[0].length) }
}

export function serializeFrontmatter(meta, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.join(', ')}]`)
    else lines.push(`${key}: ${value}`)
  }
  lines.push('---', '')
  return lines.join('\n') + String(body ?? '')
}
