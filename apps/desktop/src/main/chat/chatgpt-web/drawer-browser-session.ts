import { randomBytes } from 'node:crypto'
import { getBrowserState } from '../../drawer/browser'
import type { BrowserSurface, BrowserSurfaceInfo } from '../browser-surface'
import { createDrawerBrowserSurface } from './drawer-browser-surface'
import { normalizeLoopbackPreviewUrl } from './preview-runtime'

export interface CompanionBrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

export interface DrawerBrowserSessionDeps {
  conversationId: string
  signal?: AbortSignal
  getState?: typeof getBrowserState
  createSurface?: typeof createDrawerBrowserSurface
}

interface BrowserToken {
  tabId: string
  createdAt: number
}

const TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_TOKENS = 64

/**
 * Session-scoped opaque handles for loopback tabs owned by one conversation's embedded browser.
 * Listing never scans ports and attaching never transfers ownership of the tab or its persistent session.
 */
export function createDrawerBrowserSession(deps: DrawerBrowserSessionDeps) {
  const state = deps.getState ?? getBrowserState
  const createSurface = deps.createSurface ?? createDrawerBrowserSurface
  const tokens = new Map<string, BrowserToken>()
  const tokenByTab = new Map<string, string>()
  let attached: { id: string; surface: BrowserSurface } | null = null
  let disposed = false

  const prune = () => {
    const now = Date.now()
    for (const [id, token] of tokens) {
      if (now - token.createdAt <= TOKEN_TTL_MS) continue
      tokens.delete(id)
      if (tokenByTab.get(token.tabId) === id) tokenByTab.delete(token.tabId)
    }
    while (tokens.size > MAX_TOKENS) {
      const id = tokens.keys().next().value
      if (typeof id !== 'string') break
      const token = tokens.get(id)
      tokens.delete(id)
      if (token && tokenByTab.get(token.tabId) === id) tokenByTab.delete(token.tabId)
    }
  }

  const opaqueId = (tabId: string): string => {
    const known = tokenByTab.get(tabId)
    if (known && tokens.has(known)) return known
    const id = `browser_${randomBytes(12).toString('hex')}`
    tokens.set(id, { tabId, createdAt: Date.now() })
    tokenByTab.set(tabId, id)
    prune()
    return id
  }

  const resolve = (id: string): { tabId: string; url: string } => {
    if (disposed) throw new Error('Browser session ended.')
    prune()
    const token = tokens.get(id)
    if (!token) throw new Error('Unknown or expired browser_id; call browser_list_tabs again.')
    const tab = state(deps.conversationId).tabs.find((candidate) => candidate.id === token.tabId)
    const url = tab ? normalizeLoopbackPreviewUrl(tab.url) : null
    if (!tab || !url) throw new Error('The selected local browser tab is no longer available.')
    return { tabId: tab.id, url }
  }

  const list = (): CompanionBrowserTab[] => {
    if (disposed) return []
    prune()
    const current = state(deps.conversationId)
    return current.tabs.flatMap((tab) => {
      const url = normalizeLoopbackPreviewUrl(tab.url)
      if (!url) return []
      return [{
        id: opaqueId(tab.id),
        title: (tab.title || 'Local preview').replace(/[\r\n\t]+/g, ' ').slice(0, 200),
        url,
        active: current.activeId === tab.id,
      }]
    })
  }

  const attach = async (id: string): Promise<BrowserSurface> => {
    const target = resolve(id)
    if (attached?.id === id) return attached.surface
    const next = await createSurface({
      convId: deps.conversationId,
      tabId: target.tabId,
      url: target.url,
      signal: deps.signal,
    })
    const previous = attached
    attached = { id, surface: next }
    await previous?.surface.dispose()
    return next
  }

  const detach = async (): Promise<void> => {
    const current = attached
    attached = null
    await current?.surface.dispose()
  }

  const createReviewSurface = async (input: {
    browserId: string
    signal: AbortSignal
    onStateChange: (info: BrowserSurfaceInfo) => void
  }): Promise<{ browser: BrowserSurface; url: string; ownership: 'attached' }> => {
    const target = resolve(input.browserId)
    const browser = await createSurface({
      convId: deps.conversationId,
      tabId: target.tabId,
      url: target.url,
      signal: input.signal,
      onStateChange: input.onStateChange,
    })
    return { browser, url: target.url, ownership: 'attached' }
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await detach()
    tokens.clear()
    tokenByTab.clear()
  }

  deps.signal?.addEventListener('abort', () => void dispose(), { once: true })

  return {
    list,
    attach,
    detach,
    active: (): BrowserSurface | null => attached?.surface ?? null,
    attachedId: (): string | null => attached?.id ?? null,
    createReviewSurface,
    show: (): boolean => attached?.surface.show() ?? false,
    dispose,
  }
}

export type DrawerBrowserSession = ReturnType<typeof createDrawerBrowserSession>
