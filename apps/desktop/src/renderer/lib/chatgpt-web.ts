import type { Api, ChatGptWebStatusPayload } from '../../preload'
import type { ChatGptWebCapabilities, ChatGptWebCapabilitiesInfo } from '../../shared/chat'

export function hasEffectiveChatGptWebMcpWriteAccess(
  info: Pick<ChatGptWebCapabilitiesInfo, 'mcpServers'>,
  capabilities: ChatGptWebCapabilities
): boolean {
  return info.mcpServers.some((server) => server.enabled && capabilities.mcp[server.id] === 'write')
}

export type ChatGptWebAppRefreshStatus = Pick<
  ChatGptWebStatusPayload,
  'configured' | 'appRefreshRequired' | 'probeActive' | 'sessions'
>

export type ChatGptWebAppRefreshApi = Pick<Api, 'chatGptWebProbeStart' | 'openExternalUrl'>

export async function openChatGptWebAppSettings(
  status: ChatGptWebAppRefreshStatus,
  api: ChatGptWebAppRefreshApi,
  url: string
): Promise<void> {
  const activeSession = status.sessions.some((session) => session.state !== 'ended')
  if (status.configured && status.appRefreshRequired && !status.probeActive && !activeSession) {
    const result = await api.chatGptWebProbeStart()
    if (!result.ok) throw new Error(result.error || 'probe-start-failed')
  }
  await api.openExternalUrl(url)
}

export interface ChatGptWebStartOutcome {
  pairingRequired: boolean
  promptCopied: boolean
}

export type ChatGptWebCompanionLifecycleApi = Pick<
  Api,
  | 'chatGptWebCompanionStart'
  | 'chatGptWebCompanionCopyPrompt'
  | 'chatGptWebCompanionOpen'
  | 'chatGptWebCompanionEnd'
  | 'chatGptWebSetCapabilities'
>

export async function startChatGptWebCompanion(
  conversationId: string,
  api: ChatGptWebCompanionLifecycleApi = window.api
): Promise<ChatGptWebStartOutcome> {
  const result = await api.chatGptWebCompanionStart(conversationId)
  if (!result.ok || !result.kickoff) throw new Error(result.error || 'session-not-found')
  const pairingRequired = result.pairingRequired !== false
  let promptCopied = !pairingRequired
  if (pairingRequired) {
    try {
      promptCopied = (await api.chatGptWebCompanionCopyPrompt(conversationId)).ok
    } catch {
      // Clipboard is a convenience, not a lifecycle boundary. The in-tab pairing bar offers retry.
      promptCopied = false
    }
  }
  const opened = await api.chatGptWebCompanionOpen(conversationId)
  if (!opened.ok) throw new Error(opened.error || 'window-unavailable')
  return { pairingRequired, promptCopied }
}

export interface ChatGptWebRestartOutcome extends ChatGptWebStartOutcome {
  capabilities: ChatGptWebCapabilitiesInfo
}

export async function restartChatGptWebCompanion(
  conversationId: string,
  capabilities: ChatGptWebCapabilities,
  reviewLoopActive: boolean,
  api: ChatGptWebCompanionLifecycleApi = window.api
): Promise<ChatGptWebRestartOutcome> {
  if (reviewLoopActive) throw new Error('review-loop-active')
  const ended = await api.chatGptWebCompanionEnd(conversationId)
  if (!ended.ok) throw new Error('session-end-failed')
  const saved = await api.chatGptWebSetCapabilities(conversationId, capabilities)
  const started = await startChatGptWebCompanion(conversationId, api)
  return { ...started, capabilities: saved }
}
