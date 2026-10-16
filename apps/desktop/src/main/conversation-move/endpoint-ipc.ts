import type { IpcMainInvokeEvent } from 'electron'
import {
  endpointInputSchemas,
  type MoveEndpointMethod,
  type MoveEndpointProgress,
} from '../../shared/conversation-move'
import type { IpcRegistrar } from '../ipc-registrar'
import { isRemoteUiTarget } from '../remote-ui-targets'
import { MOVE_ENDPOINT_PROGRESS, type MoveEndpoint } from './endpoint'
import { MoveError } from './errors'

/**
 * Serves this host's move endpoint to the computer coordinating a move, over the bridge. A window of this host never
 * calls these channels: its own computer's coordinator calls the endpoint directly. Channel names follow
 * `moveEndpointChannel`, written out so the IPC contract can inventory them.
 */
export function registerConversationMoveEndpointIpc(reg: IpcRegistrar, endpoint: MoveEndpoint): void {
  const serve =
    (method: MoveEndpointMethod) =>
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> => {
      if (!isRemoteUiTarget(event.sender))
        throw new MoveError('remote-only', 'This channel serves another computer only.')
      const parsed = endpointInputSchemas[method].safeParse(raw)
      if (!parsed.success) throw new Error(`Invalid ${method} input.`)
      const input = parsed.data as { operationId?: string }
      // Clone and import progress goes to the computer that asked, while its call runs.
      const unsubscribe = input.operationId
        ? endpoint.onProgress(input.operationId, (progress: MoveEndpointProgress) =>
            event.sender.send(MOVE_ENDPOINT_PROGRESS, progress)
          )
        : () => {}
      try {
        return await (endpoint[method] as (value: unknown) => Promise<unknown>)(parsed.data)
      } finally {
        unsubscribe()
      }
    }
  reg.mhandle('conversation-move-endpoint:inspect-source', serve('inspectSource'))
  reg.mhandle('conversation-move-endpoint:check-ancestry', serve('checkAncestry'))
  reg.mhandle('conversation-move-endpoint:inspect-target', serve('inspectTarget'))
  reg.mhandle('conversation-move-endpoint:freeze-source', serve('freezeSource'))
  reg.mhandle('conversation-move-endpoint:export-source', serve('exportSource'))
  reg.mhandle('conversation-move-endpoint:staging-directory', serve('stagingDirectory'))
  reg.mhandle('conversation-move-endpoint:prepare-target-workspace', serve('prepareTargetWorkspace'))
  reg.mhandle('conversation-move-endpoint:import-target', serve('importTarget'))
  reg.mhandle('conversation-move-endpoint:verify-target', serve('verifyTarget'))
  reg.mhandle('conversation-move-endpoint:release-source', serve('releaseSource'))
  reg.mhandle('conversation-move-endpoint:commit-target', serve('commitTarget'))
  reg.mhandle('conversation-move-endpoint:discard-target', serve('discardTarget'))
  reg.mhandle('conversation-move-endpoint:thaw-source', serve('thawSource'))
  reg.mhandle('conversation-move-endpoint:cleanup', serve('cleanup'))
}
