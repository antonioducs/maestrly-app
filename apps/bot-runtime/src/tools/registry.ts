import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { TurnSnapshot } from '@maestrly/host-protocol'
import type { Journal } from '../control/journal.js'
import type { FileService } from '../files/service.js'
import type { TurnHooks } from '../providers/provider.js'
import type { ProcessRegistry } from '../turns/leases.js'
import { runtimeError } from '../turns/service.js'
import { BrowserSession } from './browser.js'
import { LocalDesktopTools, type DesktopTools } from '../desktop/desktop-tools.js'
import { approveSystem } from './policy.js'
import { systemExec } from './system.js'
import { proposeMemory } from './memory.js'
import type { CollaborationClient } from '../teams/client.js'
import { COLLABORATION_SUMMARIES, collaborationTools, isCollaborationTool } from '../teams/tools.js'

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
/**
 * What the model reads in tools/list. The summaries above are for people watching the task;
 * these tell the model what each tool is for, so a request like "abre o Chrome" maps to the
 * managed Chromium instead of a search for a browser binary on the PATH.
 */
const descriptions: Record<keyof typeof schemas, string> = {
  browser_navigate:
    'Abre uma URL (http, https ou arquivo do workspace) no navegador Chromium já instalado nesta área de trabalho; a janela aparece na tela do bot. Use para qualquer pedido de abrir o navegador, o Chrome ou pesquisar na web (por exemplo https://www.google.com/search?q=termos). Não procure nem instale outro navegador.',
  browser_snapshot: 'Lê a página aberta no Chromium: título, URL, texto e elementos interativos numerados (ref). Necessário antes de browser_click e browser_type.',
  browser_click: 'Clica no elemento de número ref da última leitura da página no Chromium.',
  browser_type: 'Preenche o campo de número ref da última leitura da página no Chromium com o texto.',
  browser_key: 'Pressiona uma tecla na página aberta no Chromium (por exemplo Enter, Tab ou Escape).',
  browser_screenshot: 'Captura como imagem a página aberta no Chromium.',
  browser_downloads: 'Lista os arquivos que o Chromium baixou para downloads/ no workspace.',
  computer_screenshot: 'Captura a área de trabalho inteira (1280×800), inclusive janelas fora do navegador. Necessário antes de computer_click, computer_type e computer_key.',
  computer_click: 'Clica na área de trabalho nas coordenadas da última captura (computer_screenshot).',
  computer_type: 'Digita texto na janela em foco da área de trabalho.',
  computer_key: 'Pressiona uma tecla ou combinação na janela em foco da área de trabalho.',
  system_exec: summaries.system_exec,
  memory_propose: 'Propõe uma memória para o bot guardar entre conversas.',
  files_deliver: 'Entrega à pessoa um arquivo do workspace, que aparece na conversa para baixar.',
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
  readonly tools: DesktopTools
  constructor(
    private journal: Journal,
    private files: FileService,
    target: BrowserSession | DesktopTools,
    private context: () => ToolContext,
    private mode: () => 'ask' | 'full-vm',
    /** Present only when this runtime can collaborate; otherwise no team tool exists. */
    private collaboration?: CollaborationClient
  ) {
    this.tools = target instanceof BrowserSession ? new LocalDesktopTools(target, files) : target
  }
  invalidate() {
    this.observationId = undefined
    this.observationKind = undefined
  }
  list() {
    return [
      ...Object.entries(schemas).map(([name, schema]) => ({
        name,
        description: descriptions[name as keyof typeof schemas],
        inputSchema: z.toJSONSchema(schema),
      })),
      // Collaboration tools belong to the turn, not to the runtime: outside a team task
      // this list is empty and the names do not exist.
      ...(this.collaboration ? collaborationTools(this.collaboration) : []),
    ]
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
        : isCollaborationTool(name)
          ? COLLABORATION_SUMMARIES[name]
          : (summaries[name as keyof typeof schemas] ?? 'Ferramenta desconhecida')
    ).slice(0, 400)
    hooks.emit({ kind: 'tool.started', summary, detail: { name, requestId } })
    let result: ToolResult
    // Managed sessions keep the browser: the handoff gate drains started work instead.
    const cancelBrowser = () => {
      this.invalidate()
      this.tools.abort()
    }
    signal.addEventListener('abort', cancelBrowser, { once: true })
    try {
      signal.throwIfAborted()
      if (isCollaborationTool(name)) {
        if (!this.collaboration) throw runtimeError('TEAM_UNAVAILABLE', 'Collaboration is not available in this environment')
        // The Host validates origin, stage, membership, grants and budget again.
        const value = await this.collaboration.call(name, (args ?? {}) as Record<string, unknown>)
        signal.removeEventListener('abort', cancelBrowser)
        return this.finish(record, hooks, summary, { content: [{ type: 'text', text: JSON.stringify(value) }] })
      }
      if (!Object.hasOwn(schemas, name)) throw runtimeError('UNKNOWN_TOOL', 'Tool is not in the allowlist')
      const schema = schemas[name as keyof typeof schemas]
      const parsed = schema.parse(args ?? {}) as Record<string, unknown>
      if (
        ['browser_click', 'browser_type', 'computer_click', 'computer_type', 'computer_key'].includes(name) &&
        (!this.observationId || parsed.observationId !== this.observationId)
      )
        throw runtimeError('STALE_OBSERVATION', 'Observe the current page before acting')
      if (['computer_click', 'computer_type', 'computer_key'].includes(name) &&
        (this.observationKind !== 'computer' || this.desktopGeneration !== await this.tools.generation()))
        throw runtimeError('STALE_OBSERVATION', 'Observe this desktop before acting; its session may have restarted')
      const observe = ['browser_snapshot', 'browser_screenshot', 'computer_screenshot'].includes(name)
      if (!observe) this.invalidate()
      let value: unknown
      switch (name) {
        case 'browser_navigate':
          value = await this.tools.navigate(String(parsed.url))
          break
        case 'browser_snapshot':
          value = await this.tools.snapshot()
          break
        case 'browser_screenshot':
        case 'computer_screenshot': {
          const observationId = randomUUID()
          const shot = name === 'computer_screenshot' ? await this.tools.captureDesktop(observationId, hooks, signal) : await this.tools.screenshot(observationId, hooks)
          this.observationId = observationId
          this.observationKind = name === 'computer_screenshot' ? 'computer' : 'browser'
          this.desktopGeneration = name === 'computer_screenshot' ? (shot as { generation?: string }).generation ?? await this.tools.generation() : undefined
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
          await this.tools.click(Number(parsed.ref))
          break
        case 'browser_type':
          await this.tools.type(Number(parsed.ref), String(parsed.text))
          break
        case 'browser_key':
          await this.tools.key(String(parsed.key))
          break
        case 'browser_downloads':
          value = await this.tools.downloads()
          break
        case 'computer_click':
          await this.tools.computerClick(
            Number(parsed.x),
            Number(parsed.y),
            parsed.button as 'left' | 'right' | 'middle' | undefined,
            signal
          )
          break
        case 'computer_type':
          await this.tools.computerType(String(parsed.text), signal)
          break
        case 'computer_key':
          await this.tools.computerKey(String(parsed.key), signal)
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
