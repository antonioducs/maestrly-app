import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, MessageSquareText, RotateCcw, SquarePen, X } from 'lucide-react'
import type { AssistantInfo, AssistantVoiceSettings } from '../../../shared/assistant'
import { ChatView } from '@/components/chat/ChatView'
import { Button } from '@/components/ui/button'
import { SettingsProvider, type OpenSettings } from '@/lib/use-settings'
import { hostApi } from '@/lib/hosts/host-context'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import { useVoiceSession } from './voice/use-voice-session'
import { VoiceButton } from './voice/VoiceButton'
import { mainAction, VoiceCallChip, VoiceStage, VoiceStrip } from './voice/VoiceStage'
import { shouldListen, startWakeListener } from './voice/wake-listener'
import { MIC_DEVICE_KEY } from '@/lib/dictation'
import { cn } from '@/lib/utils'

/** Statuses that wait for the person: the window stays up while it loses focus, so the card can be answered. */
const NEEDS_PERSON = new Set(['asking', 'waiting'])

/** Keys the voice screen takes only when the person is not typing or on a control that uses them. */
const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]')
const controlTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest('button, a, summary, [role="switch"], [role="option"]')

const focusComposer = () =>
  document.querySelector<HTMLElement>('[data-assistant-chat] .chat-input[contenteditable="true"]')?.focus()

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

  // The voice screen takes the window from the moment the voice starts, however it started, until the person
  // leaves it; the conversation opens over it as a sheet while the voice goes on in a bar.
  const [voiceMode, setVoiceMode] = useState(false)
  const [sheet, setSheet] = useState(false)
  const voiceActive = voice.state !== 'idle' || voice.call !== null
  useEffect(() => {
    if (voiceActive) setVoiceMode(true)
  }, [voiceActive])
  const covered = voiceMode && !sheet
  const leaveVoice = useCallback(() => {
    voiceEscape()
    setVoiceMode(false)
    setSheet(false)
  }, [voiceEscape])
  const openConversation = useCallback((write?: boolean) => {
    setSheet(true)
    if (write) requestAnimationFrame(focusComposer)
  }, [])
  const closeConversation = useCallback(() => setSheet(false), [])
  useEffect(() => {
    if (!covered) return
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-voice-stage] [data-voice-main], [data-voice-redial]')?.focus()
    )
  }, [covered])
  const keys = useRef({ voice, voiceMode, sheet, covered })
  keys.current = { voice, voiceMode, sheet, covered }

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
      // Opened again with the voice quiet: the chat, unless it opens to listen.
      const { voice: current } = keys.current
      if (!listen && current.state === 'idle' && !current.call) {
        setVoiceMode(false)
        setSheet(false)
      }
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
      setVoiceMode(false)
      setSheet(false)
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
      if (event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const { voice: current, voiceMode: inVoice, sheet: sheetOpen, covered: onStage } = keys.current
      if (event.key === 'Escape') {
        // Esc closes the conversation, then stops the voice talking, then the voice; once quiet, it hides the window.
        if (inVoice && sheetOpen) {
          event.preventDefault()
          setSheet(false)
          return
        }
        if (current.call && current.state === 'speaking') {
          event.preventDefault()
          current.interrupt()
          return
        }
        if (voiceEscape()) {
          event.preventDefault()
          return
        }
        window.api.assistantHide()
        return
      }
      if (!inVoice || event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return
      if (event.key === ' ' && onStage && !controlTarget(event.target)) {
        if (current.mode === 'realtime' && !current.call) return
        event.preventDefault()
        mainAction(current)
      } else if ((event.key === 'c' || event.key === 'C') && !event.repeat) {
        event.preventDefault()
        setSheet((open) => !open)
      }
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
        setVoiceMode(false)
        setSheet(false)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  return (
    <SettingsProvider openSettings={openSettings}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="drag hairline-b flex h-10 shrink-0 items-center gap-1 pl-3 pr-1">
          {voiceMode ? (
            <div className="min-w-0 flex-1">
              <VoiceCallChip session={voice} />
            </div>
          ) : (
            <span className="flex-1 truncate text-sm font-medium">{t('assistant.title')}</span>
          )}
          <div className="no-drag flex items-center">
            {voiceMode && (
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 gap-1.5 px-2 text-[12.5px] font-normal text-foreground/75', sheet && 'bg-accent')}
                title={t('assistant.voice.stage.conversationKey')}
                aria-expanded={sheet}
                onClick={() => (sheet ? closeConversation() : openConversation())}
              >
                <MessageSquareText />
                {t('assistant.voice.stage.conversation')}
              </Button>
            )}
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
        {voiceMode && sheet && <VoiceStrip session={voice} onBack={closeConversation} onExit={leaveVoice} />}
        {voice.notice && !covered && (
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
            // Under the voice screen the chat stays mounted: the voice sends through its composer.
            <div data-assistant-chat className="contents" inert={covered || undefined}>
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
            </div>
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
          {covered && (
            <div className="absolute inset-0 z-20">
              <VoiceStage
                session={voice}
                onOpenConversation={openConversation}
                onExit={leaveVoice}
                onOpenSettings={() => void window.api.assistantOpenSettings('assistant')}
              />
            </div>
          )}
        </main>
      </div>
    </SettingsProvider>
  )
}
