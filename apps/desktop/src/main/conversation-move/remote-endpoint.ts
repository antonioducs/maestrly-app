import type { MoveEndpointProgress } from '../../shared/conversation-move'
import type { HostId } from '../../shared/host-key'
import { MOVE_ENDPOINT_METHODS, MOVE_ENDPOINT_PROGRESS, type MoveEndpoint, moveEndpointChannel } from './endpoint'
import { MoveError, moveErrorCode, moveErrorMessage } from './errors'

const UNREACHABLE = new Set(['not-connected', 'connection-lost'])

/** A host's move endpoint, reached over its bridge from this computer's main process. */
export function createRemoteMoveEndpoint(
  hostId: HostId,
  deps: {
    call: (channel: string, input: unknown) => Promise<unknown>
    onEvent: (listener: (hostId: HostId, channel: string, args: unknown[]) => void) => () => void
  }
): MoveEndpoint {
  const call = async (method: (typeof MOVE_ENDPOINT_METHODS)[number], input: unknown): Promise<any> => {
    try {
      return await deps.call(moveEndpointChannel(method), input)
    } catch (error) {
      // The host's own refusals keep their code; a lost bridge reads as the host being unavailable.
      if (UNREACHABLE.has(moveErrorCode(error) ?? ''))
        throw new MoveError('host-unavailable', `The host is not reachable: ${moveErrorMessage(error)}`)
      throw error
    }
  }
  const methods = Object.fromEntries(
    MOVE_ENDPOINT_METHODS.map((method) => [method, (input: unknown) => call(method, input)])
  ) as Omit<MoveEndpoint, 'hostId' | 'onProgress'>
  return {
    hostId,
    ...methods,
    onProgress(operationId, listener) {
      return deps.onEvent((from, channel, args) => {
        const progress = args[0] as MoveEndpointProgress | undefined
        if (from === hostId && channel === MOVE_ENDPOINT_PROGRESS && progress?.operationId === operationId)
          listener(progress)
      })
    },
  }
}
