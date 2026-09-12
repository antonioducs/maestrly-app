/** Serialize note saves and retain pending content until persistence succeeds.
 * Failed writes remain retryable rather than silently advancing the saved baseline. */

export class NotesSaveQueue {
  private pending: { id: string; md: string } | null = null
  private chain: Promise<void> = Promise.resolve()

  get pendingEdit(): { id: string; md: string } | null {
    return this.pending
  }

  setPending(id: string, md: string): void {
    this.pending = { id, md }
  }

  clearPending(): void {
    this.pending = null
  }

  flush(write: (id: string, md: string) => Promise<void>): Promise<void> {
    const p = this.pending
    if (!p) return this.chain
    this.pending = null
    const run = write(p.id, p.md)
    this.chain = this.chain.catch(() => {}).then(() => run)
    return this.chain
  }

  settle(): Promise<void> {
    return this.chain
  }
}

export interface NotesMemoryEvictionOptions {
  pendingDelete: boolean
  conflict: boolean
  flushBody: () => Promise<void>
  titleDirty: boolean
  commitTitle: () => Promise<void>
  persistOpenPage: () => void
}

export async function prepareNotesMemoryEviction(
  options: NotesMemoryEvictionOptions
): Promise<{ safe: boolean; reason?: string }> {
  if (options.pendingDelete) return { safe: false, reason: 'delete-modal' }
  if (options.conflict) return { safe: false, reason: 'conflict' }

  try {
    await options.flushBody()
  } catch {
    return { safe: false, reason: 'write-failed' }
  }

  if (options.titleDirty) {
    try {
      await options.commitTitle()
    } catch {
      return { safe: false, reason: 'title-write-failed' }
    }
  }

  options.persistOpenPage()
  return { safe: true }
}
