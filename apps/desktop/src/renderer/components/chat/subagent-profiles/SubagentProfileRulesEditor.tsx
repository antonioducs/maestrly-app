import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Plus, Trash2, X } from 'lucide-react'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/search-select'
import { chatProviderChoices } from '../account-pool'
import { ModelPicker } from '../model-settings/ModelPicker'
import { ProfileSelectionBody } from '../model-settings/SelectionBodies'
import type { ModelSelection } from '../model-settings/model-selection'
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

type Scope = 'default' | 'category' | 'agent'

/** A rule being added, or a fallback being added to a rule, until its picker closes. */
interface PendingSlot {
  scope: Scope
  key: string
  index: number
}

function profileCandidates(rules: SubagentProfileRulesV1): SubagentProfileCandidate[] {
  return [
    ...(rules.default ?? []),
    ...Object.values(rules.byCategory ?? {}).flat(),
    ...Object.values(rules.byAgent ?? {}).flat(),
  ]
}

function chainOf(rules: SubagentProfileRulesV1, scope: Scope, key: string): SubagentProfileCandidate[] {
  if (scope === 'default') return rules.default ?? []
  return (scope === 'category' ? rules.byCategory : rules.byAgent)?.[key] ?? []
}

/** Rules with one chain replaced; an empty chain removes its rule (the default then follows the conversation). */
function withChain(
  rules: SubagentProfileRulesV1,
  scope: Scope,
  key: string,
  chain: SubagentProfileCandidate[]
): SubagentProfileRulesV1 {
  if (scope === 'default') return { ...rules, default: chain.length ? chain : undefined }
  const field = scope === 'category' ? 'byCategory' : 'byAgent'
  const map = { ...(rules[field] ?? {}) }
  if (chain.length) map[key] = chain
  else delete map[key]
  return { ...rules, [field]: Object.keys(map).length ? map : undefined }
}

const candidateOf = (selection: ModelSelection): SubagentProfileCandidate => ({
  providerId: selection.providerId,
  modelId: selection.modelId,
  effort: selection.effort ?? '',
  ...(selection.fastMode ? { fastMode: true } : {}),
})

export function SubagentProfileRulesEditor({ value, catalog, config, diagnostics = [], onSave, onClear }: Props) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [rules, setRules] = useState<SubagentProfileRulesV1>(value ?? { version: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingSlot | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  useEffect(() => setRules(value ?? { version: 1 }), [value])
  useEffect(() => {
    const unsubscribes = CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((provider) =>
      api.onChatSubscriptionStatus(provider, () => setCatalogRevision((revision) => revision + 1))
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [api])
  useEffect(() => setError(null), [rules, catalogRevision, config])

  /** Same checks as the runtime before saving: Fable must be in the account's catalog, effort and Fast supported. */
  const validate = async (next: SubagentProfileRulesV1): Promise<string | null> => {
    const fableCandidates = profileCandidates(next).filter((candidate) =>
      isUnavailableClaudeFable(candidate.providerId, candidate.modelId, [])
    )
    const catalogRequests = new Map<string, ReturnType<typeof api.chatSubagentProfilesModelCatalog>>()
    const unavailableModels = await Promise.all(
      fableCandidates.map(async (candidate) => {
        let request = catalogRequests.get(candidate.providerId)
        if (!request) {
          request = api.chatSubagentProfilesModelCatalog(candidate.providerId)
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
    if (unavailableModels.some(Boolean)) return t('subagentProfiles.modelUnavailable')
    const validations = await Promise.all(
      profileCandidates(next).map(async (candidate) => {
        const metadata = await api.chatSubagentProfilesModelMeta(candidate.providerId, candidate.modelId)
        return {
          effort: validateSubagentProfileEffort(candidate, metadata).valid,
          fastMode: validateSubagentProfileFastMode(candidate, metadata).valid,
        }
      })
    )
    if (validations.some((validation) => !validation.effort)) return t('subagentProfiles.diagnostics.invalid-effort')
    if (validations.some((validation) => !validation.fastMode))
      return t('subagentProfiles.diagnostics.fast-mode-unsupported')
    return null
  }

  /** Validates and saves at once; the rules shown change only once the save is confirmed. */
  const persist = async (next: SubagentProfileRulesV1): Promise<string | null> => {
    setBusy(true)
    try {
      const invalid = await validate(next)
      if (invalid) return invalid
      if (!(await onSave(next))) return t('modelSettings.saveFailed')
      setRules(next)
      return null
    } catch {
      return t('modelSettings.saveFailed')
    } finally {
      setBusy(false)
    }
  }
  const act = (next: SubagentProfileRulesV1) => void persist(next).then(setError)

  const clear = async () => {
    if (!onClear) return
    setBusy(true)
    try {
      await onClear()
    } finally {
      setBusy(false)
    }
  }

  const ruleKeys = (scope: 'category' | 'agent') => {
    const keys = Object.keys((scope === 'category' ? rules.byCategory : rules.byAgent) ?? {})
    return pending?.scope === scope && !keys.includes(pending.key) ? [...keys, pending.key] : keys
  }
  const used = (scope: 'category' | 'agent') => new Set(ruleKeys(scope))
  const addRule = (scope: 'category' | 'agent', raw: string) => {
    const key = normalizeSubagentProfileKey(raw)
    if (!key || used(scope).has(key)) return
    setPending({ scope, key, index: 0 })
  }

  const ruleRow = (scope: Scope, key: string) => (
    <RuleRow
      key={`${scope}:${key}`}
      scope={scope}
      ruleKey={key}
      chain={chainOf(rules, scope, key)}
      config={config}
      catalogRevision={catalogRevision}
      knownAgents={catalog.agents}
      pendingIndex={pending?.scope === scope && pending.key === key ? pending.index : null}
      onAddFallback={(index) => setPending({ scope, key, index })}
      onPendingClosed={() => setPending(null)}
      onCommit={(index, selection) => {
        const chain = [...chainOf(rules, scope, key)]
        if (selection) chain[index] = candidateOf(selection)
        else chain.splice(index, 1)
        return persist(withChain(rules, scope, key, chain))
      }}
      onChain={(chain) => act(withChain(rules, scope, key, chain))}
    />
  )

  return (
    <div aria-busy={busy} className="@container flex min-w-0 flex-col gap-2.5">
      {diagnostics.map((item, index) => (
        <div
          key={`${item.code}-${index}`}
          title={item.message}
          className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          {t(`subagentProfiles.diagnostics.${item.code}`)}
        </div>
      ))}
      <div className="divide-y divide-border rounded-lg border border-border bg-white/[0.02]">
        {ruleRow('default', '')}
        {ruleKeys('category').map((key) => ruleRow('category', key))}
        {ruleKeys('agent').map((key) => ruleRow('agent', key))}
        <div className="flex flex-wrap gap-2 px-3.5 py-2.5">
          <SearchSelect
            className="w-56 max-w-full [&>button]:border-dashed [&>button]:text-muted-foreground"
            options={catalog.agents
              .map((agent) => agent.name)
              .filter((name) => !used('agent').has(normalizeSubagentProfileKey(name)))
              .map((name) => ({ id: name, label: name }))}
            placeholder={t('modelSettings.subagents.addAgent')}
            ariaLabel={t('modelSettings.subagents.addAgent')}
            allowCustom
            avoidOverflow
            onChange={(next) => next && addRule('agent', next)}
          />
          <SearchSelect
            className="w-56 max-w-full [&>button]:border-dashed [&>button]:text-muted-foreground"
            options={catalog.categories
              .filter((name) => !used('category').has(normalizeSubagentProfileKey(name)))
              .map((name) => ({ id: name, label: name }))}
            placeholder={t('modelSettings.subagents.addCategory')}
            ariaLabel={t('modelSettings.subagents.addCategory')}
            allowCustom
            avoidOverflow
            onChange={(next) => next && addRule('category', next)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-red-300">
          {error}
        </p>
      )}
      {onClear && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void clear()}
          className="w-fit rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5 disabled:opacity-40"
        >
          {t('subagentProfiles.inheritGlobal')}
        </button>
      )}
    </div>
  )
}

function RuleRow({
  scope,
  ruleKey,
  chain,
  config,
  catalogRevision,
  knownAgents,
  pendingIndex,
  onAddFallback,
  onPendingClosed,
  onCommit,
  onChain,
}: {
  scope: Scope
  ruleKey: string
  chain: SubagentProfileCandidate[]
  config: ChatConfig
  catalogRevision: number
  knownAgents: SubagentAgentDto[]
  /** Slot whose picker opens by itself: a new rule or a new fallback. */
  pendingIndex: number | null
  onAddFallback: (index: number) => void
  onPendingClosed: () => void
  onCommit: (index: number, selection: ModelSelection | null) => Promise<string | null>
  onChain: (chain: SubagentProfileCandidate[]) => void
}) {
  const { t } = useTranslation('chat')
  const knownAgent =
    scope === 'agent' ? knownAgents.find((agent) => normalizeSubagentProfileKey(agent.name) === ruleKey) : undefined
  const isRealAgent = knownAgent != null && !knownAgent.virtual
  const slots = Math.max(chain.length, pendingIndex != null ? pendingIndex + 1 : 0, scope === 'default' ? 1 : 0)
  const name = scope === 'default' ? t('modelSettings.subagents.allSubagents') : ruleKey
  const move = (from: number, to: number) => {
    const next = [...chain]
    ;[next[from], next[to]] = [next[to], next[from]]
    onChain(next)
  }

  return (
    <div className="grid grid-cols-1 items-start gap-x-3 gap-y-2 px-3.5 py-2.5 @xl:grid-cols-[minmax(0,170px)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-0.5 pt-1">
        {scope === 'default' ? (
          <span className="truncate text-[12px] font-medium text-foreground">{name}</span>
        ) : (
          <code className="truncate text-[12px] text-indigo-200" title={ruleKey}>
            {ruleKey}
          </code>
        )}
        <span className="flex flex-wrap items-center gap-1 text-[10.5px] text-muted-foreground">
          {t(`modelSettings.subagents.kind.${scope}`)}
          {scope === 'agent' && (
            <span
              title={isRealAgent ? t('subagentProfiles.realAgentHint') : t('subagentProfiles.virtualAgentHint')}
              className={cn(
                'rounded px-1 py-px text-[9.5px] uppercase tracking-wide',
                isRealAgent ? 'bg-sky-400/15 text-sky-300' : 'bg-indigo-400/15 text-indigo-300'
              )}
            >
              {isRealAgent ? t('subagentProfiles.agentRealBadge') : t('subagentProfiles.agentVirtualBadge')}
            </span>
          )}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {Array.from({ length: slots }, (_, index) => {
          const candidate = chain[index]
          const value: ModelSelection | null = candidate ?? null
          const pendingHere = pendingIndex === index
          return (
            <Fragment key={index}>
              {index > 0 && (
                <ArrowRight
                  aria-label={t('modelSettings.subagents.fallback')}
                  className="size-3 shrink-0 text-muted-foreground/70"
                />
              )}
              <ModelPicker
                value={value}
                providers={chatProviderChoices(config)}
                label={t('modelSettings.subagents.candidateLabel', { rule: name, position: index + 1 })}
                placeholder={
                  scope === 'default' && chain.length === 0
                    ? t('modelSettings.subagents.inheritConversation')
                    : t('modelSettings.chooseModel')
                }
                className="w-fit max-w-[280px]"
                {...(pendingHere ? { open: true, onOpenChange: (open: boolean) => !open && onPendingClosed() } : {})}
              >
                {(close) => (
                  <ProfileSelectionBody
                    value={value}
                    config={config}
                    catalogRevision={catalogRevision}
                    inherit={
                      scope === 'default' && index === 0 && chain.length <= 1
                        ? {
                            label: t('modelSettings.subagents.inheritConversation'),
                            hint: t('modelSettings.subagents.inheritHint'),
                          }
                        : undefined
                    }
                    onCommit={(selection) => onCommit(index, selection)}
                    actions={
                      candidate && (
                        <>
                          {chain.length > 1 && index > 0 && (
                            <ChainAction
                              icon={<ArrowLeft />}
                              label={t('modelSettings.subagents.tryEarlier')}
                              onClick={() => {
                                close()
                                move(index, index - 1)
                              }}
                            />
                          )}
                          {chain.length > 1 && index < chain.length - 1 && (
                            <ChainAction
                              icon={<ArrowRight />}
                              label={t('modelSettings.subagents.tryLater')}
                              onClick={() => {
                                close()
                                move(index, index + 1)
                              }}
                            />
                          )}
                          {(chain.length > 1 || scope !== 'default') && (
                            <ChainAction
                              icon={<X />}
                              danger
                              label={t('modelSettings.subagents.removeCandidate')}
                              onClick={() => {
                                close()
                                onChain(chain.filter((_, item) => item !== index))
                              }}
                            />
                          )}
                        </>
                      )
                    }
                  />
                )}
              </ModelPicker>
            </Fragment>
          )
        })}
        {chain.length > 0 && pendingIndex == null && (
          <button
            type="button"
            title={t('modelSettings.subagents.fallbackHint')}
            onClick={() => onAddFallback(chain.length)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border px-2 text-[11px] text-muted-foreground hover:border-indigo-400/50 hover:text-foreground"
          >
            <Plus className="size-3" />
            {t('modelSettings.subagents.fallbackShort')}
          </button>
        )}
      </div>
      {scope !== 'default' ? (
        <button
          type="button"
          title={t('subagentProfiles.remove')}
          aria-label={`${t('subagentProfiles.remove')} ${ruleKey}`}
          onClick={() => (chain.length ? onChain([]) : onPendingClosed())}
          className="grid size-8 place-items-center justify-self-end rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function ChainAction({
  icon,
  label,
  danger = false,
  onClick,
}: {
  icon: ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground [&_svg]:size-3',
        danger ? 'hover:bg-red-500/10 hover:text-red-300' : 'hover:bg-white/[0.05] hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
