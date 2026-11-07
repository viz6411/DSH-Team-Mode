/** Role catalog: agent.md role specs from the user directory with packaged fallback, plus CRUD for the editor. */
import { join } from 'node:path'
import { fsPromises, parseFrontmatter, serializeFrontmatter, sha1 } from './util.js'

const ROLE_ID = /^[a-z][a-z0-9-]{0,40}$/

export class RoleCatalog {
  constructor(rolesDir, packagedDir) {
    this.rolesDir = rolesDir
    this.packagedDir = packagedDir
  }

  async readDir(dir) {
    const fs = await fsPromises()
    try {
      const entries = await fs.readdir(dir)
      const out = []
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue
        try {
          const text = await fs.readFile(join(dir, entry), 'utf8')
          out.push({ id: entry.slice(0, -3), text })
        } catch {
          /* unreadable file is skipped, the rest of the catalog still loads */
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** Merged catalog: user files override packaged defaults with the same id. */
  async all() {
    const packaged = await this.readDir(this.packagedDir)
    const user = await this.readDir(this.rolesDir)
    const merged = new Map()
    for (const item of packaged) merged.set(item.id, { ...item, source: 'package', path: join(this.packagedDir, `${item.id}.md`) })
    for (const item of user) merged.set(item.id, { ...item, source: 'user', path: join(this.rolesDir, `${item.id}.md`) })
    return [...merged.values()]
  }

  async list() {
    const items = await this.all()
    return items.map((item) => {
      const { meta } = parseFrontmatter(item.text)
      return {
        id: meta.id || item.id,
        name: meta.name || item.id,
        description: meta.description || '',
        presetId: meta.presetId || `team-${item.id}`,
        source: item.source,
        path: item.path,
      }
    })
  }

  async read(roleId) {
    if (!ROLE_ID.test(String(roleId))) return null
    const items = await this.all()
    const item = items.find((candidate) => candidate.id === roleId)
    if (!item) return null
    const { meta, body } = parseFrontmatter(item.text)
    return { id: roleId, meta, body: body.trim(), source: item.source, path: item.path }
  }

  async spec(roleId) {
    const role = await this.read(roleId)
    if (!role) return null
    return {
      id: roleId,
      name: role.meta.name || roleId,
      description: role.meta.description || '',
      presetId: role.meta.presetId || `team-${roleId}`,
      deny: Array.isArray(role.meta.deny) ? role.meta.deny : [],
      allow: Array.isArray(role.meta.allow) ? role.meta.allow : [],
      text: role.body,
      hash: sha1(role.body),
      source: role.source,
    }
  }

  async write(roleId, payload) {
    if (!ROLE_ID.test(String(roleId))) return { ok: false, error: `invalid role id "${roleId}" (lowercase letters, digits, dashes)` }
    const body = typeof payload.body === 'string' ? payload.body : ''
    const meta = {
      id: roleId,
      name: String(payload.meta?.name ?? roleId),
      description: String(payload.meta?.description ?? ''),
      presetId: String(payload.meta?.presetId ?? `team-${roleId}`),
    }
    if (Array.isArray(payload.meta?.deny)) meta.deny = payload.meta.deny.map(String)
    if (Array.isArray(payload.meta?.allow)) meta.allow = payload.meta.allow.map(String)
    const fs = await fsPromises()
    try {
      await fs.mkdir(this.rolesDir, { recursive: true })
      await fs.writeFile(join(this.rolesDir, `${roleId}.md`), serializeFrontmatter(meta, body), 'utf8')
      return { ok: true, path: join(this.rolesDir, `${roleId}.md`) }
    } catch (error) {
      return { ok: false, error: `could not save role "${roleId}": ${error?.message ?? error}` }
    }
  }

  async remove(roleId) {
    if (!ROLE_ID.test(String(roleId))) return { ok: false, error: 'invalid role id' }
    const fs = await fsPromises()
    const userFile = join(this.rolesDir, `${roleId}.md`)
    try {
      await fs.unlink(userFile)
      return { ok: true, note: 'removed the user override; the packaged default applies again' }
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, error: `role "${roleId}" has no user override to remove (packaged defaults stay)` }
      return { ok: false, error: `could not remove role "${roleId}": ${error?.message ?? error}` }
    }
  }
}
