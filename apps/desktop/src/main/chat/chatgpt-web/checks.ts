/**
 * Checks the bridge may RUN (tests, lint, typecheck): the only side effect allowed for ChatGPT Web
 * here, and only through an allowlist.
 *
 * Security model: the model selects a NAME; the command line comes from here, never from the model.
 * No shell (`execFile`), no `&&`/pipes, no expansion: remote prompt injection cannot become arbitrary
 * execution. The list comes only from explicit user configuration in settings.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { killProcessTree } from '../../platform'
import { getAppSetting, setAppSetting } from '../../store'
import type { BridgeCheck, BridgeCheckResult } from './bridge-server'

const CHECKS_KEY = 'chat.chatgptWeb.checks'
const TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_CHARS = 24_000
export interface ChatGptWebCheck extends BridgeCheck {
  /** Executable and arguments already separated (no shell). */
  command: string[]
}

/** Explicit configuration: one entry per line, `name = command with args`. Empty means no checks. */
export function getChecksConfig(): string {
  return getAppSetting(CHECKS_KEY) ?? ''
}

export function setChecksConfig(raw: string): void {
  setAppSetting(CHECKS_KEY, raw.trim())
}

function parseConfig(raw: string): ChatGptWebCheck[] {
  const out: ChatGptWebCheck[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    // Simple split: without a shell there is no quoting/expansion to interpret; the user controls the line.
    const command = trimmed
      .slice(eq + 1)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (!name || command.length === 0) continue
    out.push({ name, description: command.join(' '), command })
  }
  return out
}

/** Valid checks for a cwd: only entries explicitly configured by the user. */
export function listChecks(_cwd: string): ChatGptWebCheck[] {
  return parseConfig(getChecksConfig())
}

function executableOnPath(name: string): string | null {
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * `.cmd` requires a shell on Windows, but checks never open a shell. For npm, invoke the official
 * `npm-cli.js` bundled with Node directly, preserving behavior without broadening the execution
 * surface of the allowlist.
 */
function windowsSafeCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32' || !/^npm(?:\.cmd)?$/i.test(path.basename(file))) return { file, args }
  const npmExecutable = executableOnPath(file) ?? executableOnPath('npm')
  const candidates = [
    process.env.npm_execpath,
    npmExecutable && path.join(path.dirname(npmExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    npmExecutable && path.join(path.dirname(npmExecutable), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => !!candidate)
  const npmCli = candidates.find((candidate) => /\.[cm]?js$/i.test(candidate) && existsSync(candidate))
  return npmCli ? { file: process.execPath, args: [npmCli, ...args] } : { file, args }
}

export function runCheck(cwd: string, name: string, signal?: AbortSignal): Promise<BridgeCheckResult> {
  const check = listChecks(cwd).find((candidate) => candidate.name === name)
  if (!check) return Promise.resolve({ exitCode: null, output: `Unknown check: ${name}` })
  if (signal?.aborted) return Promise.resolve({ exitCode: null, output: 'Check cancelled.', aborted: true })
  const [configuredFile, ...configuredArgs] = check.command
  const { file, args } = windowsSafeCommand(configuredFile, configuredArgs)
  return new Promise((resolve) => {
    let tail = ''
    let totalChars = 0
    let timedOut = false
    let aborted = false
    let settled = false
    const append = (chunk: unknown) => {
      const text = String(chunk)
      totalChars += text.length
      tail = `${tail}${text}`.slice(-MAX_OUTPUT_CHARS)
    }
    const proc = spawn(file, args, {
      cwd,
      env: process.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', append)
    proc.stderr?.on('data', append)

    const terminate = () => {
      if (proc.pid && proc.exitCode === null) killProcessTree(proc.pid)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      append('\nCheck stopped: timeout exceeded.\n')
      terminate()
    }, TIMEOUT_MS)
    timeout.unref?.()
    const onAbort = () => {
      aborted = true
      append('\nCheck cancelled because the turn or session ended.\n')
      terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      const merged = tail.trim()
      const omitted = Math.max(0, totalChars - tail.length)
      const output = omitted > 0 ? `… [output truncated: ${omitted} characters omitted from the beginning]\n${merged}` : merged
      resolve({
        exitCode: timedOut || aborted ? null : exitCode,
        output,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      })
    }
    proc.on('error', (error) => {
      append(`\nFailed to start \`${configuredFile}\`: ${error.message}\n`)
      // `close` usually follows `error`; the guard avoids relying on this platform detail.
      finish(null)
    })
    proc.on('close', (code) => finish(typeof code === 'number' ? code : null))
  })
}
