import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { excludeFromGitInfo } from './git-service'
import { tMain } from './i18n'
import { beginVSCodeBridgeOperation } from './vscode/vscode-memory'

/**
 * Control embedded VS Code debugging through MCP. The file channel avoids web VS Code's CSP blocking
 * localhost fetches: write <cwd>/.maestrly/debug-cmd.json {id,op,args}; setupDebugBridge polls, runs
 * vscode.debug/DAP, and writes debug-result.json {id,ok,data,error}. Read the matching ID. The
 * conversation Code tab must be open so its web extension host is running.
 */
export interface DebugResult {
  ok: boolean
  data?: unknown
  error?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const chains = new Map<string, Promise<unknown>>() // serialize commands per cwd, one in flight at a time

export function runDebugCommand(
  cwd: string,
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = 25_000
): Promise<DebugResult> {
  const prev = chains.get(cwd) ?? Promise.resolve()
  const release = beginVSCodeBridgeOperation(cwd)
  const run = () => execOne(cwd, op, args, timeoutMs).finally(release)
  const next = prev.then(run, run)
  chains.set(
    cwd,
    next.catch(() => {})
  )
  return next
}

async function execOne(
  cwd: string,
  op: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<DebugResult> {
  const dir = path.join(cwd, '.maestrly')
  const cmdFile = path.join(dir, 'debug-cmd.json')
  const resFile = path.join(dir, 'debug-result.json')
  const id = randomUUID()
  try {
    await fsp.mkdir(dir, { recursive: true })
    await excludeFromGitInfo(cwd, ['.maestrly/debug-cmd.json', '.maestrly/debug-result.json']).catch(() => {})
    await fsp.rm(resFile, { force: true }).catch(() => {}) // descarta result anterior
    await fsp.writeFile(cmdFile, JSON.stringify({ id, op, args, ts: Date.now() }))
  } catch (e) {
    return { ok: false, error: 'failed to write command: ' + String((e as Error)?.message ?? e) }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(100)
    try {
      const r = JSON.parse(await fsp.readFile(resFile, 'utf8'))
      if (r && r.id === id) return { ok: !!r.ok, data: r.data, error: r.error ?? undefined }
    } catch {
      /* The result has not arrived yet. */
    }
  }
  return {
    ok: false,
    error: tMain('main')('debug.extTimeout'),
  }
}
