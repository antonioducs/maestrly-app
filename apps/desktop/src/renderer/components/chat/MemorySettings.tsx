import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useHostApi } from '@/lib/hosts/host-context'
import type { ChatConfig } from '../../../shared/chat'
import type { PersonalMemorySettings, MemorySettings as MemorySettingsConfig } from '../../../shared/memory'
import type { SubagentProfileCandidate } from '../../../shared/subagent-profiles'
import { CandidateFields } from './subagent-profiles/CandidateFields'

const DEFAULT_SETTINGS: MemorySettingsConfig = {
  autoRecall: true,
  extraction: { enabled: false, selection: null },
}

function candidateFor(selection: MemorySettingsConfig['extraction']['selection']): SubagentProfileCandidate {
  return selection
    ? { ...selection, effort: selection.effort || 'off' }
    : { providerId: '', modelId: '', effort: 'off' }
}

const snapshot = (active: boolean, recall: boolean, extract: boolean, model: SubagentProfileCandidate) =>
  JSON.stringify([
    active,
    recall,
    extract,
    model.providerId,
    model.modelId,
    model.effort || 'off',
    model.fastMode === true,
  ])

/** Personal memory settings as its dialog edits them; the chat settings tab saves each change as it is made. */
export function MemorySettings({
  config,
  catalogRevision,
  onChanged,
  onDirtyChange,
  onBusyChange,
  onCancel,
  onSaved,
}: {
  config: ChatConfig
  catalogRevision: number
  onChanged: () => void
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onCancel?: () => void
  onSaved?: () => void
}) {
  const { t } = useTranslation('chat')
  const persisted = DEFAULT_SETTINGS
  const [personalSettings, setPersonalSettings] = useState<PersonalMemorySettings | null>(null)
  const [personalEnabled, setPersonalEnabled] = useState(true)
  const api = useHostApi()
  const [autoRecall, setAutoRecall] = useState(persisted.autoRecall)
  const [enabled, setEnabled] = useState(persisted.extraction.enabled)
  const [candidate, setCandidate] = useState(() => candidateFor(persisted.extraction.selection))
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const draft = snapshot(personalEnabled, autoRecall, enabled, candidate)
  const baseline = useRef(draft)
  const dirty = draft !== baseline.current
  const dirtyRef = useRef(dirty)
  const savingRef = useRef(false)
  dirtyRef.current = dirty

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    onBusyChange?.(saving)
  }, [saving, onBusyChange])

  useEffect(() => {
    let active = true
    let receivedEvent = false
    setLoadError(false)
    const apply = (settings: PersonalMemorySettings) => {
      if (!active || dirtyRef.current || savingRef.current) return
      const nextCandidate = candidateFor(settings.extraction.selection)
      baseline.current = snapshot(settings.enabled, settings.autoRecall, settings.extraction.enabled, nextCandidate)
      setPersonalSettings(settings)
      setPersonalEnabled(settings.enabled)
      setAutoRecall(settings.autoRecall)
      setEnabled(settings.extraction.enabled)
      setCandidate(nextCandidate)
      setLoadError(false)
    }
    const unsubscribe = api.onPersonalMemorySettingsChanged((settings) => {
      receivedEvent = true
      apply(settings)
    })
    void api
      .getPersonalMemorySettings()
      .then((settings) => {
        if (!receivedEvent) apply(settings)
      })
      .catch(() => {
        if (active && !receivedEvent) setLoadError(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, loadAttempt])

  const changeCandidate = useCallback((next: SubagentProfileCandidate) => {
    setCandidate(next)
    setNote(null)
  }, [])

  const save = async () => {
    if (savingRef.current || !personalSettings) return
    if (enabled && (!candidate.providerId || !candidate.modelId)) {
      setNote({ error: true, text: t('memorySettings.modelRequired') })
      return
    }
    savingRef.current = true
    onBusyChange?.(true)
    setSaving(true)
    setNote(null)
    try {
      const settings: MemorySettingsConfig = {
        autoRecall,
        extraction: {
          enabled,
          selection:
            enabled && candidate.providerId && candidate.modelId
              ? {
                  providerId: candidate.providerId,
                  modelId: candidate.modelId,
                  effort: candidate.effort || 'off',
                  fastMode: candidate.fastMode === true,
                }
              : null,
        },
      }
      await api.setPersonalMemorySettings({ ...settings, enabled: personalEnabled })
      baseline.current = draft
      dirtyRef.current = false
      onDirtyChange?.(false)
      setNote({ error: false, text: t('memorySettings.saved') })
      onChanged()
      onSaved?.()
    } catch {
      setNote({ error: true, text: t('memorySettings.saveFailed') })
    } finally {
      savingRef.current = false
      onBusyChange?.(false)
      setSaving(false)
    }
  }

  return (
    <section aria-label={t('personalMemorySettings.title')} className="flex min-h-0 flex-col gap-3 overflow-hidden">
      {!personalSettings && (
        <div role={loadError ? 'alert' : 'status'} className="px-5 py-3 text-xs text-muted-foreground">
          {t(loadError ? 'personalMemorySettings.loadFailed' : 'personalMemorySettings.loading')}
          {loadError && (
            <Button variant="outline" size="sm" className="ml-2" onClick={() => setLoadAttempt((value) => value + 1)}>
              {t('personalMemorySettings.retry')}
            </Button>
          )}
        </div>
      )}
      <fieldset
        disabled={saving || !personalSettings}
        className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-5 disabled:opacity-50 [&>label]:border-b [&>label]:border-border [&>label]:py-3"
      >
        <label className="flex items-start gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={personalEnabled}
            onChange={(event) => {
              setPersonalEnabled(event.target.checked)
              setNote(null)
            }}
            className="mt-0.5 accent-primary"
          />
          <span>
            {t('personalMemorySettings.enabled')}
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {t('personalMemorySettings.enabledHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={autoRecall}
            aria-label={t('memorySettings.autoRecall')}
            onChange={(event) => {
              setAutoRecall(event.target.checked)
              setNote(null)
            }}
            className="mt-0.5 accent-primary"
          />
          <span>
            {t('memorySettings.autoRecall')}
            <span className="mt-0.5 block text-[11px] text-muted-foreground">{t('memorySettings.autoRecallHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={enabled}
            aria-label={t('memorySettings.extraction')}
            onChange={(event) => {
              setEnabled(event.target.checked)
              setNote(null)
            }}
            className="mt-0.5 accent-primary"
          />
          <span>
            {t('memorySettings.extraction')}
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {t('personalMemorySettings.extractionHint')}
            </span>
          </span>
        </label>
        {enabled && (
          <div role="group" aria-label={t('memorySettings.model')} className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">{t('memorySettings.model')}</span>
            <CandidateFields
              candidate={candidate}
              config={config}
              catalogRevision={catalogRevision}
              density="compact"
              responsive
              allowOff
              readOnly={saving}
              onChange={changeCandidate}
            />
          </div>
        )}
      </fieldset>
      {note && (
        <p role="status" className={cn('px-5 text-[11px]', note.error ? 'text-destructive' : 'text-muted-foreground')}>
          {note.text}
        </p>
      )}
      <div className="mt-2 flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          {t('personalMemorySettings.cancel')}
        </Button>
        <Button size="sm" disabled={saving || !personalSettings} onClick={() => void save()}>
          {t(saving ? 'personalMemorySettings.saving' : 'memorySettings.save')}
        </Button>
      </div>
    </section>
  )
}
