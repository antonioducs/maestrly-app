import { neutralizedCodexCatalog, type loadCodexModels } from '../runtime-catalog.js'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ExecutionContext, ExecutionHandle, ExecutionOutcome, ExecutorAdapter, ExecutorCapabilities } from '../executor.js'

export interface CodexExecutorOptions {
  catalogLoader?: typeof loadCodexModels
  executable?: string
  spawnProcess?: typeof spawn
  extraEnvironment?: Record<string, string>
  cancelGraceMs?: number
}

function promptFor(context: ExecutionContext): string {
  const snapshot = context.envelope.snapshot
  if(snapshot.renderedPrompt)return snapshot.renderedPrompt
  return [
    snapshot.title,
    '',
    snapshot.description,
    '',
    'Acceptance criteria:',
    ...snapshot.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    'Work only inside the provided workspace. Produce a concise final summary and run relevant verification.',
  ].join('\n')
}

function limitedEnvironment(context: ExecutionContext, extra: Record<string, string>): NodeJS.ProcessEnv {
  const codexHome = path.join(context.environment.runtimeDirectory ?? path.dirname(context.environment.workspacePath), 'codex')
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? 'C.UTF-8',
    CODEX_HOME: codexHome,
    ...context.environment.environment,
    ...extra,
  }
}

export class CodexExecutor implements ExecutorAdapter {
  constructor(private readonly options: CodexExecutorOptions = {}) {}

  async capabilities(): Promise<ExecutorCapabilities> {
    return { executor: 'codex', capabilities: [{ name: 'executor:codex', version: '0.153', attributes: {} }, { name: 'delivery:patch', attributes: {} }] }
  }

  async start(context: ExecutionContext): Promise<ExecutionHandle> {
    const codexHome = path.join(context.environment.runtimeDirectory ?? path.dirname(context.environment.workspacePath), 'codex')
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    const catalog=await neutralizedCodexCatalog(this.options.executable??'codex',codexHome,this.options.catalogLoader)
    if(context.signal?.aborted)throw new Error('Execution cancelled before agent startup.')
    const args = [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--strict-config',
      '--model', context.envelope.snapshot.model,
      '-c', 'model_catalog_json='+JSON.stringify(catalog),
      '--disable','multi_agent','--disable','multi_agent_v2',
      '-c','shell_environment_policy.exclude=["OPENAI_*","ANTHROPIC_*"]',
      ...(context.envelope.snapshot.effort?['-c','model_reasoning_effort='+JSON.stringify(context.envelope.snapshot.effort)]:[]),
      ...(context.envelope.snapshot.fastMode?['-c','service_tier='+JSON.stringify(context.envelope.snapshot.fastServiceTier??'priority')]:[]),
      '--sandbox', context.readOnly?'read-only':'workspace-write', '--cd', context.environment.workspacePath, '-',
    ]
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnProcess(this.options.executable ?? 'codex', args, {
      cwd: context.environment.workspacePath,
      env: limitedEnvironment(context, this.options.extraEnvironment ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    child.stdin?.end(promptFor(context))
    return createCodexHandle(child, context, this.options.cancelGraceMs ?? 5_000)
  }
}

function createCodexHandle(child: ChildProcess, context: ExecutionContext, cancelGraceMs: number): ExecutionHandle {
  let cancelled = false
  let summary = ''
  let stderr = ''
  let buffered = ''
  let settled = false
  const done = new Promise<ExecutionOutcome>((resolve, reject) => {
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      if(Buffer.byteLength(buffered)>Math.min(context.envelope.snapshot.maxLogBytes??10485760,1048576)){stderr='Codex output exceeded the line limit.';terminate(child,'SIGTERM');buffered='';return}
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          const item = event.item as Record<string, unknown> | undefined
          if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') summary = item.text
          void context.emit({ type: `codex.${String(event.type ?? 'event')}`, data: event }).catch(() => undefined)
        } catch {
          stderr = `${stderr}\nInvalid Codex JSONL: ${line}`.slice(-65_536)
        }
      }
    })
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-65_536) })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      settled = true
      if (cancelled) return resolve({ state: 'cancelled', summary: `Codex stopped (${signal ?? code ?? 'cancelled'}).` })
      if (code === 0) return resolve({ state: 'succeeded', summary: summary || 'Codex completed the approved task.' })
      resolve({ state: 'failed', failure: stderr.trim() || `Codex exited with status ${code ?? signal ?? 'unknown'}.` })
    })
  })

  return {
    done,
    async cancel() {
      if (settled) { await done; return }
      cancelled = true
      terminate(child, 'SIGTERM')
      const forced = setTimeout(() => terminate(child, 'SIGKILL'), cancelGraceMs)
      forced.unref?.()
      try { await done } finally { clearTimeout(forced) }
    },
  }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already exited */ }
  }
}
