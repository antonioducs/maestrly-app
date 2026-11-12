import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  reconcileElements,
  restoreElements,
  sceneCoordsToViewportCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyOps,
  type Board,
  type BoardElement,
  checkBoard,
  keepsCurrent,
  mergeElements,
  type Op,
  orderedElements,
  readBoard,
  type StoredElement,
} from '../../src/index'

type Saved = { revision: number; elements: StoredElement[] }
// The canvas's element types are branded; the board's are the same JSON without the brands.
type Scene = any[]

const errors: string[] = []
addEventListener('error', (event) => errors.push(String(event.message)))
addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

/** What the agent does in the demo, from the revision it read when the board opened. */
const AGENT_OPS: Op[] = [
  { op: 'move', id: 'api', to: { x: 0, y: 0 } },
  { op: 'card', id: 'queue', text: 'Job queue', in: 'backend', color: 'violet' },
  { op: 'connect', from: 'api', to: 'queue', label: 'enqueue' },
  { op: 'card', id: 'cdn', text: 'CDN for static assets?', in: 'client', color: 'gray', suggested: true },
]

function toBoard(saved: Saved): Board {
  return { revision: saved.revision, elements: new Map(saved.elements.map((stored) => [stored.element.id, stored])) }
}

export function App() {
  const [initial, setInitial] = useState<Scene | null>(null)
  const [status, setStatus] = useState('')
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const board = useRef<Board | null>(null)
  const opened = useRef(0)
  const changesAtLoad = useRef<number | null>(null)

  useEffect(() => {
    fetch('./board.json')
      .then((response) => response.json())
      .then((saved: Saved) => {
        board.current = toBoard(saved)
        opened.current = saved.revision
        const elements = orderedElements(board.current, { deleted: true })
        setInitial(restoreElements(elements as Scene, null, { refreshDimensions: true, repairBindings: true }))
      })
      .catch((error) => errors.push(String(error)))
  }, [])

  // A person's changes reach the board element by element, as they would reach the host.
  const onChange = useCallback((elements: readonly any[]) => {
    const current = board.current
    if (!current) return
    const changed = elements.filter((element) => {
      const stored = current.elements.get(element.id)?.element
      return !stored || stored.version !== element.version || stored.versionNonce !== element.versionNonce
    })
    changesAtLoad.current ??= changed.length
    if (!changed.length) return
    const merged = mergeElements(current, changed as BoardElement[], 'person')
    board.current = merged.board
    if (merged.accepted.length) setStatus(`rev ${merged.board.revision}: ${merged.accepted.length} changed by a person`)
  }, [])

  const runAgent = useCallback((baseRevision = opened.current) => {
    const excalidraw = api.current
    if (!excalidraw || !board.current) return null
    const result = applyOps(board.current, { baseRevision, ops: AGENT_OPS, now: Date.now() })
    if (!result.ok) {
      setStatus(`agent failed: ${result.error.message}`)
      return result
    }
    board.current = result.board
    // The same path a collaborator's changes take into a canvas.
    const reconciled = reconcileElements(
      excalidraw.getSceneElementsIncludingDeleted(),
      result.changed as Scene,
      excalidraw.getAppState()
    )
    excalidraw.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER })
    const warnings = checkBoard(result.board)
    setStatus(
      `rev ${result.board.revision}: agent applied ${result.applied.length}, ${result.conflicts.length} met a person's change, ${warnings.length} warnings`
    )
    return {
      applied: result.applied,
      conflicts: result.conflicts,
      created: result.created,
      revision: result.board.revision,
      warnings,
    }
  }, [])

  useEffect(() => {
    ;(window as any).__spike = {
      ready: () => !!api.current && !!board.current,
      board: () => board.current,
      outline: (since?: number) => board.current && readBoard(board.current, { since }),
      runAgent,
      /** Where an element's center is, in the frame's viewport. */
      viewportCenter(id: string) {
        const element = api.current!.getSceneElements().find((item) => item.id === id)!
        return sceneCoordsToViewportCoords(
          { sceneX: element.x + element.width / 2, sceneY: element.y + element.height / 2 },
          api.current!.getAppState()
        )
      },
      report: () => report(api.current!, board.current!, changesAtLoad.current),
      scene: (id: string) => {
        const element = api.current!.getSceneElements().find((item) => item.id === id)
        return element && { x: element.x, y: element.y, version: element.version }
      },
    }
  }, [runAgent])

  if (!initial) return null
  return (
    <Excalidraw
      excalidrawAPI={(instance) => {
        api.current = instance
        requestAnimationFrame(() =>
          instance.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 })
        )
      }}
      initialData={{ elements: initial, scrollToContent: true }}
      onChange={onChange}
      renderTopRightUI={() => (
        <div className="spike-panel">
          <output>{status}</output>
          <button type="button" onClick={() => runAgent()}>
            Agent: add ideas
          </button>
        </div>
      )}
    />
  )
}

async function report(api: ExcalidrawImperativeAPI, board: Board, changesAtLoad: number | null) {
  await document.fonts.ready
  const scene = api.getSceneElements() as Scene
  const byId = new Map(scene.map((element) => [element.id, element]))

  // How the board's estimates compare with what the canvas measured with the real fonts.
  const ratios: number[] = []
  const overflowing: string[] = []
  for (const element of scene) {
    if (element.type !== 'text') continue
    const ours = board.elements.get(element.id)?.element
    if (ours?.width) ratios.push(element.width / ours.width)
    const container = element.containerId ? byId.get(element.containerId) : null
    if (container && container.type !== 'arrow' && element.height > container.height - 10)
      overflowing.push(container.id)
  }

  // Excalidraw's reconciliation and the board's merge must pick the same copy, or canvases and host drift apart.
  let mismatches = 0
  let cases = 0
  for (const current of scene) {
    for (const [dv, nonce] of [
      [1, 0],
      [-1, 0],
      [0, current.versionNonce - 1],
      [0, current.versionNonce + 1],
    ] as const) {
      const incoming = {
        ...current,
        version: current.version + dv,
        versionNonce: dv ? current.versionNonce : nonce,
        x: 1,
      }
      const winner = reconcileElements([current], [incoming], api.getAppState())[0]
      const keptCurrent = winner?.x !== 1
      if (keptCurrent !== keepsCurrent(current, incoming)) mismatches++
      cases++
    }
  }

  const appState = api.getAppState()
  const png = await exportToBlob({ elements: scene, appState, files: api.getFiles(), mimeType: 'image/png' })
  const svg = await exportToSvg({ elements: scene, appState, files: api.getFiles() })
  return {
    origin: location.origin,
    assetPath: window.EXCALIDRAW_ASSET_PATH,
    elements: scene.length,
    changesAtLoad,
    fonts: [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
    textWidthRatio: ratios.length ? { min: Math.min(...ratios), max: Math.max(...ratios) } : null,
    overflowing,
    reconcile: { cases, mismatches },
    export: { pngBytes: png.size, svgChars: svg.outerHTML.length, svgEmbedsFont: svg.outerHTML.includes('@font-face') },
    errors,
  }
}
