import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ChatConfig } from '../../../shared/chat'
import type { MemorySettings as MemorySettingsConfig } from '../../../shared/memory'
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

export function MemorySettings({
  config,
  catalogRevision,
  onChanged,
  locked = false,
}: {
  config: ChatConfig
  catalogRevision: number
  onChanged: () => void
  locked?: boolean
}) {
  const { t } = useTranslation('chat')
  const persisted = config.memory ?? DEFAULT_SETTINGS
  const [autoRecall, setAutoRecall] = useState(persisted.autoRecall)
  const [enabled, setEnabled] = useState(persisted.extraction.enabled)
  const [candidate, setCandidate] = useState(() => candidateFor(persisted.extraction.selection))
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)

  useEffect(() => {
    setAutoRecall(persisted.autoRecall)
    setEnabled(persisted.extraction.enabled)
    setCandidate(candidateFor(persisted.extraction.selection))
  }, [persisted.autoRecall, persisted.extraction.enabled, persisted.extraction.selection])

  const changeCandidate = useCallback((next: SubagentProfileCandidate) => {
    setCandidate(next)
    setNote(null)
  }, [])

  const save = async () => {
    if (saving || locked) return
    setSaving(true)
    setNote(null)
    try {
      const result = await window.api.chatSetMemorySettings({
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
      })
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
      setNote({ error: false, text: t('memorySettings.saved') })
      onChanged()
    } catch {
      setNote({ error: true, text: t('memorySettings.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="memory-settings-heading" className="mt-1 flex flex-col gap-3 border-t border-border pt-3">
      <div>
        <h3 id="memory-settings-heading" className="text-[12px] font-medium text-foreground">
          {t('memorySettings.title')}
        </h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('memorySettings.description')}</p>
      </div>
      <fieldset disabled={saving || locked} className="flex flex-col gap-3 disabled:opacity-50">
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
            <span className="mt-0.5 block text-[11px] text-muted-foreground">{t('memorySettings.extractionHint')}</span>
          </span>
        </label>
        {enabled && (
          <div role="group" aria-label={t('memorySettings.model')} className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">{t('memorySettings.model')}</span>
            <CandidateFields
              candidate={candidate}
              config={config}
              catalogRevision={catalogRevision}
              density="comfortable"
              allowOff
              readOnly={locked || saving}
              onChange={changeCandidate}
            />
          </div>
        )}
        <Button size="sm" className="self-end" disabled={saving || locked} onClick={() => void save()}>
          {t('memorySettings.save')}
        </Button>
      </fieldset>
      {note && (
        <p role="status" className={note.error ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'}>
          {note.text}
        </p>
      )}
    </section>
  )
}
