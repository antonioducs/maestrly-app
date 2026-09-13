import { appendFileSync, existsSync, lstatSync, renameSync, unlinkSync } from 'node:fs'
export class RotatingLog {
  constructor(
    private readonly path: string,
    private readonly maxBytes = 1024 * 1024,
    private readonly generations = 3
  ) {}
  write(
    event: 'started' | 'stopped' | 'connection_rejected' | 'protocol_rejected' | 'request_completed' | 'request_failed'
  ) {
    if (existsSync(this.path)) {
      const info = lstatSync(this.path)
      if (!info.isFile() || info.nlink !== 1) throw Error('Unsafe log file')
      if (info.size >= this.maxBytes) {
        for (let n = this.generations; n >= 1; n--) {
          const old = n === 1 ? this.path : `${this.path}.${n - 1}`
          const next = `${this.path}.${n}`
          if (n === this.generations && existsSync(next)) unlinkSync(next)
          if (existsSync(old)) renameSync(old, next)
        }
      }
    }
    appendFileSync(this.path, `${JSON.stringify({ time: new Date().toISOString(), event })}\n`, { mode: 0o600 })
  }
}
