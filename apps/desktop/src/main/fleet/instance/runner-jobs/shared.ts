import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { realFs } from '../../../real-fs'
import { InstanceHttpError } from '../http'

/** What the files of a runner job share: the errors the control server answers with, and a few file helpers. */

export const invalid = (message: string): InstanceHttpError => new InstanceHttpError(400, 'INVALID_REQUEST', message)
export const conflict = (message: string): InstanceHttpError => new InstanceHttpError(409, 'CONFLICT', message)
export const unknownJob = (): InstanceHttpError => new InstanceHttpError(404, 'NOT_FOUND', 'Job does not exist.')

export const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
/** What a folder may hold that cannot be read now: left out, not a reason to refuse the whole folder. */
export const unreadable = (error: unknown): boolean =>
  ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EBUSY'].includes(errno(error) ?? '')

/** The names of the files a job keeps in its record folder. */
export const RUNNER_JOB_FILES = {
  record: 'record.json',
  manifest: 'manifest.json',
  log: 'job.log',
  /** Ends in `.partial` so a bot move, which leaves such files behind, never carries a half-received archive. */
  outputsPart: 'outputs.tar.zst.partial',
  outputsResult: 'outputs.json',
} as const

/** Where a job's staging and log live inside its folder, relative to it. */
export const RUNNER_FOLDER_STATE = '.maestrly/runner-jobs'

/** Writes a file whole or not at all: to a temporary file beside it, then renamed over it. Owner only. */
export async function writeFileAtomically(file: string, data: string): Promise<void> {
  const fs = realFs.promises
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data, { mode: 0o600 })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

/** Runs the tasks of one key one after another; a task that fails does not stop the ones behind it. */
export class KeyedSerial {
  private readonly tails = new Map<string, Promise<unknown>>()
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

/** Runs `task` on each item, `limit` at a time; the first failure stops the rest. */
export async function mapLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await task(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Whether `candidate` is `root` or under it; both are real paths. */
export const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * The folder inside `root` (a real path) where a job's staging and log go, made if missing. Refuses one that a link
 * leads out of the job folder, and answers its real path.
 */
export async function ensureRunnerStateFolder(root: string): Promise<string> {
  const fs = realFs.promises
  let current = root
  // One level at a time, so a link in the way is checked before anything is created behind it.
  for (const segment of RUNNER_FOLDER_STATE.split('/')) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch((error: unknown) => {
      if (errno(error) === 'ENOENT') return null
      throw error
    })
    if (!info) await fs.mkdir(current)
    else if (!info.isDirectory() && !info.isSymbolicLink())
      throw invalid('The job folder keeps a file where its runner files go.')
    const real = await fs.realpath(current)
    if (!isInside(root, real)) throw invalid('The job folder keeps its runner files outside of itself.')
    if (!(await fs.stat(real)).isDirectory()) throw invalid('The job folder keeps a file where its runner files go.')
    current = real
  }
  return current
}
