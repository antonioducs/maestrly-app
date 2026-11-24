import type { IpcMainInvokeEvent } from 'electron'
import type { MaestroSwarmTask } from '../../shared/maestro-swarm'
import { listSwarm, stopSwarm } from './maestro-swarm'

export interface MaestroSwarmIpcRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mhandle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
}

export interface MaestroSwarmIpcDeps {
  stopChat?: (conversationId: string) => Promise<void> | void
}

export type MaestroSwarmStopResult =
  | { ok: true; stopped: number }
  | { ok: false; stopped: 0; error: 'invalid-conversation' }

async function defaultStopChat(conversationId: string): Promise<void> {
  const { stopChat } = await import('./service')
  await stopChat(conversationId)
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function registerMaestroSwarmIpc(reg: MaestroSwarmIpcRegistrar, deps?: MaestroSwarmIpcDeps): void {
  const stopChat = deps?.stopChat ?? defaultStopChat

  reg.mhandle('chat:maestro:swarm:get', (_event, conversationId: unknown): MaestroSwarmTask[] =>
    validConversationId(conversationId) ? listSwarm(conversationId) : []
  )

  reg.mhandle(
    'chat:maestro:swarm:stop',
    async (_event, conversationId: unknown): Promise<MaestroSwarmStopResult> => {
      if (!validConversationId(conversationId)) {
        return { ok: false, stopped: 0, error: 'invalid-conversation' }
      }
      const { workerConversationIds } = stopSwarm(conversationId)
      const targets = [conversationId, ...new Set(workerConversationIds.filter((id) => id !== conversationId))]
      await Promise.allSettled(targets.map((id) => Promise.resolve().then(() => stopChat(id))))
      return { ok: true, stopped: workerConversationIds.length }
    }
  )
}
