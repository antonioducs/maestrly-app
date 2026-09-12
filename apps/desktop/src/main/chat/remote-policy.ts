import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import type { ToolSet } from 'ai'
import { APP_TOOL_POLICY } from './tool-policy'
import { getDb } from '../store'
import type { ChatMode, ChatPermMode } from '../../shared/chat'

export interface RemoteChatPolicy {
  conversationId: string
  mode: ChatMode | 'chat'
  permMode: ChatPermMode
  cwd: string
  providerIds: string[]
  allowCommands: boolean
  allowWeb: boolean
  allowAppTools: boolean
  allowMcp: boolean
  allowPush: boolean
}
const active = new Map<string, RemoteChatPolicy>(),
  context = new AsyncLocalStorage<RemoteChatPolicy>()
export function remoteChatPolicy(id = '') {
  return active.get(id) ?? context.getStore()
}
export function withRemoteChatPolicy<T>(policy: RemoteChatPolicy, fn: () => T): T {
  return context.run(policy, fn)
}
export function registerRemoteChatPolicy(policy: RemoteChatPolicy) {
  active.set(policy.conversationId, policy)
  return () => active.delete(policy.conversationId)
}
export function isWebManagedConversation(id: string): boolean {
  try {
    return !!getDb().prepare('select 1 from platform_chat_sessions where conversation_id=?').get(id)
  } catch {
    return false
  }
}
export function assertRemoteChatPermission(
  policy: RemoteChatPolicy,
  input: { action: string; resources: string[] }
): 'read' | 'ask' {
  const deny = (why: string): never => {
    throw new Error('Remote chat operation is not allowed: ' + why)
  }
  const readOnly = !['agent', 'design'].includes(policy.mode)
  const protectedEffect = () => (policy.permMode === 'ask' ? 'ask' : 'read')
  if (input.action === 'external_directory') return policy.permMode === 'full' ? 'read' : 'ask'
  if (['read', 'edit', 'grep', 'glob'].includes(input.action)) {
    let external = false
    for (const r of input.resources) {
      const relative = path.relative(policy.cwd, path.resolve(policy.cwd, r))
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) external = true
    }
    if (input.action === 'edit') {
      if (readOnly) deny('read-only conversation')
      if (external && policy.permMode !== 'full') return 'ask'
      return protectedEffect()
    }
    if (external && policy.permMode !== 'full') return 'ask'
    if (
      policy.permMode !== 'full' &&
      input.resources.some((r) => /(?:^|[/\\])\.env(?:\.|$)/.test(r) && !r.endsWith('.example'))
    )
      return 'ask'
    return 'read'
  }
  if (input.action === 'bash') {
    if (!policy.allowCommands || readOnly) deny('commands')
    if (!policy.allowPush && input.resources.some((r) => /\bgit\s+(?:-[^\s]+\s+)*push\b/.test(r))) deny('git push')
    return policy.permMode === 'full' ? 'read' : 'ask'
  }
  if (input.action === 'webfetch') {
    if (!policy.allowWeb) deny('web access')
    return protectedEffect()
  }
  if (input.action === 'mcp') {
    for (const name of input.resources) {
      const app = APP_TOOL_POLICY[name as keyof typeof APP_TOOL_POLICY]
      if (!(app ? policy.allowAppTools : policy.allowMcp)) deny(app ? 'application tools' : 'MCP')
      if (readOnly && !app?.readOnly) deny('read-only conversation')
      if (!policy.allowCommands && name.startsWith('terminal_')) deny('terminal')
      if (!policy.allowWeb && name.startsWith('browser_')) deny('browser')
    }
    return input.resources.every((name) => APP_TOOL_POLICY[name as keyof typeof APP_TOOL_POLICY]?.readOnly)
      ? 'read'
      : protectedEffect()
  }
  return deny(input.action)
}
/** Capture the policy for SDK callbacks and delegated tasks that execute outside the admission context. */
export function governRemoteChatTools(tools: ToolSet, id: string) {
  const policy = remoteChatPolicy(id)
  if (!policy) return
  for (const [name, tool] of Object.entries(tools))
    if (tool.execute) {
      const execute = tool.execute
      tools[name] = { ...tool, execute: (...args) => withRemoteChatPolicy(policy, () => execute(...args)) }
    }
}
