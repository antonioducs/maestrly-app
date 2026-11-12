// A whiteboard's board, between its canvas in the frame and the host. The canvas asks for the board and sends what the
// person changes; the viewer reads and writes them with its own session, and keeps the canvas current by asking the
// host for changes, one long request after another.
import { type ArtifactApi, bodyOf } from './api.js'
import { boardError, createBoardPoller } from './board-model.js'
import type { BoardError, BridgeMessage, ShellMessage } from './contract.js'

type Request = Extract<BridgeMessage, { type: 'board-load' | 'board-push' }>

export interface BoardSync {
  handle(message: Request): void
  stop(): void
}

export interface BoardSyncOptions {
  api: ArtifactApi
  frame: HTMLIFrameElement
  /** The thumbnail capture: the board is shown, never changed or followed. */
  preview: boolean
  /** The viewer lost access to the board while following it. */
  onLost(): void
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createBoardSync(options: BoardSyncOptions): BoardSync {
  const { api, frame } = options
  const poller = createBoardPoller()
  let following = false
  let stopped = false

  function toCanvas(message: ShellMessage): void {
    // The frame's origin is opaque, so the message cannot be addressed to a specific one.
    frame.contentWindow?.postMessage({ source: 'maestrly-shell', ...message }, '*')
  }

  const failed = (requestId: string, type: 'board-loaded' | 'board-pushed', error: BoardError) =>
    toCanvas({ type, requestId, ok: false, error })

  async function follow(): Promise<void> {
    if (following || options.preview) return
    following = true
    for (;;) {
      const step = poller.next()
      if (!step || stopped) break
      if (step.delayMs) await pause(step.delayMs)
      if (stopped) break
      let status = 0
      let body: Record<string, unknown> = {}
      try {
        const response = await api.read(`board/changes?since=${step.since}`)
        status = response.status
        body = await bodyOf(response)
      } catch {
        // A network failure counts as one more failure; the poller waits longer before the next request.
      }
      const revision = typeof body.revision === 'number' ? body.revision : undefined
      if (status === 200 && revision !== undefined && Array.isArray(body.elements) && body.elements.length)
        toCanvas({ type: 'board-changes', revision, elements: body.elements })
      poller.result({ status, revision })
      if (status === 404) {
        options.onLost()
        break
      }
    }
    following = false
  }

  async function load(requestId: string): Promise<void> {
    const response = await api.read('board').catch(() => null)
    if (!response) return failed(requestId, 'board-loaded', 'failed')
    if (response.status !== 200) return failed(requestId, 'board-loaded', boardError(response.status))
    const body = await bodyOf(response)
    if (typeof body.revision !== 'number' || !Array.isArray(body.elements))
      return failed(requestId, 'board-loaded', 'failed')
    toCanvas({
      type: 'board-loaded',
      requestId,
      ok: true,
      revision: body.revision,
      elements: body.elements,
      canEdit: !options.preview && body.canEdit === true,
    })
    poller.result({ status: 200, revision: body.revision })
    void follow()
  }

  async function push(requestId: string, elements: unknown[]): Promise<void> {
    if (options.preview) return failed(requestId, 'board-pushed', 'read_only')
    const response = await api.write('board/elements', 'POST', { elements }).catch(() => null)
    if (!response) return failed(requestId, 'board-pushed', 'failed')
    if (response.status !== 200) return failed(requestId, 'board-pushed', boardError(response.status))
    const body = await bodyOf(response)
    if (typeof body.revision !== 'number' || !Array.isArray(body.kept))
      return failed(requestId, 'board-pushed', 'failed')
    toCanvas({ type: 'board-pushed', requestId, ok: true, revision: body.revision, kept: body.kept })
  }

  return {
    handle(message) {
      if (message.type === 'board-load') void load(message.requestId)
      else void push(message.requestId, message.elements)
    },
    stop() {
      stopped = true
    },
  }
}
