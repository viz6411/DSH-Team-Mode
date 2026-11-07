/** Per-workspace durable store for Team Mode: manager binding, role profiles, task board, event log. */
import { join } from 'node:path'
import { teamModeHome, readJson, writeJsonAtomic, fsPromises } from './util.js'

export const SCHEMA_VERSION = 1

const sanitize = (key) => String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)

export function emptyWorkspace(workspaceId, workspacePath) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceId,
    workspacePath: workspacePath ?? null,
    managerSessionId: null,
    managerHistory: [],
    profiles: [],
    tasks: [],
    events: [],
    updatedAt: new Date().toISOString(),
  }
}

export class WorkspaceStore {
  constructor(logger) {
    this.logger = logger ?? console
    this.cache = new Map()
    this.queues = new Map()
    this.dir = join(teamModeHome(), 'workspaces')
  }

  fileFor(workspaceId) {
    return join(this.dir, `${sanitize(workspaceId)}.json`)
  }

  async load(workspaceId, workspacePath) {
    if (this.cache.has(workspaceId)) return this.cache.get(workspaceId)
    const loaded = await readJson(this.fileFor(workspaceId))
    let data
    if (!loaded || loaded.__corrupt) {
      if (loaded?.__corrupt) {
        const backup = `${this.fileFor(workspaceId)}.corrupt-${Date.now()}`
        try {
          const fs = await fsPromises()
          await fs.copyFile(this.fileFor(workspaceId), backup)
          this.logger?.log?.(`dsh-team-mode: corrupt workspace file backed up to ${backup}`)
        } catch {
          /* backup best effort */
        }
      }
      data = emptyWorkspace(workspaceId, workspacePath)
    } else {
      data = { ...emptyWorkspace(workspaceId, workspacePath), ...loaded }
      data.workspacePath = workspacePath ?? data.workspacePath ?? null
    }
    this.cache.set(workspaceId, data)
    return data
  }

  /** Serialize every mutation of one workspace file; a failing write is reported, never swallowed silently. */
  async mutate(workspaceId, workspacePath, operation) {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve()
    const task = previous.then(async () => {
      const data = await this.load(workspaceId, workspacePath)
      const result = await operation(data)
      data.updatedAt = new Date().toISOString()
      const written = await writeJsonAtomic(this.fileFor(workspaceId), data)
      if (!written) this.logger?.log?.(`dsh-team-mode: failed to persist workspace ${workspaceId}`)
      return result
    })
    this.queues.set(
      workspaceId,
      task.catch(() => undefined),
    )
    return task
  }

  log(data, type, payload) {
    data.events = [...(data.events ?? []), { at: new Date().toISOString(), type, ...payload }].slice(-500)
  }
}
