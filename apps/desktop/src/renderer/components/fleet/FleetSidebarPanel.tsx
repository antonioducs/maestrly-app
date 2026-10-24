import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { AlertTriangle, BrainCircuit, CircleArrowUp, Clock, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { activityLabel, gb, memorySegments, outOfMemory } from '@/lib/fleet/format'
import { environmentUpdateState, type EnvironmentUpdateState } from '@/lib/fleet/updates'
import { BotUpdateBanner } from './BotUpdateBanner'
import {
  botMatchesQuery,
  environmentDot,
  filterEnvironmentGroups,
  hasEnvironments,
  type EnvironmentDot,
} from '@/lib/fleet/environments'
import { botMoveAvailability, moveTargetAvailability } from '@/lib/fleet/move'
import { groupBotsByEnvironment } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { MoveBotDialog } from './MoveBotDialog'

const dotClass: Record<EnvironmentDot, string> = {
  ready: 'bg-emerald-400',
  busy: 'bg-blue-400',
  stopped: 'bg-muted-foreground',
  failed: 'bg-destructive',
}

export function FleetSidebarPanel({
  fleet,
  query,
  selected,
  onOpenBotSettings,
  onOpenBot,
  onOpenEnvironment,
  onOpenServer,
  onOpenInbox,
  onOpenOwnerMemory,
  marked,
}: {
  fleet: FleetController
  query: string
  /** A bot id, `environment:<id>` for an environment (ids of both kinds can be equal), or a view kind. */
  selected: string | null
  /** The ids of the bots with something new for the owner, marked until the owner opens them. */
  marked?: ReadonlySet<string>
  onOpenBotSettings: () => void
  onOpenBot: (id: string) => void
  onOpenEnvironment: (id: string) => void
  onOpenServer: () => void
  onOpenInbox: () => void
  onOpenOwnerMemory: () => void
}) {
  const { t } = useTranslation('fleet')
  const { connection, snapshot } = fleet.state
  // A bot dragged onto another environment opens its move there; nothing moves before the owner confirms.
  const [dragging, setDragging] = useState<FleetBot | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [moveTo, setMoveTo] = useState<{ bot: FleetBot; environmentId: string } | null>(null)
  const movable = (bot: FleetBot) => botMoveAvailability(fleet, bot) === 'ready'
  const accepts = (environment: FleetEnvironment) =>
    !!dragging && moveTargetAvailability(fleet, dragging, environment) === 'ready'
  const endDrag = () => {
    setDragging(null)
    setDropTarget(null)
  }
  if (
    connection.state === 'unconfigured' ||
    connection.state === 'unauthorized' ||
    connection.state === 'incompatible'
  ) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{t(`connection.${connection.state}`)}</p>
        <p className="mt-2 leading-5">{t('connection.sidebarHint')}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onOpenBotSettings}>
          {t('connection.openSettings')}
        </Button>
      </div>
    )
  }
  // With environments, bots are listed under their environment; before them, as one flat list.
  const grouped = hasEnvironments(connection)
    ? (() => {
        const { groups, ungrouped } = groupBotsByEnvironment(snapshot.environments, snapshot.bots)
        return filterEnvironmentGroups(groups, ungrouped, query)
      })()
    : null
  const bots = grouped ? grouped.ungrouped : snapshot.bots.filter((bot) => botMatchesQuery(bot, query))
  const empty = grouped ? grouped.resultCount === 0 : bots.length === 0
  const segments = memorySegments(snapshot.host, snapshot.bots, snapshot.environments)
  return (
    <div className="p-2 text-xs">
      {connection.state !== 'connected' && (
        <div role="status" className="px-2 py-2 text-muted-foreground">
          {t(connection.state === 'connecting' ? 'connection.connectingTo' : 'connection.reconnectingTo', {
            host: connection.hostname ?? connection.url ?? '',
          })}
        </div>
      )}
      {!query && (
        <button
          type="button"
          onClick={onOpenServer}
          className={`w-full rounded-lg border border-border p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected === 'server' ? 'bg-accent' : ''}`}
        >
          <span className="flex items-center gap-2 font-medium">
            <Server className="size-4" />
            {connection.hostname ?? snapshot.host?.hostname ?? connection.url}
          </span>
          <span className="mt-1 block text-muted-foreground">
            ● {t(connection.state === 'connected' ? 'connection.online' : 'connection.reconnectingStatus')}
          </span>
          {snapshot.host && (
            <>
              <span
                className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted"
                aria-label={t('sidebar.memory', {
                  used: gb(snapshot.host.memory.usedBytes),
                  total: gb(snapshot.host.memory.totalBytes),
                })}
              >
                {segments.map((segment) => (
                  <span
                    key={`${segment.kind}:${segment.id}`}
                    style={{ width: `${Math.min(100, segment.fraction * 100)}%`, background: segment.tint }}
                  />
                ))}
              </span>
              <span className="mt-1 block text-muted-foreground">
                {t('sidebar.botMemory', {
                  count: snapshot.bots.length,
                  used: gb(snapshot.host.memory.usedBytes),
                  total: gb(snapshot.host.memory.totalBytes),
                })}
              </span>
            </>
          )}
        </button>
      )}
      {!query && <BotUpdateBanner fleet={fleet} compact />}
      {!query && snapshot.inbox.length > 0 && (
        <button
          type="button"
          onClick={onOpenInbox}
          className={`mt-2 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-amber-500 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected === 'inbox' ? 'bg-accent' : ''}`}
        >
          <span>{t('sidebar.awaiting')}</span>
          <span className="rounded-full bg-amber-500/15 px-2">{snapshot.inbox.length}</span>
        </button>
      )}
      {!query && (
        <button
          type="button"
          onClick={onOpenOwnerMemory}
          aria-current={selected === 'memory' ? 'page' : undefined}
          className={`mt-2 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected === 'memory' ? 'bg-accent' : ''}`}
        >
          <BrainCircuit className="size-4 text-muted-foreground" />
          <span>{t('sidebar.ownerMemory')}</span>
        </button>
      )}
      <div className="mt-2 space-y-0.5">
        {grouped?.groups.map((group) => {
          const over = dropTarget === group.environment.id
          return (
            <div
              key={group.environment.id}
              role="group"
              aria-label={group.environment.name}
              data-drop-target={over || undefined}
              className={`rounded-md pt-1 transition-colors ${over ? 'bg-primary/10 ring-1 ring-primary/50' : ''}`}
              onDragOver={(event) => {
                if (!accepts(group.environment)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (dropTarget !== group.environment.id) setDropTarget(group.environment.id)
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                if (dropTarget === group.environment.id) setDropTarget(null)
              }}
              onDrop={(event) => {
                if (!dragging || !accepts(group.environment)) return
                event.preventDefault()
                setMoveTo({ bot: dragging, environmentId: group.environment.id })
                endDrag()
              }}
            >
              <EnvironmentHeader
                environment={group.environment}
                update={environmentUpdateState(group.environment, snapshot.host)}
                selected={selected === `environment:${group.environment.id}`}
                onOpen={() => onOpenEnvironment(group.environment.id)}
              />
              {over && dragging && (
                <p role="status" className="px-2 pb-1 text-primary">
                  {t('move.dropHint', { name: dragging.name })}
                </p>
              )}
              <div className="ml-3 space-y-0.5 border-l border-border pl-1">
                {group.bots.map((bot) => (
                  <BotRow
                    key={bot.id}
                    bot={bot}
                    selected={selected === bot.id}
                    marked={!!marked?.has(bot.id)}
                    onOpen={() => onOpenBot(bot.id)}
                    draggable={movable(bot)}
                    onDragStart={() => setDragging(bot)}
                    onDragEnd={endDrag}
                  />
                ))}
              </div>
            </div>
          )
        })}
        {bots.map((bot) => (
          <BotRow
            key={bot.id}
            bot={bot}
            selected={selected === bot.id}
            marked={!!marked?.has(bot.id)}
            onOpen={() => onOpenBot(bot.id)}
          />
        ))}
        {empty && (
          <p className="px-2 py-4 text-center text-muted-foreground">
            {query ? t('sidebar.noResults') : t('sidebar.noBots')}
          </p>
        )}
      </div>
      {moveTo && (
        <MoveBotDialog
          bot={moveTo.bot}
          fleet={fleet}
          initialEnvironmentId={moveTo.environmentId}
          onClose={() => setMoveTo(null)}
          onOpenEnvironment={(environmentId) => {
            setMoveTo(null)
            onOpenEnvironment(environmentId)
          }}
        />
      )}
    </div>
  )
}

function EnvironmentHeader({
  environment,
  update,
  selected,
  onOpen,
}: {
  environment: FleetEnvironment
  update: EnvironmentUpdateState
  selected: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('fleet')
  const bots = t('environment.botCount', { count: environment.botIds.length })
  const memory = environment.resources.memoryBytes
  const updateLabel =
    update === 'available' ? t('updates.available') : update === 'pending' ? t('updates.pendingShort') : null
  const oom = outOfMemory(environment.resources)
  const oomLabel = oom ? t('server.outOfMemory', { count: oom.kills }) : null
  const label = t('sidebar.environmentLabel', {
    name: environment.name,
    status: t(`environment.lifecycle.${environment.lifecycle}`),
    bots,
  })
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'page' : undefined}
      aria-label={[label, updateLabel, oomLabel].filter(Boolean).join(' · ')}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-accent' : ''}`}
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotClass[environmentDot(environment)]}`} />
      <span className="min-w-0 flex-1 truncate font-medium">{environment.name}</span>
      {updateLabel && (
        <span title={updateLabel} className="shrink-0 text-primary">
          {update === 'pending' ? (
            <Clock aria-hidden="true" className="size-3.5" />
          ) : (
            <CircleArrowUp aria-hidden="true" className="size-3.5" />
          )}
        </span>
      )}
      {oomLabel && (
        <span title={oomLabel} className="shrink-0 text-amber-300">
          <AlertTriangle aria-hidden="true" className="size-3.5" />
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">
        {memory ? `${t('sidebar.environmentMemory', { memory: gb(memory) })} · ` : ''}
        {bots}
      </span>
    </button>
  )
}

/** The type a dragged bot carries, which no other drop target of the app reads. */
const BOT_DRAG_TYPE = 'application/x-maestrly-bot'

function BotRow({
  bot,
  selected,
  marked = false,
  onOpen,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  bot: FleetBot
  selected: boolean
  /** The bot has something new for the owner. */
  marked?: boolean
  onOpen: () => void
  /** The bot can be dragged onto another environment to move there. */
  draggable?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const { t } = useTranslation('fleet')
  const activity = activityLabel(bot.activity, bot.status)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'page' : undefined}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(BOT_DRAG_TYPE, bot.id)
        onDragStart?.()
      }}
      onDragEnd={onDragEnd}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-accent' : ''}`}
    >
      <span
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold text-white"
        style={{ background: bot.tint }}
      >
        {bot.name.charAt(0).toUpperCase()}
        <span
          className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar ${bot.status === 'waiting' ? 'bg-amber-400' : bot.status === 'working' ? 'bg-blue-400' : bot.status === 'idle' ? 'bg-emerald-400' : 'bg-muted-foreground'}`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{bot.name}</span>
        <span className="block truncate text-muted-foreground">
          {bot.move ? t('move.moving') : t(activity.key, activity.values)}
        </span>
      </span>
      {bot.pendingCount > 0 && (
        <span className="rounded-full bg-amber-500/15 px-1.5 text-amber-500">{bot.pendingCount}</span>
      )}
      {marked && (
        <span
          role="img"
          aria-label={t('sidebar.botAttention')}
          title={t('sidebar.botAttention')}
          className="size-2 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]"
        />
      )}
    </button>
  )
}
