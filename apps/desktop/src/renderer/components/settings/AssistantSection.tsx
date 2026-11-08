import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, AppWindow, EyeOff, Keyboard, Power, SquarePen, Sparkles } from 'lucide-react'
import {
  type AssistantInfo,
  type AssistantSettingsPatch,
  type AssistantSettingsState,
  bindingFromKeyPress,
  defaultAssistantShortcut,
  effectiveAssistantShortcut,
} from '../../../shared/assistant'
import { bindingKey, formatAccelerator } from '../../../shared/shortcuts'
import { Button } from '@/components/ui/button'
import { ChatModelChip } from '@/components/chat/ChatModelChip'
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
    </section>
  )
}
