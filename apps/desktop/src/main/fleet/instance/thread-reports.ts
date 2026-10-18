import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { MemoryCoreExtraSection } from '../../memory/core'

/** Answers kept for the bot's own conversation: the latest ones, of the last week. */
export const THREAD_REPORT_LIMITS = { keep: 10, maxAgeMs: 7 * 86_400_000, textMax: 2000 } as const

const reportSchema = z.object({
  threadId: z.string().min(1).max(80),
  peerName: z.string().max(200),
  title: z.string().max(200),
  text: z.string().max(THREAD_REPORT_LIMITS.textMax),
  at: z.iso.datetime(),
})
const fileSchema = z.object({ version: z.literal(1), reports: z.array(reportSchema) })
export type ThreadReport = z.infer<typeof reportSchema>

/**
 * What the bot brought back to its own conversation from threads with other bots it opened there
 * (`bot_peers_report`). The owner reads them on the thread's card; the bot reads them, through its always-on memory,
 * on its next turn in its own conversation, which no report starts.
 */
export class ThreadReports {
  private reports: ThreadReport[] | null = null
  private writeTail: Promise<void> = Promise.resolve()
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  async add(report: Omit<ThreadReport, 'at'>): Promise<void> {
    const entry = reportSchema.parse({
      ...report,
      text: report.text.slice(0, THREAD_REPORT_LIMITS.textMax),
      at: new Date(this.now()).toISOString(),
    })
    // A thread reports its latest answer: an earlier one of the same thread gives way.
    const reports = [...(await this.read()).filter((item) => item.threadId !== entry.threadId), entry]
    this.reports = this.fresh(reports)
    await this.write(this.reports)
  }

  async list(): Promise<ThreadReport[]> {
    return this.fresh(await this.read())
  }

  /** The always-on memory section of the bot's own conversation, or null without recent answers. */
  async section(): Promise<MemoryCoreExtraSection | null> {
    const reports = await this.list()
    if (!reports.length) return null
    return {
      key: 'peer-reports',
      heading: 'Answers from your conversations with other bots',
      intro:
        'You opened these conversations from this one, and each one brought back its answer. They happened in conversations of their own: tell your owner what they need to know.',
      budgetChars: THREAD_REPORT_LIMITS.keep * (THREAD_REPORT_LIMITS.textMax + 200),
      entries: reports.map((report) => ({
        id: `${report.threadId}:${report.at}`,
        text: report.text,
        meta: `${report.peerName} · ${report.title} · ${report.at.slice(0, 16).replace('T', ' ')} UTC`,
      })),
    }
  }

  private fresh(reports: ThreadReport[]): ThreadReport[] {
    const since = this.now() - THREAD_REPORT_LIMITS.maxAgeMs
    return reports.filter((report) => Date.parse(report.at) >= since).slice(-THREAD_REPORT_LIMITS.keep)
  }

  private async read(): Promise<ThreadReport[]> {
    if (this.reports) return this.reports
    try {
      this.reports = fileSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))).reports
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.reports = []
    }
    return this.reports
  }

  private write(reports: ThreadReport[]): Promise<void> {
    const contents = JSON.stringify({ version: 1, reports })
    const write = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(temporary, contents, { mode: 0o600 })
        await fs.rename(temporary, this.file)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.writeTail = write.catch(() => undefined)
    return write
  }
}
