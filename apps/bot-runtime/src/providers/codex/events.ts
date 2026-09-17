import { randomUUID } from 'node:crypto'
import type { CodexNotification, CodexServerRequest } from '@maestrly/codex-client'
import { TOOL_OUTPUT_MAX } from '@maestrly/host-protocol'
import type { TurnHooks, TurnOutcome } from '../provider.js'
import { MCP_SERVER_NAME } from './configuration.js'
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
/** Notification mapping for Codex app-server v2. Unknown notifications are ignored. */
export function notificationEvent(notification: CodexNotification, hooks: TurnHooks): Partial<TurnOutcome> | undefined {
  const params = object(notification.params)
  const item = object(params.item)
  if (notification.method === 'item/agentMessage/delta')
    hooks.emit({
      kind: 'assistant.delta',
      summary: 'Escrevendo…',
      detail: { text: text(params.delta) || text(params.text) },
    })
  if (notification.method === 'item/completed' && item.type === 'agentMessage')
    hooks.emit({
      kind: 'assistant.message',
      summary: 'O bot respondeu',
      detail: { content: text(item.text).slice(0, 64 * 1024) },
    })
  // Reasoning travels as text on its own channel; the Host folds it into a separate part.
  if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(notification.method)) {
    const delta = text(params.delta) || text(params.text)
    if (delta) hooks.emit({ kind: 'assistant.delta', summary: 'Pensando…', detail: { text: delta, channel: 'reasoning' } })
  }
  const summaries: Record<string, string> = {
    commandExecution: 'Executando um comando',
    fileChange: 'Alterando arquivos',
    mcpToolCall: 'Executando uma ferramenta',
  }
  const summary = summaries[text(item.type)]
  if (summary && ['item/started', 'item/completed'].includes(notification.method))
    hooks.emit({
      kind: notification.method === 'item/started' ? 'tool.started' : 'tool.finished',
      summary,
      detail: { tool: item.type, summary, ...toolDetail(item) },
    })
  if (notification.method === 'thread/tokenUsage/updated') {
    const tokenUsage = object(params.tokenUsage)
    const total = object(tokenUsage.total)
    const last = object(tokenUsage.last)
    const usage: NonNullable<TurnOutcome['usage']> = {}
    const count = (value: unknown) => (Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined)
    if (count(total.inputTokens) != null) usage.inputTokens = count(total.inputTokens)
    if (count(total.outputTokens) != null) usage.outputTokens = count(total.outputTokens)
    if (count(total.cachedInputTokens) != null) usage.cachedInputTokens = count(total.cachedInputTokens)
    if (count(total.reasoningOutputTokens) != null) usage.reasoningOutputTokens = count(total.reasoningOutputTokens)
    // What currently occupies the window is the last request, not the whole thread's total.
    if (count(last.totalTokens) != null) usage.contextTokens = count(last.totalTokens)
    if (count(tokenUsage.modelContextWindow) != null) usage.modelContextWindow = count(tokenUsage.modelContextWindow)
    return { usage }
  }
  if (notification.method === 'turn/completed') {
    const turn = object(params.turn)
    return {
      status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'succeeded',
      ...(turn.status === 'failed'
        ? { error: { code: 'PROVIDER_ERROR', message: 'Codex failed to complete the turn' } }
        : {}),
    }
  }
  if (['error', 'turn/error'].includes(notification.method))
    return { status: 'failed', error: { code: 'PROVIDER_ERROR', message: 'Codex reported an error' } }
  return undefined
}
/**
 * What a tool card needs beyond the summary: identity (so start and finish match), the command
 * or arguments, the end of the output, the exit code and the files touched. Bounded here so an
 * event never carries more than the transcript keeps.
 */
export function toolDetail(item: Record<string, unknown>): Record<string, unknown> {
  const detail: Record<string, unknown> = {}
  if (text(item.id)) detail.callId = text(item.id).slice(0, 128)
  if (text(item.command)) detail.command = text(item.command).slice(0, 4096)
  const output = text(item.aggregatedOutput) || text(item.output)
  if (output) detail.output = output.length > TOOL_OUTPUT_MAX ? output.slice(output.length - TOOL_OUTPUT_MAX) : output
  if (typeof item.exitCode === 'number' && Number.isInteger(item.exitCode)) detail.exitCode = item.exitCode
  if (text(item.server)) detail.server = text(item.server).slice(0, 80)
  if (text(item.tool)) detail.name = text(item.tool).slice(0, 80)
  if (item.arguments !== undefined) {
    const json = JSON.stringify(item.arguments) ?? ''
    detail.arguments = json.length <= 4096 ? item.arguments : { truncated: true, preview: json.slice(0, 4096) }
  }
  if (item.error) detail.error = typeof item.error === 'string' ? item.error.slice(0, 2000) : true
  if (Array.isArray(item.changes))
    detail.changes = item.changes
      .map(object)
      .filter((change) => text(change.path))
      .slice(0, 64)
      .map((change) => ({ path: text(change.path).slice(0, 512), kind: (text(change.kind) || text(object(change.kind).type) || 'update').slice(0, 20) }))
  return detail
}
export async function serverRequest(request: CodexServerRequest, hooks: TurnHooks) {
  const params = object(request.params)
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
    const command = request.method.includes('commandExecution')
    const parameters = Object.fromEntries(Object.entries(params).filter(([key]) => !/diff/i.test(key)))
    const bounded =
      Buffer.byteLength(JSON.stringify(parameters)) > 8192
        ? { description: 'Parameters exceed preview limit' }
        : parameters
    const decision = await hooks.requestApproval({
      actionId: randomUUID(),
      title: command ? 'Executar um comando' : 'Alterar arquivos',
      reason: text(params.reason).slice(0, 2000),
      consequence: command ? 'Executa o comando no computador do bot' : 'Modifica arquivos no computador do bot',
      parameters: bounded,
    })
    // Codex 0.153.4 v2 schema uses decline to deny an action and continue the turn.
    return { decision: decision === 'approve' ? 'accept' : 'decline' }
  }
  if (/requestUserInput$/.test(request.method)) {
    const questions = Array.isArray(params.questions)
      ? params.questions.map(object)
      : [{ id: 'answer', question: params.question }]
    const answers: Record<string, { answers: string[] }> = {}
    // v2 assumption: answers are keyed by question id with {answers: string[]} values.
    for (const question of questions) {
      const answer = await hooks.askQuestion({
        actionId: randomUUID(),
        title: text(question.header) || 'Uma pergunta do bot',
        question: text(question.question) || 'Como deseja continuar?',
      })
      answers[text(question.id) || 'answer'] = { answers: [answer] }
    }
    return { answers }
  }
  /**
   * With approvals on request, Codex asks the client to confirm every MCP tool call. The only
   * configured server is the bot's own catalogue (browser, computer, files, memory), whose limits
   * the Host already enforces, so it is accepted; anything else is declined instead of refused.
   * Without this answer Codex treats each tool call as refused, which silently disables the
   * browser and computer tools in `ask` mode.
   */
  if (request.method === 'mcpServer/elicitation/request') {
    const server = text(params.server_name ?? params.serverName ?? params.server ?? object(params.request).server_name)
    const mine = !server || server === MCP_SERVER_NAME
    if (!mine)
      hooks.emit({
        kind: 'diagnostic',
        summary: 'Pedido de um servidor de ferramentas desconhecido recusado',
        detail: { server: server.slice(0, 80) },
      })
    return { action: mine ? 'accept' : 'decline' }
  }
  hooks.emit({
    kind: 'diagnostic',
    summary: 'Solicitação desconhecida do provedor',
    detail: { method: request.method.slice(0, 200) },
  })
  throw Object.assign(new Error('Unsupported Codex server method'), { code: -32601 })
}
