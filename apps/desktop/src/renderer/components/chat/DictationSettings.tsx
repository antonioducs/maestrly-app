import { Check } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { cn } from '@/lib/utils'
import {
  DICTATION_API_PROVIDERS,
  DICTATION_ENGINES,
  isDictationEngine,
  type DictationApiProvider,
  type DictationConfig,
} from '../../../shared/dictation'
import {
  DICTATION_NOTICE_KEYS,
  createDictationSettingsActions,
  dictationSettingsModel,
  loadDictationServer,
  type DictationServerView,
  type DictationSettingsApi,
  type DictationSettingsNotice,
} from './dictation-settings-model'

const inputCls =
  'rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'

/**
 * This computer's dictation engine and API keys, and the bot server's key for phones. Dictation runs where the
 * microphone is, so these settings are this computer's, whichever host the settings window shows. Keys are
 * write-only: the screen only learns whether one is set, and of the server's key its last four characters.
 */
export function DictationSettings() {
  const { t } = useTranslation('chat')
  const api = window.api as unknown as DictationSettingsApi
  const actions = useMemo(() => createDictationSettingsActions(api), [api])
  const [config, setConfig] = useState<DictationConfig | null>(null)
  const [server, setServer] = useState<DictationServerView>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<DictationSettingsNotice | null>(null)

  const refresh = useCallback(async () => {
    const [nextConfig, nextServer] = await Promise.all([
      api.chatDictationConfig().catch(() => null),
      loadDictationServer(api),
    ])
    if (nextConfig) setConfig(nextConfig)
    setServer(nextServer)
  }, [api])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (action: () => Promise<DictationSettingsNotice | null>) => {
    setBusy(true)
    try {
      setNotice(await action())
    } catch (error) {
      console.error('[dictation] settings action failed', error)
      setNotice(null)
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  if (!config) return null
  const model = dictationSettingsModel(config, server)
  const noticeFor = (scope: DictationSettingsNotice['scope']) =>
    notice?.scope === scope ? (
      <p className={cn('text-[11px]', notice.kind === 'memory' ? 'text-amber-400' : 'text-destructive')}>
        {t(DICTATION_NOTICE_KEYS[notice.kind])}
      </p>
    ) : null

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] font-medium text-foreground">{t('settings.dictationHeading')}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.dictationDescription')}</p>
        </div>
        <OptionSelect
          className="h-8 w-auto shrink-0 text-[12px]"
          aria-label={t('settings.dictationHeading')}
          disabled={busy}
          value={config.engine}
          onValueChange={(value) => {
            if (isDictationEngine(value)) void run(() => actions.setEngine(value))
          }}
        >
          {DICTATION_ENGINES.map((engine) => (
            <SelectOption key={engine} value={engine}>
              {t(`settings.dictationEngine.${engine}`)}
            </SelectOption>
          ))}
        </OptionSelect>
      </div>
      {DICTATION_API_PROVIDERS.map((provider) => (
        <div key={provider} className="flex flex-col gap-1">
          <DictationKeyRow
            provider={provider}
            present={config.keys[provider]}
            busy={busy}
            onSave={(key) => run(() => actions.saveKey(provider, key))}
            onRemove={() => run(() => actions.clearKey(provider))}
          />
          {noticeFor(provider)}
        </div>
      ))}
      {model.phone === 'old' && <p className="text-[11px] text-muted-foreground">{t('settings.dictationServerOld')}</p>}
      {model.phone === 'ready' && model.state && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-foreground">{t('settings.dictationServerHeading')}</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              {model.state.key === 'settings.dictationServerState'
                ? t(model.state.key, {
                    provider: t(`settings.dictationEngine.${model.state.provider}`),
                    hint: model.state.hint,
                  })
                : t(model.state.key)}
            </span>
            {model.useOnPhone && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => actions.useOnPhone())}
                className="rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
              >
                {t('settings.dictationUseOnPhone')}
              </button>
            )}
            {model.removeFromServer && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => actions.removeFromServer())}
                className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:text-destructive"
              >
                {t('settings.dictationRemoveFromServer')}
              </button>
            )}
          </div>
          {noticeFor('server')}
        </div>
      )}
    </div>
  )
}

function DictationKeyRow({
  provider,
  present,
  busy,
  onSave,
  onRemove,
}: {
  provider: DictationApiProvider
  present: boolean
  busy: boolean
  onSave: (key: string) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const { t } = useTranslation('chat')
  const [draft, setDraft] = useState('')
  const label = t(`settings.dictationKeyLabel.${provider}`)
  const save = async () => {
    const key = draft.trim()
    if (!key) return
    setDraft('')
    await onSave(key)
  }
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      {present ? (
        <>
          <span className="inline-flex flex-1 items-center gap-1 text-[11px] text-emerald-400">
            <Check className="h-3 w-3" /> {t('settings.keySaved')}
          </span>
          <button
            type="button"
            onClick={() => void onRemove()}
            disabled={busy}
            className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:text-destructive"
          >
            {t('settings.webSearchKeyRemove')}
          </button>
        </>
      ) : (
        <>
          <input
            type="password"
            autoComplete="off"
            aria-label={label}
            value={draft}
            disabled={busy}
            placeholder={t('settings.webSearchKeyPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            className={cn(inputCls, 'min-w-0 flex-1')}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!draft.trim() || busy}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[12px] font-medium',
              draft.trim() ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-foreground/10 text-muted-foreground'
            )}
          >
            {t('settings.webSearchKeySave')}
          </button>
        </>
      )}
    </div>
  )
}
