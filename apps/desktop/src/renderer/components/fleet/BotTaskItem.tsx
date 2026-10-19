import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, ChevronDown, Loader2, X } from 'lucide-react'
import type { FleetBot, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { FleetImageCache } from '@/lib/fleet/image-cache'
import { taskReasons, taskSummary } from '@/lib/fleet/bot-task'
import { cn } from '@/lib/utils'
import { BotTranscriptImages } from './BotTranscriptImages'

type TaskToolItem = Extract<FleetTranscriptItem, { kind: 'tool' }> & {
  task: NonNullable<Extract<FleetTranscriptItem, { kind: 'tool' }>['task']>
}

const RESULT_PREVIEW = 160

/**
 * A task the bot started: what it is, how hard the bot said it is, the model that runs it, what it does now and what
 * came back. Opening it tells why it ran on that model and what the bot asked.
 */
export function BotTaskItem({
  item,
  bot,
  imageCache,
}: {
  item: TaskToolItem
  bot: FleetBot
  imageCache: FleetImageCache
}) {
  const { t } = useTranslation('fleet')
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const { task } = item
  const summary = taskSummary(task)
  const model = summary.model ?? t('transcript.task.conversationModel')
  const output = item.output?.trim() ?? ''
  const reasons = task.model ? taskReasons(task) : []
  const icon =
    item.state === 'running' ? (
      <Loader2 className="size-3.5 animate-spin text-sky-300 motion-reduce:animate-none" aria-hidden="true" />
    ) : item.state === 'done' ? (
      <Check className="size-3.5 text-emerald-400" aria-hidden="true" />
    ) : item.state === 'error' ? (
      <AlertTriangle className="size-3.5 text-amber-300" aria-hidden="true" />
    ) : (
      <X className="size-3.5 text-muted-foreground" aria-hidden="true" />
    )
  const label = (key: string, values: Record<string, string>) => {
    const tier = values.tier ? t(`botTasks.tier.${values.tier}`).toLowerCase() : undefined
    const wanted = values.wanted ? t(`botTasks.tier.${values.wanted}`).toLowerCase() : undefined
    const complexity = values.complexity ? t(`transcript.task.difficulty.${values.complexity}`) : undefined
    return t(`transcript.task.why.${key}`, {
      ...values,
      ...(tier ? { tier } : {}),
      ...(wanted ? { wanted } : {}),
      ...(complexity ? { complexity } : {}),
      name: bot.name,
    })
  }

  return (
    <div className="rounded-lg border border-border text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex w-full min-w-0 items-center gap-2.5">
          <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {item.target ?? t('transcript.task.untitled')}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-180'
            )}
            aria-hidden="true"
          />
        </span>
        <span className="pl-[26px] text-xs text-muted-foreground">
          {summary.complexity ? `${t(`transcript.task.complexity.${summary.complexity}`)} · ` : ''}
          <span className="text-foreground/80">{model}</span>
        </span>
        {item.state === 'running' && task.activity && (
          <span className="truncate pl-[26px] text-xs text-muted-foreground">{task.activity}…</span>
        )}
        {item.state !== 'running' && output && !open && (
          <span className="line-clamp-2 pl-[26px] text-xs text-foreground/75">
            {output.length > RESULT_PREVIEW ? `${output.slice(0, RESULT_PREVIEW)}…` : output}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-2.5 border-t border-border px-3 py-2.5 pl-[38px] text-[12.5px]">
          {reasons.length > 0 && (
            <p className="text-foreground/80">{reasons.map(({ key, values }) => label(key, values)).join(' ')}</p>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('transcript.task.prompt', { name: bot.name })}
            </summary>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{task.prompt}</p>
          </details>
          {item.state !== 'running' && output && (
            <div>
              <p className="text-xs text-muted-foreground">{t('transcript.task.result')}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground/85">{output}</p>
            </div>
          )}
        </div>
      )}
      <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
    </div>
  )
}
