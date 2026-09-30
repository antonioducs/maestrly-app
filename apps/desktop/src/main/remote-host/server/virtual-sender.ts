import { EventEmitter } from 'node:events'

// Real WebContents ids are positive, and the popup manager uses -1 as "no sender".
let nextId = -1000

/**
 * One renderer of another computer, as this host's IPC handlers see it: the `sender` of the events the bridge
 * dispatches. It has the part of a WebContents those handlers use (identity, `send`, `isDestroyed` and the
 * `destroyed` event), and what it is sent becomes `event` frames for that renderer.
 */
export class VirtualSender extends EventEmitter {
  readonly id = nextId--
  private destroyed = false

  constructor(private readonly deliver: (channel: string, args: unknown[]) => void) {
    super()
    // Each subscription of a renderer (chat streams, terminals) listens for `destroyed`.
    this.setMaxListeners(0)
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.destroyed) this.deliver(channel, args)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** Performance diagnostics list renderers by process; a remote renderer has none here. */
  getOSProcessId(): number {
    return 0
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
    this.removeAllListeners()
  }
}
