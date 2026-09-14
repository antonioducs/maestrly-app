import { mkdir, readFile, rename, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HostTarget } from '../shared/types'
import { aliasValue } from './validation'

/**
 * Typed Host targets persisted in hosts.json. Legacy phase-one files (a plain array of
 * SSH aliases) are migrated in place. No discovery: a target exists only because the
 * person added it or the local Host was detected on this Mac.
 */
export function parseTargets(data: unknown): HostTarget[] {
  if (!Array.isArray(data)) return []
  const targets: HostTarget[] = []
  const safeAlias = (value: unknown) => {
    try {
      return aliasValue(value)
    } catch {
      return undefined
    }
  }
  for (const entry of data) {
    if (typeof entry === 'string') {
      const alias = safeAlias(entry)
      if (alias) targets.push({ kind: 'ssh', id: `ssh:${alias}`, alias, displayName: alias })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const hostId = typeof value.hostId === 'string' && /^[a-f0-9-]{36}$/i.test(value.hostId) ? value.hostId : undefined
    const lastConnectedAt = typeof value.lastConnectedAt === 'string' ? value.lastConnectedAt.slice(0, 40) : undefined
    const displayName = typeof value.displayName === 'string' ? value.displayName.slice(0, 80) : undefined
    if (value.kind === 'local') targets.push({ kind: 'local', id: 'local', displayName: displayName || 'Este Mac', hostId, lastConnectedAt })
    else if (value.kind === 'ssh' && typeof value.alias === 'string') {
      const alias = safeAlias(value.alias)
      if (alias) targets.push({ kind: 'ssh', id: `ssh:${alias}`, alias, displayName: displayName || alias, hostId, lastConnectedAt })
    }
  }
  return [...new Map(targets.map((t) => [t.id, t])).values()]
}
export class HostTargets {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}
  async list(): Promise<HostTarget[]> {
    try {
      return parseTargets(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      return []
    }
  }
  async get(id: string): Promise<HostTarget | undefined> {
    return (await this.list()).find((t) => t.id === id)
  }
  async upsert(target: HostTarget): Promise<HostTarget> {
    const targets = (await this.list()).filter((t) => t.id !== target.id)
    await this.save([...targets, target])
    return target
  }
  async remove(id: string) {
    await this.save((await this.list()).filter((t) => t.id !== id))
  }
  private save(targets: HostTarget[]) {
    const snapshot = JSON.stringify(targets)
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      const handle = await open(temp, 'w', 0o600)
      try {
        await handle.writeFile(snapshot)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, this.file)
    })
    this.writes = write.catch(() => {})
    return write
  }
}
