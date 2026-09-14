import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpus, totalmem } from 'node:os'
import { lstat, mkdir, open, rename, chmod, chown, readFile, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionDriver } from './supervisor.js'
import type { SessionRecord } from './catalog.js'
import { sessionDropIn, sessionPaths, sessionSlice } from './session-profile.js'

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
    await writeOwned(`/etc/systemd/system/${p.slice}`, sessionSlice(prepared))
    await writeOwned(`/etc/systemd/system/${p.runtimeUnit}.d/session.conf`, sessionDropIn(prepared, false))
    await writeOwned(`/etc/systemd/system/${p.desktopUnit}.d/session.conf`, sessionDropIn(prepared, true))
    await command('/bin/systemctl', ['daemon-reload'])
    await this.endpoints(prepared)
    return prepared
  }
  async start(record: SessionRecord) {
    await this.endpoints(record)
    const p = sessionPaths(record)
    await command('/bin/systemctl', ['start', p.runtimeUnit])
  }
  async stop(record: SessionRecord) {
    const p = sessionPaths(record)
    await command('/bin/systemctl', ['stop', p.runtimeUnit, p.desktopUnit])
    // Empty slice proves detached children did not survive cancellation/archival.
    const group = (await command('/bin/systemctl', ['show', p.slice, '--property=ControlGroup', '--value'])).stdout.trim()
    if (group && !/^\/[-a-zA-Z0-9._/]+$/.test(group)) throw new Error('Unexpected session cgroup path')
    if (group) {
      const events = await readFile(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return '' })
      if (/populated 1/.test(events)) throw new Error('Session processes remain; stop not confirmed')
    }
  }
  async inspect(record: SessionRecord): Promise<'running' | 'stopped' | 'unknown'> {
    const p = sessionPaths(record)
    const values = await Promise.all([p.runtimeUnit, p.desktopUnit].map(async unit => {
      const result = await command('/bin/systemctl', ['show', unit, '--property=ActiveState', '--value'])
      return result.stdout.trim()
    }))
    if (values.every(v => v === 'active')) return 'running'
    if (values.every(v => ['inactive', 'failed'].includes(v))) return 'stopped'
    return 'unknown'
  }
}
