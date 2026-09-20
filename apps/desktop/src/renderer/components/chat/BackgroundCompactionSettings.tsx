import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { BackgroundCompactionConfig } from '../../../shared/background-compaction'
import type { ChatConfig } from '../../../shared/chat'
import type { SubagentProfileCandidate } from '../../../shared/subagent-profiles'
import { CandidateFields } from './subagent-profiles/CandidateFields'

const DEFAULT_INTERVAL_TOKENS = 100_000

function savedConfig(config: ChatConfig): BackgroundCompactionConfig {
  return (
    config.backgroundCompaction ?? {
      enabled: false,
      intervalTokens: DEFAULT_INTERVAL_TOKENS,
      selection: null,
    }
  )
}

function candidateFor(config: BackgroundCompactionConfig): SubagentProfileCandidate {
  return config.selection
    ? {
        providerId: config.selection.providerId,
        modelId: config.selection.modelId,
        effort: config.selection.effort || 'off',
        fastMode: config.selection.fastMode,
      }
    : { providerId: '', modelId: '', effort: 'off' }
}

export function BackgroundCompactionSettings({
  config,
  catalogRevision,
  onChanged,
}: {
  config: ChatConfig
  catalogRevision: number
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const persisted = savedConfig(config)
  const persistedProviderId = persisted.selection?.providerId ?? ''
  const persistedModelId = persisted.selection?.modelId ?? ''
  const persistedEffort = persisted.selection?.effort || 'off'
  const persistedFastMode = persisted.selection?.fastMode === true
  const [enabled, setEnabled] = useState(persisted.enabled)
  const [intervalTokens, setIntervalTokens] = useState(String(persisted.intervalTokens))
  const [candidate, setCandidate] = useState<SubagentProfileCandidate>(() => candidateFor(persisted))
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setEnabled(persisted.enabled)
    setIntervalTokens(String(persisted.intervalTokens))
    setCandidate({
      providerId: persistedProviderId,
      modelId: persistedModelId,
      effort: persistedEffort,
      fastMode: persistedFastMode,
    })
  }, [
    persisted.enabled,
    persisted.intervalTokens,
    persistedEffort,
    persistedFastMode,
    persistedModelId,
    persistedProviderId,
  ])

  const parsedInterval = Number(intervalTokens)
  const intervalValid = Number.isInteger(parsedInterval) && parsedInterval > 0
  const hasModel = Boolean(candidate.providerId && candidate.modelId)
  const saveDisabled = saving || !intervalValid || (enabled && !hasModel)
  const changeCandidate = useCallback((next: SubagentProfileCandidate) => {
    setCandidate(next)
    if (!next.providerId || !next.modelId) setEnabled(false)
    setNote(null)
  }, [])

  const save = async () => {
    if (saveDisabled) return
    setSaving(true)
    setNote(null)
    const next: BackgroundCompactionConfig = {
      enabled,
      intervalTokens: parsedInterval,
      selection: hasModel
        ? {
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            effort: candidate.effort || 'off',
            fastMode: candidate.fastMode === true,
          }
        : null,
    }
    try {
      const result = await window.api.chatSetBackgroundCompaction(next)
      if (!result.ok) {
        setNote({ kind: 'error', text: result.error || t('settings.backgroundCompactionSaveFailed') })
        return
      }
      setNote({ kind: 'saved', text: t('settings.backgroundCompactionSaved') })
      onChanged()
    } catch {
      setNote({ kind: 'error', text: t('settings.backgroundCompactionSaveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      data-background-compaction-settings
      className="mt-1 flex flex-col gap-3 border-t border-border pt-3"
      aria-labelledby="background-compaction-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="background-compaction-heading" className="text-[12px] font-medium text-foreground">
            {t('settings.backgroundCompactionHeading')}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.backgroundCompactionDescription')}</p>
        </div>
        <button
          type="button"
          disabled={!enabled && !hasModel}
          onClick={() => setEnabled((current) => !current)}
          className={cn(
            'mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            enabled ? 'bg-emerald-500/70' : 'bg-white/10',
            !enabled && !hasModel && 'cursor-not-allowed opacity-45'
          )}
          title={
            !hasModel
              ? t('settings.backgroundCompactionModelRequired')
              : enabled
                ? t('settings.toggleOn')
                : t('settings.toggleOff')
          }
          aria-label={t('settings.backgroundCompactionToggle')}
          aria-pressed={enabled}
        >
          <span
            className={cn('block h-3 w-3 rounded-full bg-white transition-transform', enabled && 'translate-x-3')}
          />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">{t('settings.backgroundCompactionModel')}</span>
        <CandidateFields
          candidate={candidate}
          config={config}
          catalogRevision={catalogRevision}
          density="comfortable"
          allowOff
          onChange={changeCandidate}
        />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          {t('settings.backgroundCompactionInterval')}
          <span className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={10_000}
              inputMode="numeric"
              value={intervalTokens}
              onChange={(event) => {
                setIntervalTokens(event.target.value)
                setNote(null)
              }}
              aria-invalid={!intervalValid}
              aria-label={t('settings.backgroundCompactionInterval')}
              className="h-8 w-36 rounded-md border border-input bg-transparent px-3 text-[13px] text-foreground outline-none focus:border-indigo-500/60"
            />
            <span className="font-normal">{t('settings.backgroundCompactionTokens')}</span>
          </span>
        </label>
        <button
          type="button"
          disabled={saveDisabled}
          onClick={() => void save()}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {saving ? t('settings.backgroundCompactionSaving') : t('settings.save')}
        </button>
      </div>

      {!hasModel && <p className="text-[11px] text-amber-300">{t('settings.backgroundCompactionModelRequired')}</p>}
      {!intervalValid && (
        <p className="text-[11px] text-red-300">{t('settings.backgroundCompactionIntervalInvalid')}</p>
      )}
      {note && (
        <p className={cn('text-[11px]', note.kind === 'error' ? 'text-red-300' : 'text-emerald-300')}>{note.text}</p>
      )}
    </section>
  )
}
