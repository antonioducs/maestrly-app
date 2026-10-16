import { Check } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import {
  isWebSearchProvider,
  WEB_SEARCH_KEY_PROVIDERS,
  WEB_SEARCH_PROVIDERS,
  type WebSearchConfig,
  type WebSearchKeyProvider,
} from '../../../shared/web-search'

const inputCls =
  'rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'

/** Provider choice and API keys for the `web_search` tool. Keys are write-only: the UI only learns whether one is set. */
export function WebSearchSettings({ webSearch, onChanged }: { webSearch: WebSearchConfig; onChanged: () => void }) {
  const api = useHostApi()
  const { t } = useTranslation('chat')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] font-medium text-foreground">{t('settings.webSearchHeading')}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.webSearchDescription')}</p>
        </div>
        <OptionSelect
          className="h-8 w-auto shrink-0 text-[12px]"
          aria-label={t('settings.webSearchHeading')}
          disabled={busy}
          value={webSearch.provider}
          onValueChange={(value) => {
            if (isWebSearchProvider(value)) void run(() => api.chatSetWebSearchProvider(value))
          }}
        >
          {WEB_SEARCH_PROVIDERS.map((provider) => (
            <SelectOption key={provider} value={provider}>
              {t(`settings.webSearchProvider.${provider}`)}
            </SelectOption>
          ))}
        </OptionSelect>
      </div>
      {WEB_SEARCH_KEY_PROVIDERS.map((provider) => (
        <WebSearchKeyRow
          key={provider}
          provider={provider}
          present={webSearch.keys[provider]}
          busy={busy}
          onSave={(key) => run(() => api.chatSetWebSearchKey(provider, key))}
          onRemove={() => run(() => api.chatClearWebSearchKey(provider))}
        />
      ))}
    </div>
  )
}

function WebSearchKeyRow({
  provider,
  present,
  busy,
  onSave,
  onRemove,
}: {
  provider: WebSearchKeyProvider
  present: boolean
  busy: boolean
  onSave: (key: string) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const { t } = useTranslation('chat')
  const [draft, setDraft] = useState('')
  const label = t(`settings.webSearchKeyLabel.${provider}`)
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
