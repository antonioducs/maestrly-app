import { useEffect } from 'react'

export function preparePlanPanelMemoryEviction(
  busy: boolean,
  editingLine: number | null,
  persistDraft: () => void
): { safe: boolean; reason?: string } {
  if (busy) return { safe: false, reason: 'busy' }
  if (editingLine !== null) return { safe: false, reason: 'inline-comment-editing' }
  persistDraft()
  return { safe: true }
}

export function usePanelMemoryEviction(
  convId: string,
  tab: string,
  prepare: () => Promise<{ safe: boolean; reason?: string }> | { safe: boolean; reason?: string }
): void {
  useEffect(() => {
    return window.api.onPrepareMemoryEviction((payload) => {
      if (payload.convId !== convId || payload.tab !== tab) return
      void Promise.resolve()
        .then(prepare)
        .then((result) => {
          window.api.memoryEvictionReady({
            requestId: payload.requestId,
            safe: result.safe,
            ...(result.reason ? { reason: result.reason } : {}),
          })
        })
        .catch(() => {
          window.api.memoryEvictionReady({ requestId: payload.requestId, safe: false, reason: 'prepare-failed' })
        })
    })
  }, [convId, prepare, tab])
}
