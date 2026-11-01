import { useChatOwnerWindow } from '@/lib/chat-window-context'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Copy, Plus, Sparkles, Trash2, Zap } from 'lucide-react'
import { isChatSubscriptionProviderKind, type ChatConfig, type ChatProviderInfo } from '../../../shared/chat'
import type { MaestroConfigV1, MaestroOrchestratorProfileV1, MaestroResourceV1 } from '../../../shared/maestro'
import { isIncompleteMaestroCandidate } from '../../../shared/maestro-config-validation'
import type { MaestroProposalUnit } from '../../../shared/maestro-configurator'
import type { SubagentProfileCandidate } from '../../../shared/subagent-profiles'
import { cn } from '@/lib/utils'
import { chatProviderChoices } from './account-pool'
import { ProviderGlyph } from './accounts/ProviderGlyph'
import { apiProviderGlyph, subscriptionGlyph, type ProviderGlyphId } from './accounts/provider-glyphs'
import { effortShortLabel } from './model-settings/model-selection'
import { modelDisplayName } from './model-search'
import { createMaestroResource, ResourceDetail, useCandidateHealth } from './MaestroControl'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** A proposal laid over the Pool: `base` is the prepared draft it was made from. */
export interface MaestroPoolReview {
  summary: string
  base: MaestroConfigV1
  proposed: MaestroConfigV1
  units: MaestroProposalUnit[]
  selected: ReadonlySet<string>
}

interface ProviderDisplay {
  name: string
  glyph: ProviderGlyphId | null
  /** Shown in the chip only when the glyph alone does not say which account runs. */
  tag: string | null
}

function glyphOf(provider: ChatProviderInfo): ProviderGlyphId | null {
  return isChatSubscriptionProviderKind(provider.kind)
    ? subscriptionGlyph(provider.kind)
    : apiProviderGlyph(provider.baseURL)
}

function useProviderDisplay(config: ChatConfig, t: Translate) {
  return useMemo(() => {
    const choices = chatProviderChoices(config)
    const glyphCounts = new Map<string, number>()
    for (const provider of choices) {
      const glyph = glyphOf(provider) ?? provider.id
      glyphCounts.set(glyph, (glyphCounts.get(glyph) ?? 0) + 1)
    }
    const byId = new Map<string, ProviderDisplay>(
      choices.map((provider) => {
        const glyph = glyphOf(provider)
        const shared = (glyphCounts.get(glyph ?? provider.id) ?? 0) > 1
        const tag = provider.accountPool
          ? t('maestro.poolEditor.activeAccount')
          : shared
            ? (provider.accountLabel ?? provider.name)
            : null
        return [provider.id, { name: provider.name, glyph, tag }]
      })
    )
    return (providerId: string): ProviderDisplay =>
      byId.get(providerId) ?? { name: providerId, glyph: null, tag: providerId }
  }, [config, t])
}

const candidateKey = (candidate: SubagentProfileCandidate) =>
  `${candidate.providerId}\0${candidate.modelId}\0${candidate.effort}\0${candidate.fastMode === true}`

function CandidateChip({
  candidate,
  provider,
  mark,
}: {
  candidate: SubagentProfileCandidate
  provider: ProviderDisplay
  mark?: 'added' | 'removed'
}) {
  const { t } = useTranslation('chat')
  const effort = candidate.effort && candidate.effort !== 'off' ? effortShortLabel(candidate.effort, t) : null
  const model = modelDisplayName(candidate.modelId)
  return (
    <span
      title={[provider.name, model, effort, candidate.fastMode ? t('fastMode.label') : null]
        .filter(Boolean)
        .join(' · ')}
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs',
        mark === 'added'
          ? 'border-dashed border-amber-400/70 bg-amber-400/[0.12] text-foreground'
          : mark === 'removed'
            ? 'border-dashed border-red-400/35 text-muted-foreground'
            : 'border-border bg-white/[0.05] text-foreground'
      )}
    >
      {mark && (
        <>
          <span
            aria-hidden="true"
            className={cn('font-semibold', mark === 'added' ? 'text-amber-300' : 'text-red-300')}
          >
            {mark === 'added' ? '+' : '−'}
          </span>
          <span className="sr-only">
            {mark === 'added' ? t('maestro.poolEditor.candidateAdded') : t('maestro.poolEditor.candidateRemoved')}
          </span>
        </>
      )}
      {provider.glyph && <ProviderGlyph glyph={provider.glyph} className="size-3 shrink-0" />}
      {provider.tag && (
        <span className="max-w-[8rem] truncate text-[10px] uppercase tracking-wide text-muted-foreground">
          {provider.tag}
        </span>
      )}
      <span className={cn('truncate', mark === 'removed' && 'line-through')}>{model}</span>
      {effort && <span className="shrink-0 text-muted-foreground">{effort}</span>}
      {candidate.fastMode && (
        <Zap aria-label={t('fastMode.label')} className="size-3 shrink-0 fill-current text-amber-300" />
      )}
    </span>
  )
}

const Arrow = () => (
  <span aria-hidden="true" className="px-0.5 text-muted-foreground/60">
    ›
  </span>
)

function InheritChip({ orchestrator, added }: { orchestrator: MaestroOrchestratorProfileV1 | null; added?: boolean }) {
  const { t } = useTranslation('chat')
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full items-center truncate rounded-md border border-dashed px-2 text-xs italic text-muted-foreground',
        added ? 'border-amber-400/70 bg-amber-400/[0.12]' : 'border-border'
      )}
    >
      {orchestrator
        ? t('maestro.poolEditor.inherits', { model: modelDisplayName(orchestrator.modelId) })
        : t('maestro.poolEditor.inheritsUnset')}
    </span>
  )
}

function CandidateChips({
  candidates,
  orchestrator,
  provider,
}: {
  candidates: SubagentProfileCandidate[]
  orchestrator: MaestroOrchestratorProfileV1 | null
  provider: (providerId: string) => ProviderDisplay
}) {
  const { t } = useTranslation('chat')
  const complete = candidates.filter((candidate) => !isIncompleteMaestroCandidate(candidate))
  const unfinished = candidates.length - complete.length
  return (
    <>
      {complete.length === 0 ? (
        <InheritChip orchestrator={orchestrator} />
      ) : (
        complete.map((candidate, index) => (
          <span key={`${candidateKey(candidate)}-${index}`} className="inline-flex min-w-0 items-center">
            {index > 0 && <Arrow />}
            <CandidateChip candidate={candidate} provider={provider(candidate.providerId)} />
          </span>
        ))
      )}
      {unfinished > 0 && (
        <span className="inline-flex h-6 items-center rounded-md border border-dashed border-amber-400/40 px-2 text-xs text-amber-200/80">
          {t('maestro.poolEditor.unfinished', { count: unfinished })}
        </span>
      )}
    </>
  )
}

/** What a reviewed resource ends up running, with what enters marked and what leaves listed apart. */
function CandidateDiff({
  before,
  after,
  orchestrator,
  provider,
}: {
  before: SubagentProfileCandidate[]
  after: SubagentProfileCandidate[]
  orchestrator: MaestroOrchestratorProfileV1 | null
  provider: (providerId: string) => ProviderDisplay
}) {
  const { t } = useTranslation('chat')
  const beforeKeys = new Set(before.map(candidateKey))
  const afterKeys = new Set(after.map(candidateKey))
  const removed = before.filter((candidate) => !afterKeys.has(candidateKey(candidate)))
  return (
    <>
      {after.length === 0 ? (
        <InheritChip orchestrator={orchestrator} added={before.length > 0} />
      ) : (
        after.map((candidate, index) => (
          <span key={`${candidateKey(candidate)}-${index}`} className="inline-flex min-w-0 items-center">
            {index > 0 && <Arrow />}
            <CandidateChip
              candidate={candidate}
              provider={provider(candidate.providerId)}
              mark={beforeKeys.has(candidateKey(candidate)) ? undefined : 'added'}
            />
          </span>
        ))
      )}
      {removed.length > 0 && (
        <span className="flex basis-full flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground/80">{t('maestro.poolEditor.review.leaving')}</span>
          {removed.map((candidate, index) => (
            <CandidateChip
              key={`${candidateKey(candidate)}-${index}`}
              candidate={candidate}
              provider={provider(candidate.providerId)}
              mark="removed"
            />
          ))}
        </span>
      )}
    </>
  )
}

function HealthDot({
  candidates,
  catalogRevision,
}: {
  candidates: SubagentProfileCandidate[]
  catalogRevision: number
}) {
  const { t } = useTranslation('chat')
  const complete = useMemo(
    () => candidates.filter((candidate) => !isIncompleteMaestroCandidate(candidate)),
    [candidates]
  )
  const health = useCandidateHealth(complete, catalogRevision, t)
  return (
    <span
      role="img"
      aria-label={health.message}
      title={health.message}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        health.level === 'checking'
          ? 'animate-pulse bg-muted-foreground'
          : health.level === 'warning'
            ? 'bg-amber-400'
            : 'bg-emerald-400'
      )}
    />
  )
}

const ROW_GRID =
  'grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2 text-left @min-[600px]:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_auto]'
// Every cell is placed explicitly: auto-placed cells would go after the ones pinned to a row, swapping the columns.
const ROW_ID = 'col-start-1 row-start-1 min-w-0'
const ROW_CHIPS =
  'col-span-full col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-1 @min-[600px]:col-span-1 @min-[600px]:col-start-2 @min-[600px]:row-start-1'
const ROW_END = 'col-start-2 row-start-1 flex items-center justify-end gap-2 @min-[600px]:col-start-3'

function RowIdentity({ label, subtitle, badge }: { label: string; subtitle: string; badge?: ReactNode }) {
  return (
    <span className={ROW_ID}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        {badge}
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span>
    </span>
  )
}

const resourceSubtitle = (resource: MaestroResourceV1, t: Translate) =>
  `${t(`maestro.capabilities.${resource.capability}`)} · ${resource.specialties.join(', ') || t('maestro.specialtiesFallback')}`

/**
 * The Settings Pool: one line per agent with the models it runs, opened in place to edit. With a proposal under
 * review, each line shows what the proposal changes there and whether that part is taken.
 */
export function MaestroPoolEditor({
  value,
  onChange,
  config,
  catalogRevision,
  orchestrator,
  onImportAgents,
  review = null,
  onToggleUnit,
  onReviewBack,
  onReviewDismiss,
  onReviewApply,
  reviewAction,
  savedRevision = 0,
  className,
}: {
  value: MaestroConfigV1
  onChange: (value: MaestroConfigV1) => void
  config: ChatConfig
  catalogRevision: number
  /** What a resource without candidates inherits. */
  orchestrator: MaestroOrchestratorProfileV1 | null
  onImportAgents?: () => void
  review?: MaestroPoolReview | null
  onToggleUnit?: (key: string, included: boolean) => void
  onReviewBack?: () => void
  onReviewDismiss?: () => void
  onReviewApply?: () => void
  /** Extra control in the header while reviewing, such as reopening a hidden assistant. */
  reviewAction?: ReactNode
  savedRevision?: number
  className?: string
}) {
  const ownerWindow = useChatOwnerWindow()
  const { t } = useTranslation('chat')
  const provider = useProviderDisplay(config, t)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    if (savedRevision) setExpanded(null)
  }, [savedRevision])
  useEffect(() => {
    if (review) setExpanded(null)
  }, [review])

  const updateResource = (index: number, resource: MaestroResourceV1) => {
    const pool = [...value.pool]
    pool[index] = resource
    onChange({ ...value, pool })
  }
  const duplicateResource = (index: number) => {
    const resource = value.pool[index]
    if (!resource) return
    onChange({
      ...value,
      pool: [
        ...value.pool.slice(0, index + 1),
        {
          ...resource,
          id: `${resource.id}-${t('maestro.copySuffix')}`,
          label: `${resource.label} ${t('maestro.copySuffix')}`,
          specialties: [...resource.specialties],
          candidates: resource.candidates.map((candidate) => ({ ...candidate })),
        },
        ...value.pool.slice(index + 1),
      ],
    })
    setExpanded(index + 1)
  }
  const removeResource = (index: number) => {
    const resource = value.pool[index]
    if (value.pool.length <= 1 || !resource) return
    if (!ownerWindow.confirm(t('maestro.confirmRemoveResource', { label: resource.label }))) return
    onChange({ ...value, pool: value.pool.filter((_, resourceIndex) => resourceIndex !== index) })
    setExpanded(null)
  }

  const enabledCount = value.pool.filter((resource) => resource.enabled).length
  const unitByKey = new Map(review?.units.map((unit) => [unit.key, unit]))
  const selectedCount = review ? review.units.filter((unit) => review.selected.has(unit.key)).length : 0

  const includeToggle = (unit: MaestroProposalUnit, label: string) => (
    <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground/80 hover:bg-white/[0.05]">
      <input
        type="checkbox"
        checked={review?.selected.has(unit.key) ?? false}
        onChange={(event) => onToggleUnit?.(unit.key, event.target.checked)}
        aria-label={t('maestro.poolEditor.review.includeLabel', { label })}
        className="accent-amber-400"
      />
      <span aria-hidden="true">{t('maestro.poolEditor.review.include')}</span>
    </label>
  )

  const reviewRows = () => {
    if (!review) return null
    const proposedById = new Map(review.proposed.pool.map((resource) => [resource.id, resource]))
    const baseIds = new Set(review.base.pool.map((resource) => resource.id))
    const rows = review.base.pool.map((base, index) => {
      const own = value.pool[index] ?? base
      const unit = unitByKey.get(`resource:${base.id}`)
      if (!unit) {
        return (
          <div key={`${base.id}-${index}`} className={cn('rounded-lg px-2.5 opacity-50', !own.enabled && 'opacity-30')}>
            <div className={ROW_GRID}>
              <RowIdentity label={own.label} subtitle={resourceSubtitle(own, t)} />
              <span className={ROW_CHIPS}>
                <CandidateChips candidates={own.candidates} orchestrator={orchestrator} provider={provider} />
              </span>
              <span className={ROW_END} />
            </div>
          </div>
        )
      }
      const included = review.selected.has(unit.key)
      const next = proposedById.get(base.id)
      const fields = unit.changes.flatMap((change) =>
        change.kind === 'resource-field' ? [t(`maestro.fieldNames.${change.field}`)] : []
      )
      return (
        <div
          key={`${base.id}-${index}`}
          className={cn(
            'rounded-lg px-2.5 transition-colors',
            included
              ? 'bg-amber-400/[0.07] shadow-[inset_2px_0_0_rgb(251_191_36)]'
              : 'shadow-[inset_2px_0_0_rgb(251_191_36_/_0.25)]'
          )}
        >
          <div className={ROW_GRID}>
            <RowIdentity
              label={unit.label}
              subtitle={next ? resourceSubtitle(next, t) : resourceSubtitle(base, t)}
              badge={
                !next && (
                  <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-300">
                    {t('maestro.poolEditor.review.removed')}
                  </span>
                )
              }
            />
            <span className={cn(ROW_CHIPS, !included && 'opacity-50')}>
              {next ? (
                <CandidateDiff
                  before={base.candidates}
                  after={next.candidates}
                  orchestrator={orchestrator}
                  provider={provider}
                />
              ) : (
                <CandidateChips candidates={base.candidates} orchestrator={orchestrator} provider={provider} />
              )}
              {fields.length > 0 && (
                <span className="basis-full text-xs text-muted-foreground">
                  {t('maestro.poolEditor.review.alsoChanges', { fields: fields.join(', ') })}
                </span>
              )}
            </span>
            <span className={ROW_END}>{includeToggle(unit, unit.label)}</span>
          </div>
        </div>
      )
    })
    const added = review.proposed.pool
      .filter((resource) => !baseIds.has(resource.id))
      .map((resource) => {
        const unit = unitByKey.get(`resource:${resource.id}`)
        if (!unit) return null
        const included = review.selected.has(unit.key)
        return (
          <div
            key={`added-${resource.id}`}
            className={cn(
              'rounded-lg px-2.5',
              included
                ? 'bg-amber-400/[0.07] shadow-[inset_2px_0_0_rgb(251_191_36)]'
                : 'shadow-[inset_2px_0_0_rgb(251_191_36_/_0.25)]'
            )}
          >
            <div className={ROW_GRID}>
              <RowIdentity
                label={resource.label}
                subtitle={resourceSubtitle(resource, t)}
                badge={
                  <span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-200">
                    {t('maestro.poolEditor.review.added')}
                  </span>
                }
              />
              <span className={cn(ROW_CHIPS, !included && 'opacity-50')}>
                <CandidateDiff
                  before={[]}
                  after={resource.candidates}
                  orchestrator={orchestrator}
                  provider={provider}
                />
              </span>
              <span className={ROW_END}>{includeToggle(unit, resource.label)}</span>
            </div>
          </div>
        )
      })
    return [...rows, ...added]
  }

  return (
    <section
      aria-label={t('maestro.pool')}
      className={cn('@container flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      <div className="flex min-h-11 items-center gap-2.5 border-b border-border py-1.5 pl-3.5 pr-2">
        {review ? (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-foreground">
              <Sparkles className="size-3.5 text-amber-300" /> {t('maestro.poolEditor.review.title')}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {t('maestro.poolEditor.review.hint', { summary: review.summary })}
            </span>
            {reviewAction && <span className="ml-auto shrink-0">{reviewAction}</span>}
          </>
        ) : (
          <>
            <span className="shrink-0 text-sm font-medium text-foreground">{t('maestro.poolEditor.title')}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {t('maestro.poolEditor.summary', { count: value.pool.length, enabled: enabledCount })}
            </span>
            <span className="ml-auto flex shrink-0 gap-1">
              {onImportAgents && (
                <button
                  type="button"
                  onClick={onImportAgents}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                >
                  {t('maestro.importAgents')}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onChange({ ...value, pool: [...value.pool, createMaestroResource(value.pool.length, t)] })
                  setExpanded(value.pool.length)
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-white/[0.05]"
              >
                <Plus className="size-3" /> {t('maestro.newResource')}
              </button>
            </span>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {review
          ? reviewRows()
          : value.pool.map((resource, index) => {
              const open = expanded === index
              return (
                <div
                  key={`${resource.id}-${index}`}
                  className={cn(
                    'rounded-lg transition-colors',
                    open ? 'bg-white/[0.035] ring-1 ring-inset ring-border' : 'hover:bg-white/[0.03]'
                  )}
                >
                  <div className="flex items-center gap-2 pl-2.5 pr-1.5">
                    <input
                      type="checkbox"
                      checked={resource.enabled}
                      aria-label={t('maestro.enableResource', { label: resource.label })}
                      onChange={(event) => updateResource(index, { ...resource, enabled: event.target.checked })}
                    />
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : index)}
                      className={cn(
                        ROW_GRID,
                        'rounded-md px-1',
                        !resource.enabled && '[&>*:not(:last-child)]:opacity-45'
                      )}
                    >
                      <RowIdentity label={resource.label} subtitle={resourceSubtitle(resource, t)} />
                      <span className={ROW_CHIPS}>
                        <CandidateChips
                          candidates={resource.candidates}
                          orchestrator={orchestrator}
                          provider={provider}
                        />
                      </span>
                      <span className={ROW_END}>
                        <HealthDot candidates={resource.candidates} catalogRevision={catalogRevision} />
                        <ChevronRight
                          aria-hidden="true"
                          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')}
                        />
                      </span>
                    </button>
                  </div>
                  {open && (
                    <div className="border-t border-border/70 px-3.5 pb-3 pt-3">
                      <ResourceDetail
                        key={`${index}-${resource.id}`}
                        resource={resource}
                        config={config}
                        catalogRevision={catalogRevision}
                        layout="split"
                        onChange={(next) => updateResource(index, next)}
                      />
                      <div className="mt-3 flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => duplicateResource(index)}
                          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                        >
                          <Copy className="size-3.5" /> {t('maestro.duplicateResource')}
                        </button>
                        <button
                          type="button"
                          disabled={value.pool.length <= 1}
                          onClick={() => removeResource(index)}
                          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                        >
                          <Trash2 className="size-3.5" /> {t('maestro.removeResource')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
      </div>

      {review && (
        <div
          data-maestro-review-bar
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-amber-400/40 bg-gradient-to-t from-amber-400/[0.11] to-amber-400/[0.05] py-2.5 pl-3.5 pr-3"
        >
          <div className="min-w-[10rem] flex-1">
            <p className="text-sm font-medium text-foreground">{t('maestro.poolEditor.review.barTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {t('maestro.poolEditor.review.barSelected', { selected: selectedCount, count: review.units.length })}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={onReviewBack}
              className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              {t('maestro.poolEditor.review.back')}
            </button>
            <button
              type="button"
              onClick={onReviewDismiss}
              className="rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground hover:bg-white/[0.05]"
            >
              {t('maestro.poolEditor.review.dismiss')}
            </button>
            <button
              type="button"
              disabled={selectedCount === 0}
              onClick={onReviewApply}
              className="rounded-md bg-amber-400 px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-40"
            >
              {t('maestro.poolEditor.review.apply', { count: selectedCount })}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
