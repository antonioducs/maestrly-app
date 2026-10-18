import type { Readable, Stream } from 'node:stream'
import { buildRedactor } from '../pii-scrub'

/** A stdio server that failed to start, with what its error output says about why. */
export class McpStdioFailure extends Error {
  constructor(
    message: string,
    /** The masked summary of its error output. */
    readonly output: string,
    cause: unknown
  ) {
    super(`${message}. The server's error output: ${output}`, { cause })
    this.name = 'McpStdioFailure'
  }
}

/** What is kept of a stdio server's error output: its end, enough for the lines that say why it stopped. */
const KEPT_BYTES = 16 * 1024
const SUMMARY_LINES = 3
const LINE_MAX = 300
export const MCP_STDIO_SUMMARY_MAX = 900

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
/** Lines that explain a failure, as servers and their launchers word it. */
const TELLING =
  /\b(error|fatal|fail(?:ed|ure)?|required|requires|missing|must|please|not set|not found|invalid|denied|unauthori[sz]ed|forbidden|cannot|can't|unable|refused|expired|ENOENT|EACCES)\b/i
/** Node's report of an uncaught error and npm's banners, which repeat the cause or say nothing about it. */
const NOISE = [
  /^at\s/,
  /^Node\.js v\d/,
  /^node:[\w/]+:\d+$/,
  /^\^+$/,
  /^throw \w+;?$/,
  /^[{}[\],]+$/,
  /^(status|signal|output|pid|stdout|stderr|code|errno|syscall|path|spawnargs):/,
  /^npm (notice|http fetch)/,
]

/** The message of a structured log line (`{"level":"fatal","message":"…"}`), or the line itself. */
function readable(line: string): string {
  if (!line.startsWith('{')) return line
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    for (const key of ['message', 'msg', 'error'])
      if (typeof value[key] === 'string' && value[key]) return value[key] as string
  } catch {
    /* not JSON */
  }
  return line
}

/**
 * Why a stdio server stopped, from its error output: the last few lines that read like a cause (or, without any, the
 * last lines), with its environment values and arguments masked, since they can hold its credentials.
 */
export function mcpStdioSummary(output: string, secrets: readonly string[]): string {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.some((pattern) => pattern.test(line)))
    .map(readable)
  const telling = lines.filter((line) => TELLING.test(line))
  const chosen = (telling.length ? telling : lines).slice(-SUMMARY_LINES)
  const redact = buildRedactor({ paths: [], secrets: [...secrets] })
  const text = chosen.map((line) => redact(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line)).join(' | ')
  return text.length > MCP_STDIO_SUMMARY_MAX ? `${text.slice(0, MCP_STDIO_SUMMARY_MAX)}…` : text
}

/**
 * Reads a stdio server's error output for as long as it runs, keeping only its end. Reading it is required: a server
 * that writes to a full pipe nobody drains stops.
 */
export function collectMcpStdioOutput(source: Stream | null): { text: () => Promise<string> } {
  // With `stderr: 'pipe'` the SDK hands out a PassThrough at once, before the process starts.
  const stream = source as Readable | null
  let kept = ''
  let ended = !stream
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk: string) => {
    kept = (kept + chunk).slice(-KEPT_BYTES)
  })
  const done = new Promise<void>((resolve) => {
    if (!stream) return resolve()
    stream.once('end', resolve)
    stream.once('close', resolve)
    stream.once('error', resolve)
  }).then(() => {
    ended = true
  })
  return {
    // A server that exits closes its output a moment after the connection reports it; one that hangs never does.
    text: async () => {
      if (!ended) await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 250))])
      return kept
    },
  }
}

/** What a stdio server's output must not repeat: its environment values and arguments, bare flag names aside. */
export function mcpStdioSecrets(server: { env?: Record<string, string>; args?: string[] }): string[] {
  return [...Object.values(server.env ?? {}), ...(server.args ?? []).filter((arg) => !/^--?[A-Za-z][\w-]*$/.test(arg))]
}

/** The connection error of a stdio server, with the cause its error output gives when it gives one. */
export async function withMcpStdioOutput(
  error: unknown,
  output: { text: () => Promise<string> },
  secrets: readonly string[]
): Promise<unknown> {
  const summary = mcpStdioSummary(await output.text(), secrets)
  if (!summary) return error
  return new McpStdioFailure(error instanceof Error ? error.message : String(error), summary, error)
}
