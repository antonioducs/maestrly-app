import { randomUUID } from 'node:crypto'
import type { CodexNotification, CodexServerRequest } from '@maestrly/codex-client'
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
      detail: { tool: item.type, summary, ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}) },
    })
  if (notification.method === 'thread/tokenUsage/updated') {
    const total = object(object(params.tokenUsage).total)
    const usage: NonNullable<TurnOutcome['usage']> = {}
    if (Number.isInteger(total.inputTokens) && Number(total.inputTokens) >= 0)
      usage.inputTokens = Number(total.inputTokens)
    if (Number.isInteger(total.outputTokens) && Number(total.outputTokens) >= 0)
      usage.outputTokens = Number(total.outputTokens)
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
