import {
  CaptureUpdateAction,
  Excalidraw,
  reconcileElements,
  restoreElements,
  sceneCoordsToViewportCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useRef, useState } from 'react'
import { createSync, type Sync, type SyncElement } from './sync'

// The canvas's element types are branded; the host's are the same JSON without the brands.
type Scene = any[]

/** Images are not synced, and the board lives on the host, never in a file the person opens or saves. */
const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, toggleTheme: true },
  tools: { image: false },
} as const

export function App() {
  const [opened, setOpened] = useState<Scene | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const sync = useRef<Sync | null>(null)
  const editing = useRef(false)
  /** Changes that arrived before the canvas was ready to show them. */
  const early = useRef<SyncElement[]>([])

  useEffect(() => {
    const board = window.maestrly?.board
    if (!board) return setProblem('unavailable')
    let unsubscribe = () => {}
    let cancelled = false

    // The path a collaborator's changes take into an Excalidraw canvas, without an undo step of the person's own.
    const show = (elements: readonly SyncElement[]) => {
      const excalidraw = api.current
      if (!excalidraw) {
        early.current.push(...elements)
        return
      }
      const reconciled = reconcileElements(
        excalidraw.getSceneElementsIncludingDeleted(),
        restoreElements(elements as Scene, null) as Scene,
        excalidraw.getAppState()
      )
      excalidraw.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER })
    }

    board
      .load()
      .then((loaded) => {
        if (cancelled) return
        const created = createSync({
          push: (elements) => board.push(elements) as Promise<{ revision: number; kept: SyncElement[] }>,
          apply: show,
          onReadOnly: () => {
            editing.current = false
            setCanEdit(false)
          },
        })
        // The canvas opens with these elements; they only need to be known, not shown again.
        created.remote(loaded.elements as SyncElement[])
        early.current = []
        sync.current = created
        unsubscribe = board.subscribe((change) => sync.current?.remote(change.elements as SyncElement[]))
        editing.current = loaded.canEdit
        setCanEdit(loaded.canEdit)
        setOpened(restoreElements(loaded.elements as Scene, null, { refreshDimensions: true, repairBindings: true }))
      })
      .catch((error: { code?: string }) => setProblem(error?.code ?? 'failed'))

    const leave = () => void sync.current?.flush()
    addEventListener('pagehide', leave)
    return () => {
      cancelled = true
      unsubscribe()
      removeEventListener('pagehide', leave)
    }
  }, [])

  // Read-only, for the end-to-end check: what the canvas shows, and where an element is on screen.
  useEffect(() => {
    window.__whiteboard = {
      ready: () => api.current !== null && sync.current !== null,
      canEdit: () => editing.current,
      elements: () => (api.current?.getSceneElements() ?? []) as Scene,
      viewportCenter(id: string) {
        const excalidraw = api.current
        const element = excalidraw?.getSceneElements().find((item) => item.id === id)
        if (!excalidraw || !element) return null
        return sceneCoordsToViewportCoords(
          { sceneX: element.x + element.width / 2, sceneY: element.y + element.height / 2 },
          excalidraw.getAppState()
        )
      },
    }
  }, [])

  if (problem) return <p className="problem">This whiteboard is not available here ({problem}).</p>
  if (!opened) return null
  return (
    <Excalidraw
      excalidrawAPI={(instance) => {
        api.current = instance
        const waiting = early.current.splice(0)
        if (waiting.length) sync.current?.remote(waiting)
        requestAnimationFrame(() =>
          instance.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 })
        )
      }}
      initialData={{ elements: opened, scrollToContent: true }}
      viewModeEnabled={!canEdit}
      UIOptions={UI_OPTIONS}
      onChange={(elements) => {
        if (editing.current) sync.current?.local(elements as unknown as SyncElement[])
      }}
    />
  )
}
