import {
  localConversationConfirmInputSchema,
  localConversationPrepareInputSchema,
} from '../../shared/local-conversation'
import type { IpcRegistrar } from '../ipc-registrar'
import { confirmLocalConversation, prepareLocalConversation } from './service'

function invalidPayload(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): never {
  const detail = error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
  throw new Error(`Invalid payload: ${detail}`)
}

export function registerLocalConversationIpc(reg: IpcRegistrar): void {
  reg.mhandle('conversation:local-prepare', (_event, payload: unknown) => {
    const parsed = localConversationPrepareInputSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return prepareLocalConversation(parsed.data)
  })
  reg.mhandle('conversation:local-confirm', (_event, payload: unknown) => {
    const parsed = localConversationConfirmInputSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return confirmLocalConversation(parsed.data.token)
  })
}
