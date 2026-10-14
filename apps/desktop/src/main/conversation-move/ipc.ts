import {
  type MoveChangedEvent,
  moveCancelSchema,
  moveExecuteSchema,
  movePrepareSchema,
  moveResolveSchema,
} from '../../shared/conversation-move'
import type { IpcRegistrar } from '../ipc-registrar'
import type { ConversationMoveService } from './service'

function invalidPayload(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): never {
  const detail = error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
  throw new Error(`Invalid payload: ${detail}`)
}

export interface ConversationMoveIpcDeps {
  service: ConversationMoveService
  emitChanged(event: MoveChangedEvent): void
}

/** This computer's windows drive the moves it coordinates; hosts refuse these channels (see host-channels). */
export function registerConversationMoveIpc(reg: IpcRegistrar, deps: ConversationMoveIpcDeps): () => void {
  const { service } = deps
  reg.mhandle('conversation-move:prepare', (_event, payload: unknown) => {
    const parsed = movePrepareSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.prepare(parsed.data)
  })
  reg.mhandle('conversation-move:execute', (_event, payload: unknown) => {
    const parsed = moveExecuteSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.execute(parsed.data)
  })
  reg.mhandle('conversation-move:cancel', (_event, payload: unknown) => {
    const parsed = moveCancelSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.cancel(parsed.data.operationId)
  })
  reg.mhandle('conversation-move:resolve', (_event, payload: unknown) => {
    const parsed = moveResolveSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.resolve(parsed.data.operationId, parsed.data.action)
  })
  reg.handle('conversation-move:recoveries', () => service.listRecoveries())
  return service.onChanged((event) => deps.emitChanged(event))
}
