import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  AppWindow,
  Bot,
  Camera,
  ChevronRight,
  FileText,
  Globe,
  ImagePlus,
  Lightbulb,
  Link2,
  ListChecks,
  MessageCircleQuestion,
  MessageSquareText,
  Pencil,
  Plug,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { MarkdownViewer, type OpenFileReference } from '@/components/MarkdownViewer'
import { cn } from '@/lib/utils'
import {
  activityLive,
  activityMatches,
  activityRows,
  activitySummary,
  baseToolName,
  groupStatus,
  reasoningTitle,
  toolDisplayName,
  type ActivityCategory,
  type ActivityRow,
  type ActivityStatus,
  type ActivityStep,
  type ActivityToolStep,
} from '@/lib/agent-activity'
import { formatResponseDuration } from '../../../shared/response-duration'

const CATEGORY_ICON: Record<ActivityCategory, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: Pencil,
  search: Search,
  web_search: Globe,
  web_fetch: Link2,
  browser: AppWindow,
  screenshot: Camera,
  subagent: Bot,
  mcp: Plug,
  image: ImagePlus,
  other: Wrench,
}

/** Categories whose target reads as code: a command, a file, a pattern. */
const MONO_TARGET = new Set<ActivityCategory>(['command', 'read', 'edit', 'search'])

/** Marks where a label's highlighted value goes, so translations keep their own word order. */
const SLOT = '\u2063'

interface Label {
  text: string
  slot: string | null
  mono: boolean
}

function toolLabel(t: TFunction, step: ActivityToolStep<unknown>, tense: 'live' | 'done'): Label {
  const name = baseToolName(step.toolName)
  let category = step.category
  // Opening a page in the browser reads like opening a page.
  if (category === 'browser' && step.target && (name === 'browser_navigate' || name === 'browser_new_tab'))
    category = 'web_fetch'
  if (category === 'mcp' || category === 'other')
    return {
      text: t(`activity.${tense}.${category}`, { tool: SLOT }),
      slot: toolDisplayName(step.toolName),
      mono: true,
    }
  if (category === 'image') return { text: t(`activity.${tense}.image`), slot: null, mono: false }
  // Only bots list a subagent as a step, without its name: a chat shows its card outside the line.
  if (category === 'subagent') return { text: t(`activity.${tense}.subagentBare`), slot: null, mono: false }
  return step.target
    ? { text: t(`activity.${tense}.${category}`, { target: SLOT }), slot: step.target, mono: MONO_TARGET.has(category) }
    : { text: t(`activity.${tense}.${category}Bare`), slot: null, mono: false }
}

const plainLabel = (label: Label): string => label.text.replace(SLOT, label.slot ?? '')

function LabelText({ label }: { label: Label }) {
  if (label.slot === null) return <>{label.text}</>
  const [before, after = ''] = label.text.split(SLOT)
  return (
    <>
      {before}
      {label.mono ? (
        <code className="rounded bg-white/[0.06] px-1 py-px font-mono text-[0.92em] text-foreground/90">
          {label.slot}
        </code>
      ) : (
        label.slot
      )}
      {after}
    </>
  )
}

/** Leads with a no-break space: a flex item drops the ordinary space at its start. */
const SEPARATOR = '\u00a0· '

const SHIMMER_MS = 2400

/** Live text, its sweep kept in phase with the clock so a new step does not restart it. */
function Shimmer({ children }: { children: ReactNode }) {
  return (
    <span
      className="agent-activity-shimmer"
      style={{ animationDelay: `-${Math.round(performance.now() % SHIMMER_MS)}ms` }}
    >
      {children}
    </span>
  )
}

function Glyph({ icon: Icon, spinning, className }: { icon: LucideIcon; spinning?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative grid size-[18px] shrink-0 place-items-center rounded-full',
        spinning && 'agent-activity-ring',
        className
      )}
    >
      <Icon className={spinning ? 'size-[11px]' : 'size-3.5'} />
    </span>
  )
}

function StatusFlag({ status }: { status: ActivityStatus }) {
  const { t } = useTranslation('chat')
  if (status === 'failed' || status === 'denied')
    return <span className="ml-1.5 text-[11.5px] text-red-300/85">{t(`activity.flag.${status}`)}</span>
  if (status === 'interrupted')
    return <span className="ml-1.5 text-[11.5px] text-muted-foreground">{t('activity.flag.interrupted')}</span>
  if (status === 'waiting')
    return <span className="ml-1.5 text-[11.5px] text-amber-300/90">{t('activity.flag.waiting')}</span>
  return null
}

export interface AgentActivityProps<S> {
  steps: ActivityStep<S>[]
  /** The turn is running: the line follows its current step. */
  live: boolean
  /** Live and the answer is streaming. */
  writing?: boolean
  /** Live and a question waits for the person's answer. */
  waitingAnswer?: boolean
  /** Live and the agent waits for the person (a bot's permission, question or help request). */
  waitingYou?: boolean
  /** Live: subagents running in their own cards outside the line. */
  runningSubagents?: number
  /** The turn did work that is not among the steps (its subagents): the summary says it worked, not only thought. */
  worked?: boolean
  /** How long the turn took, when known: the summary leads with it. */
  durationMs?: number | null
  /** Images the steps produced, shown under the line whether it is open or not. */
  thumbnails?: ReactNode
  renderToolDetail: (step: ActivityToolStep<S>) => ReactNode
  /** A note under a reasoning step's text, e.g. that it was cut. */
  reasoningNote?: (step: Extract<ActivityStep<S>, { kind: 'reasoning' }>) => ReactNode
  onOpenMention?: OpenFileReference
  searchQuery?: string
  currentSearchMatch?: boolean
}

/**
 * One line for what an agent did on its way to an answer. While the turn runs it shows the current step; once it ends,
 * a summary. Opening it shows every step as a timeline, each with its details.
 */
export function AgentActivity<S>({
  steps,
  live,
  writing = false,
  waitingAnswer = false,
  waitingYou = false,
  runningSubagents = 0,
  worked = false,
  durationMs,
  thumbnails,
  renderToolDetail,
  reasoningNote,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: AgentActivityProps<S>) {
  const { t } = useTranslation('chat')
  const panelId = useId()
  const [open, setOpen] = useState(false)
  // A search hit inside the activity opens it, so the highlight is visible.
  const searchHit = !!searchQuery && steps.some((step) => activityMatches(step, searchQuery))
  const shown = open || searchHit

  let glyph: ReactNode
  let label: ReactNode
  let labelKey: string
  let tone: 'live' | 'waiting' | 'done'
  if (live) {
    const now = waitingYou
      ? ({ kind: 'waiting-you' } as const)
      : activityLive(steps, { writing, waitingAnswer, runningSubagents })
    tone =
      now.kind === 'waiting-permission' || now.kind === 'waiting-answer' || now.kind === 'waiting-you'
        ? 'waiting'
        : 'live'
    if (now.kind === 'waiting-permission') {
      glyph = <Glyph icon={ShieldQuestion} />
      labelKey = t('activity.waitingPermission')
      label = labelKey
    } else if (now.kind === 'waiting-answer' || now.kind === 'waiting-you') {
      glyph = <Glyph icon={MessageCircleQuestion} />
      labelKey = t(now.kind === 'waiting-answer' ? 'activity.waitingAnswer' : 'activity.waitingYou')
      label = labelKey
    } else if (now.kind === 'writing') {
      glyph = <Glyph icon={MessageSquareText} spinning />
      labelKey = t('activity.writing')
      label = <Shimmer>{labelKey}</Shimmer>
    } else if (now.kind === 'thinking') {
      glyph = <Glyph icon={Lightbulb} spinning />
      labelKey = now.title ? t('activity.thinkingAbout', { title: now.title }) : t('activity.thinking')
      label = <Shimmer>{labelKey}</Shimmer>
    } else if (now.kind === 'subagents') {
      glyph = <Glyph icon={Bot} spinning />
      labelKey = t('activity.runningSubagents', { count: now.count })
      label = <Shimmer>{labelKey}</Shimmer>
    } else {
      const text = toolLabel(t, now.step, 'live')
      glyph = <Glyph icon={CATEGORY_ICON[now.step.category]} spinning />
      labelKey = `${now.step.id}:${plainLabel(text)}`
      label = (
        <Shimmer>
          <LabelText label={text} />
        </Shimmer>
      )
    }
  } else {
    tone = 'done'
    const summary = activitySummary(steps)
    const lead =
      durationMs != null
        ? t(summary.tools || worked ? 'activity.workedFor' : 'activity.thoughtFor', {
            duration: formatResponseDuration(durationMs),
          })
        : summary.tools
          ? null
          : t('activity.thought')
    const counts = summary.counts.slice(0, 3).map(({ category, count }) => t(`activity.count.${category}`, { count }))
    const rest = summary.counts.slice(3)
    if (rest.length === 1) counts.push(`+${t(`activity.count.${rest[0].category}`, { count: rest[0].count })}`)
    else if (rest.length > 1)
      counts.push(t('activity.count.more', { count: rest.reduce((total, entry) => total + entry.count, 0) }))
    const flags = [
      summary.failed ? t('activity.count.failed', { count: summary.failed }) : null,
      summary.denied ? t('activity.count.denied', { count: summary.denied }) : null,
    ].filter((flag): flag is string => !!flag)
    const leadText = lead ?? (counts.length || flags.length ? null : t('activity.thought'))
    glyph = <Glyph icon={ListChecks} />
    labelKey = 'summary'
    label = (
      <span className="flex min-w-0 items-baseline whitespace-nowrap">
        {leadText && <span className="shrink-0 text-foreground/75 group-hover:text-foreground">{leadText}</span>}
        {counts.length > 0 && (
          <span className="min-w-0 truncate">
            {leadText ? SEPARATOR : ''}
            {counts.join(' · ')}
          </span>
        )}
        {flags.length > 0 && (
          <span className="shrink-0 text-red-300/80">
            {leadText || counts.length ? SEPARATOR : ''}
            {flags.join(' · ')}
          </span>
        )}
      </span>
    )
  }

  return (
    <section className="flex min-w-0 max-w-full flex-col" data-agent-activity={tone}>
      <button
        type="button"
        onClick={() => setOpen(!shown)}
        aria-expanded={shown}
        aria-controls={panelId}
        title={t(shown ? 'activity.hide' : 'activity.show')}
        className={cn(
          'group -ml-1.5 flex w-fit min-w-0 max-w-full items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-left text-[13px] leading-5 transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          tone === 'waiting' ? 'text-amber-300/90' : 'text-muted-foreground hover:text-foreground/80'
        )}
      >
        {glyph}
        <span className="grid min-w-0 overflow-hidden" aria-live={live ? 'polite' : undefined}>
          <span
            key={labelKey}
            className={cn(
              'min-w-0 truncate [grid-area:1/1]',
              live && 'animate-in fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none'
            )}
          >
            {label}
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 motion-reduce:transition-none',
            shown && 'rotate-90'
          )}
        />
      </button>
      {thumbnails}
      {shown && (
        <div id={panelId} className="animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          <ActivityTimeline
            steps={steps}
            live={live}
            renderToolDetail={renderToolDetail}
            reasoningNote={reasoningNote}
            onOpenMention={onOpenMention}
            searchQuery={searchQuery}
            currentSearchMatch={currentSearchMatch}
          />
        </div>
      )}
    </section>
  )
}

function ActivityTimeline<S>({
  steps,
  live,
  renderToolDetail,
  reasoningNote,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: Pick<
  AgentActivityProps<S>,
  'steps' | 'live' | 'renderToolDetail' | 'reasoningNote' | 'onOpenMention' | 'searchQuery' | 'currentSearchMatch'
>) {
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const rows = activityRows(steps)
  const lastStep = steps[steps.length - 1]
  if (!rows.length) return null
  return (
    <ol className="relative my-1 flex min-w-0 flex-col before:absolute before:bottom-3.5 before:left-[8.5px] before:top-3.5 before:w-px before:bg-white/[0.1]">
      {rows.map((row) => (
        <ActivityTimelineRow
          key={row.id}
          row={row}
          open={openRows.has(row.id) || (row.kind === 'reasoning' && activityMatches(row.step, searchQuery))}
          onToggle={() => toggle(row.id)}
          openRows={openRows}
          onToggleRow={toggle}
          thinking={live && row.kind === 'reasoning' && row.step === lastStep}
          renderToolDetail={renderToolDetail}
          reasoningNote={reasoningNote}
          onOpenMention={onOpenMention}
          searchQuery={searchQuery}
          currentSearchMatch={currentSearchMatch}
        />
      ))}
    </ol>
  )
}

const rowHead =
  'grid w-full min-w-0 grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-2.5 rounded-md py-1 pl-0 pr-1.5 text-left text-[13px] leading-5 text-foreground/80 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function RowIcon({ icon, status }: { icon: LucideIcon; status: ActivityStatus }) {
  const busy = status === 'running' || status === 'waiting'
  return (
    <Glyph
      icon={icon}
      spinning={busy}
      className={cn(
        'z-[1] bg-[#1a1a1d] [&>svg]:size-[10px]',
        busy ? 'text-foreground/80' : 'border border-white/[0.14] text-muted-foreground',
        (status === 'failed' || status === 'denied') && 'border-red-400/40 text-red-300'
      )}
    />
  )
}

function RowChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        'size-3.5 text-muted-foreground/50 transition-transform duration-200 motion-reduce:transition-none',
        open && 'rotate-90'
      )}
    />
  )
}

function ToolRowHead<S>({ step, open, onToggle }: { step: ActivityToolStep<S>; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation('chat')
  const label = toolLabel(t, step, step.status === 'running' || step.status === 'waiting' ? 'live' : 'done')
  return (
    <button type="button" className={rowHead} aria-expanded={open} onClick={onToggle}>
      <RowIcon icon={CATEGORY_ICON[step.category]} status={step.status} />
      <span className="min-w-0 truncate" title={plainLabel(label)}>
        <LabelText label={label} />
        <StatusFlag status={step.status} />
      </span>
      <RowChevron open={open} />
    </button>
  )
}

/** Where a step's details go; the renderer draws their box. */
const detailBox = 'mb-2 ml-7 mt-0.5 min-w-0'

function ActivityTimelineRow<S>({
  row,
  open,
  onToggle,
  openRows,
  onToggleRow,
  thinking,
  renderToolDetail,
  reasoningNote,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: {
  row: ActivityRow<S>
  open: boolean
  onToggle: () => void
  openRows: ReadonlySet<string>
  onToggleRow: (id: string) => void
  thinking: boolean
} & Pick<
  AgentActivityProps<S>,
  'renderToolDetail' | 'reasoningNote' | 'onOpenMention' | 'searchQuery' | 'currentSearchMatch'
>) {
  const { t } = useTranslation('chat')
  if (row.kind === 'narration')
    return (
      <li className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] gap-2.5 py-1 pr-1.5">
        <RowIcon icon={MessageSquareText} status="completed" />
        <div className="agent-activity-prose min-w-0 text-[13px] text-foreground/75 [&_p]:my-0">
          <MarkdownViewer
            markdown={row.step.text}
            onOpenMention={onOpenMention}
            searchQuery={searchQuery}
            currentSearchMatch={currentSearchMatch}
          />
        </div>
      </li>
    )
  if (row.kind === 'reasoning') {
    const title = reasoningTitle(row.step.text)
    const text = thinking
      ? title
        ? t('activity.thinkingAbout', { title })
        : t('activity.thinking')
      : title
        ? t('activity.thoughtAbout', { title })
        : t('activity.thought')
    return (
      <li className="min-w-0">
        <button type="button" className={rowHead} aria-expanded={open} onClick={onToggle}>
          <RowIcon icon={Lightbulb} status={thinking ? 'running' : 'completed'} />
          <span className="min-w-0 truncate" title={text}>
            {text}
          </span>
          <RowChevron open={open} />
        </button>
        {open && (
          <div className="agent-activity-prose mb-2 ml-7 mt-0.5 min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[13px] italic text-muted-foreground">
            <MarkdownViewer
              markdown={row.step.text}
              onOpenMention={onOpenMention}
              searchQuery={searchQuery}
              currentSearchMatch={currentSearchMatch}
            />
            {reasoningNote?.(row.step)}
          </div>
        )}
      </li>
    )
  }
  if (row.kind === 'group') {
    const status = groupStatus(row.steps)
    const names = row.steps.map((step) => step.target).filter(Boolean) as string[]
    const text = t(`activity.group.${row.category}`, { count: row.steps.length })
    return (
      <li className="min-w-0">
        <button type="button" className={rowHead} aria-expanded={open} onClick={onToggle}>
          <RowIcon icon={CATEGORY_ICON[row.category]} status={status} />
          <span className="min-w-0 truncate" title={[text, ...names].join(' · ')}>
            {text}
            {names.length > 0 && <span className="ml-1.5 text-muted-foreground">{names.join(', ')}</span>}
            <StatusFlag status={status} />
          </span>
          <RowChevron open={open} />
        </button>
        {open && (
          <ol className="mb-1 ml-7 flex min-w-0 flex-col">
            {row.steps.map((step) => (
              <li key={step.id} className="min-w-0">
                <ToolRowHead step={step} open={openRows.has(step.id)} onToggle={() => onToggleRow(step.id)} />
                {openRows.has(step.id) && <div className={detailBox}>{renderToolDetail(step)}</div>}
              </li>
            ))}
          </ol>
        )}
      </li>
    )
  }
  return (
    <li className="min-w-0">
      <ToolRowHead step={row.step} open={open} onToggle={onToggle} />
      {open && <div className={detailBox}>{renderToolDetail(row.step)}</div>}
    </li>
  )
}
