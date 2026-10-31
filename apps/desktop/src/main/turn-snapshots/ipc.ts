import {
  turnRevertConfirmInputSchema,
  turnRevertPrepareInputSchema,
  turnSnapshotDiffInputSchema,
  turnSnapshotEnabledInputSchema,
  turnSnapshotListInputSchema,
} from '../../shared/turn-snapshots'
import type { IpcRegistrar } from '../ipc-registrar'
import { getConversation } from '../store'
import { setTurnSnapshotsEnabled, warmTurnSnapshots } from './lifecycle'
import { clearTurnSnapshots, forgetTurnSnapshotUsage, turnSnapshotUsage } from './maintenance'
import {
  confirmTurnRevert,
  listTurnSnapshots,
  prepareTurnRevert,
  type RevertDeps,
  turnFilePatch,
  turnSnapshotDetail,
} from './revert'

function invalidPayload(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): never {
  const detail = error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
  throw new Error(`Invalid payload: ${detail}`)
}

interface Schema<T> {
  safeParse(
    value: unknown
  ): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

function parse<T>(schema: Schema<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return invalidPayload(parsed.error)
  return parsed.data
}

/** `deps.isRunning` comes from the chat service, which imports this module's turn hooks. */
export function registerTurnSnapshotIpc(reg: IpcRegistrar, deps: RevertDeps): void {
  reg.handle('turnSnapshots:list', (_event, payload: unknown) => {
    const input = parse(turnSnapshotListInputSchema, payload)
    const conversation = getConversation(input.conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    if (input.recordId) return turnSnapshotDetail(input.conversationId, input.recordId)
    warmTurnSnapshots(conversation, deps.isRunning(conversation.id))
    return listTurnSnapshots(input.conversationId)
  })
  reg.handle('turnSnapshots:diff', (_event, payload: unknown) =>
    turnFilePatch(parse(turnSnapshotDiffInputSchema, payload))
  )
  reg.mhandle('turnSnapshots:prepare', (_event, payload: unknown) =>
    prepareTurnRevert(parse(turnRevertPrepareInputSchema, payload), deps)
  )
  reg.mhandle('turnSnapshots:confirm', (_event, payload: unknown) =>
    confirmTurnRevert(parse(turnRevertConfirmInputSchema, payload), deps)
  )
  reg.handle('turnSnapshots:usage', () => turnSnapshotUsage())
  reg.mhandle('turnSnapshots:clear', async () => {
    await clearTurnSnapshots()
    forgetTurnSnapshotUsage()
    return { ok: true }
  })
  reg.mhandle('turnSnapshots:set-enabled', (_event, payload: unknown) => {
    setTurnSnapshotsEnabled(parse(turnSnapshotEnabledInputSchema, payload).enabled)
    return { ok: true }
  })
}
