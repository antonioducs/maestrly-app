interface DialogSuppressionSender {
  id: number
  once(event: 'destroyed' | 'render-process-gone', listener: (...args: unknown[]) => void): unknown
  on(event: 'did-start-navigation', listener: (...args: unknown[]) => void): unknown
  removeListener(
    event: 'destroyed' | 'render-process-gone' | 'did-start-navigation',
    listener: (...args: unknown[]) => void
  ): unknown
}

interface DialogSuppressionLease {
  onEnded: (...args: unknown[]) => void
  onNavigation: (...args: unknown[]) => void
}

export interface DialogSuppressionLeases {
  update(sender: DialogSuppressionSender, suppress: boolean): void
  ownerIds(): ReadonlySet<number>
}

/**
 * Tracks one modal lease per renderer. The renderer already collapses nested Radix dialogs into a
 * single true/false pair, while this tracker prevents one renderer from releasing another's lease.
 * A renderer that disappears cannot leave native views and tool shortcuts suppressed forever.
 */
export function createDialogSuppressionLeases(
  onChange: (ownerWebContentsIds: ReadonlySet<number>) => void
): DialogSuppressionLeases {
  const leases = new Map<DialogSuppressionSender, DialogSuppressionLease>()

  const publish = (): void => onChange(new Set([...leases.keys()].map((sender) => sender.id)))

  const release = (sender: DialogSuppressionSender): void => {
    const lease = leases.get(sender)
    if (!lease) return
    leases.delete(sender)
    sender.removeListener('destroyed', lease.onEnded)
    sender.removeListener('render-process-gone', lease.onEnded)
    sender.removeListener('did-start-navigation', lease.onNavigation)
    publish()
  }

  return {
    update(sender, suppress) {
      if (!suppress) {
        release(sender)
        return
      }
      if (leases.has(sender)) return
      const onEnded = () => release(sender)
      const onNavigation = (...args: unknown[]) => {
        // Electron: (event, url, isInPlace, isMainFrame, ...). A main-frame reload replaces the JS
        // context that owned the Dialog; subframe navigation must not release its lease.
        if (args[3] !== false) release(sender)
      }
      leases.set(sender, { onEnded, onNavigation })
      sender.once('destroyed', onEnded)
      sender.once('render-process-gone', onEnded)
      sender.on('did-start-navigation', onNavigation)
      publish()
    },
    ownerIds: () => new Set([...leases.keys()].map((sender) => sender.id)),
  }
}
