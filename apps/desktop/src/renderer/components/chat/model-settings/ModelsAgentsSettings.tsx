import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { isChatProviderConnected, type ChatConfig } from '../../../../shared/chat'
import type { SubagentProfileRulesV1 } from '../../../../shared/subagent-profiles'
import { SubagentProfilesSettings } from '../subagent-profiles/SubagentProfilesSettings'
import { backgroundCompactionConfig, CompactionRow, ImageInterpreterRow, MemoryExtractionRow } from './BackgroundTasks'
import {
  MemoryCards,
  memoryExtractionModel,
  projectMemorySettings,
  usePersonalMemorySettings,
  type PersonalMemoryState,
} from './MemoryCards'
import { ModelPicker } from './ModelPicker'
import { HighlightedModelContext, modelSelectionKey, providerTone, type ModelSelection } from './model-selection'
import { ChatSelectionBody } from './SelectionBodies'

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 id={id} className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {hint && <p className="text-[11px] text-muted-foreground/70">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

interface ModelUse {
  selection: ModelSelection
  uses: string[]
}

/** Every place a model runs from these settings, grouped by model. */
function useModelsInUse(
  config: ChatConfig,
  personal: PersonalMemoryState,
  subagentRules: SubagentProfileRulesV1 | null
): ModelUse[] {
  const { t } = useTranslation('chat')
  const entries: Array<{ selection: ModelSelection; use: string }> = []
  if (config.defaultSelection)
    entries.push({ selection: config.defaultSelection, use: t('modelSettings.defaultModel.title') })
  if (config.imageInterpreter)
    entries.push({ selection: config.imageInterpreter, use: t('modelSettings.imageInterpreter.title') })
  const compaction = backgroundCompactionConfig(config)
  if (compaction.enabled && compaction.selection)
    entries.push({ selection: compaction.selection, use: t('modelSettings.compaction.title') })
  const project = projectMemorySettings(config)
  const memoryModel = memoryExtractionModel(project, personal.settings)
  const memoryUsed =
    project.extraction.enabled || (personal.settings?.enabled === true && personal.settings.extraction.enabled)
  if (memoryModel && memoryUsed)
    entries.push({ selection: memoryModel, use: t('modelSettings.memoryExtraction.title') })
  const subagentName = (key: string) => t('modelSettings.subagents.useLabel', { rule: key })
  for (const candidate of subagentRules?.default ?? [])
    entries.push({ selection: candidate, use: subagentName(t('modelSettings.subagents.allSubagents')) })
  for (const [key, chain] of [
    ...Object.entries(subagentRules?.byCategory ?? {}),
    ...Object.entries(subagentRules?.byAgent ?? {}),
  ])
    for (const candidate of chain) entries.push({ selection: candidate, use: subagentName(key) })

  const byModel = new Map<string, ModelUse>()
  for (const entry of entries) {
    const key = modelSelectionKey(entry.selection)
    const current = byModel.get(key)
    if (current) current.uses.push(entry.use)
    else byModel.set(key, { selection: entry.selection, uses: [entry.use] })
  }
  return [...byModel.values()]
}

function ModelsInUse({
  models,
  config,
  highlighted,
  onHighlight,
}: {
  models: ModelUse[]
  config: ChatConfig
  highlighted: string | null
  onHighlight: (key: string | null) => void
}) {
  const { t } = useTranslation('chat')
  if (!models.length) return null
  return (
    <div
      role="group"
      aria-label={t('modelSettings.inUse')}
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2"
    >
      <span className="mr-1 text-[11px] text-muted-foreground">{t('modelSettings.inUse')}</span>
      {models.map(({ selection, uses }) => {
        const key = modelSelectionKey(selection)
        const provider = config.providers.find((item) => item.id === selection.providerId)
        const active = highlighted === key
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            title={`${provider?.name ?? selection.providerId}: ${uses.join(' · ')}`}
            onClick={() => onHighlight(active ? null : key)}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2 text-[11.5px] transition-colors',
              active
                ? 'border-indigo-400/60 bg-indigo-500/15 text-foreground'
                : 'border-border bg-white/[0.03] text-foreground/90 hover:border-border-strong'
            )}
          >
            <span className={cn('size-1.5 shrink-0 rounded-full', providerTone(provider))} />
            <span className="truncate">{selection.modelId}</span>
            <span className="rounded-full bg-white/[0.08] px-1.5 text-[10px] text-muted-foreground">
              {t('modelSettings.useCount', { count: uses.length })}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function DefaultModel({
  config,
  modelFilterRevision,
  onChanged,
  onOpenAccounts,
}: {
  config: ChatConfig
  modelFilterRevision: number
  onChanged: () => void
  onOpenAccounts?: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const connected = config.providers.some(isChatProviderConnected)
  const value: ModelSelection | null = config.defaultSelection
    ? {
        ...config.defaultSelection,
        effort: config.defaultReasoning || 'off',
        fastMode: config.defaultFastMode === true,
      }
    : null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-gradient-to-br from-white/[0.05] to-white/[0.015] px-4 py-3.5">
      <div className="min-w-0 flex-1 basis-56">
        <h4 className="text-[13px] font-medium text-foreground">{t('modelSettings.defaultModel.title')}</h4>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('modelSettings.defaultModel.description')}</p>
      </div>
      {connected ? (
        <ModelPicker
          value={value}
          providers={config.providers}
          label={t('modelSettings.defaultModel.title')}
          placeholder={t('modelSettings.chooseModel')}
          size="lg"
          className="w-full @xl:w-[300px]"
        >
          {() => (
            <ChatSelectionBody
              value={value}
              config={config}
              modelFilterRevision={modelFilterRevision}
              allowFast
              onCommit={async (selection) => {
                if (!selection) return null
                const result = await api.chatSetDefault({
                  providerId: selection.providerId,
                  modelId: selection.modelId,
                  reasoning: selection.effort || 'off',
                  fastMode: selection.fastMode === true,
                })
                onChanged()
                return result.ok ? null : t('modelSettings.saveFailed')
              }}
            />
          )}
        </ModelPicker>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          {t('modelSettings.defaultModel.noProviders')}
          {onOpenAccounts && (
            <button type="button" onClick={onOpenAccounts} className="text-indigo-300 hover:underline">
              {t('modelSettings.defaultModel.openAccounts')}
            </button>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * The Models & agents tab: the conversation's default, the background tasks with the model each one uses, what
 * memory does, and the subagents' execution rules. Every change is saved as it is made.
 */
export function ModelsAgentsSettings({
  config,
  modelFilterRevision,
  locked,
  onChanged,
  onOpenAccounts,
}: {
  config: ChatConfig
  modelFilterRevision: number
  /** A bot's own window shows the owner's background preparation and memory without edit controls. */
  locked: boolean
  onChanged: () => void
  onOpenAccounts?: () => void
}) {
  const { t } = useTranslation('chat')
  const personal = usePersonalMemorySettings()
  const [subagentRules, setSubagentRules] = useState<SubagentProfileRulesV1 | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [memoryPickerOpen, setMemoryPickerOpen] = useState(false)
  const memoryRowRef = useRef<HTMLDivElement>(null)
  const connected = config.providers.some(isChatProviderConnected)
  const models = useModelsInUse(config, personal, subagentRules)
  const onRulesChange = useCallback((rules: SubagentProfileRulesV1 | null) => setSubagentRules(rules), [])

  useEffect(() => {
    if (highlighted && !models.some((model) => modelSelectionKey(model.selection) === highlighted)) setHighlighted(null)
  }, [highlighted, models])

  const pickMemoryModel = () => {
    memoryRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (!locked) setMemoryPickerOpen(true)
  }

  return (
    <HighlightedModelContext.Provider value={highlighted}>
      <div data-models-agents-settings className="@container flex flex-col gap-5 pt-1">
        <ModelsInUse models={models} config={config} highlighted={highlighted} onHighlight={setHighlighted} />

        <Section id="models-settings-conversation" title={t('modelSettings.sections.conversation')}>
          <DefaultModel
            config={config}
            modelFilterRevision={modelFilterRevision}
            onChanged={onChanged}
            onOpenAccounts={onOpenAccounts}
          />
        </Section>

        <Section
          id="models-settings-background"
          title={t('modelSettings.sections.background')}
          hint={t('modelSettings.sections.backgroundHint')}
        >
          <div className="divide-y divide-border rounded-lg border border-border bg-white/[0.02]">
            {connected && (
              <ImageInterpreterRow config={config} modelFilterRevision={modelFilterRevision} onChanged={onChanged} />
            )}
            <CompactionRow
              config={config}
              catalogRevision={modelFilterRevision}
              locked={locked}
              onChanged={onChanged}
            />
            <MemoryExtractionRow
              ref={memoryRowRef}
              config={config}
              catalogRevision={modelFilterRevision}
              personal={personal}
              locked={locked}
              open={memoryPickerOpen}
              onOpenChange={setMemoryPickerOpen}
              onChanged={onChanged}
            />
          </div>
        </Section>

        <Section
          id="models-settings-memory"
          title={t('modelSettings.sections.memory')}
          hint={t('modelSettings.sections.memoryHint')}
        >
          <MemoryCards
            config={config}
            personal={personal}
            locked={locked}
            onChanged={onChanged}
            onPickModel={pickMemoryModel}
          />
        </Section>

        <Section
          id="models-settings-subagents"
          title={t('modelSettings.sections.subagents')}
          hint={t('modelSettings.sections.subagentsHint')}
        >
          <SubagentProfilesSettings config={config} onRulesChange={onRulesChange} />
        </Section>
      </div>
    </HighlightedModelContext.Provider>
  )
}
