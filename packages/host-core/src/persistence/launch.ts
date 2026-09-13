import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, lstat, rm, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const execute = promisify(execFile)
export interface Launch {
  generation: string
  identity: string
  bootSession: string
  pid?: number
  processStart?: string
}
export async function bootSession() {
  if (process.platform === 'darwin')
    return (await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).stdout.trim()
  if (process.platform === 'linux')
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  throw new Error('Boot identity is supported only on macOS or Linux')
}
export async function processStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid launch PID')
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Process identity is supported only on macOS or Linux')
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  try {
    const value = (
      await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 3000,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      })
    ).stdout.trim()
    return value || undefined
  } catch (error) {
    if ((error as { code?: number }).code === 1) return
    throw error
  }
}
const locks = new Map<string, Promise<void>>()
async function exclusive<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(directory) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => pending)
  locks.set(directory, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (locks.get(directory) === tail) locks.delete(directory)
  }
}
export async function saveLaunch(directory: string, launch: Launch, initial = false) {
  return exclusive(directory, () => writeLaunch(directory, launch, initial))
}
async function writeLaunch(directory: string, launch: Launch, initial: boolean) {
  const path = join(directory, initial ? 'launched' : `.launch-${randomUUID()}`)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(launch))
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!initial) await rename(path, join(directory, 'launched'))
  const parent = await open(directory, 'r')
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}
export async function readLaunch(directory: string, identity: string): Promise<Launch> {
  const path = join(directory, 'launched')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 4096)
    throw new Error('Invalid launch record')
  const launch = JSON.parse(await readFile(path, 'utf8')) as Launch
  if (
    launch.identity !== identity ||
    typeof launch.generation !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(launch.generation) ||
    typeof launch.bootSession !== 'string' ||
    !launch.bootSession
  )
    throw new Error('Invalid launch identity')
  return launch
}
export async function launchGone(launch: Launch) {
  if (launch.bootSession !== (await bootSession())) return true
  if (!launch.pid || !launch.processStart) return false
  return (await processStart(launch.pid)) !== launch.processStart
}
/** Caller must prove process exit. Generation prevents a late callback deleting a new launch. */
export async function cleanLaunch(directory: string, launch: Launch) {
  return exclusive(directory, () => removeLaunch(directory, launch))
}
async function removeLaunch(directory: string, launch: Launch) {
  const current = await readLaunch(directory, launch.identity)
  if (current.generation !== launch.generation) return
  for (const name of ['qmp.sock', 'qga.sock']) {
    const path = join(directory, name)
    try {
      const stat = await lstat(path)
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Unowned stale socket')
      await rm(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await rm(join(directory, 'launched'))
}
