import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { TurnSnapshot } from '@maestrly/host-protocol'
import type { Journal } from '../control/journal.js'
import type { FileService } from '../files/service.js'
import type { TurnHooks } from '../providers/provider.js'
import type { ProcessRegistry } from '../turns/leases.js'
import { runtimeError } from '../turns/service.js'
import type { BrowserSession } from './browser.js'
import { Computer } from './computer.js'
import { approveSystem } from './policy.js'
import { systemExec } from './system.js'
import { proposeMemory } from './memory.js'
import { captureDesktop } from '../desktop/capture.js'

const empty = z.strictObject({})
const ref = { ref: z.number().int().positive(), observationId: z.string().uuid() }
const text = z.string().max(32 * 1024)
const schemas = {
  browser_navigate: z.strictObject({ url: z.string().max(8192) }),
  browser_snapshot: empty,
  browser_click: z.strictObject(ref),
  browser_type: z.strictObject({ ...ref, text }),
  browser_key: z.strictObject({ key: z.string().min(1).max(100) }),
  browser_screenshot: empty,
  browser_downloads: empty,
  computer_screenshot: empty,
  computer_click: z.strictObject({
    x: z.number().min(0).max(1279),
    y: z.number().min(0).max(799),
    button: z.enum(['left', 'right', 'middle']).optional(),
    observationId: z.string().uuid(),
  }),
  computer_type: z.strictObject({ text, observationId: z.string().uuid() }),
  computer_key: z.strictObject({ key: z.string().min(1).max(100), observationId: z.string().uuid() }),
  system_exec: z.strictObject({
    command: z.array(z.string().min(1).max(8192)).min(1).max(256),
    reason: z.string().min(1).max(4096),
  }),
  memory_propose: z.strictObject({ content: z.string().min(1).max(8192) }),
  files_deliver: z.strictObject({ path: z.string().min(1).max(4096), title: z.string().max(300).optional() }),
}
const summaries: Record<keyof typeof schemas, string> = {
  browser_navigate: 'Abrindo a página',
  browser_snapshot: 'Observando a página',
  browser_click: 'Clicando na página',
  browser_type: 'Digitando na página',
  browser_key: 'Pressionando uma tecla',
  browser_screenshot: 'Capturando a tela',
  browser_downloads: 'Consultando downloads',
  computer_screenshot: 'Capturando a tela',
  computer_click: 'Clicando na tela',
  computer_type: 'Digitando na tela',
  computer_key: 'Pressionando uma tecla',
  system_exec: 'Execução com privilégios indisponível (ask e full-vm); não há aprovação para root',
  memory_propose: 'Propondo uma memória',
  files_deliver: 'Entregando um arquivo',
}
export interface ToolContext {
  snapshot: TurnSnapshot
  hooks: TurnHooks
  signal: AbortSignal
  processes: ProcessRegistry
}
export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' })[]
  isError?: boolean
}
export class ToolRegistry {
  private observationId?: string
  private observationKind?: 'browser' | 'computer'
  private desktopGeneration?: string
  private requests = new Map<string, Promise<ToolResult>>()
  private queue: Promise<unknown> = Promise.resolve()
  private computer: Computer
  constructor(
    private journal: Journal,
    private files: FileService,
    readonly browser: BrowserSession,
    private context: () => ToolContext,
    private mode: () => 'ask' | 'full-vm'
  ) {
    this.computer = new Computer(browser)
  }
  invalidate() {
    this.observationId = undefined
    this.observationKind = undefined
  }
  list() {
    return Object.entries(schemas).map(([name, schema]) => ({
      name,
      description: summaries[name as keyof typeof schemas],
      inputSchema: z.toJSONSchema(schema),
    }))
  }
  call(turnId: string, requestId: string, name: string, args: unknown): Promise<ToolResult> {
    const key = turnId + ':' + requestId
    const previous = this.requests.get(key)
    if (previous) return previous
    if (this.requests.size >= 10_000) return Promise.reject(runtimeError('LIMIT', 'Tool request cache is full'))
    if (this.journal.hasToolRequest(turnId, requestId))
      return Promise.resolve({
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: 'REPLY_LOST',
              message: 'This request already started; it will not be executed again',
            }),
          },
        ],
      })
    const operation = this.queue.then(() => this.execute(turnId, requestId, name, args))
    this.queue = operation.catch(() => {})
    this.requests.set(key, operation)
    return operation
  }
  private async execute(turnId: string, requestId: string, name: string, args: unknown): Promise<ToolResult> {
    const context = this.context()
    if (context.snapshot.turnId !== turnId) throw runtimeError('TURN_UNKNOWN', 'Tool call belongs to an inactive turn')
    const { hooks, snapshot, signal } = context
    const record = { turnId, generation: snapshot.generation, requestId, tool: name }
    this.journal.append('action.intent', record)
    const summary = (
      name === 'browser_navigate' && args && typeof args === 'object' && 'url' in args
        ? 'Abrindo a página ' + String(args.url)
        : (summaries[name as keyof typeof schemas] ?? 'Ferramenta desconhecida')
    ).slice(0, 400)
    hooks.emit({ kind: 'tool.started', summary, detail: { name, requestId } })
    let result: ToolResult
    const cancelBrowser = () => {
      this.invalidate()
      void this.browser.close()
    }
    signal.addEventListener('abort', cancelBrowser, { once: true })
    try {
      signal.throwIfAborted()
      if (!Object.hasOwn(schemas, name)) throw runtimeError('UNKNOWN_TOOL', 'Tool is not in the allowlist')
      const schema = schemas[name as keyof typeof schemas]
      const parsed = schema.parse(args ?? {}) as Record<string, unknown>
      if (
        ['browser_click', 'browser_type', 'computer_click', 'computer_type', 'computer_key'].includes(name) &&
        (!this.observationId || parsed.observationId !== this.observationId)
      )
        throw runtimeError('STALE_OBSERVATION', 'Observe the current page before acting')
      if (['computer_click', 'computer_type', 'computer_key'].includes(name) &&
        (this.observationKind !== 'computer' || this.desktopGeneration !== await this.browser.desktop.generation()))
        throw runtimeError('STALE_OBSERVATION', 'Observe this desktop before acting; its session may have restarted')
      const observe = ['browser_snapshot', 'browser_screenshot', 'computer_screenshot'].includes(name)
      if (!observe) this.invalidate()
      let value: unknown
      switch (name) {
        case 'browser_navigate':
          value = await this.browser.navigate(String(parsed.url))
          break
        case 'browser_snapshot':
          value = await this.browser.snapshot()
          break
        case 'browser_screenshot':
        case 'computer_screenshot': {
          const observationId = randomUUID()
          const shot = name === 'computer_screenshot' ? await captureDesktop(this.browser.desktop, this.files, observationId, hooks, signal) : await this.browser.screenshot(observationId, hooks)
          this.observationId = observationId
          this.observationKind = name === 'computer_screenshot' ? 'computer' : 'browser'
          this.desktopGeneration = name === 'computer_screenshot' ? await this.browser.desktop.generation() : undefined
          result = {
            content: [
              { type: 'text', text: JSON.stringify({ observationId, path: shot.path }) },
              { type: 'image', data: shot.bytes.toString('base64'), mimeType: 'image/png' },
            ],
          }
          signal.removeEventListener('abort', cancelBrowser)
          return this.finish(record, hooks, summary, result)
        }
        case 'browser_click':
          await this.browser.click(Number(parsed.ref))
          break
        case 'browser_type':
          await this.browser.type(Number(parsed.ref), String(parsed.text))
          break
        case 'browser_key':
          await this.browser.key(String(parsed.key))
          break
        case 'browser_downloads':
          value = this.browser.listDownloads()
          break
        case 'computer_click':
          await this.computer.click(
            Number(parsed.x),
            Number(parsed.y),
            parsed.button as 'left' | 'right' | 'middle' | undefined,
            signal
          )
          break
        case 'computer_type':
          await this.computer.type(String(parsed.text), signal)
          break
        case 'computer_key':
          await this.computer.key(String(parsed.key), signal)
          break
        case 'system_exec': {
          const command = parsed.command as string[]
          await approveSystem(this.mode(), command, String(parsed.reason), hooks)
          signal.throwIfAborted()
          value = await systemExec(command, {
            workspace: this.files.workspace,
            turnId,
            processes: context.processes,
            signal,
          })
          break
        }
        case 'memory_propose':
          value = proposeMemory(String(parsed.content), hooks)
          break
        case 'files_deliver': {
          const path = String(parsed.path)
          const info = await this.files.stat({ path })
          if (info.kind !== 'file') throw runtimeError('NOT_FILE', 'Only workspace files can be delivered')
          value = { path, name: basename(path), size: info.size, digest: info.digest, title: parsed.title }
          hooks.emit({ kind: 'file.produced', summary: 'Arquivo disponível', detail: value as Record<string, unknown> })
          break
        }
      }
      if (observe) {
        this.observationId = randomUUID()
        this.observationKind = 'browser'
        value = { ...(value as object), observationId: this.observationId }
      }
      result = {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? { done: true }) }],
      }
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      result = {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ code: failure.code ?? 'TOOL_ERROR', message: failure.message ?? 'Tool failed' }),
          },
        ],
      }
    }
    signal.removeEventListener('abort', cancelBrowser)
    return this.finish(record, hooks, summary, result)
  }
  private finish(record: Record<string, unknown>, hooks: TurnHooks, summary: string, result: ToolResult) {
    this.journal.append('action.result', { ...record, isError: result.isError ?? false })
    hooks.emit({
      kind: 'tool.finished',
      summary,
      detail: { name: record.tool, requestId: record.requestId, isError: result.isError ?? false },
    })
    return result
  }
}
