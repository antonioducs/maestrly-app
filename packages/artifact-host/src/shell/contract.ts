// Shared by the host (Node) and the viewer shell (browser): no DOM and no Node APIs.

export const ARTIFACT_HEADER = 'x-maestrly-artifact'
export const SESSION_COOKIE = 'maestrly_artifact_session'
export const MAX_BRIDGE_MESSAGE_CHARS = 300
/** Never includes `allow-same-origin` or `allow-top-navigation`: content keeps an opaque origin. */
export const CONTENT_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox'

export type ViewerIdentity = { kind: 'owner' }

export interface ViewerVersion {
  number: number
  createdAt: number
  summary: string
}

export interface ViewerState {
  artifact: { id: string; title: string; currentVersion: number; versions: ViewerVersion[] }
  identity: ViewerIdentity
}

export interface FrameResponse {
  url: string
  expiresAt: number
}

export type BridgeMessage = { type: 'ready' } | { type: 'error'; message: string }

/** Messages come from untrusted page code: accept only known shapes and cap every string. */
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { source?: unknown; type?: unknown; message?: unknown }
  if (v.source !== 'maestrly-bridge') return null
  if (v.type === 'ready') return { type: 'ready' }
  if (v.type === 'error') return { type: 'error', message: String(v.message ?? '').slice(0, MAX_BRIDGE_MESSAGE_CHARS) }
  return null
}
