import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  AppWindow,
  AudioLines,
  EyeOff,
  Keyboard,
  Loader2,
  Mic,
  Play,
  Power,
  SquarePen,
  Sparkles,
} from 'lucide-react'
import {
  type AssistantInfo,
  type AssistantSettingsPatch,
  type AssistantSettingsState,
  type AssistantVoiceOptions,
  type AssistantVoiceSettings,
  ASSISTANT_OPENAI_VOICES,
  bindingFromKeyPress,
  defaultAssistantShortcut,
  effectiveAssistantShortcut,
} from '../../../shared/assistant'
import { bindingKey, formatAccelerator } from '../../../shared/shortcuts'
import { Button } from '@/components/ui/button'
import { ChatModelChip } from '@/components/chat/ChatModelChip'
import { DictationSettings } from '@/components/chat/DictationSettings'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { pickSystemVoice, systemVoicesFor } from '@/components/assistant/voice/speaker'
import type { SupportedLocale } from '../../../shared/locale'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'

function Switch({
  checked,
  onChange,
  icon,
  title,
  desc,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  icon: ReactNode
  title: string
  desc: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-[11px] leading-snug text-muted-foreground">{desc}</div>
      </div>
      <span
        className={cn(
          'mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-primary' : 'bg-white/15'
        )}
      >
        <span className={cn('size-4 rounded-full bg-white transition-transform', checked && 'translate-x-4')} />
      </span>
    </button>
  )
}

/** The system's voices, once the platform listed them (Chromium lists them late, and never on some systems). */
function useSystemVoices(): SpeechSynthesisVoice[] | null {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null)
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') {
      setVoices([])
      return
    }
    const load = () => {
      const list = speechSynthesis.getVoices()
      if (list.length) setVoices(list)
    }
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    const settle = setTimeout(() => setVoices((current) => current ?? speechSynthesis.getVoices()), 1500)
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', load)
      clearTimeout(settle)
    }
  }, [])
  return voices
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-[12px] text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function VoiceSettings({
  t,
  voice,
  update,
  disabled,
}: {
  t: TFn
  voice: AssistantVoiceSettings
  update: (patch: AssistantSettingsPatch) => void
  disabled: boolean
}) {
  const os = window.api.platformInfo.os
  const { i18n } = useTranslation()
  const locale: SupportedLocale = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('pt')
    ? 'pt-BR'
    : 'en'
  const [options, setOptions] = useState<AssistantVoiceOptions | null>(null)
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const systemVoices = useSystemVoices()
  const dictation = useRef<HTMLDivElement>(null)

  const loadOptions = useCallback(() => {
    void window.api
      .assistantVoices()
      .then(setOptions)
      .catch(() => {})
  }, [])
  useEffect(() => {
    loadOptions()
    window.addEventListener('focus', loadOptions)
    return () => window.removeEventListener('focus', loadOptions)
  }, [loadOptions])

  const setVoice = (patch: Partial<AssistantVoiceSettings>) => {
    setTestError(null)
    update({ voice: patch })
  }
  const fitting = systemVoices ? systemVoicesFor(systemVoices, locale) : []
  const chosen = voice.systemVoice && systemVoices?.find((v) => v.name === voice.systemVoice)
  const systemChoices = chosen && !fitting.includes(chosen) ? [chosen, ...fitting] : fitting
  const noSystemVoice = systemVoices !== null && systemVoices.length === 0
  const realtime = voice.mode === 'realtime'
  // OpenAI's voices speak at most 1.5×; the system's go up to 2×.
  const maxSpeed = realtime || voice.engine === 'openai' ? 1.5 : 2
  const shownSpeed = Math.min(voice.speed, maxSpeed)
  const keyMissing = (voice.engine === 'openai' || realtime) && options !== null && !options.openaiKey
  const showDictation = () => dictation.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const test = async () => {
    setTestError(null)
    const sample = t('settings.assistant.voice.sample')
    if (voice.engine === 'system' && !realtime) {
      if (typeof speechSynthesis === 'undefined') return setTestError('no-voice')
      speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(sample)
      utterance.lang = locale
      utterance.rate = voice.speed
      const picked = pickSystemVoice(systemVoices ?? [], voice.systemVoice, locale)
      if (picked) utterance.voice = picked
      utterance.onerror = (event) => {
        if (event.error !== 'interrupted' && event.error !== 'canceled') setTestError('no-voice')
      }
      speechSynthesis.speak(utterance)
      return
    }
    setTesting(true)
    try {
      const result = await window.api.assistantTestVoice({
        text: sample,
        voice: realtime ? voice.realtimeVoice : voice.openaiVoice,
        speed: shownSpeed,
      })
      if (!result.ok) return setTestError(result.error)
      const context = new AudioContext()
      const source = context.createBufferSource()
      source.buffer = await context.decodeAudioData(result.audio.slice(0))
      source.connect(context.destination)
      source.onended = () => void context.close().catch(() => {})
      source.start()
    } catch {
      setTestError('playback')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-3', disabled && 'pointer-events-none opacity-50')}>
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <AudioLines className="size-4 text-muted-foreground" /> {t('settings.assistant.voice.heading')}
        </h3>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.assistant.voice.desc')}</p>
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
        <Row label={t('settings.assistant.voice.mode')}>
          <OptionSelect
            className="h-8 w-auto shrink-0 text-[12px]"
            aria-label={t('settings.assistant.voice.mode')}
            value={voice.mode}
            onValueChange={(mode) => setVoice({ mode: mode === 'realtime' ? 'realtime' : 'agent' })}
          >
            <SelectOption value="agent">{t('settings.assistant.voice.modeAgent')}</SelectOption>
            <SelectOption value="realtime">{t('settings.assistant.voice.modeRealtime')}</SelectOption>
          </OptionSelect>
        </Row>
        {realtime && (
          <Row label={t('settings.assistant.voice.realtimeModel')}>
            <OptionSelect
              className="h-8 w-auto shrink-0 text-[12px]"
              aria-label={t('settings.assistant.voice.realtimeModel')}
              value={voice.realtimeModel}
              onValueChange={(model) =>
                setVoice({ realtimeModel: model === 'gpt-realtime-2.1' ? 'gpt-realtime-2.1' : 'gpt-realtime-2.1-mini' })
              }
            >
              <SelectOption value="gpt-realtime-2.1-mini">{t('settings.assistant.voice.realtimeMini')}</SelectOption>
              <SelectOption value="gpt-realtime-2.1">{t('settings.assistant.voice.realtimeFull')}</SelectOption>
            </OptionSelect>
          </Row>
        )}
        <Row label={t('settings.assistant.voice.engine')}>
          <OptionSelect
            disabled={realtime}
            className="h-8 w-auto shrink-0 text-[12px]"
            aria-label={t('settings.assistant.voice.engine')}
            value={voice.engine}
            onValueChange={(engine) => setVoice({ engine: engine === 'openai' ? 'openai' : 'system' })}
          >
            <SelectOption value="system">{t('settings.assistant.voice.engineSystem')}</SelectOption>
            <SelectOption value="openai">{t('settings.assistant.voice.engineOpenai')}</SelectOption>
          </OptionSelect>
        </Row>
        <Row label={t('settings.assistant.voice.voice')}>
          {voice.engine === 'system' && !realtime ? (
            <OptionSelect
              className="h-8 w-auto max-w-64 shrink-0 text-[12px]"
              aria-label={t('settings.assistant.voice.voice')}
              value={voice.systemVoice ?? ''}
              onValueChange={(name) => setVoice({ systemVoice: name || null })}
              disabled={noSystemVoice}
            >
              <SelectOption value="">{t('settings.assistant.voice.systemDefault')}</SelectOption>
              {systemChoices.map((v) => (
                <SelectOption key={v.voiceURI || v.name} value={v.name}>
                  {v.name}
                </SelectOption>
              ))}
            </OptionSelect>
          ) : (
            <OptionSelect
              className="h-8 w-auto shrink-0 text-[12px] capitalize"
              aria-label={t('settings.assistant.voice.voice')}
              value={realtime ? voice.realtimeVoice : voice.openaiVoice}
              onValueChange={(name) => {
                const next = (options?.openai ?? ASSISTANT_OPENAI_VOICES).find((v) => v === name)
                if (next) setVoice(realtime ? { realtimeVoice: next } : { openaiVoice: next })
              }}
            >
              {(options?.openai ?? ASSISTANT_OPENAI_VOICES).map((name) => (
                <SelectOption key={name} value={name} className="capitalize">
                  {name}
                </SelectOption>
              ))}
            </OptionSelect>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void test()}
            disabled={testing || (voice.engine === 'system' && !realtime && noSystemVoice) || keyMissing}
          >
            {testing ? <Loader2 className="animate-spin" /> : <Play />}
            {t('settings.assistant.voice.test')}
          </Button>
        </Row>
        <Row label={t('settings.assistant.voice.speed', { speed: shownSpeed.toFixed(1) })}>
          <input
            type="range"
            min={0.5}
            max={maxSpeed}
            step={0.1}
            value={shownSpeed}
            aria-label={t('settings.assistant.voice.speed', { speed: shownSpeed.toFixed(1) })}
            onChange={(event) => setVoice({ speed: Math.round(Number(event.target.value) * 10) / 10 })}
            className="w-40 accent-primary"
          />
        </Row>
        {voice.engine === 'system' && !realtime && noSystemVoice && (
          <p className="flex items-start gap-1 text-[11px] leading-snug text-amber-400">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {t(
              os === 'linux' ? 'settings.assistant.voice.noSystemVoiceLinux' : 'settings.assistant.voice.noSystemVoice'
            )}
          </p>
        )}
        {realtime && (
          <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.assistant.voice.realtimeCost')}</p>
        )}
        {keyMissing && (
          <p className="flex flex-wrap items-center gap-1 text-[11px] leading-snug text-amber-400">
            <AlertTriangle className="size-3 shrink-0" />
            {t('settings.assistant.voice.keyMissing')}
            <button type="button" className="underline underline-offset-2 hover:text-amber-300" onClick={showDictation}>
              {t('settings.assistant.voice.keyMissingLink')}
            </button>
          </p>
        )}
        {testError && (
          <p className="flex items-start gap-1 text-[11px] leading-snug text-amber-400">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {t(`assistant.voice.notice.speech-${testError}`)}
          </p>
        )}
      </div>

      <Switch
        checked={voice.autoSpeak}
        onChange={(next) => setVoice({ autoSpeak: next })}
        icon={<AudioLines />}
        title={t('settings.assistant.voice.autoSpeakTitle')}
        desc={t('settings.assistant.voice.autoSpeakDesc')}
      />
      <Switch
        checked={voice.shortcutListens}
        onChange={(next) => setVoice({ shortcutListens: next })}
        icon={<Mic />}
        title={t('settings.assistant.voice.shortcutListensTitle')}
        desc={t('settings.assistant.voice.shortcutListensDesc')}
      />

      <div ref={dictation} className="flex scroll-mt-4 flex-col gap-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">{t('settings.assistant.voice.transcription')}</h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.assistant.voice.transcriptionDesc')}</p>
        </div>
        <DictationSettings />
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.assistant.voice.cost')}</p>
    </div>
  )
}

export function AssistantSection({ t }: { t: TFn }) {
  const os = window.api.platformInfo.os
  const [state, setState] = useState<AssistantSettingsState | null>(null)
  const [info, setInfo] = useState<AssistantInfo | null>(null)
  const [recording, setRecording] = useState(false)
  const [invalidKey, setInvalidKey] = useState(false)

  useEffect(() => {
    void window.api.assistantSettings().then(setState)
  }, [])
  const enabled = state?.settings.enabled ?? false
  useEffect(() => {
    if (!enabled) return
    void window.api.assistantInfo().then(setInfo)
  }, [enabled])

  const update = useCallback((patch: AssistantSettingsPatch) => {
    void window.api.setAssistantSettings(patch).then(setState)
  }, [])

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setRecording(false)
        return
      }
      const binding = bindingFromKeyPress(event)
      if (binding === null) return
      if (binding === 'invalid') {
        setInvalidKey(true)
        return
      }
      setInvalidKey(false)
      setRecording(false)
      update({ shortcut: binding })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, update])

  if (!state) return null
  const { settings } = state
  const shortcut = effectiveAssistantShortcut(settings, os)
  const defaultShortcut = defaultAssistantShortcut(os)

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="size-4 text-muted-foreground" /> {t('settings.assistant.heading')}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.assistant.desc')}</p>
      </div>

      <Switch
        checked={settings.enabled}
        onChange={(next) => update({ enabled: next })}
        icon={<Power />}
        title={t('settings.assistant.enabledTitle')}
        desc={t('settings.assistant.enabledDesc')}
      />

      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5',
          !settings.enabled && 'pointer-events-none opacity-50'
        )}
      >
        <div className="flex items-center gap-2">
          <Keyboard className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('settings.assistant.shortcut')}</span>
          <button
            type="button"
            onClick={() => {
              setInvalidKey(false)
              setRecording((value) => !value)
            }}
            className={cn(
              'min-w-28 rounded-md border px-2.5 py-1 text-center font-mono text-[12px] transition-colors',
              recording
                ? 'border-primary/60 bg-primary/15 text-foreground'
                : 'border-border bg-white/[0.02] text-muted-foreground hover:text-foreground'
            )}
          >
            {recording
              ? t('settings.assistant.recording')
              : shortcut
                ? formatAccelerator(shortcut, os)
                : t('settings.assistant.shortcutOff')}
          </button>
          {shortcut && (
            <Button variant="ghost" size="sm" onClick={() => update({ shortcut: null })}>
              {t('settings.assistant.shortcutDisable')}
            </Button>
          )}
          {(!shortcut || bindingKey(shortcut) !== bindingKey(defaultShortcut)) && (
            <Button variant="ghost" size="sm" onClick={() => update({ shortcut: defaultShortcut })}>
              {t('settings.assistant.shortcutReset')}
            </Button>
          )}
        </div>
        {recording && (
          <p className="text-[11px] text-muted-foreground">
            {invalidKey ? t('settings.assistant.shortcutInvalid') : t('settings.assistant.recordingHint')}
          </p>
        )}
        {state.shortcutError && (
          <p className="flex items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="size-3" />
            {t(
              state.shortcutError === 'conflict'
                ? 'settings.assistant.shortcutConflict'
                : 'settings.assistant.shortcutUnsupported'
            )}
          </p>
        )}
        {state.wayland && (
          <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.assistant.wayland')}</p>
        )}
      </div>

      <Switch
        checked={settings.hideOnBlur}
        onChange={(next) => update({ hideOnBlur: next })}
        icon={<EyeOff />}
        title={t('settings.assistant.hideOnBlurTitle')}
        desc={t('settings.assistant.hideOnBlurDesc')}
        disabled={!settings.enabled}
      />
      <Switch
        checked={settings.keepRunning}
        onChange={(next) => update({ keepRunning: next })}
        icon={<AppWindow />}
        title={t('settings.assistant.keepRunningTitle')}
        desc={t('settings.assistant.keepRunningDesc')}
        disabled={!settings.enabled}
      />

      {settings.enabled && info && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{t('settings.assistant.model')}</div>
            <div className="text-[11px] leading-snug text-muted-foreground">{t('settings.assistant.modelDesc')}</div>
          </div>
          <ChatModelChip key={info.conversationId} conversationId={info.conversationId} />
        </div>
      )}

      {settings.enabled && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void window.api.assistantShow()}>
            <Sparkles />
            {t('settings.assistant.open')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void window.api.assistantNewSession().then(setInfo)}>
            <SquarePen />
            {t('settings.assistant.newSession')}
          </Button>
        </div>
      )}

      <VoiceSettings t={t} voice={settings.voice} update={update} disabled={!settings.enabled} />
    </section>
  )
}
