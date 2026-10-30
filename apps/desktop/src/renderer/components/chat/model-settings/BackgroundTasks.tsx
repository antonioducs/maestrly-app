import { forwardRef, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, ChevronDown, Image as ImageIcon, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import type { BackgroundCompactionConfig } from '../../../../shared/background-compaction'
import type { ChatConfig } from '../../../../shared/chat'
import type { MemorySettings } from '../../../../shared/memory'
import { chatProviderChoices } from '../account-pool'
import { SegmentedChoice, SettingSwitch } from './controls'
import { memoryExtractionModel, projectMemorySettings, type PersonalMemoryState } from './MemoryCards'
import { ModelPicker } from './ModelPicker'
import { sameModelSelection, type ModelSelection } from './model-selection'
import { ChatSelectionBody, ProfileSelectionBody, type CommitSelection } from './SelectionBodies'

const DEFAULT_INTERVAL_TOKENS = 100_000
const INTERVAL_PRESETS = [50_000, 100_000, 200_000]

export const backgroundCompactionConfig = (config: ChatConfig): BackgroundCompactionConfig =>
  config.backgroundCompaction ?? { enabled: false, intervalTokens: DEFAULT_INTERVAL_TOKENS, selection: null }

interface TaskRowProps {
  icon: ReactNode
  title: string
  description: ReactNode
  picker: ReactNode
  /** The switch, or what stands in its place. */
  control?: ReactNode
  details?: ReactNode
  detailsLabel?: string
  className?: string
  'data-background-compaction-settings'?: boolean
}

/** A background task: what it does, its model, whether it runs, and its details on demand. */
const TaskRow = forwardRef<HTMLDivElement, TaskRowProps>(function TaskRow(
  { icon, title, description, picker, control, details, detailsLabel, className, ...rest },
  ref
) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div ref={ref} role="group" aria-label={title} className={cn('px-3.5 py-3', className)} {...rest}>
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 @xl:grid-cols-[28px_minmax(0,1fr)_minmax(0,250px)_auto]">
        <div className="grid size-7 place-items-center rounded-md bg-white/[0.06] text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </div>
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-foreground">{title}</h4>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div>
        </div>
        <div className="col-span-2 flex min-w-0 items-center gap-2.5 @xl:col-span-2">
          <div className="min-w-0 flex-1 @xl:w-[250px] @xl:flex-none">{picker}</div>
          <div className="flex w-7 shrink-0 justify-center">{control}</div>
          {details ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={detailsLabel}
              title={detailsLabel}
              onClick={() => setExpanded((value) => !value)}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            >
              <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
            </button>
          ) : (
            <span className="size-7 shrink-0" />
          )}
        </div>
      </div>
      {details && expanded && (
        <div className="mt-2.5 flex flex-col gap-2.5 text-[11px] text-muted-foreground @xl:pl-10">{details}</div>
      )}
    </div>
  )
})

export function ImageInterpreterRow({
  config,
  modelFilterRevision,
  onChanged,
}: {
  config: ChatConfig
  modelFilterRevision: number
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const value: ModelSelection | null = config.imageInterpreter
    ? { ...config.imageInterpreter, effort: config.imageInterpreter.effort ?? 'off' }
    : null
  // Turning it off forgets the model on the host; the last one comes back when it is turned on again.
  const lastValue = useRef(value)
  if (value) lastValue.current = value
  const [open, setOpen] = useState(false)

  const save = async (selection: ModelSelection | null) => {
    const result = await api.chatSetImageInterpreter(
      selection
        ? {
            providerId: selection.providerId,
            modelId: selection.modelId,
            ...(selection.effort && selection.effort !== 'off' ? { effort: selection.effort } : {}),
          }
        : null
    )
    onChanged()
    return result.ok ? null : t('modelSettings.saveFailed')
  }

  return (
    <TaskRow
      icon={<ImageIcon />}
      title={t('modelSettings.imageInterpreter.title')}
      description={t('modelSettings.imageInterpreter.description')}
      picker={
        <ModelPicker
          value={value}
          providers={chatProviderChoices(config)}
          label={t('modelSettings.imageInterpreter.title')}
          placeholder={t('modelSettings.off')}
          dimmed={!value}
          open={open}
          onOpenChange={setOpen}
        >
          {() => (
            <ChatSelectionBody
              value={value}
              config={config}
              modelFilterRevision={modelFilterRevision}
              requireVision
              onCommit={save}
            />
          )}
        </ModelPicker>
      }
      control={
        <SettingSwitch
          checked={value != null}
          label={t('modelSettings.imageInterpreter.toggle')}
          onChange={(checked) => {
            if (!checked) void save(null)
            else if (lastValue.current) void save(lastValue.current)
            else setOpen(true)
          }}
        />
      }
      details={<p>{t('settings.imageInterpreterDescription')}</p>}
      detailsLabel={t('modelSettings.details', { task: t('modelSettings.imageInterpreter.title') })}
    />
  )
}

export function CompactionRow({
  config,
  catalogRevision,
  locked,
  onChanged,
}: {
  config: ChatConfig
  catalogRevision: number
  locked: boolean
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const persisted = backgroundCompactionConfig(config)
  const [open, setOpen] = useState(false)
  const [enableOnPick, setEnableOnPick] = useState(false)
  const [customInterval, setCustomInterval] = useState(!INTERVAL_PRESETS.includes(persisted.intervalTokens))
  const [intervalDraft, setIntervalDraft] = useState(String(persisted.intervalTokens))
  const [error, setError] = useState<string | null>(null)
  const value: ModelSelection | null = persisted.selection

  const save = async (next: BackgroundCompactionConfig): Promise<string | null> => {
    setError(null)
    try {
      const result = await api.chatSetBackgroundCompaction(next)
      if (!result.ok) return result.error || t('settings.backgroundCompactionSaveFailed')
      onChanged()
      return null
    } catch {
      return t('settings.backgroundCompactionSaveFailed')
    }
  }
  const report = (pending: Promise<string | null>) => void pending.then(setError)
  // Turning it on without a model opens the picker, and every choice made there keeps it on.
  const commitModel: CommitSelection = (selection) =>
    save({
      ...persisted,
      enabled: (persisted.enabled || enableOnPick) && selection != null,
      selection: selection && {
        providerId: selection.providerId,
        modelId: selection.modelId,
        effort: selection.effort || 'off',
        fastMode: selection.fastMode === true,
      },
    })
  const parsedInterval = Number(intervalDraft)
  const intervalValid = Number.isInteger(parsedInterval) && parsedInterval > 0

  const intervalLabel = (tokens: number) => t('modelSettings.compaction.tokens', { count: Math.round(tokens / 1000) })
  return (
    <TaskRow
      data-background-compaction-settings
      icon={<Layers />}
      title={t('modelSettings.compaction.title')}
      description={
        locked ? (
          <>
            {t('modelSettings.compaction.description')} {t('settings.backgroundCompactionManagedByMac')}
          </>
        ) : (
          t('modelSettings.compaction.description')
        )
      }
      picker={
        <>
          <ModelPicker
            value={value}
            providers={chatProviderChoices(config)}
            label={t('settings.backgroundCompactionModel')}
            placeholder={t('modelSettings.chooseModel')}
            dimmed={!persisted.enabled}
            readOnly={locked}
            open={open}
            onOpenChange={(next) => {
              setOpen(next)
              if (!next) setEnableOnPick(false)
            }}
          >
            {() => (
              <ProfileSelectionBody
                value={value}
                config={config}
                catalogRevision={catalogRevision}
                allowOff
                onCommit={commitModel}
              />
            )}
          </ModelPicker>
          {error && (
            <p role="alert" className="mt-1 text-[11px] text-red-300">
              {error}
            </p>
          )}
        </>
      }
      control={
        <SettingSwitch
          checked={persisted.enabled}
          label={t('settings.backgroundCompactionToggle')}
          title={value ? undefined : t('settings.backgroundCompactionModelRequired')}
          disabled={locked}
          onChange={(enabled) => {
            if (enabled && !value) {
              setEnableOnPick(true)
              setOpen(true)
              return
            }
            report(save({ ...persisted, enabled }))
          }}
        />
      }
      detailsLabel={t('modelSettings.details', { task: t('modelSettings.compaction.title') })}
      details={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-foreground/90">{t('settings.backgroundCompactionInterval')}</span>
          <SegmentedChoice
            ariaLabel={t('settings.backgroundCompactionInterval')}
            disabled={locked}
            value={customInterval ? 'custom' : String(persisted.intervalTokens)}
            options={[
              ...INTERVAL_PRESETS.map((tokens) => ({ id: String(tokens), label: intervalLabel(tokens) })),
              { id: 'custom', label: t('modelSettings.compaction.custom') },
            ]}
            onChange={(id) => {
              if (id === 'custom') {
                setCustomInterval(true)
                return
              }
              setCustomInterval(false)
              setIntervalDraft(id)
              report(save({ ...persisted, intervalTokens: Number(id) }))
            }}
          />
          {customInterval && (
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                step={10_000}
                inputMode="numeric"
                value={intervalDraft}
                disabled={locked}
                aria-label={t('settings.backgroundCompactionInterval')}
                aria-invalid={!intervalValid}
                onChange={(event) => setIntervalDraft(event.target.value)}
                onBlur={() => {
                  if (intervalValid && parsedInterval !== persisted.intervalTokens)
                    report(save({ ...persisted, intervalTokens: parsedInterval }))
                }}
                onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                className="h-7 w-28 rounded-md border border-input bg-transparent px-2 text-[12px] text-foreground outline-none focus:border-indigo-500/60"
              />
              <span>{t('settings.backgroundCompactionTokens')}</span>
            </span>
          )}
          {customInterval && !intervalValid && (
            <p className="basis-full text-red-300">{t('settings.backgroundCompactionIntervalInvalid')}</p>
          )}
        </div>
      }
    />
  )
}

export const MemoryExtractionRow = forwardRef<
  HTMLDivElement,
  {
    config: ChatConfig
    catalogRevision: number
    personal: PersonalMemoryState
    locked: boolean
    open: boolean
    onOpenChange: (open: boolean) => void
    onChanged: () => void
  }
>(function MemoryExtractionRow({ config, catalogRevision, personal, locked, open, onOpenChange, onChanged }, ref) {
  const { t, i18n } = useTranslation('chat')
  const api = useHostApi()
  const project = projectMemorySettings(config)
  const personalSettings = personal.settings
  const value = memoryExtractionModel(project, personalSettings)
  const personalModel = personalSettings?.extraction.selection ?? null
  const differs =
    project.extraction.selection != null && personalModel != null && !sameModelSelection(value, personalModel)
  const users = [
    ...(project.extraction.enabled ? [t('modelSettings.memoryExtraction.scopeProject')] : []),
    ...(personalSettings?.enabled && personalSettings.extraction.enabled
      ? [t('modelSettings.memoryExtraction.scopePersonal')]
      : []),
  ]

  // One model serves both memories: saving it writes the same selection to each.
  const save: CommitSelection = async (selection) => {
    if (!selection) return null
    const extractionSelection = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      effort: selection.effort || 'off',
      fastMode: selection.fastMode === true,
    }
    const nextProject: MemorySettings = {
      ...project,
      extraction: { ...project.extraction, selection: extractionSelection },
    }
    try {
      const result = await api.chatSetMemorySettings(nextProject)
      if (!result.ok) return result.error || t('memorySettings.saveFailed')
      onChanged()
      if (personalSettings)
        await personal.save({
          ...personalSettings,
          extraction: { ...personalSettings.extraction, selection: extractionSelection },
        })
      return null
    } catch {
      return t('memorySettings.saveFailed')
    }
  }

  return (
    <TaskRow
      ref={ref}
      icon={<Brain />}
      title={t('modelSettings.memoryExtraction.title')}
      description={
        <>
          {t('modelSettings.memoryExtraction.description')}{' '}
          <span className={users.length ? 'text-foreground/80' : 'text-amber-300/90'}>
            {users.length
              ? t('modelSettings.memoryExtraction.usedBy', {
                  scopes: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(users),
                })
              : t('modelSettings.memoryExtraction.unused')}
          </span>
          {differs && personalModel && (
            <span className="mt-1 flex flex-wrap items-center gap-2 text-amber-300/90">
              {t('modelSettings.memoryExtraction.mismatch', { model: personalModel.modelId })}
              {!locked && (
                <button
                  type="button"
                  className="rounded border border-amber-300/40 px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/10"
                  onClick={() => void save(value)}
                >
                  {t('modelSettings.memoryExtraction.unify')}
                </button>
              )}
            </span>
          )}
        </>
      }
      picker={
        <ModelPicker
          value={value}
          providers={chatProviderChoices(config)}
          label={t('memorySettings.model')}
          placeholder={t('modelSettings.chooseModel')}
          dimmed={users.length === 0}
          readOnly={locked}
          open={open}
          onOpenChange={onOpenChange}
        >
          {() => (
            <ProfileSelectionBody
              value={value}
              config={config}
              catalogRevision={catalogRevision}
              allowOff
              onCommit={save}
            />
          )}
        </ModelPicker>
      }
      detailsLabel={t('modelSettings.details', { task: t('modelSettings.memoryExtraction.title') })}
      details={
        <>
          <p>{t('memorySettings.extractionHint')}</p>
          <p>{t('personalMemorySettings.extractionHint')}</p>
        </>
      }
    />
  )
})
