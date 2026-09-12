import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/search-select'
import {
  emptySubagentProfileCandidate,
  isRealSubagentProfileEffort,
  subagentProfileProviders,
} from '@/lib/subagent-profile-editor'
import { CandidateFields } from './CandidateFields'
import { CHAT_SUBSCRIPTION_PROVIDER_KINDS, type ChatConfig } from '../../../../shared/chat'
import {
  validateSubagentProfileEffort,
  validateSubagentProfileFastMode,
} from '../../../../shared/subagent-profile-effort'
import {
  isUnavailableClaudeFable,
  normalizeSubagentProfileKey,
  type SubagentAgentDto,
  type SubagentProfileCandidate,
  type SubagentProfileCatalog,
  type SubagentProfileDiagnostic,
  type SubagentProfileRulesV1,
} from '../../../../shared/subagent-profiles'

interface Props {
  value: SubagentProfileRulesV1 | null
  catalog: SubagentProfileCatalog
  config: ChatConfig
  diagnostics?: SubagentProfileDiagnostic[]
  onSave: (rules: SubagentProfileRulesV1) => Promise<boolean>
  onClear?: () => Promise<void>
}

function emptyCandidate(config: ChatConfig): SubagentProfileCandidate {
  return emptySubagentProfileCandidate(subagentProfileProviders(config.providers)[0]?.id ?? '')
}

function profileCandidates(rules: SubagentProfileRulesV1): SubagentProfileCandidate[] {
  return [
    ...(rules.default ?? []),
    ...Object.values(rules.byCategory ?? {}).flat(),
    ...Object.values(rules.byAgent ?? {}).flat(),
  ]
}

function CandidateList({
  candidates,
  config,
  catalogRevision,
  onChange,
}: {
  candidates: SubagentProfileCandidate[]
  config: ChatConfig
  catalogRevision: number
  onChange: (candidates: SubagentProfileCandidate[]) => void
}) {
  const { t } = useTranslation('chat')
  return (
    <div className="flex flex-col gap-1.5">
      {candidates.map((candidate, index) => (
        <div key={index} className="flex items-center gap-1">
          <CandidateFields
            key={`${candidate.providerId}\0${candidate.modelId}`}
            candidate={candidate}
            config={config}
            catalogRevision={catalogRevision}
            onChange={(next) => onChange(candidates.map((item, itemIndex) => (itemIndex === index ? next : item)))}
          />
          <button
            type="button"
            title={t('subagentProfiles.moveUp')}
            disabled={index === 0}
            onClick={() => {
              const next = [...candidates]
              ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
              onChange(next)
            }}
            className="rounded p-1 text-muted-foreground hover:bg-white/5 disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t('subagentProfiles.moveDown')}
            disabled={index === candidates.length - 1}
            onClick={() => {
              const next = [...candidates]
              ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
              onChange(next)
            }}
            className="rounded p-1 text-muted-foreground hover:bg-white/5 disabled:opacity-30"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t('subagentProfiles.remove')}
            onClick={() => onChange(candidates.filter((_, itemIndex) => itemIndex !== index))}
            className="rounded p-1 text-red-300/80 hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...candidates, emptyCandidate(config)])}
        className="inline-flex w-fit items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/5"
      >
        <Plus className="h-3 w-3" /> {t('subagentProfiles.addFallback')}
      </button>
    </div>
  )
}

function RuleMapEditor({
  title,
  value,
  suggestions,
  config,
  catalogRevision,
  agentBadges = false,
  knownAgents = [],
  onChange,
}: {
  title: string
  value: Record<string, SubagentProfileCandidate[]>
  suggestions: string[]
  config: ChatConfig
  catalogRevision: number

  agentBadges?: boolean
  knownAgents?: SubagentAgentDto[]
  onChange: (value: Record<string, SubagentProfileCandidate[]>) => void
}) {
  const { t } = useTranslation('chat')
  const add = (raw: string) => {
    const key = normalizeSubagentProfileKey(raw)
    if (!key || value[key]) return
    onChange({ ...value, [key]: [emptyCandidate(config)] })
  }
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border/70 p-2.5">
      <span className="text-[12px] font-medium text-foreground">{title}</span>
      {Object.entries(value).map(([key, candidates]) => {
        const knownAgent = knownAgents.find((agent) => normalizeSubagentProfileKey(agent.name) === key)
        const isRealAgent = knownAgent != null && !knownAgent.virtual
        return (
          <div key={key} className="flex flex-col gap-1.5 border-t border-border/60 pt-2 first:border-0 first:pt-0">
            <div className="flex items-center justify-between">
              <code className="text-[11px] text-indigo-200">{key}</code>
              <button
                type="button"
                title={t('subagentProfiles.remove')}
                onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([item]) => item !== key)))}
                className="text-red-300/80"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {agentBadges && (
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'rounded px-1 py-px text-[10px] uppercase tracking-wide',
                    isRealAgent ? 'bg-sky-400/15 text-sky-300' : 'bg-indigo-400/15 text-indigo-300'
                  )}
                >
                  {isRealAgent ? t('subagentProfiles.agentRealBadge') : t('subagentProfiles.agentVirtualBadge')}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {isRealAgent ? t('subagentProfiles.realAgentHint') : t('subagentProfiles.virtualAgentHint')}
                </span>
              </div>
            )}
            <CandidateList
              candidates={candidates}
              config={config}
              catalogRevision={catalogRevision}
              onChange={(next) =>
                next.length
                  ? onChange({ ...value, [key]: next })
                  : onChange(Object.fromEntries(Object.entries(value).filter(([item]) => item !== key)))
              }
            />
          </div>
        )
      })}
      <div className="flex gap-1.5">
        <SearchSelect
          className="min-w-0 flex-1"
          options={suggestions
            .filter((item) => !value[normalizeSubagentProfileKey(item)])
            .map((item) => ({ id: item, label: item }))}
          placeholder={t('subagentProfiles.manualKey')}
          ariaLabel={t('subagentProfiles.manualKey')}
          allowCustom
          avoidOverflow
          onChange={(next) => next && add(next)}
        />
      </div>
    </section>
  )
}

export function SubagentProfileRulesEditor({ value, catalog, config, diagnostics = [], onSave, onClear }: Props) {
  const { t } = useTranslation('chat')
  const [rules, setRules] = useState<SubagentProfileRulesV1>(value ?? { version: 1 })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [invalidEffort, setInvalidEffort] = useState(false)
  const [invalidFastMode, setInvalidFastMode] = useState(false)
  const [invalidModel, setInvalidModel] = useState(false)
  const [catalogRevision, setCatalogRevision] = useState(0)
  useEffect(() => setRules(value ?? { version: 1 }), [value])
  useEffect(() => {
    const unsubscribes = CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((provider) =>
      window.api.onChatSubscriptionStatus(provider, () => setCatalogRevision((revision) => revision + 1))
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])
  useEffect(() => {
    setInvalidEffort(false)
    setInvalidFastMode(false)
    setInvalidModel(false)
  }, [rules, catalogRevision, config])
  const invalid = useMemo(() => {
    return profileCandidates(rules).some(
      (candidate) =>
        !candidate.providerId.trim() || !candidate.modelId.trim() || !isRealSubagentProfileEffort(candidate.effort)
    )
  }, [rules])
  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      const fableCandidates = profileCandidates(rules).filter((candidate) =>
        isUnavailableClaudeFable(candidate.providerId, candidate.modelId, [])
      )
      const catalogRequests = new Map<string, ReturnType<typeof window.api.chatSubagentProfilesModelCatalog>>()
      const unavailableModels = await Promise.all(
        fableCandidates.map(async (candidate) => {
          let request = catalogRequests.get(candidate.providerId)
          if (!request) {
            request = window.api.chatSubagentProfilesModelCatalog(candidate.providerId)
            catalogRequests.set(candidate.providerId, request)
          }
          try {
            const catalog = await request
            return (
              catalog.status === 'available' &&
              isUnavailableClaudeFable(candidate.providerId, candidate.modelId, catalog.models)
            )
          } catch {
            return false
          }
        })
      )
      if (unavailableModels.some(Boolean)) {
        setInvalidModel(true)
        return
      }
      const validations = await Promise.all(
        profileCandidates(rules).map(async (candidate) => {
          if (!isRealSubagentProfileEffort(candidate.effort)) return { effort: false, fastMode: true }
          const metadata = await window.api.chatSubagentProfilesModelMeta(candidate.providerId, candidate.modelId)
          return {
            effort: validateSubagentProfileEffort(candidate, metadata).valid,
            fastMode: validateSubagentProfileFastMode(candidate, metadata).valid,
          }
        })
      )
      if (validations.some((validation) => !validation.effort)) {
        setInvalidEffort(true)
        return
      }
      if (validations.some((validation) => !validation.fastMode)) {
        setInvalidFastMode(true)
        return
      }
      const ok = await onSave(rules)
      setSaved(ok)
      if (ok) setTimeout(() => setSaved(false), 1500)
    } catch {
      setSaved(false)
    } finally {
      setSaving(false)
    }
  }
  const clear = async () => {
    if (!onClear) return
    setSaving(true)
    try {
      await onClear()
    } finally {
      setSaving(false)
    }
  }
  return (
    <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
      {diagnostics.map((item, index) => (
        <div
          key={`${item.code}-${index}`}
          title={item.message}
          className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          {t(`subagentProfiles.diagnostics.${item.code}`)}
        </div>
      ))}
      <section className="flex flex-col gap-2 rounded-md border border-border/70 p-2.5">
        <span className="text-[12px] font-medium text-foreground">{t('subagentProfiles.default')}</span>
        <CandidateList
          candidates={rules.default ?? []}
          config={config}
          catalogRevision={catalogRevision}
          onChange={(next) => setRules({ ...rules, default: next.length ? next : undefined })}
        />
      </section>
      <RuleMapEditor
        title={t('subagentProfiles.categories')}
        value={rules.byCategory ?? {}}
        suggestions={catalog.categories}
        config={config}
        catalogRevision={catalogRevision}
        onChange={(next) => setRules({ ...rules, byCategory: Object.keys(next).length ? next : undefined })}
      />
      <RuleMapEditor
        title={t('subagentProfiles.agents')}
        value={rules.byAgent ?? {}}
        suggestions={catalog.agents.map((agent) => agent.name)}
        config={config}
        catalogRevision={catalogRevision}
        agentBadges
        knownAgents={catalog.agents}
        onChange={(next) => setRules({ ...rules, byAgent: Object.keys(next).length ? next : undefined })}
      />
      {invalid && <p className="text-[11px] text-red-300">{t('subagentProfiles.completeRequired')}</p>}
      {invalidModel && <p className="text-[11px] text-red-300">{t('subagentProfiles.modelUnavailable')}</p>}
      {invalidEffort && <p className="text-[11px] text-red-300">{t('subagentProfiles.diagnostics.invalid-effort')}</p>}
      {invalidFastMode && (
        <p className="text-[11px] text-red-300">{t('subagentProfiles.diagnostics.fast-mode-unsupported')}</p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving || invalid || invalidModel || invalidEffort || invalidFastMode}
          onClick={save}
          className="rounded-md bg-indigo-500 px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
        >
          {saving ? t('subagentProfiles.saving') : saved ? t('subagentProfiles.saved') : t('subagentProfiles.save')}
        </button>
        {onClear && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void clear()}
            className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5 disabled:opacity-40"
          >
            {t('subagentProfiles.inheritGlobal')}
          </button>
        )}
      </div>
    </fieldset>
  )
}
