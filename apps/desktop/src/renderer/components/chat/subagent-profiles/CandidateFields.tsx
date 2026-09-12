import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/search-select'
import {
  changeSubagentProfileModel,
  changeSubagentProfileProvider,
  changeSubagentProfileFastMode,
  isRealSubagentProfileEffort,
  subagentProfileAllowsCustomEffort,
  subagentProfileEffortIds,
  subagentProfileModelOptions,
  subagentProfileProviders,
} from '@/lib/subagent-profile-editor'
import { subagentEffortLabel } from '@/lib/subagent-profile-display'
import { type ChatConfig } from '../../../../shared/chat'
import {
  validateSubagentProfileEffort,
  type SubagentProfileModelMetaResult,
} from '../../../../shared/subagent-profile-effort'
import { isUnavailableClaudeFable, type SubagentProfileCandidate } from '../../../../shared/subagent-profiles'

export function CandidateFields({
  candidate,
  config,
  catalogRevision,
  density = 'compact',
  allowOff = false,
  readOnly = false,
  onChange,
}: {
  candidate: SubagentProfileCandidate
  config: ChatConfig
  catalogRevision: number
  density?: 'compact' | 'comfortable'

  allowOff?: boolean

  readOnly?: boolean
  onChange: (candidate: SubagentProfileCandidate) => void
}) {
  const { t } = useTranslation('chat')
  const [models, setModels] = useState<string[]>([])
  const [modelCatalogStatus, setModelCatalogStatus] = useState<'loading' | 'available' | 'unavailable'>('loading')
  const [modelMeta, setModelMeta] = useState<SubagentProfileModelMetaResult | null>(null)

  useEffect(() => {
    let alive = true
    setModels([])
    setModelCatalogStatus('loading')
    if (!candidate.providerId) {
      setModelCatalogStatus('unavailable')
      return
    }

    void window.api
      .chatSubagentProfilesModelCatalog(candidate.providerId)
      .then((catalog) => {
        if (!alive) return
        setModels(catalog.models)
        setModelCatalogStatus(catalog.status)
      })
      .catch(() => {
        if (!alive) return
        setModelCatalogStatus('unavailable')
      })
    return () => {
      alive = false
    }
  }, [candidate.providerId, catalogRevision, config])

  useEffect(() => {
    let alive = true
    setModelMeta(null)
    if (!candidate.providerId || !candidate.modelId) return

    void window.api
      .chatSubagentProfilesModelMeta(candidate.providerId, candidate.modelId)
      .then((value) => alive && setModelMeta(value))
      .catch(() => alive && setModelMeta({ status: 'unavailable', meta: null }))
    return () => {
      alive = false
    }
  }, [candidate.providerId, candidate.modelId, catalogRevision, config])

  useEffect(() => {
    if (!modelMeta || candidate.fastMode !== true || modelMeta.meta?.fastModeCapability === true) return
    if (!readOnly) onChange(changeSubagentProfileFastMode(candidate, false))
  }, [candidate, modelMeta, onChange, readOnly])

  useEffect(() => {
    if (!allowOff || modelMeta?.status !== 'available') return
    if (candidate.effort === 'off') return
    if ((!candidate.effort || modelMeta.meta?.reasoning === false) && !readOnly) {
      onChange({ ...candidate, effort: 'off' })
    }
  }, [allowOff, candidate, modelMeta, onChange, readOnly])

  const validateEffort = (effort: string) =>
    modelMeta ? validateSubagentProfileEffort({ ...candidate, effort }, modelMeta) : null
  const effortValidation = validateEffort(candidate.effort)
  const effortIds = subagentProfileEffortIds(modelMeta)
  const allowCustomEffort = subagentProfileAllowsCustomEffort(modelMeta)
  const noConfigurableEffort = modelMeta?.status === 'available' && modelMeta.meta?.reasoning === false
  const effortOptions = [
    ...(allowOff ? [{ id: 'off', label: t('reasoning.default') }] : []),
    ...effortIds.map((effort) => ({ id: effort, label: subagentEffortLabel(effort, t) })),
  ]
  const unavailableFable =
    modelCatalogStatus === 'available' && isUnavailableClaudeFable(candidate.providerId, candidate.modelId, models)
  const selectClassName = density === 'comfortable' ? '[&>button]:h-9 [&>button]:text-sm' : undefined
  const selectContentClassName = density === 'comfortable' ? '[&_[role=option]]:text-sm [&_input]:text-sm' : undefined

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[minmax(110px,0.8fr)_minmax(140px,1.4fr)_minmax(150px,1fr)] gap-1.5">
      <SearchSelect
        className={selectClassName}
        contentClassName={selectContentClassName}
        value={candidate.providerId || undefined}
        avoidOverflow
        options={subagentProfileProviders(config.providers).map((provider) => ({
          id: provider.id,
          label: `${provider.name}${provider.apiKeyPresent ? '' : ` (${t('subagentProfiles.noKey')})`}`,
        }))}
        placeholder={t('subagentProfiles.provider')}
        ariaLabel={t('subagentProfiles.provider')}
        disabled={readOnly}
        onChange={(providerId) => onChange(changeSubagentProfileProvider(candidate, providerId ?? ''))}
      />
      <SearchSelect
        className={selectClassName}
        contentClassName={selectContentClassName}
        value={candidate.modelId || undefined}
        avoidOverflow
        options={subagentProfileModelOptions(
          candidate.providerId,
          models,
          t('subagentProfiles.modelUnavailableShort'),
          modelCatalogStatus === 'available'
        )}
        placeholder={t('subagentProfiles.model')}
        ariaLabel={t('subagentProfiles.model')}
        allowCustom
        disabled={readOnly}
        invalid={unavailableFable}
        onChange={(modelId) => {
          const next = modelId ?? ''
          if (modelCatalogStatus === 'available' && isUnavailableClaudeFable(candidate.providerId, next, models)) {
            return
          }
          onChange(changeSubagentProfileModel(candidate, next))
        }}
      />
      <SearchSelect
        className={selectClassName}
        contentClassName={selectContentClassName}
        value={candidate.effort || undefined}
        options={effortOptions}
        placeholder={
          noConfigurableEffort ? t('subagentProfiles.noConfigurableEffortShort') : t('subagentProfiles.effort')
        }
        ariaLabel={t('subagentProfiles.effort')}
        allowCustom={allowCustomEffort && !allowOff}
        disabled={!modelMeta || readOnly}
        invalid={
          candidate.effort !== 'off' &&
          (!isRealSubagentProfileEffort(candidate.effort) || noConfigurableEffort || effortValidation?.valid === false)
        }
        avoidOverflow
        panelWidth={280}
        panelAlign="end"
        onChange={(effort) => onChange({ ...candidate, effort: effort?.trim().toLowerCase() ?? '' })}
      />
      {modelMeta?.status === 'available' && modelMeta.meta?.fastModeCapability === true && (
        <button
          type="button"
          aria-pressed={candidate.fastMode === true}
          aria-label={t('subagentProfiles.fastMode')}
          title={t('subagentProfiles.fastModeTooltip')}
          disabled={readOnly}
          onClick={() => onChange(changeSubagentProfileFastMode(candidate, candidate.fastMode !== true))}
          className={cn(
            'col-span-3 inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-white/[0.05]',
            candidate.fastMode === true
              ? 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/15'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Zap className={cn('h-3.5 w-3.5', candidate.fastMode === true && 'fill-current')} />
          <span>{candidate.fastMode === true ? t('fastMode.label') : t('subagentProfiles.standardMode')}</span>
        </button>
      )}
      {noConfigurableEffort && !allowOff && (
        <p className="col-span-3 text-[11px] text-amber-300">{t('subagentProfiles.noConfigurableEffort')}</p>
      )}
      {unavailableFable && (
        <p className="col-span-3 text-[11px] text-red-300">{t('subagentProfiles.modelUnavailable')}</p>
      )}
      {allowCustomEffort && !allowOff && candidate.effort && (
        <p className="col-span-3 text-[11px] text-amber-300">{t('subagentProfiles.diagnostics.effort-unverified')}</p>
      )}
    </div>
  )
}
