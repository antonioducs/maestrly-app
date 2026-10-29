import { FLEET_RUNNER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { type FileHandle, open } from 'node:fs/promises'
import { readAt, writeAt } from '../transfer-io'
import { isTransientApiError, RunnerApiError, type RunnerJobApi } from './api'
import { abortableSleep } from './sleep'

const MASK = Buffer.from('***')
const EMPTY = Buffer.alloc(0)
/** Variable values shorter than this are not hidden: they would also hide ordinary text. */
const SECRET_MIN_LENGTH = 4

/** The text with every value of `env` (of at least four characters) replaced by `***`. */
export function redactEnvValues(text: string, env: Readonly<Record<string, string>>): string {
  let redacted = text
  for (const value of secretValues(env)) redacted = redacted.split(value).join('***')
  return redacted
}

const secretValues = (env: Readonly<Record<string, string>>): string[] =>
  [...new Set(Object.values(env).filter((value) => value.length >= SECRET_MIN_LENGTH))].sort(
    (a, b) => b.length - a.length
  )

function replaceAll(data: Buffer, needle: Buffer): Buffer {
  let at = data.indexOf(needle)
  if (at < 0) return data
  const parts: Buffer[] = []
  let from = 0
  while (at >= 0) {
    parts.push(data.subarray(from, at), MASK)
    from = at + needle.length
    at = data.indexOf(needle, from)
  }
  parts.push(data.subarray(from))
  return Buffer.concat(parts)
}

/** How many of the last bytes of `data` start a secret that the next bytes may complete. */
function partialSuffix(data: Buffer, secrets: readonly Buffer[]): number {
  let hold = 0
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, data.length); length > hold; length--) {
      if (data[data.length - length] !== secret[0]) continue
      if (data.subarray(data.length - length).equals(secret.subarray(0, length))) {
        hold = length
        break
      }
    }
  }
  return hold
}

export interface RunnerLogPumpOptions {
  api: RunnerJobApi
  jobId: string
  /** The local copy of the log. */
  file: string
  /** The job's environment variables: their values never reach the file or the gateway. */
  env: Readonly<Record<string, string>>
  /** Longest wait before pending output is sent. */
  intervalMs?: number
  /** Pending bytes that are sent without waiting. */
  sendBytes?: number
  /** Milliseconds to wait before retry number `attempt` (0 for the first) of a batch the gateway did not take. */
  backoff?: (attempt: number) => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * A job's log: what the executor prints is appended to a local file and sent to the gateway in batches, every two
 * seconds or 64 KiB, each at its explicit offset in the log so a batch sent twice lands once. Sending never holds up
 * the job: a batch the gateway does not take is tried again with growing pauses while the output goes on piling up in
 * the file. The values of the job's environment variables are replaced by `***` before anything is stored or sent.
 */
export class RunnerLogPump {
  private readonly api: RunnerJobApi
  private readonly jobId: string
  private readonly file: string
  private readonly secrets: Buffer[]
  private readonly intervalMs: number
  private readonly sendBytes: number
  private readonly backoff: (attempt: number) => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly handle: Promise<FileHandle>
  private readonly controller = new AbortController()
  private readonly waiters: Array<() => void> = []
  /** Output cut off from a secret that the next bytes may complete. */
  private carry: Buffer = EMPTY
  private chain: Promise<void> = Promise.resolve()
  /** Where the next bytes go in the file. */
  private reserved = 0
  /** Bytes in the file. */
  private size = 0
  /** Bytes the gateway holds. */
  private sent = 0
  private timer: NodeJS.Timeout | null = null
  private sending = false
  private flushing = false
  private closed = false
  /** The gateway refuses the log: it is kept locally only. */
  private abandoned = false
  private attempt = 0
  private rewinds = 0

  constructor(options: RunnerLogPumpOptions) {
    this.api = options.api
    this.jobId = options.jobId
    this.file = options.file
    this.secrets = secretValues(options.env).map((value) => Buffer.from(value))
    this.intervalMs = options.intervalMs ?? 2_000
    this.sendBytes = options.sendBytes ?? 64 * 1024
    this.backoff = options.backoff ?? ((attempt) => Math.min(30_000, 1_000 * 2 ** attempt))
    this.sleep = options.sleep ?? abortableSleep
    this.handle = open(this.file, 'w+', 0o600)
    this.handle.catch(() => undefined)
  }

  /** Adds output. The bytes are in the file, and on their way to the gateway, soon after. */
  write(chunk: Buffer): void {
    if (this.closed) return
    this.append(this.redact(chunk, false))
  }

  private redact(chunk: Buffer, final: boolean): Buffer {
    if (!this.secrets.length) return chunk
    let data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    this.carry = EMPTY
    for (const secret of this.secrets) data = replaceAll(data, secret)
    if (final) return data
    const hold = partialSuffix(data, this.secrets)
    if (!hold) return data
    this.carry = Buffer.from(data.subarray(data.length - hold))
    return data.subarray(0, data.length - hold)
  }

  private append(data: Buffer): void {
    if (!data.length) return
    const position = this.reserved
    this.reserved += data.length
    this.chain = this.chain
      .then(async () => {
        await writeAt(await this.handle, data, position)
        this.size = position + data.length
        this.kick()
      })
      // A log that cannot be kept locally is lost; the job goes on.
      .catch(() => undefined)
  }

  private kick(): void {
    if (this.abandoned || this.closed || this.size <= this.sent) return
    if (this.flushing || this.size - this.sent >= this.sendBytes) void this.send()
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.send()
      }, this.intervalMs)
      this.timer.unref?.()
    }
  }

  private idle(): boolean {
    return !this.sending && (this.sent >= this.size || this.abandoned || this.closed)
  }

  private async send(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (!this.abandoned && !this.closed && this.sent < this.size) {
        const offset = this.sent
        const length = Math.min(this.size - offset, FLEET_RUNNER_LIMITS.logBatchBytesMax)
        try {
          const bytes = await readAt(await this.handle, length, offset)
          await this.api.log(this.jobId, offset, bytes, this.controller.signal)
          this.sent = offset + length
          this.attempt = 0
        } catch (error) {
          if (this.closed) return
          if (isTransientApiError(error)) {
            await this.sleep(this.backoff(this.attempt++), this.controller.signal).catch(() => undefined)
          } else if (error instanceof RunnerApiError && error.status === 409 && offset > 0 && ++this.rewinds <= 2) {
            // The environment holds less than this computer thinks it sent: send the log again from the start.
            this.sent = 0
          } else this.abandoned = true
        }
      }
    } finally {
      this.sending = false
      if (this.idle()) for (const resume of this.waiters.splice(0)) resume()
    }
  }

  private drained(): Promise<void> {
    return this.idle() ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve))
  }

  /**
   * Sends everything still pending, waiting at most `maxWaitMs`. Call it when the output has ended: bytes held back
   * in case they completed a secret are released. Returns whether the gateway holds the whole log.
   */
  async flush(maxWaitMs = 15_000): Promise<boolean> {
    if (this.closed) return false
    this.append(this.redact(EMPTY, true))
    await this.chain
    this.flushing = true
    this.kick()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.drained(), new Promise<void>((resolve) => (timer = setTimeout(resolve, maxWaitMs)))])
    clearTimeout(timer)
    return this.sent >= this.size && !this.abandoned
  }

  /** The last `lines` lines of the log, within its last `bytes` bytes. */
  async tail(lines: number, bytes: number): Promise<string> {
    await this.chain
    // The file is there once it is open: a log that was never written to is not open yet when nothing waits for it.
    await this.handle.catch(() => undefined)
    const handle = await open(this.file, 'r')
    try {
      const { size } = await handle.stat()
      // One byte before the window tells whether it starts at the start of a line.
      const start = Math.max(0, size - bytes - 1)
      let text = (await readAt(handle, size - start, start)).toString('utf8')
      // A window that begins inside a line starts at the next line.
      if (start > 0) text = text.slice(text.includes('\n') ? text.indexOf('\n') + 1 : 1)
      return text.replace(/\n$/, '').split('\n').slice(-lines).join('\n')
    } finally {
      await handle.close()
    }
  }

  /** Stops sending and closes the file. What was not sent stays in the local file. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.controller.abort()
    await this.chain
    for (const resume of this.waiters.splice(0)) resume()
    await (await this.handle.catch(() => null))?.close()
  }
}
