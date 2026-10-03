/**
 * The subset of the Agent Client Protocol (https://agentclientprotocol.com, protocol version 1) that Maestrly
 * speaks. Field names follow the wire format exactly; unknown fields sent by an agent are tolerated.
 */

export const ACP_PROTOCOL_VERSION = 1
/** JSON-RPC error code agents return when a request needs `authenticate` first. */
export const ACP_AUTH_REQUIRED_CODE = -32000
/** JSON-RPC error code for an unknown session id (for example on `session/resume`). */
export const ACP_RESOURCE_NOT_FOUND_CODE = -32002

export type AcpContentBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export interface AcpMcpServerHttp {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

export interface AcpConfigSelectOption {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name?: string
  category?: string
  type: 'select' | 'boolean'
  currentValue: string | boolean
  options?: AcpConfigSelectOption[]
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities?: Record<string, unknown>
  authMethods?: { id: string; name: string; description?: string }[]
  agentInfo?: { name: string; title?: string; version: string }
}

export interface AcpSessionSetupResult {
  sessionId?: string
  configOptions?: AcpConfigOption[]
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export interface AcpPromptResult {
  stopReason: AcpStopReason
}

export interface AcpToolCallMeta {
  mcp?: { server?: string; tool?: string }
  is_mcp_tool_call?: boolean
}

export type AcpMessageChunkUpdate = {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'
  content: AcpContentBlock | { type: string }
}

export type AcpToolCallUpdate = {
  sessionUpdate: 'tool_call' | 'tool_call_update'
  toolCallId: string
  title?: string
  status?: string
  rawInput?: unknown
  _meta?: AcpToolCallMeta
}

export type AcpSessionUpdate =
  | AcpMessageChunkUpdate
  | AcpToolCallUpdate
  | { sessionUpdate: string; [key: string]: unknown }

export interface AcpSessionNotification {
  sessionId: string
  update: AcpSessionUpdate
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AcpPermissionRequest {
  sessionId: string
  toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown; _meta?: AcpToolCallMeta }
  options: AcpPermissionOption[]
}

export type AcpPermissionOutcome = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}

export function isAcpMessageChunk(update: AcpSessionUpdate): update is AcpMessageChunkUpdate {
  return update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk'
}

export function isAcpToolCallUpdate(update: AcpSessionUpdate): update is AcpToolCallUpdate {
  return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
}
