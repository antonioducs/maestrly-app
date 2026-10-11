import type { WebContents } from 'electron'

/**
 * What the remote browser stream runs inside the streamed page, always in an isolated world of its own: the page's
 * scripts can neither see nor call it. Copying falls back to reading the selection from here when the page put nothing
 * on the clipboard.
 */

const WORLD = 'maestrly-browser-stream'

const SELECTION_SCRIPT = `(() => {
  const el = document.activeElement
  const field =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && /^(text|search|url|tel|email|number)$/.test(el.type))
  if (field && el.selectionStart !== null && el.selectionEnd !== null)
    return el.value.slice(el.selectionStart, el.selectionEnd)
  const selection = getSelection()
  return selection ? String(selection) : ''
})()`

interface EvaluateResult {
  result?: { value?: unknown }
  exceptionDetails?: unknown
}

const send = (wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> =>
  wc.debugger.sendCommand(method, params)

/** An isolated world of this module in the page's main frame; Chromium returns the same one for the same name. */
async function isolatedContext(wc: WebContents): Promise<number> {
  const tree = (await send(wc, 'Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown } } }
  const frameId = tree.frameTree?.frame?.id
  if (typeof frameId !== 'string') throw new Error('The page has no main frame.')
  const world = (await send(wc, 'Page.createIsolatedWorld', { frameId, worldName: WORLD })) as {
    executionContextId?: unknown
  }
  if (typeof world.executionContextId !== 'number') throw new Error('The page refused an isolated world.')
  return world.executionContextId
}

async function evaluateIn(wc: WebContents, contextId: number, expression: string, awaitPromise = false) {
  const evaluated = (await send(wc, 'Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise,
    returnByValue: true,
  })) as EvaluateResult
  if (evaluated.exceptionDetails) throw new Error('The page script failed.')
  return evaluated.result?.value
}

/** The text selected in the page (or in its focused text field), read from an isolated world. */
export async function readPageSelection(wc: WebContents): Promise<string> {
  if (wc.isDestroyed()) return ''
  try {
    const value = await evaluateIn(wc, await isolatedContext(wc), SELECTION_SCRIPT)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}
