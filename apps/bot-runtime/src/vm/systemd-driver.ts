import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpus, totalmem } from 'node:os'
import { access, lstat, mkdir, open, rename, chmod, chown, readFile, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DESKTOP_HANDOFF_CAPABILITY, DESKTOP_LIVE_CAPABILITY, desktopGenerationSchema } from '@maestrly/host-protocol'
import type { SessionDriver, UnitState } from './supervisor.js'
import type { SessionRecord } from './catalog.js'
import { sessionDropIn, sessionPaths, sessionSlice } from './session-profile.js'
import { probeVnc } from '../desktop/vnc-server.js'

const execute = promisify(execFile)
async function command(path: string, args: string[]) {
  return execute(path, args, { timeout: 45000, maxBuffer: 128 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } })
}
export async function safeAncestors(path: string) {
  let current = path
  while (current !== '/') {
    const stat = await lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined })
    if (stat?.isSymbolicLink()) throw new Error('Symlink in session destination')
    current = dirname(current)
  }
}
export async function writeOwned(path: string, bytes: string, mode = 0o644) {
  await safeAncestors(path)
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, 'wx', mode)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  await rename(temp, path)
  const parent = await open(dirname(path), 'r')
  try { await parent.sync() } finally { await parent.close() }
}
const SERVICES_TEMPLATES = ['/etc/systemd/system/maestrly-bot-desktop-services@.service', '/etc/systemd/system/maestrly-bot-desktop-services@.socket']
function unitState(value: string): UnitState {
  if (value === 'active') return 'running'
  if (['inactive', 'failed'].includes(value)) return 'stopped'
  return 'unknown'
}
/** `systemctl show a b c --property=Id,ActiveState`: one block per unit, matched by Id. */
export function parseUnitStates(stdout: string, units: string[]): UnitState[] {
  const states = new Map<string, string>()
  for (const block of stdout.split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(block)?.[1]?.trim()
    const state = /^ActiveState=(.*)$/m.exec(block)?.[1]?.trim()
    if (id && state !== undefined) states.set(id, state)
  }
  return units.map((unit) => unitState(states.get(unit) ?? ''))
}
export class SystemdSessionDriver implements SessionDriver {
  constructor(private endpoints: (record: SessionRecord) => Promise<void>) {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('VM supervisor requires root inside Linux')
  }
  async resources() {
    const fs = await statfs('/home')
    return { memoryMiB: Math.floor(totalmem() / 1024 ** 2), cpus: cpus().length, freeDiskMiB: Math.floor(Number(fs.bavail) * Number(fs.bsize) / 1024 ** 2) }
  }
  async provision(record: SessionRecord): Promise<SessionRecord> {
    const p = sessionPaths(record)
    for (const path of [p.home, p.state, p.socketDirectory]) await safeAncestors(path)
    const account = await command('/usr/bin/getent', ['passwd', record.username]).then(r => r.stdout.trim()).catch((e: { code: number | string }) => { if (e.code !== 2) throw e; return '' })
    if (!account) {
      if (record.legacy) throw new Error('Legacy session account missing; adoption refused')
      await command('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', p.home, '--shell', '/usr/sbin/nologin', record.username])
    } else {
      const parts = account.split(':')
      if (parts[5] !== p.home || Number(parts[2]) === 0) throw new Error('Session account ownership conflict')
    }
    const uid = Number((await command('/usr/bin/id', ['-u', record.username])).stdout.trim())
    const gid = Number((await command('/usr/bin/id', ['-g', record.username])).stdout.trim())
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1 || record.uid !== undefined && record.uid !== uid || record.gid !== undefined && record.gid !== gid) throw new Error('Invalid session account')
    const groups = (await command('/usr/bin/id', ['-G', record.username])).stdout.trim().split(/\s+/).map(Number)
    if (groups.some(group => group !== gid)) throw new Error('Session account has unexpected supplementary groups')
    if (!record.legacy) for (const parent of ['/home/maestrly-sessions', '/var/lib/maestrly-sessions']) {
      await safeAncestors(parent); await mkdir(parent, { recursive: true, mode: 0o755 }); await chmod(parent, 0o755)
    }
    for (const path of [p.home, p.state, join(p.home, 'workspace')]) {
      const old = await lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined })
      if (old && (!old.isDirectory() || old.uid !== uid)) throw new Error('Session directory has unexpected ownership')
      if (!old) { await mkdir(path, { recursive: true, mode: 0o700 }); await chown(path, uid, gid) }
      await chmod(path, 0o700)
    }
    const prepared = { ...record, uid, gid }
    if (!record.legacy) {
      const installed = JSON.parse(await readFile('/opt/maestrly-bot/package.json', 'utf8'))
      await writeOwned(join(p.state, 'installed.json'), JSON.stringify({ version: installed.version }), 0o600)
      await chown(join(p.state, 'installed.json'), uid, gid)
    }
    await this.writeUnits(prepared)
    await this.endpoints(prepared)
    return prepared
  }
  private async writeUnits(record: SessionRecord) {
    const p = sessionPaths(record)
    await writeOwned(`/etc/systemd/system/${p.slice}`, sessionSlice(record))
    await writeOwned(`/etc/systemd/system/${p.runtimeUnit}.d/session.conf`, sessionDropIn(record, 'runtime'))
    await writeOwned(`/etc/systemd/system/${p.desktopUnit}.d/session.conf`, sessionDropIn(record, 'desktop'))
    await writeOwned(`/etc/systemd/system/${p.servicesUnit}.d/session.conf`, sessionDropIn(record, 'services'))
    await command('/bin/systemctl', ['daemon-reload'])
  }
  /** Rewrites generated units after an authorized package update; it starts nothing. */
  async refresh(record: SessionRecord) {
    if (!record.uid || !record.gid) return
    await this.writeUnits(record)
  }
  async start(record: SessionRecord, options: { automation?: boolean } = {}) {
    await this.endpoints(record)
    const p = sessionPaths(record)
    await command('/bin/systemctl', ['start', p.desktopUnit, p.servicesSocketUnit, p.servicesUnit, ...(options.automation === false ? [] : [p.runtimeUnit])])
  }
  /** Emergency, archive and cancellation: every component, proven by an empty slice. */
  async stop(record: SessionRecord) {
    const p = sessionPaths(record)
    await command('/bin/systemctl', ['stop', p.runtimeUnit, p.servicesUnit, p.servicesSocketUnit, p.desktopUnit])
    // Empty slice proves detached children did not survive cancellation/archival.
    await this.assertEmpty(p.slice, 'Session processes remain; stop not confirmed')
  }
  /** Human takeover: only the automation unit stops; display, browser and proxy remain. */
  async stopAutomation(record: SessionRecord) {
    const p = sessionPaths(record)
    await command('/bin/systemctl', ['stop', p.runtimeUnit])
    const state = unitState((await command('/bin/systemctl', ['show', p.runtimeUnit, '--property=ActiveState', '--value'])).stdout.trim())
    if (state !== 'stopped') throw Object.assign(new Error('Automation did not stop'), { code: 'HANDOFF_UNCERTAIN' })
    // Codex, MCP bridges, native shells and detached descendants all live in this cgroup.
    await this.assertEmpty(p.runtimeUnit, 'Automation processes remain; handoff not confirmed')
  }
  async startAutomation(record: SessionRecord) {
    await this.endpoints(record)
    const p = sessionPaths(record)
    await command('/bin/systemctl', ['start', p.runtimeUnit])
    const state = unitState((await command('/bin/systemctl', ['show', p.runtimeUnit, '--property=ActiveState', '--value'])).stdout.trim())
    if (state !== 'running') throw Object.assign(new Error('Automation did not start'), { code: 'SESSION_RESULT_UNCERTAIN' })
  }
  private async assertEmpty(unit: string, message: string) {
    const group = (await command('/bin/systemctl', ['show', unit, '--property=ControlGroup', '--value'])).stdout.trim()
    if (group && !/^\/[-a-zA-Z0-9._/@\\]+$/.test(group)) throw new Error('Unexpected session cgroup path')
    if (!group) return
    const events = await readFile(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return '' })
    if (/populated 1/.test(events)) throw Object.assign(new Error(message), { code: 'HANDOFF_UNCERTAIN' })
  }
  /** One systemctl process for the three units: this runs on the 2 s desktop timer. */
  async units(record: SessionRecord) {
    const p = sessionPaths(record)
    const names = [p.desktopUnit, p.servicesUnit, p.runtimeUnit]
    const [desktop, services, automation] = parseUnitStates((await command('/bin/systemctl', ['show', ...names, '--property=Id,ActiveState'])).stdout, names)
    return { desktop, services, automation }
  }
  async inspect(record: SessionRecord): Promise<'running' | 'stopped' | 'unknown'> {
    const units = Object.values(await this.units(record))
    if (units.every(v => v === 'running')) return 'running'
    if (units.every(v => v === 'stopped')) return 'stopped'
    return 'unknown'
  }
  async desktopGeneration(record: SessionRecord) {
    return desktopGenerationSchema.parse((await readFile(sessionPaths(record).desktopGeneration, 'utf8')).trim())
  }
  private vncProbe?: ReturnType<typeof probeVnc>
  /** Advertised only when the supervised units and a verified read-only screen server exist. */
  async capabilities(): Promise<string[]> {
    try {
      for (const path of SERVICES_TEMPLATES) await access(path, constants.R_OK)
      // The pinned binary does not change while the supervisor runs; vm.inspect is frequent
      // and each probe starts two processes. A failed probe is retried on the next call.
      this.vncProbe ??= probeVnc().catch((error) => {
        this.vncProbe = undefined
        throw error
      })
      await this.vncProbe
      await access('/usr/bin/Xvfb', constants.X_OK)
      return [DESKTOP_LIVE_CAPABILITY, DESKTOP_HANDOFF_CAPABILITY]
    } catch {
      return []
    }
  }
}
