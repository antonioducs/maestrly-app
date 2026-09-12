import {
  migrationCancelSchema,
  migrationExecuteSchema,
  migrationPrepareSchema,
  migrationResolveSchema,
  type MigrationChangedEvent,
} from '../../shared/conversation-migration'
import type { IpcRegistrar } from '../ipc-registrar'
import { conversationMigrationService, type ConversationMigrationService } from './service'

function invalidPayload(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): never {
  const detail = error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
  throw new Error(`Invalid payload: ${detail}`)
}

export interface ConversationMigrationIpcDeps {
  service?: ConversationMigrationService
  emitChanged(event: MigrationChangedEvent): void
}

export function registerConversationMigrationIpc(reg: IpcRegistrar, deps: ConversationMigrationIpcDeps): () => void {
  const service = deps.service ?? conversationMigrationService

  reg.mhandle('conversation:migration-prepare', (_event, payload: unknown) => {
    const parsed = migrationPrepareSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.prepare(parsed.data.conversationId, parsed.data.destinationBranch)
  })
  reg.mhandle('conversation:migration-execute', (_event, payload: unknown) => {
    const parsed = migrationExecuteSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.execute(
      parsed.data.operationId,
      parsed.data.selectedIgnoredPaths,
      parsed.data.confirmedSensitivePaths
    )
  })
  reg.mhandle('conversation:migration-cancel', (_event, payload: unknown) => {
    const parsed = migrationCancelSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.cancel(parsed.data.operationId)
  })
  reg.mhandle('conversation:migration-resolve', (_event, payload: unknown) => {
    const parsed = migrationResolveSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload(parsed.error)
    return service.resolve(parsed.data.operationId, parsed.data.action)
  })
  reg.handle('conversation:migration-list-recoveries', () => service.listRecoveries())
  return service.onChanged((event) => deps.emitChanged(event))
}
