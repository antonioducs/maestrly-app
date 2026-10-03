import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsProvider, useSettings } from '@/lib/use-settings'
import { ChatWindowEnvironment } from '@/lib/chat-window-context'
import { moveChatSurface, prepareChatDocument } from '@/lib/chat-window-document'
import {
  openChatWindow,
  registerChatWindowHost,
  setChatWindowPlacement,
  useChatWindowPlacement,
  type ChatWindowController,
} from '@/lib/chat-windows'
import { chatWindowKey, type ChatWindowTarget } from '../../../shared/chat-window'

export function ChatWindowButton({ target }: { target: ChatWindowTarget }) {
  const { t } = useTranslation('ui')
  const placement = useChatWindowPlacement(target)
  const label = t(placement === 'detached' ? 'chatWindow.focus' : 'chatWindow.open')
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      title={label}
      aria-label={label}
      disabled={placement === 'missing' || placement === 'opening'}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openChatWindow(target)}
    >
      <ExternalLink className="size-4" />
    </Button>
  )
}

/**
 * React always renders into the same container. Moving it between documents preserves drafts,
 * attachment URLs, queues, and the original renderer's live IPC subscriptions without a handoff.
 */
export function ChatWindowHost({
  target,
  title,
  children,
  onDetachedChange,
  onReattach,
  onShowSource,
  actions,
}: {
  target: ChatWindowTarget
  title: string
  children: (detached: boolean) => ReactNode
  onDetachedChange?: (detached: boolean) => void
  onReattach?: () => void
  onShowSource?: () => void
  actions?: ReactNode
}) {
  const { t } = useTranslation('ui')
  const key = chatWindowKey(target)
  const settings = useSettings()
  const openSettings = useCallback<ReturnType<typeof useSettings>['openSettings']>(
    (section) => {
      settings.openSettings(section)
      void window.api.chatWindowShowSource(key)
    },
    [key, settings]
  )
  const dock = useRef<HTMLDivElement>(null)
  const controller = useRef<ChatWindowController | null>(null)
  const latest = useRef({ title, target, onDetachedChange, onReattach, onShowSource })
  latest.current = { title, target, onDetachedChange, onReattach, onShowSource }
  const [surface] = useState(() => {
    const root = document.createElement('div')
    root.className = 'flex h-full min-h-0 w-full flex-col bg-surface text-foreground'
    const content = document.createElement('div')
    content.className = 'flex min-h-0 flex-1 flex-col'
    const overlays = document.createElement('div')
    root.append(content, overlays)
    return { root, content, overlays }
  })
  const [ownerDocument, setOwnerDocument] = useState(document)
  const [detached, setDetached] = useState(false)
  const [error, setError] = useState(false)
  const focusSource = useCallback(() => {
    if (ownerDocument !== document) void window.api.chatWindowShowSource(key)
  }, [key, ownerDocument])
  const showConversation = useCallback(() => {
    if (ownerDocument === document) return
    latest.current.onShowSource?.()
    focusSource()
  }, [focusSource, ownerDocument])
  const environment = useMemo(
    () => ({ document: ownerDocument, portalContainer: surface.overlays, focusSource, showConversation }),
    [ownerDocument, surface, focusSource, showConversation]
  )

  useLayoutEffect(() => {
    const destination = dock.current
    if (!destination) return
    destination.append(surface.root)
    let child: Window | null = null
    let stopStyles: (() => void) | undefined
    let opening = false
    let alive = true
    let generation = 0

    const placement = (value: 'docked' | 'opening' | 'detached') => {
      const external = value !== 'docked'
      setDetached(external)
      setChatWindowPlacement(key, value)
      latest.current.onDetachedChange?.(external)
    }
    const restore = (navigate: boolean) => {
      generation++
      opening = false
      stopStyles?.()
      stopStyles = undefined
      moveChatSurface(surface.root, destination)
      child = null
      setOwnerDocument(document)
      // Select the source before releasing retention, especially for an inactive bot's draft.
      if (navigate) latest.current.onReattach?.()
      placement('docked')
    }
    const reattach = () => {
      if (!child && !opening) return
      restore(true)
      void window.api.chatWindowClose(key)
    }
    const open = async () => {
      if (child && !child.closed) {
        await window.api.chatWindowFocus(key)
        return
      }
      if (opening) return
      opening = true
      const attempt = ++generation
      setError(false)
      placement('opening')
      try {
        const prepared = await window.api.chatWindowPrepare({ ...latest.current.target, title: latest.current.title })
        if (!alive || attempt !== generation) {
          await window.api.chatWindowClose(key)
          return
        }
        child = window.open('about:blank', prepared.frameName)
        if (!child) throw new Error('Chat window was not created')
        stopStyles = prepareChatDocument(document, child.document)
        child.document.title = latest.current.title
        moveChatSurface(surface.root, child.document.body)
        setOwnerDocument(child.document)
        opening = false
        placement('detached')
        child.focus()
      } catch {
        if (alive && attempt === generation) {
          restore(false)
          setError(true)
        }
        await window.api.chatWindowClose(key).catch(() => {})
      }
    }
    controller.current = { open: () => void open(), reattach }
    const unregister = registerChatWindowHost(key, controller.current)
    const offRequest = window.api.onChatWindowCloseRequested((closedKey) => {
      if (closedKey === key) reattach()
    })
    const offClosed = window.api.onChatWindowClosed((closedKey) => {
      if (closedKey === key && child) restore(true)
    })
    return () => {
      alive = false
      generation++
      stopStyles?.()
      offRequest()
      offClosed()
      unregister()
      controller.current = null
      // Disposal (archive/delete/app teardown) does not navigate back to a removed conversation.
      surface.root.remove()
      void window.api.chatWindowClose(key).catch(() => {})
    }
  }, [key, surface])

  useLayoutEffect(() => {
    if (ownerDocument !== document) ownerDocument.title = title
  }, [ownerDocument, title])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-chat-window-host={key}>
      <div
        ref={dock}
        className="flex min-h-0 flex-1 flex-col"
        style={{ display: ownerDocument !== document ? 'none' : undefined }}
      />
      {ownerDocument !== document && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <ExternalLink className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('chatWindow.detached')}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => controller.current?.open()}>
              {t('chatWindow.focus')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => controller.current?.reattach()}>
              {t('chatWindow.return')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t('chatWindow.failed')}
        </p>
      )}
      {createPortal(
        <ChatWindowEnvironment.Provider value={environment}>
          <SettingsProvider openSettings={openSettings}>
            <header
              className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
              style={{ display: ownerDocument === document ? 'none' : undefined }}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => controller.current?.reattach()}
                  title={t('chatWindow.return')}
                >
                  <ArrowLeft className="size-4" />
                  {t('chatWindow.return')}
                </Button>
                {actions}
              </div>
            </header>
            <div className="relative flex min-h-0 flex-1 flex-col">{children(detached)}</div>
          </SettingsProvider>
        </ChatWindowEnvironment.Provider>,
        surface.content
      )}
    </div>
  )
}
