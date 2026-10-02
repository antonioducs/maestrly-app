import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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

export function MemorySettings({
  config,
  scope = 'workspace',
  catalogRevision,
  onChanged,
  locked = false,
  presentation = 'settings',
  onDirtyChange,
  onBusyChange,
  onCancel,
  onSaved,
}: {
  scope?: 'workspace' | 'personal'
  config: ChatConfig
  catalogRevision: number
  onChanged: () => void
  locked?: boolean
  presentation?: 'settings' | 'dialog'
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onCancel?: () => void
  onSaved?: () => void
}) {
  const { t } = useTranslation('chat')
  const persisted = scope === 'personal' ? DEFAULT_SETTINGS : (config.memory ?? DEFAULT_SETTINGS)
  const [personalSettings, setPersonalSettings] = useState<PersonalMemorySettings | null>(null)
  const [personalEnabled, setPersonalEnabled] = useState(true)
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
    if (scope !== 'personal') return
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
    const unsubscribe = window.api.onPersonalMemorySettingsChanged((settings) => {
      receivedEvent = true
      apply(settings)
    })
    void window.api
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
  }, [scope, loadAttempt])

  useEffect(() => {
    if (scope === 'personal' || dirtyRef.current || savingRef.current) return
    const nextCandidate = candidateFor(persisted.extraction.selection)
    baseline.current = snapshot(true, persisted.autoRecall, persisted.extraction.enabled, nextCandidate)
    setAutoRecall(persisted.autoRecall)
    setEnabled(persisted.extraction.enabled)
    setCandidate(nextCandidate)
  }, [scope, persisted.autoRecall, persisted.extraction.enabled, persisted.extraction.selection])

  const changeCandidate = useCallback((next: SubagentProfileCandidate) => {
    setCandidate(next)
    setNote(null)
  }, [])

  const save = async () => {
    if (savingRef.current || locked || (scope === 'personal' && !personalSettings)) return
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
      const result =
        scope === 'personal'
          ? await window.api
              .setPersonalMemorySettings({ ...settings, enabled: personalEnabled })
              .then(() => ({ ok: true, error: undefined }))
          : await window.api.chatSetMemorySettings(settings)
      if (!result.ok) {
        setNote({
          error: true,
          text:
            result.error === 'memory-model-required'
              ? t('memorySettings.modelRequired')
              : result.error || t('memorySettings.saveFailed'),
        })
        return
      }
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
    <section
      aria-labelledby={presentation === 'settings' ? `${scope}-memory-settings-heading` : undefined}
      aria-label={presentation === 'dialog' ? t('personalMemorySettings.title') : undefined}
      className={cn(
        'flex min-h-0 flex-col gap-3',
        presentation === 'settings' ? 'mt-1 border-t border-border pt-3' : 'overflow-hidden'
      )}
    >
      {presentation === 'settings' && (
        <div>
          <h3 id={`${scope}-memory-settings-heading`} className="text-[12px] font-medium text-foreground">
            {t(scope === 'personal' ? 'personalMemorySettings.title' : 'memorySettings.title')}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t(scope === 'personal' ? 'personalMemorySettings.description' : 'memorySettings.description')}
          </p>
        </div>
      )}
      {scope === 'personal' && !personalSettings && (
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
        disabled={saving || locked || (scope === 'personal' && !personalSettings)}
        className={cn(
          'flex min-w-0 flex-col gap-3 disabled:opacity-50',
          presentation === 'dialog' &&
            'min-h-0 overflow-y-auto px-5 [&>label]:border-b [&>label]:border-border [&>label]:py-3'
        )}
      >
        {scope === 'personal' && (
          <>
            {presentation === 'settings' && (
              <button
                type="button"
                className="self-start text-xs text-primary underline"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('maestrly:open-memory', { detail: { personal: true } }))
                }
              >
                {t('personalMemorySettings.manage')}
              </button>
            )}
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
                {presentation === 'dialog' && (
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {t('personalMemorySettings.enabledHint')}
                  </span>
                )}
              </span>
            </label>
          </>
        )}
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
              {t(scope === 'personal' ? 'personalMemorySettings.extractionHint' : 'memorySettings.extractionHint')}
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
              density={presentation === 'dialog' ? 'compact' : 'comfortable'}
              responsive={presentation === 'dialog'}
              allowOff
              readOnly={locked || saving}
              onChange={changeCandidate}
            />
          </div>
        )}
        {presentation === 'settings' && (
          <Button size="sm" className="self-end" disabled={saving || locked} onClick={() => void save()}>
            {t('memorySettings.save')}
          </Button>
        )}
      </fieldset>
      {note && (
        <p
          role="status"
          className={cn(
            'text-[11px]',
            presentation === 'dialog' && 'px-5',
            note.error ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {note.text}
        </p>
      )}
      {presentation === 'dialog' && (
        <div className="mt-2 flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
            {t('personalMemorySettings.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={saving || locked || (scope === 'personal' && !personalSettings)}
            onClick={() => void save()}
          >
            {t(saving ? 'personalMemorySettings.saving' : 'memorySettings.save')}
          </Button>
        </div>
      )}
    </section>
  )
}
