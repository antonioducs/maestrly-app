import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { Button } from '@/components/ui/button'
import { useSettingsLifetime } from '@/lib/fleet/environment-settings'
export interface EnvironmentSettingsSectionProps {
  environment: FleetEnvironment
  fleet: FleetController
  onDirtyChange?: (dirty: boolean, save: () => Promise<boolean>, discard: () => void) => void
}
/**
 * Whether a section's editors show their own save and discard buttons. In the environment settings panel one bar saves
 * every section, so the section's own buttons give way to it; an editor in a dialog of its own keeps them.
 */
const OwnSaveButtons = createContext(true)
export function SharedSaveBarScope({ children }: { children: ReactNode }) {
  return <OwnSaveButtons.Provider value={false}>{children}</OwnSaveButtons.Provider>
}
export function OwnSaveButtonsScope({ children }: { children: ReactNode }) {
  return <OwnSaveButtons.Provider value={true}>{children}</OwnSaveButtons.Provider>
}
export function useOwnSaveButtons(): boolean {
  return useContext(OwnSaveButtons)
}
export const settingsInput =
  'w-full rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-500/60'
export function SettingsPanel({
  children,
  error,
  reload,
  loading,
}: {
  children: ReactNode
  error?: boolean | string
  reload?: () => void
  loading?: boolean
}) {
  const { t } = useTranslation('fleet')
  return (
    <section className="mx-auto w-full max-w-3xl space-y-3 text-[13px]">
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('environmentSettings.loading')}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p>{t(error === 'conflict' ? 'environmentSettings.conflict' : 'environmentSettings.failed')}</p>
          {reload && (
            <Button size="sm" variant="outline" onClick={reload}>
              {t('environmentSettings.reload')}
            </Button>
          )}
        </div>
      )}
      {children}
    </section>
  )
}
export function SaveDiscard({
  dirty,
  busy,
  save,
  discard,
}: {
  dirty: boolean
  busy: boolean
  save: () => Promise<boolean>
  discard: () => void
}) {
  const { t } = useTranslation('fleet')
  if (!useOwnSaveButtons()) return null
  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
        {t('environmentSettings.save')}
      </Button>
      <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={discard}>
        {t('environmentSettings.discard')}
      </Button>
    </div>
  )
}
export function useSettingsDraft<T>(
  initial: T,
  persist: (draft: T) => Promise<void>,
  onDirtyChange?: EnvironmentSettingsSectionProps['onDirtyChange'],
  revision?: string
) {
  const [draft, setDraft] = useState(initial)
  const [baseline, setBaseline] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<boolean | string>(false)
  const observed = useRef(revision)
  const incoming = useRef(initial)
  incoming.current = initial
  const conflict = useRef(false)
  const lifetime = useSettingsLifetime()
  const writing = useRef(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const latest = useRef({ draft, baseline, persist, dirty })
  latest.current = { draft, baseline, persist, dirty }
  useEffect(() => {
    if (revision === undefined || revision === observed.current) return
    observed.current = revision
    // A write may publish its own new snapshot before its response reaches this editor.
    if (writing.current) return
    if (!latest.current.dirty) {
      setDraft(incoming.current)
      setBaseline(incoming.current)
      return
    }
    conflict.current = true
    setError('conflict')
    const value = incoming.current
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      setDraft(
        (previous) =>
          Object.fromEntries(
            Object.entries(value).map(([key, next]) => [
              key,
              JSON.stringify((previous as Record<string, unknown>)[key]) ===
              JSON.stringify((latest.current.baseline as Record<string, unknown>)[key])
                ? next
                : (previous as Record<string, unknown>)[key],
            ])
          ) as T
      )
    }
  }, [revision])
  const save = useCallback(async () => {
    if (writing.current || conflict.current) return false
    if (!latest.current.dirty) return true
    const { draft: value, persist: write } = latest.current
    const epoch = lifetime.current
    writing.current = true
    setBusy(true)
    setError(false)
    try {
      await write(value)
      if (epoch !== lifetime.current) return false
      setBaseline(value)
      setError(false)
      return true
    } catch (cause) {
      if (epoch === lifetime.current)
        setError(/stale-revision|conflict|settings changed/i.test(String(cause)) ? 'conflict' : true)
      return false
    } finally {
      writing.current = false
      if (epoch === lifetime.current) setBusy(false)
    }
  }, [lifetime])
  const discard = useCallback(() => {
    const value = conflict.current ? incoming.current : latest.current.baseline
    setDraft(value)
    setBaseline(value)
    conflict.current = false
    setError(false)
  }, [])
  const reset = useCallback((value: T) => {
    conflict.current = false
    setBaseline(value)
    setDraft(value)
    setError(false)
  }, [])
  useEffect(() => {
    onDirtyChange?.(dirty, save, discard)
  }, [dirty, draft, save, discard, onDirtyChange])
  return { draft, setDraft, dirty, busy, error, save, discard, reset }
}
export function Usage({ bots }: { bots: { id: string; name: string }[] }) {
  const { t } = useTranslation('fleet')
  return bots.length ? (
    <p className="text-[11px] text-muted-foreground">
      {t('environmentSettings.usedBy', { names: bots.map((bot) => bot.name).join(', ') })}
    </p>
  ) : null
}

/** Combine independently saved sections into one navigation guard without losing either draft. */
export function useCombinedSettingsDraft(onDirtyChange: EnvironmentSettingsSectionProps['onDirtyChange']) {
  const drafts = useRef(new Map<string, { dirty: boolean; save: () => Promise<boolean>; discard: () => void }>())
  const callback = useRef(onDirtyChange)
  callback.current = onDirtyChange
  const save = useCallback(async () => {
    for (const draft of drafts.current.values()) if (draft.dirty && !(await draft.save())) return false
    return true
  }, [])
  const discard = useCallback(() => {
    for (const draft of drafts.current.values()) draft.discard()
  }, [])
  return useCallback(
    (id: string, dirty: boolean, write: () => Promise<boolean>, reset: () => void) => {
      drafts.current.set(id, { dirty, save: write, discard: reset })
      callback.current?.(
        [...drafts.current.values()].some((draft) => draft.dirty),
        save,
        discard
      )
    },
    [save, discard]
  )
}
