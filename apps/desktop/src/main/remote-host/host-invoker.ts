import type { HostId } from '../../shared/host-key'

/** The part of the host registry that reaches a remote host's handlers. */
export interface HostInvokerRegistry {
  list(): Array<{ id: HostId; state: string }>
  use(
    hostId: HostId,
    origin: number,
    role: () => { role: 'main' }
  ): { invoke(origin: number, channel: string, args: unknown[]): Promise<unknown> }
}

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostUnavailableError'
  }
}

export interface HostInvoker {
  online(hostId: HostId): boolean
  invoke<T>(hostId: HostId, channel: string, args: unknown[], opts?: { timeoutMs?: number }): Promise<T>
}

/**
 * Calls a remote host's IPC handlers from the main process, as the main window would: the host knows this computer's
 * callers by a window, so the call goes out under the main window's origin and fails when there is none.
 */
export function createHostInvoker(deps: {
  registry(): HostInvokerRegistry | null
  mainWebContentsId(): number | null
}): HostInvoker {
  return {
    online(hostId) {
      return !!deps
        .registry()
        ?.list()
        .some((host) => host.id === hostId && host.state === 'online')
    },
    async invoke<T>(hostId: HostId, channel: string, args: unknown[], opts: { timeoutMs?: number } = {}): Promise<T> {
      const registry = deps.registry()
      const origin = deps.mainWebContentsId()
      if (!registry || origin === null) throw new HostUnavailableError('No window can reach the host.')
      const call = registry.use(hostId, origin, () => ({ role: 'main' })).invoke(origin, channel, args) as Promise<T>
      if (!opts.timeoutMs) return call
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HostUnavailableError('The host did not answer in time.')), opts.timeoutMs)
      })
      try {
        return await Promise.race([call, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
