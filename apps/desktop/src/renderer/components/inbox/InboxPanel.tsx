import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bell,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleDot,
  ClipboardList,
  FolderTree,
  Folder,
  Hand,
  HelpCircle,
  Loader2,
  LocateFixed,
  MessagesSquare,
  Repeat,
  Server,
  ShieldAlert,
  Users,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import { hostTarget } from '@/lib/hosts/shell-keys'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { compactAge } from '@/components/sidebar/relative-time'
import type { InboxGroup, InboxItem, InboxKind, InboxSource } from '@/lib/inbox/inbox-model'
import type { InboxViewState } from './use-inbox-view'

const GROUPS: readonly InboxGroup[] = ['waiting', 'new', 'read']
/** A read item says when it leaves the list once it has this little left. */
const LEAVING_SOON_MS = 3 * 60 * 60 * 1000

const KIND_ICON: Record<InboxKind, { icon: typeof Bell; className: string }> = {
  question: { icon: HelpCircle, className: 'text-artifact-warn' },
  approval: { icon: ShieldAlert, className: 'text-artifact-warn' },
  plan: { icon: ClipboardList, className: 'text-artifact-warn' },
  help: { icon: Hand, className: 'text-artifact-warn' },
  error: { icon: XCircle, className: 'text-status-error' },
  finished: { icon: CircleDot, className: 'text-status-ready' },
  activity: { icon: CircleDot, className: 'text-status-ready' },
}

const SOURCES: ReadonlyArray<{ source: InboxSource | null; icon: typeof Bell | null }> = [
  { source: null, icon: null },
  { source: 'workspace', icon: FolderTree },
  { source: 'chat', icon: MessagesSquare },
  { source: 'bot', icon: Bot },
]

/** The home tab of an item's source, for "Show in". */
const HOME_TAB: Record<InboxSource, 'workspaces' | 'chats' | 'bots'> = {
  workspace: 'workspaces',
  chat: 'chats',
  bot: 'bots',
}

/** What waits in a conversation, read from its host: the question it asks, or the approval it needs. */
interface PendingDetail {
  text: string | null
  requestId?: string
}

/** The question or approval each waiting conversation shows, read again whenever it asks anew. */
function usePendingDetails(items: readonly InboxItem[]): Record<string, PendingDetail> {
  const [details, setDetails] = useState<Record<string, PendingDetail & { version: string }>>({})
  const wanted = useMemo(
    () =>
      items
        .filter(
          (item) =>
            item.target.kind === 'conversation' &&
            item.group === 'waiting' &&
            (item.kind === 'approval' || item.kind === 'question')
        )
        .map((item) => ({ item, version: `${item.kind}@${item.at}` })),
    [items]
  )
  const signature = wanted.map(({ item, version }) => `${item.key}#${version}`).join('|')
  const detailsRef = useRef(details)
  detailsRef.current = details
  useEffect(() => {
    let alive = true
    for (const { item, version } of wanted) {
      if (item.target.kind !== 'conversation' || detailsRef.current[item.key]?.version === version) continue
      const { api, id } = hostTarget(item.target.conversationId)
      void api
        .chatRuntime(id)
        .then((runtime) => {
          if (!alive) return
          const request = item.kind === 'approval' ? runtime.pendingPermissions[0] : undefined
          const question = item.kind === 'question' ? runtime.pendingQuestions?.[0]?.questions[0]?.question : undefined
          const detail: PendingDetail & { version: string } = {
            version,
            text: request?.title ?? question ?? null,
            ...(request ? { requestId: request.id } : {}),
          }
          setDetails((current) => ({ ...current, [item.key]: detail }))
        })
        .catch(() => undefined)
    }
    return () => {
      alive = false
    }
    // The signature says when another item waits, or one asks anew.
  }, [signature])
  return details
}

export function InboxPanel({
  view,
  activeKey,
  showPlaces,
  onShowIn,
  showQuickTooltip,
  hideQuickTooltip,
}: {
  view: InboxViewState
  /** The item open in the main area, if any. */
  activeKey: string | null
  /** Whether items come from more than one machine or environment, so each says where. */
  showPlaces: boolean
  /** Shows the item in its own tab, once opened. */
  onShowIn: (item: InboxItem, tab: 'workspaces' | 'chats' | 'bots') => void
  showQuickTooltip: (e: { currentTarget: HTMLElement }, text: string) => void
  hideQuickTooltip: () => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const details = usePendingDetails(view.items)
  const [responding, setResponding] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  /** How long ago a time was, as the sidebar says it (`3min`, `2h`). */
  const ageOf = (ts: number): string => {
    const value = compactAge(ts)
    if (!value) return ''
    return value.unit === 'Now' ? t('sidebar.ageNow') : t(`sidebar.age${value.unit}`, { count: value.count })
  }
  /** A length of time in the same words. */
  const lengthOf = (ms: number): string => ageOf(Date.now() - ms)

  const respond = async (item: InboxItem, reply: 'once' | 'reject') => {
    setResponding((current) => new Set(current).add(item.key))
    try {
      if (item.target.kind === 'conversation') {
        const requestId = details[item.key]?.requestId
        if (!requestId) return
        hostTarget(item.target.conversationId).api.chatPermissionRespond(requestId, reply)
      } else await view.actions.resolveBotRequest(item, reply)
      view.actions.markRead([item])
    } catch {
      /* What went wrong shows where the request is: opening the item shows it. */
    } finally {
      setResponding((current) => {
        const next = new Set(current)
        next.delete(item.key)
        return next
      })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-inbox-row]') ?? [])]
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const down = event.key === 'j' || event.key === 'ArrowDown'
    const up = event.key === 'k' || event.key === 'ArrowUp'
    if (down || up) {
      if (index < 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) return
      event.preventDefault()
      const next = rows[index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (down ? 1 : -1)))]
      next?.focus()
      next?.scrollIntoView({ block: 'nearest' })
      return
    }
    if ((event.key === 'e' || event.key === 'E') && index >= 0) {
      const item = view.items.find((entry) => entry.key === rows[index].dataset.inboxRow)
      if (item?.unread) {
        event.preventDefault()
        view.actions.markRead([item])
      }
    }
  }

  const origin = (item: InboxItem): ReactNode => {
    const parts: ReactNode[] = []
    if (item.source === 'workspace')
      parts.push(
        <span key="where" className="flex min-w-0 items-center gap-1">
          <Folder aria-hidden="true" className="size-[11px] shrink-0 opacity-80" />
          <span className="truncate">{item.project ?? t('inbox.source.workspace')}</span>
        </span>
      )
    else if (item.source === 'chat')
      parts.push(
        <span key="where" className="flex min-w-0 items-center gap-1">
          <MessagesSquare aria-hidden="true" className="size-[11px] shrink-0 opacity-80" />
          <span className="truncate">{t('inbox.source.chat')}</span>
        </span>
      )
    else {
      const lane = item.bot?.lane ?? 'main'
      const LaneIcon = lane === 'routine' ? Repeat : lane === 'thread' ? Users : Bot
      parts.push(
        <span key="where" className="flex min-w-0 items-center gap-1">
          <LaneIcon aria-hidden="true" className="size-[11px] shrink-0 opacity-80" />
          <span className="truncate">{t(`inbox.lane.${lane}`)}</span>
        </span>
      )
    }
    if (showPlaces)
      parts.push(
        <span key="place" className="min-w-0 truncate">
          {item.place.label}
        </span>
      )
    return parts.flatMap((part, index) =>
      index === 0
        ? [part]
        : [
            <span key={`dot-${index}`} aria-hidden="true" className="shrink-0 opacity-45">
              ·
            </span>,
            part,
          ]
    )
  }

  const timeOf = (item: InboxItem): { text: string; title: string; className?: string } => {
    const title = dateFormat.format(item.at)
    if (item.group === 'read' && item.expiresAt !== null) {
      const left = item.expiresAt - Date.now()
      const leaves = t('inbox.leavesIn', { time: lengthOf(Math.max(60_000, left)) })
      if (left < LEAVING_SOON_MS)
        return { text: leaves, title: `${title} · ${leaves}`, className: 'text-muted-foreground/60' }
      return { text: ageOf(item.at), title: `${title} · ${leaves}` }
    }
    if (item.group === 'waiting')
      return { text: ageOf(item.at), title: t('inbox.waitingSince', { time: title }), className: 'text-artifact-warn' }
    return { text: ageOf(item.at), title }
  }

  const row = (item: InboxItem) => {
    const { icon: KindIcon, className: kindClass } = KIND_ICON[item.kind]
    const working = item.status === 'working' && item.group !== 'waiting'
    const time = timeOf(item)
    // What a conversation asked is read from its host while it waits; once answered it says nothing more.
    const detail = item.summary ?? (item.group === 'waiting' ? (details[item.key]?.text ?? null) : null)
    const approvable =
      item.group === 'waiting' &&
      item.kind === 'approval' &&
      (item.target.kind === 'bot' ? Boolean(item.target.requestId) : Boolean(details[item.key]?.requestId))
    const busy = responding.has(item.key)
    const homeTab = HOME_TAB[item.source]
    return (
      <li
        key={item.key}
        className={cn(
          'group/row relative mx-1.5 rounded-lg transition-colors hover:bg-white/[0.04]',
          activeKey === item.key && 'conv-selected',
          item.group === 'read' && activeKey !== item.key && 'opacity-75 hover:opacity-100 focus-within:opacity-100'
        )}
      >
        <button
          type="button"
          data-inbox-row={item.key}
          onClick={() => view.open(item)}
          className="flex w-full min-w-0 gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="mt-[2px] inline-flex shrink-0">
            {working ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-status-working" />
            ) : (
              <KindIcon aria-hidden="true" className={cn('size-3.5', kindClass)} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex h-[18px] min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px]',
                  item.unread ? 'font-semibold text-foreground' : 'text-sidebar-foreground/85'
                )}
                onMouseEnter={(e) => showQuickTooltip(e, item.title)}
                onMouseLeave={hideQuickTooltip}
              >
                {item.title}
              </span>
              {item.unread && (
                <span
                  role="img"
                  aria-label={t('inbox.unread')}
                  className="size-[7px] shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.85)] group-focus-within/row:invisible group-hover/row:invisible"
                />
              )}
              <span
                title={time.title}
                className={cn(
                  'shrink-0 text-[11px] tabular-nums text-muted-foreground/80 group-focus-within/row:invisible group-hover/row:invisible',
                  time.className
                )}
              >
                {time.text}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
              {origin(item)}
            </span>
            {item.group !== 'read' && (
              <span
                className={cn(
                  'text-[12px] leading-[1.4] text-sidebar-foreground/65',
                  item.group === 'waiting' ? 'line-clamp-2' : 'line-clamp-1'
                )}
              >
                <span
                  className={cn(
                    'font-medium',
                    item.group === 'waiting'
                      ? 'text-artifact-warn'
                      : item.kind === 'error'
                        ? 'text-status-error'
                        : 'text-sidebar-foreground/80'
                  )}
                >
                  {t(`inbox.kind.${item.kind}`)}
                </span>
                {detail && <> · {detail}</>}
              </span>
            )}
          </span>
        </button>
        {approvable && (
          <div className="flex gap-1.5 pb-2 pl-[30px] pr-2">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2.5 text-[11.5px]"
              disabled={busy}
              onClick={() => void respond(item, 'reject')}
            >
              {t('inbox.deny')}
            </Button>
            <Button
              size="sm"
              className="h-6 px-2.5 text-[11.5px]"
              disabled={busy}
              onClick={() => void respond(item, 'once')}
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              {t('inbox.allowOnce')}
            </Button>
          </div>
        )}
        <div className="pointer-events-none absolute right-1.5 top-1 flex gap-0.5 opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
          {item.unread && (
            <RowAction label={t('inbox.markRead')} onClick={() => view.actions.markRead([item])}>
              <Check className="size-3" />
            </RowAction>
          )}
          <RowAction
            label={t('inbox.showIn', { tab: t(`sidebar.${homeTab}`) })}
            onClick={() => onShowIn(item, homeTab)}
          >
            <LocateFixed className="size-3" />
          </RowAction>
          <RowAction label={t('inbox.dismiss')} onClick={() => view.dismiss(item)}>
            <X className="size-3" />
          </RowAction>
        </div>
      </li>
    )
  }

  const byGroup = (group: InboxGroup) => view.items.filter((item) => item.group === group)
  const filtered = view.place !== null || view.source !== null
  const empty = view.items.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view.total > 0 && (
        <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
          {view.places.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-black/20 px-2.5 text-left text-[12px] text-sidebar-foreground/85 outline-none hover:border-border-strong focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:border-border-strong"
                >
                  <Server aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {view.places.find((place) => place.key === view.place)?.label ?? t('inbox.everyPlace')}
                  </span>
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[220px]">
                {[{ key: null, label: t('inbox.everyPlace'), count: view.total }, ...view.places].map((place) => (
                  <DropdownMenuItem
                    key={place.key ?? 'all'}
                    onClick={() => view.setPlace(place.key)}
                    className="gap-2 text-xs"
                  >
                    <Check className={cn('size-3.5', view.place !== place.key && 'invisible')} />
                    <span className="min-w-0 flex-1 truncate">{place.label}</span>
                    <span className="tabular-nums text-muted-foreground">{place.count}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div
            role="group"
            aria-label={t('inbox.filterSource')}
            className="grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-0.5 rounded-lg border border-border bg-black/20 p-0.5"
          >
            {SOURCES.map(({ source, icon: Icon }) => {
              const count = view.sourceCounts[source ?? 'all']
              const label = t(source ? `inbox.source.${source}s` : 'inbox.source.all')
              return (
                <button
                  key={source ?? 'all'}
                  type="button"
                  aria-pressed={view.source === source}
                  aria-label={`${label}, ${count}`}
                  title={label}
                  onClick={() => view.setSource(source)}
                  className={cn(
                    'flex h-6 items-center justify-center gap-1 rounded-md text-[11.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                    view.source === source && 'bg-sidebar-accent text-foreground'
                  )}
                >
                  {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : <span>{label}</span>}
                  <span className="text-[10.5px] tabular-nums opacity-75">{count}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div
        ref={listRef}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-3 pt-1"
      >
        {empty ? (
          <div className="px-6 py-10 text-center text-muted-foreground">
            <div
              className={cn(
                'mx-auto mb-3 grid size-10 place-items-center rounded-xl',
                view.total === 0 ? 'bg-status-ready/10 text-status-ready' : 'bg-white/[0.05]'
              )}
            >
              {view.total === 0 ? <CheckCheck className="size-5" /> : <Bell className="size-5" />}
            </div>
            <p className="text-[13px] font-medium text-foreground">
              {view.total === 0 ? t('inbox.emptyTitle') : t('inbox.emptyFilteredTitle')}
            </p>
            <p className="mt-1 text-xs leading-relaxed">
              {view.total === 0 ? t('inbox.emptyBody') : t('inbox.emptyFilteredBody', { count: view.total })}
            </p>
            {view.total > 0 && filtered && (
              <Button variant="outline" size="sm" className="mt-3 h-7 text-xs" onClick={view.clearFilters}>
                {t('inbox.showEverything')}
              </Button>
            )}
          </div>
        ) : (
          GROUPS.map((group) => {
            const items = byGroup(group)
            if (items.length === 0) return null
            const open = !view.collapsed[group]
            return (
              <section key={group} aria-label={t(`inbox.group.${group}`)}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => view.toggleGroup(group)}
                  title={t(`inbox.groupHint.${group}`)}
                  className="mx-1.5 mb-0.5 mt-2 flex w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[11.5px] font-medium text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('size-3 transition-transform', !open && '-rotate-90')}
                  />
                  <span className={cn(group === 'waiting' && 'text-artifact-warn')}>{t(`inbox.group.${group}`)}</span>
                  <span className="rounded bg-white/[0.05] px-1 text-[10px] tabular-nums">{items.length}</span>
                  {group !== 'new' && (
                    <span className="ml-auto truncate text-[10.5px] font-normal text-muted-foreground/60">
                      {t(`inbox.groupCaption.${group}`)}
                    </span>
                  )}
                </button>
                {open && <ul>{items.map(row)}</ul>}
              </section>
            )
          })
        )}
      </div>

      {view.undo ? (
        <div
          role="status"
          className="mx-2 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border-strong bg-popover px-2.5 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">{t('inbox.dismissed', { title: view.undo.item.title })}</span>
          <button type="button" onClick={view.undoDismiss} className="shrink-0 font-semibold hover:underline">
            {t('inbox.undo')}
          </button>
        </div>
      ) : (
        !empty && (
          <div
            aria-hidden="true"
            className="flex shrink-0 gap-3 border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground/60"
          >
            <span>{t('inbox.keysNavigate')}</span>
            <span>{t('inbox.keysOpen')}</span>
            <span>{t('inbox.keysRead')}</span>
          </div>
        )
      )}
    </div>
  )
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-[22px] place-items-center rounded-md bg-[#232226] text-muted-foreground shadow-[0_0_0_1px_var(--border)] outline-none hover:bg-[#2c2b30] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}
