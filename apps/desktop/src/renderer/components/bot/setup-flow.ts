import type { BotActionName, BotPermissionCeiling, BotSettingsView, BotSetupInput } from '../../../shared/bot'

/**
 * Answering one incoming bot request.
 *
 * A bot is never created ahead of time here: it exists because a request asked for access, and the
 * connection minted for that request is what the approval then names. The two steps are separate calls to
 * the main process, so this keeps them honest — the request must still be waiting before anything is
 * created, and a connection already minted for it is reused instead of a second one being connected when
 * the approval itself failed and the person tries again.
 */
export interface BotSetupDraft {
  requestId: string
  name: string
  workspaceIds: string[]
  selections: Array<{ providerId: string; modelId: string }>
  actions: BotActionName[]
  /** How far this bot's conversations may go before they stop and ask the person at this computer. */
  permissionCeiling: BotPermissionCeiling
}

export interface BotSetupApi {
  settings(): Promise<BotSettingsView>
  connect(input: BotSetupInput): Promise<BotSettingsView>
  authorize(requestId: string, approved: boolean, connectionId: string): Promise<BotSettingsView>
}

export interface BotSetupOptions {
  api: BotSetupApi
  draft: BotSetupDraft
  /** A bot already created for this same request by an earlier attempt, reused instead of a new one. */
  createdConnectionId?: string
  messages: { requestGone: string; createFailed: string }
  /** Every view this flow learns about, so the screen keeps up while the two calls run. */
  onView?: (view: BotSettingsView) => void
  /** Reported the moment a bot exists, which is before it is known whether the approval succeeds. */
  onCreated?: (connectionId: string) => void
}

export async function approveRequestWithNewBot(options: BotSetupOptions): Promise<{
  connectionId: string
  view: BotSettingsView
}> {
  const { api, draft, messages } = options
  const latest = await api.settings()
  options.onView?.(latest)
  // An expired or already answered request grants nothing, and never lends its setup to another request.
  if (!latest.pendingAuthorizations.some((entry) => entry.id === draft.requestId)) throw new Error(messages.requestGone)
  let connectionId = options.createdConnectionId ?? ''
  if (!connectionId) {
    const known = new Set(latest.connections.map((connection) => connection.id))
    const payload: BotSetupInput = {
      name: draft.name.trim(),
      workspaceIds: draft.workspaceIds,
      providerIds: [...new Set(draft.selections.map((selection) => selection.providerId))],
      selections: draft.selections,
      actions: draft.actions,
      permissionCeiling: draft.permissionCeiling,
    }
    const connected = await api.connect(payload)
    options.onView?.(connected)
    const fresh = connected.connections.find((connection) => !connection.legacy && !known.has(connection.id))
    if (!fresh) throw new Error(messages.createFailed)
    connectionId = fresh.id
    options.onCreated?.(fresh.id)
  }
  const view = await api.authorize(draft.requestId, true, connectionId)
  return { connectionId, view }
}
