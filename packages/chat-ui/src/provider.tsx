import { createContext, useContext, type ReactNode } from 'react'
/** Everything a host application injects: copy, navigation and byte access. Nothing here reaches window.* directly. */
export interface ChatUiLabels {
  copy: string
  copied: string
  responseDuration: (seconds: number) => string
  tool: {
    running: string
    done: string
    error: string
    output: string
    command: string
    changes: string
    pending: string
    awaitingPermission: string
    denied: string
    imageOutput: string
    imageLoading: string
    imageUnavailable: string
  }
  context: { title: string; used: (used: string, limit: string) => string; cost: (cost: string) => string; unknownWindow: string }
  composer: {
    placeholder: string
    /** Accessible name of the message box. */
    message: string
    send: string
    stop: string
    stopping: string
    attach: string
    add: string
    attachments: string
    removeAttachment: string
    commands: string
    skills: string
    noCommands: string
  }
  model: { title: string; effort: string }
  permission: { ask: string; full: string; askHint: string; fullHint: string }
  usage: {
    title: string
    description: string
    period: string
    model: string
    input: string
    output: string
    cached: string
    turns: string
    cost: string
    empty: string
    loading: string
    refresh: string
    close: string
    periodToday: string
    period7d: string
    period30d: string
    period90d: string
    periodCustom: string
    from: string
    to: string
    cardTotalTokens: string
    cardTotalCost: string
    cardTurns: string
    cardModels: string
    colModel: string
    colInput: string
    colOutput: string
    colCacheCreate: string
    colCacheRead: string
    colTotal: string
    colShare: string
    colCost: string
    turnsUnit: string
    totalRow: string
    /** "+ n models without a price", appended to the total when some rows could not be priced. */
    unpriced: (count: number) => string
    noPricing: string
    note: string
    /** What stands in for a value that does not exist. */
    dash: string
  }
  mermaid: { failed: string; rendering: string; expand: string; zoomIn: string; zoomOut: string; reset: string; close: string; dialog: string }
}
export interface ChatUiContextValue {
  labels: ChatUiLabels
  openExternal: (url: string) => void
  /**
   * Resolves an image reference the transcript carries into something an <img> can show. The
   * optional `release` gives object URLs back once the preview leaves the viewport. Undefined
   * means this application cannot show tool images at all.
   */
  resolveImage?: (ref: string, signal?: AbortSignal) => Promise<{ src: string; release?: () => void } | null>
  locale: string
}
const Context = createContext<ChatUiContextValue | null>(null)
export function ChatUiProvider({ value, children }: { value: ChatUiContextValue; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useChatUi(): ChatUiContextValue {
  const value = useContext(Context)
  if (!value) throw new Error('ChatUiProvider is required above chat-ui components')
  return value
}
