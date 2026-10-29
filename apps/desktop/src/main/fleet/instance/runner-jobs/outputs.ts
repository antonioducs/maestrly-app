import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { FLEET_RUNNER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { extractArchive, UnsafeArchiveError } from '../../../folder-archive'
import { realFs } from '../../../real-fs'
import { hashFile, writeAt } from '../../../transfer-io'
import {
  conflict,
  ensureRunnerStateFolder,
  errno,
  invalid,
  isInside,
  RUNNER_FOLDER_STATE,
  RUNNER_JOB_FILES,
  writeFileAtomically,
} from './shared'

const fs = realFs.promises
const SHA256 = /^[a-f0-9]{64}$/

/** What a committed output archive put into the job folder. */
export interface RunnerOutputsResult {
  /** The files that landed, with their paths relative to the job folder. */
  files: Array<{ path: string; size: number }>
  /** The archive's size and SHA-256. */
  bytes: number
  sha256: string
  /** Entries that were not placed: their destination is a directory, or sits behind something that is not one. */
  skipped: number
}

interface Staged {
  path: string
  kind: 'directory' | 'file' | 'symlink'
  size: number
  mode: number
}

/** What `extractArchive` made under `root`, parents before children; it makes nothing but these three kinds. */
async function listStaged(root: string): Promise<Staged[]> {
  const out: Staged[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, name)
      const info = await fs.lstat(absolute)
      const relative = prefix ? `${prefix}/${name}` : name
      if (info.isDirectory()) {
        out.push({ path: relative, kind: 'directory', size: 0, mode: info.mode & 0o777 })
        await visit(absolute, relative)
      } else if (info.isFile()) out.push({ path: relative, kind: 'file', size: info.size, mode: info.mode & 0o777 })
      else if (info.isSymbolicLink()) out.push({ path: relative, kind: 'symlink', size: 0, mode: 0o777 })
    }
  }
  await visit(root, '')
  return out
}

/** Moves a staged file or link over `destination`, which is a file, a link or nothing, never a directory. */
async function replace(source: string, destination: string, kind: Staged['kind']): Promise<void> {
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (errno(error) !== 'EXDEV') throw error
    // Staging is on another file system than its folder (a mount in between): copy it over instead.
    await fs.rm(destination, { force: true })
    if (kind === 'symlink') await fs.symlink(await fs.readlink(source), destination)
    else await fs.copyFile(source, destination, realFs.constants.COPYFILE_EXCL)
    await fs.rm(source, { force: true })
  }
}

/**
 * Receives the output archive of one job: the runner uploads it in chunks at explicit offsets into a part file next to
 * the job's record, and commits it with the whole archive's size and SHA-256. Committing extracts it into a staging
 * folder inside the job folder and moves its files into place. Calls on one job run one after another, except that a
 * chunk is read before it waits its turn.
 */
export class RunnerOutputs {
  private tail: Promise<unknown> = Promise.resolve()

  /** `dir` is the job's record folder; `jobId` names the staging folder. */
  constructor(
    private readonly jobId: string,
    private readonly dir: string
  ) {}

  private get part(): string {
    return path.join(this.dir, RUNNER_JOB_FILES.outputsPart)
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }

  private async received(): Promise<number | null> {
    try {
      return (await fs.stat(this.part)).size
    } catch (error) {
      if (errno(error) === 'ENOENT') return null
      throw error
    }
  }

  private async stored(): Promise<RunnerOutputsResult | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, RUNNER_JOB_FILES.outputsResult), 'utf8'))
    } catch (error) {
      if (errno(error) === 'ENOENT') return null
      throw error
    }
  }

  private async discard(): Promise<void> {
    await fs.rm(this.part, { force: true })
  }

  /** Drops a half-received archive once its job has ended and nothing can complete it. A committed one is kept. */
  discardPart(): Promise<void> {
    return this.exclusive(() => this.discard())
  }

  /**
   * How many bytes of the archive are here, so an interrupted upload resumes there. Once the archive is committed it is
   * all of it, so a runner that lost the answer to its commit goes on to commit again.
   */
  async status(): Promise<{ received: number }> {
    const stored = await this.stored()
    return { received: stored ? stored.bytes : ((await this.received()) ?? 0) }
  }

  /**
   * Stores one chunk of `length` bytes at `offset`, which may not be past what is here (a chunk sent again lands where
   * it did). A chunk whose SHA-256 is not `sha256`, or whose body is not `length` bytes, counts for nothing, and so
   * does anything that would take the archive past `FLEET_RUNNER_LIMITS.outputBytesMax`.
   */
  async chunk(offset: number, body: Readable, sha256: string, length: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('Invalid chunk offset.')
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > FLEET_RUNNER_LIMITS.outputChunkBytes + FLEET_RUNNER_LIMITS.chunkBodySlackBytes
    )
      throw invalid('Invalid chunk size.')
    if (!SHA256.test(sha256)) throw invalid('Invalid chunk digest.')
    if (offset + length > FLEET_RUNNER_LIMITS.outputBytesMax)
      throw invalid(`outputs_too_large: The outputs are larger than ${FLEET_RUNNER_LIMITS.outputBytesMax} bytes.`)
    const before = (await this.status()).received
    if (offset > before) throw conflict(`The outputs hold ${before} bytes.`)
    // Held whole, so a chunk that breaks off or does not match leaves the archive as it was.
    const chunks: Buffer[] = []
    let size = 0
    for await (const piece of body) {
      const bytes = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
      size += bytes.length
      if (size > length) throw invalid('The chunk is longer than declared.')
      chunks.push(bytes)
    }
    if (size !== length) throw invalid('The chunk is shorter than declared.')
    const data = Buffer.concat(chunks, size)
    if (createHash('sha256').update(data).digest('hex') !== sha256)
      throw invalid('The chunk does not match its digest.')
    await this.exclusive(async () => {
      const stored = await this.stored()
      // A chunk sent again after the commit is already part of what was committed.
      if (stored) {
        if (offset + length <= stored.bytes) return
        throw conflict('The outputs were already committed.')
      }
      const held = (await this.received()) ?? 0
      if (offset > held) throw conflict(`The outputs hold ${held} bytes.`)
      const handle = await fs.open(this.part, realFs.constants.O_RDWR | realFs.constants.O_CREAT, 0o600)
      try {
        await writeAt(handle, data, offset)
      } finally {
        await handle.close()
      }
    })
  }

  /**
   * Checks the archive against `commit`, extracts it and moves its files into `folder`, replacing files and links
   * and removing nothing else. Committing again with the same SHA-256 answers the first result. An archive that does
   * not match, or that holds anything unsafe (see `extractArchive`), is refused and dropped, so the runner starts it
   * again; one that is not all here yet is a conflict that says how much is.
   */
  commit(commit: { bytes: number; sha256: string }, folder: string): Promise<RunnerOutputsResult> {
    return this.exclusive(async () => {
      const stored = await this.stored()
      if (stored) {
        if (stored.sha256 === commit.sha256) return stored
        throw conflict('The outputs were committed with another digest.')
      }
      const received = await this.received()
      if (received === null || received < commit.bytes)
        throw conflict(`The outputs hold ${received ?? 0} of ${commit.bytes} bytes.`)
      if (received > commit.bytes) {
        await this.discard()
        throw invalid(`The outputs hold more than ${commit.bytes} bytes. Send them again.`)
      }
      if ((await hashFile(this.part)) !== commit.sha256) {
        await this.discard()
        throw invalid('The outputs do not match their digest. Send them again.')
      }
      let placed: { files: Array<{ path: string; size: number }>; skipped: number }
      try {
        placed = await this.place(folder)
      } catch (error) {
        if (error instanceof UnsafeArchiveError) {
          await this.discard()
          throw invalid(`The outputs were refused. ${error.message}`)
        }
        throw error
      }
      const result: RunnerOutputsResult = { ...placed, bytes: commit.bytes, sha256: commit.sha256 }
      await writeFileAtomically(path.join(this.dir, RUNNER_JOB_FILES.outputsResult), JSON.stringify(result))
      await this.discard()
      return result
    })
  }

  private async place(folder: string): Promise<{ files: Array<{ path: string; size: number }>; skipped: number }> {
    const root = await fs.realpath(folder).catch((error: unknown) => {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') throw conflict('The job folder does not exist.')
      throw error
    })
    const stagingName = `${this.jobId}.staging`
    const staging = path.join(await ensureRunnerStateFolder(root), stagingName)
    await fs.rm(staging, { recursive: true, force: true })
    try {
      await extractArchive(this.part, staging)
      return await moveIntoPlace(staging, root, `${RUNNER_FOLDER_STATE}/${stagingName}`)
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * Moves what was extracted under `staging` into `root`, the job folder's real path. Everything is checked first: a
 * destination whose existing parent resolves outside `root` (a link was there before) refuses the whole commit with
 * nothing moved. An entry that cannot take its place without removing a folder, or that sits behind something that is
 * not a folder, is skipped and counted.
 */
async function moveIntoPlace(
  staging: string,
  root: string,
  stagingRelative: string
): Promise<{ files: Array<{ path: string; size: number }>; skipped: number }> {
  const staged = await listStaged(staging)
  const absolute = (relative: string): string => path.join(root, ...relative.split('/'))
  const lstat = (target: string) =>
    fs.lstat(target).catch((error: unknown) => {
      if (errno(error) === 'ENOENT') return null
      throw error
    })
  let skipped = 0

  // Whether things can be placed in a folder of the job folder: it exists as a folder (or a link to one inside the job
  // folder), or it is missing and will be made.
  const usable = new Map<string, boolean>()
  const canHold = async (directory: string): Promise<boolean> => {
    if (!directory) return true
    const known = usable.get(directory)
    if (known !== undefined) return known
    const above = path.posix.dirname(directory)
    let ok = await canHold(above === '.' ? '' : above)
    if (ok) {
      const info = await lstat(absolute(directory))
      if (info?.isSymbolicLink()) {
        const real = await fs.realpath(absolute(directory)).catch(() => null)
        if (real !== null && !isInside(root, real)) throw invalid(`${directory} leads outside the job folder.`)
        ok = real !== null && (await fs.stat(real)).isDirectory()
      } else ok = !info || info.isDirectory()
    }
    usable.set(directory, ok)
    return ok
  }

  const plan: Array<{ item: Staged; destination: string }> = []
  for (const item of staged) {
    if (item.path === stagingRelative || item.path.startsWith(`${stagingRelative}/`)) {
      skipped++
      continue
    }
    const above = path.posix.dirname(item.path)
    if (!(await canHold(above === '.' ? '' : above))) {
      skipped++
      continue
    }
    const destination = absolute(item.path)
    const existing = await lstat(destination)
    if (item.kind === 'directory') {
      if (!existing) plan.push({ item, destination })
      else if (!(await canHold(item.path))) skipped++
    } else if (existing && !existing.isFile() && !existing.isSymbolicLink()) skipped++
    else plan.push({ item, destination })
  }

  const files: Array<{ path: string; size: number }> = []
  for (const { item, destination } of plan) {
    if (item.kind === 'directory') {
      await fs.mkdir(destination, { recursive: true })
      if (process.platform !== 'win32') await fs.chmod(destination, item.mode)
      continue
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    try {
      await replace(path.join(staging, ...item.path.split('/')), destination, item.kind)
    } catch (error) {
      // A folder appeared there since the plan was made: it stays.
      if (!['EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(errno(error) ?? '')) throw error
      skipped++
      continue
    }
    if (item.kind === 'file') files.push({ path: item.path, size: item.size })
  }
  return { files, skipped }
}
