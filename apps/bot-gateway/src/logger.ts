type Level = 'debug' | 'info' | 'warn' | 'error'
const ranking = { debug: 0, info: 1, warn: 2, error: 3 }
const sensitive = /token|secret|password|pairing|code|message|text|prompt|instructions|authorization/i
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(item)])
    )
  return value
}
export class Logger {
  constructor(
    readonly level: Level = 'info',
    private readonly output = process.stdout,
    private readonly errors = process.stderr
  ) {}
  log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
    if (ranking[level] < ranking[this.level]) return
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(redact(fields) as object) }) + '\n'
    ;(ranking[level] >= ranking.warn ? this.errors : this.output).write(line)
  }
  debug(message: string, fields?: Record<string, unknown>) {
    this.log('debug', message, fields)
  }
  info(message: string, fields?: Record<string, unknown>) {
    this.log('info', message, fields)
  }
  warn(message: string, fields?: Record<string, unknown>) {
    this.log('warn', message, fields)
  }
  error(message: string, fields?: Record<string, unknown>) {
    this.log('error', message, fields)
  }
}
