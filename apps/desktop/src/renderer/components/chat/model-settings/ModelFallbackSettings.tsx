import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import type { ChatConfig, ChatModelFallbackCandidate, ChatModelFallbackConfigV1 } from '../../../../shared/chat'
import { SettingSwitch } from './controls'
import { ModelPicker } from './ModelPicker'
import type { ModelSelection } from './model-selection'
import { ProfileSelectionBody } from './SelectionBodies'

const EMPTY: ChatModelFallbackConfigV1 = { version: 1, enabled: false, fallbacks: [] }

const selectionOf = (candidate: ChatModelFallbackCandidate): ModelSelection => ({
  providerId: candidate.providerId,
  modelId: candidate.modelId,
  effort: candidate.reasoning ?? 'off',
  fastMode: candidate.fastMode === true,
})

const candidateOf = (selection: ModelSelection): ChatModelFallbackCandidate => ({
  providerId: selection.providerId,
  modelId: selection.modelId,
  ...(selection.effort && selection.effort !== 'off' ? { reasoning: selection.effort } : {}),
  ...(selection.fastMode ? { fastMode: true } : {}),
})

/**
 * The ordered list of models a failed turn, subagent or background task moves to when its model hits a limit,
 * loses its login or is unavailable. Every change is saved as it is made.
 */
export function ModelFallbackSettings({
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
  const [value, setValue] = useState<ChatModelFallbackConfigV1>(config.modelFallback ?? EMPTY)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setValue(config.modelFallback ?? EMPTY), [config.modelFallback])

  const save = async (next: ChatModelFallbackConfigV1): Promise<string | null> => {
    const previous = value
    setValue(next)
    setError(null)
    try {
      const result = await api.chatModelFallbackSet(next)
      if (!result.ok || !result.config) throw new Error(result.error || t('modelSettings.saveFailed'))
      setValue(result.config)
      onChanged()
      return null
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setValue(previous)
      setError(message)
      return message
    }
  }

  const fallbacks = value.fallbacks
  const setFallbacks = (list: ChatModelFallbackCandidate[]) => save({ ...value, fallbacks: list })
  const move = (from: number, to: number) => {
    const next = [...fallbacks]
    ;[next[from], next[to]] = [next[to]!, next[from]!]
    void setFallbacks(next)
  }
  const slots = fallbacks.length + (pending ? 1 : 0)

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-white/[0.02] px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <h4 className="text-[13px] font-medium text-foreground">{t('modelSettings.fallback.title')}</h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('modelSettings.fallback.description')}</p>
        </div>
        <SettingSwitch
          checked={value.enabled}
          disabled={locked || fallbacks.length === 0}
          label={t('modelSettings.fallback.toggle')}
          title={fallbacks.length === 0 ? t('modelSettings.fallback.addFirst') : undefined}
          onChange={(enabled) => void save({ ...value, enabled })}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {Array.from({ length: slots }, (_, index) => {
          const candidate = fallbacks[index]
          const selection = candidate ? selectionOf(candidate) : null
          const pendingHere = pending && index === fallbacks.length
          return (
            <Fragment key={candidate ? `${candidate.providerId}::${candidate.modelId}` : 'pending'}>
              {index > 0 && (
                <ArrowRight
                  aria-label={t('modelSettings.fallback.next')}
                  className="size-3 shrink-0 text-muted-foreground/70"
                />
              )}
              <ModelPicker
                value={selection}
                providers={config.providers}
                label={t('modelSettings.fallback.candidateLabel', { position: index + 1 })}
                placeholder={t('modelSettings.chooseModel')}
                readOnly={locked}
                className="w-fit max-w-[280px]"
                {...(pendingHere ? { open: true, onOpenChange: (open: boolean) => !open && setPending(false) } : {})}
              >
                {(close) => (
                  <ProfileSelectionBody
                    value={selection}
                    config={config}
                    catalogRevision={catalogRevision}
                    allowOff
                    onCommit={async (next) => {
                      if (!next) return null
                      const entry = candidateOf(next)
                      const list = candidate
                        ? fallbacks.map((item, position) => (position === index ? entry : item))
                        : [...fallbacks, entry]
                      if (pendingHere) setPending(false)
                      // The first model added turns the list on; turning it off afterwards is the person's call.
                      return save({ ...value, enabled: fallbacks.length === 0 ? true : value.enabled, fallbacks: list })
                    }}
                    actions={
                      candidate && (
                        <>
                          {index > 0 && (
                            <ChainAction
                              icon={<ArrowLeft />}
                              label={t('modelSettings.fallback.tryEarlier')}
                              onClick={() => {
                                close()
                                move(index, index - 1)
                              }}
                            />
                          )}
                          {index < fallbacks.length - 1 && (
                            <ChainAction
                              icon={<ArrowRight />}
                              label={t('modelSettings.fallback.tryLater')}
                              onClick={() => {
                                close()
                                move(index, index + 1)
                              }}
                            />
                          )}
                          <ChainAction
                            icon={<X />}
                            danger
                            label={t('modelSettings.fallback.remove')}
                            onClick={() => {
                              close()
                              const list = fallbacks.filter((_, position) => position !== index)
                              void save({ ...value, enabled: list.length > 0 && value.enabled, fallbacks: list })
                            }}
                          />
                        </>
                      )
                    }
                  />
                )}
              </ModelPicker>
            </Fragment>
          )
        })}
        {!locked && !pending && (
          <button
            type="button"
            onClick={() => setPending(true)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border px-2 text-[11px] text-muted-foreground hover:border-indigo-400/50 hover:text-foreground"
          >
            <Plus className="size-3" />
            {t('modelSettings.fallback.add')}
          </button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground/80">{t('modelSettings.fallback.hint')}</p>
      {error && (
        <p role="alert" className="text-[11px] text-red-300">
          {error}
        </p>
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
