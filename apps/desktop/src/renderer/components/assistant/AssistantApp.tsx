import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, RotateCcw, SquarePen, X } from 'lucide-react'
import type { AssistantInfo } from '../../../shared/assistant'
import { ChatView } from '@/components/chat/ChatView'
import { Button } from '@/components/ui/button'
import { SettingsProvider, type OpenSettings } from '@/lib/use-settings'
import { hostApi } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'

/** Statuses that wait for the person: the window stays up while it loses focus, so the card can be answered. */
const NEEDS_PERSON = new Set(['asking', 'waiting'])

export function AssistantApp() {
  const { t } = useTranslation('ui')
  const [info, setInfo] = useState<AssistantInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | undefined>(undefined)

  const load = useCallback(() => {
    setError(null)
    window.api
      .assistantInfo()
      .then(setInfo)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  useEffect(() => {
    load()
    return window.api.onAssistantConversationChanged((next) => {
      setStatus(undefined)
      setInfo(next)
    })
  }, [load])

  const conversationId = info?.conversationId
  useEffect(() => {
    if (!conversationId) return
    return hostApi(LOCAL_HOST_ID).onStatus(({ agentId, status: next }) => {
      if (agentId === conversationId) setStatus(next)
    })
  }, [conversationId])

  useEffect(() => {
    window.api.assistantHold('question', !!status && NEEDS_PERSON.has(status))
  }, [status])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      window.api.assistantHide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openSettings = useCallback<OpenSettings>((sectionOrEvent) => {
    void window.api.assistantOpenSettings(typeof sectionOrEvent === 'string' ? sectionOrEvent : undefined)
  }, [])

  const newSession = useCallback(() => {
    void window.api
      .assistantNewSession()
      .then((next) => {
        setStatus(undefined)
        setInfo(next)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  return (
    <SettingsProvider openSettings={openSettings}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="drag hairline-b flex h-10 shrink-0 items-center gap-1 pl-3 pr-1">
          <span className="flex-1 truncate text-sm font-medium">{t('assistant.title')}</span>
          <div className="no-drag flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={t('assistant.newSession')}
              aria-label={t('assistant.newSession')}
              onClick={newSession}
            >
              <SquarePen />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={t('assistant.openInApp')}
              aria-label={t('assistant.openInApp')}
              onClick={() => void window.api.assistantOpenInApp()}
            >
              <ExternalLink />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={t('assistant.hide')}
              aria-label={t('assistant.hide')}
              onClick={() => window.api.assistantHide()}
            >
              <X />
            </Button>
          </div>
        </header>
        <main className="relative min-h-0 flex-1">
          {info ? (
            <ChatView
              key={info.conversationId}
              conversationId={info.conversationId}
              workspaceId={null}
              cwd={info.cwd}
              experience="standard"
              visible
              status={status}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
              {error ? (
                <>
                  <span>{t('assistant.loadFailed', { error })}</span>
                  <Button variant="outline" size="sm" onClick={load}>
                    <RotateCcw />
                    {t('assistant.retry')}
                  </Button>
                </>
              ) : (
                <span>{t('assistant.loading')}</span>
              )}
            </div>
          )}
        </main>
      </div>
    </SettingsProvider>
  )
}
