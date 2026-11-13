import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, RotateCcw, SquarePen, X } from 'lucide-react'
import type { AssistantInfo, AssistantVoiceSettings } from '../../../shared/assistant'
import { ChatView } from '@/components/chat/ChatView'
import { Button } from '@/components/ui/button'
import { SettingsProvider, type OpenSettings } from '@/lib/use-settings'
import { hostApi } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import { useVoiceSession } from './voice/use-voice-session'
import { VoiceButton } from './voice/VoiceButton'
import { shouldListen, startWakeListener } from './voice/wake-listener'
import { MIC_DEVICE_KEY } from '@/lib/dictation'

/** Statuses that wait for the person: the window stays up while it loses focus, so the card can be answered. */
const NEEDS_PERSON = new Set(['asking', 'waiting'])

export function AssistantApp() {
  const { t, i18n } = useTranslation('ui')
  const [info, setInfo] = useState<AssistantInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [voiceSettings, setVoiceSettings] = useState<AssistantVoiceSettings | null>(null)
  const locale = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
  const voice = useVoiceSession({ conversationId: info?.conversationId ?? null, voice: voiceSettings, locale })
  const { tap: voiceTap, escape: voiceEscape } = voice
  const [wake, setWake] = useState({ listening: false })

  useEffect(() => {
    void window.api
      .assistantWakeState()
      .then(setWake)
      .catch(() => {})
    return window.api.onAssistantWakeState(setWake)
  }, [])

  const listen = shouldListen(wake, voice.state)
  useEffect(() => {
    if (!listen) return
    let stopped = false
    let listener: { stop(): void } | null = null
    void startWakeListener({
      deviceId: localStorage.getItem(MIC_DEVICE_KEY),
      onBurst: (pcm) => window.api.assistantWakeBurst(pcm),
    })
      .then((started) => {
        if (stopped) started.stop()
        else listener = started
      })
      .catch(() => {
        if (!stopped) window.api.assistantWakeMicFailed()
      })
    return () => {
      stopped = true
      listener?.stop()
    }
  }, [listen])

  // Settings change in the main window: read them again each time the window comes back.
  const loadVoiceSettings = useCallback(() => {
    void window.api
      .assistantSettings()
      .then((state) => setVoiceSettings(state.settings.voice))
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadVoiceSettings()
    window.addEventListener('focus', loadVoiceSettings)
    const off = window.api.onAssistantShown(({ listen }) => {
      loadVoiceSettings()
      if (listen) voiceTap()
    })
    return () => {
      window.removeEventListener('focus', loadVoiceSettings)
      off()
    }
  }, [loadVoiceSettings, voiceTap])

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
      // Esc first stops the voice; once it is quiet, Esc hides the window.
      if (voiceEscape()) {
        event.preventDefault()
        return
      }
      window.api.assistantHide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [voiceEscape])

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
        {voice.notice && (
          <div role="status" className="hairline-b flex items-start gap-2 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="flex-1">{t(`assistant.voice.notice.${voice.notice}`)}</span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 hover:bg-white/[0.06] hover:text-foreground"
              title={t('assistant.voice.dismiss')}
              aria-label={t('assistant.voice.dismiss')}
              onClick={voice.dismissNotice}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
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
              micSlotOverride={({ submitText }) => <VoiceButton session={voice} submitText={submitText} />}
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
