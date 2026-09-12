import { open, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'

export interface JournalRun {
  runId: string
  jobId: string
  leaseId: string
  state: 'claimed' | 'running' | 'completing'
  workspacePath?: string
  processIdentity?: { pid: number; startedAt: string; executable: string }
  unacknowledgedEvents: Array<{ id: string; type: string; data: Record<string, unknown> }>
  updatedAt: string
}

export interface RunnerJournalData {
  version: 1
  runs: JournalRun[]
}

const EMPTY: RunnerJournalData = { version: 1, runs: [] }
const MAX_BYTES = 2 * 1024 * 1024
const MAX_EVENTS_PER_RUN = 1_000

export class RunnerJournal {
  constructor(readonly file: string) {}

  async read(): Promise<RunnerJournalData> {
    try {
      if ((await stat(this.file)).size > MAX_BYTES) throw new Error('Runner journal exceeds its size limit.')
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as RunnerJournalData
      if (parsed.version !== 1 || !Array.isArray(parsed.runs)) throw new Error('Runner journal has an unsupported format.')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY)
      throw error
    }
  }

  async update(change: (current: RunnerJournalData) => RunnerJournalData | void): Promise<RunnerJournalData> {
    const current = await this.read()
    const draft = structuredClone(current)
    const next = change(draft) ?? draft
    for (const run of next.runs) run.unacknowledgedEvents = run.unacknowledgedEvents.slice(-MAX_EVENTS_PER_RUN)
    const serialized = `${JSON.stringify(next, null, 2)}\n`
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Runner journal update exceeds its size limit.')
    const temporary = `${this.file}.tmp`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.file)
    // Windows cannot fsync directories; the file itself is synced before the atomic rename.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(this.file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    return next
  }
}
