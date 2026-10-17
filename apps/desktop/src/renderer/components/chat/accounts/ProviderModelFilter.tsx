import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import { ModelVisibilityCheckbox } from '../ModelVisibilityCheckbox'
import { modelDisplayName } from '../model-search'
import { inputCls } from './account-ui'

export function ProviderModelFilter({
  providerId,
  onFilterChanged,
}: {
  providerId: string
  onFilterChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [query, setQuery] = useState('')
  const hiddenRef = useRef<string[]>([])
  const hiddenRevisionRef = useRef(0)
  const latestSaveIdRef = useRef(0)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const aliveRef = useRef(true)

  const applyHidden = useCallback((next: string[]) => {
    hiddenRef.current = next
    setHidden(next)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    const hiddenRevision = hiddenRevisionRef.current
    api
      .chatHiddenModels()
      .then((map) => {
        if (alive && hiddenRevision === hiddenRevisionRef.current) applyHidden(map[providerId] ?? [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [applyHidden, providerId, api])

  useEffect(() => {
    if (!open) return
    let alive = true
    const hiddenRevision = hiddenRevisionRef.current
    setLoading(true)
    setFailed(false)
    setSaveError(false)
    setModels([])
    setQuery('')
    Promise.all([api.chatModels(providerId, false, true), api.chatHiddenModels()])
      .then(([all, map]) => {
        if (!alive) return
        setModels(all)

        if (hiddenRevision === hiddenRevisionRef.current) applyHidden(map[providerId] ?? [])
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [applyHidden, open, providerId, api])

  const hiddenSet = new Set(hidden)
  const persist = (update: (current: string[]) => string[]) => {
    const next = update(hiddenRef.current)
    const saveId = ++latestSaveIdRef.current
    hiddenRevisionRef.current += 1
    applyHidden(next)
    setSaveError(false)
    setSaving(true)

    const save = async () => {
      hiddenRevisionRef.current += 1
      try {
        const result = await api.chatSetHiddenModels(providerId, next)
        if (!result.ok) throw new Error(result.error ?? 'save-failed')

        hiddenRevisionRef.current += 1
        if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
        applyHidden(next)
        setSaving(false)
        onFilterChanged()
      } catch {
        hiddenRevisionRef.current += 1

        if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
        try {
          const map = await api.chatHiddenModels()
          if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
          hiddenRevisionRef.current += 1
          applyHidden(map[providerId] ?? [])

          onFilterChanged()
        } catch {}
        if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
        setSaving(false)
        setSaveError(true)
      }
    }

    saveQueueRef.current = saveQueueRef.current.then(save, save)
  }
  const toggle = (modelId: string) =>
    persist((current) => (current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]))
  const q = query.trim().toLowerCase()

  const shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models
  const showAll = () => persist((current) => current.filter((id) => !shown.includes(id)))
  const hideAll = () => persist((current) => [...new Set([...current, ...shown])])
  const visibleCount = models.filter((m) => !hiddenSet.has(m)).length

  const toggleOpen = () => {
    if (!open) {
      setLoading(true)
      setModels([])
      setFailed(false)
      setQuery('')
    }
    setOpen((current) => !current)
  }

  return (
    <section className="mt-4 border-t border-border/70 pt-4">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[12px] font-medium text-foreground hover:text-foreground/80"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {t('settings.modelFilterToggle')}
        {hidden.length > 0 && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            {t('settings.modelFilterBadge', { count: hidden.length })}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[11px] text-muted-foreground">{t('settings.modelFilterDescription')}</p>
          <input
            className={cn(inputCls, 'py-1 text-[12px]')}
            placeholder={t('settings.modelFilterSearchPlaceholder')}
            value={query}
            disabled={loading}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {t('settings.modelFilterCount', {
                visible: visibleCount,
                total: models.length,
              })}
              {saving && <Loader2 className="h-3 w-3 animate-spin" aria-label={t('settings.modelFilterSaving')} />}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={showAll}
                disabled={loading || shown.length === 0}
                className="hover:text-foreground disabled:opacity-40"
              >
                {t('settings.modelFilterShowAll')}
              </button>
              <button
                type="button"
                onClick={hideAll}
                disabled={loading || shown.length === 0}
                className="hover:text-foreground disabled:opacity-40"
              >
                {t('settings.modelFilterHideAll')}
              </button>
            </span>
          </div>
          <div className="max-h-56 overflow-auto rounded-md border border-border">
            {loading && (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('settings.loadingModels')}
              </div>
            )}
            {!loading && failed && (
              <p className="px-2.5 py-2 text-[12px] text-destructive">{t('settings.modelFilterLoadFailed')}</p>
            )}
            {!loading && !failed && models.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-muted-foreground">{t('settings.modelFilterEmpty')}</p>
            )}
            {!loading && !failed && models.length > 0 && shown.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-muted-foreground">{t('settings.modelFilterNoMatch')}</p>
            )}
            {!loading &&
              !failed &&
              shown.map((m) => (
                <ModelVisibilityCheckbox
                  key={m}
                  name={modelDisplayName(m)}
                  checked={!hiddenSet.has(m)}
                  onChange={() => toggle(m)}
                />
              ))}
          </div>
          {saveError && <p className="text-[11px] text-destructive">{t('settings.modelFilterSaveFailed')}</p>}
        </div>
      )}
    </section>
  )
}
