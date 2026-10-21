import {
  FLEET_FILES_FEATURE,
  type FleetBot,
  type FleetPeerThread,
  type FleetRoutineRun,
  type FleetRoutineRunKept,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, type TextInputInstance, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LaneConflictError } from '../../fleet/controller'
import { formatDateTime } from '../../fleet/format'
import {
  expiresInDays,
  laneKey,
  lanesSupported,
  runDuration,
  runState,
  runWorking,
  threadState,
  threadWorking,
  type LaneRef,
} from '../../fleet/lanes'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { DEMO_SERVER } from '../../demo/demo-source'
import { ComposerShell, ShownError } from '../composer/Composer'
import { confirm } from '../confirm'
import { botFileAccess } from '../conversation/bot-file-fetch'
import { ConversationList, type ExtraRow } from '../conversation/ConversationList'
import { ConversationContext, shownError, type ConversationContextValue } from '../conversation/CueCard'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { IconButton } from '../primitives/IconButton'
import { Sheet } from '../primitives/Sheet'
import { AppText } from '../primitives/Text'
import { citationKey, setCitation } from './citations'
import { PairAvatars, runLook, Tag, threadLook, usePeerTint } from './parts'

const selectOnline = (state: FleetState) => state.connection === 'open'
const selectFeatures = (state: FleetState) => state.features

/** Opens a run's or a thread's own conversation, over the one shown. */
export const openLaneScreen = (botId: string, lane: LaneRef) =>
  router.push({ pathname: '/lane/[id]', params: { id: botId, kind: lane.kind, lane: lane.id } })

/** Back to the bot's own conversation, under every side conversation opened over it. */
function backToBot() {
  if (router.canDismiss()) router.dismissAll()
  else router.replace('/home')
}

function Header({ title, sub, right, lead }: { title: string; sub: string; right?: ReactNode; lead?: ReactNode }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2 }}>
      <IconButton
        icon="chev-left"
        label={t('common.back')}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
      />
      {lead}
      <View style={{ flex: 1, minWidth: 0, paddingHorizontal: 6 }}>
        <AppText
          accessibilityRole="header"
          numberOfLines={1}
          style={{ fontFamily: fonts.display, fontSize: 17, lineHeight: 22, color: palette.ink }}
        >
          {title}
        </AppText>
        <AppText numberOfLines={1} variant="small" tone="muted">
          {sub}
        </AppText>
      </View>
      {right}
    </View>
  )
}

/** One line under the header: the state, that it is apart from the bot's conversation, and how long it is kept. */
function Strip({ children }: { children: ReactNode }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.surface,
      }}
    >
      {children}
    </View>
  )
}

function StripText({ icon, text, cue }: { icon: 'clock' | 'pin' | 'branch'; text: string; cue?: boolean }) {
  const { palette } = useTheme()
  const color = cue ? palette.cueInk : palette.muted
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Icon name={icon} size={13} color={color} />
      <AppText variant="small" style={{ fontSize: 12, color }}>
        {text}
      </AppText>
    </View>
  )
}

/** How many of the bots' messages in a row the thread may still take before it waits for the owner. */
function HopMeter({ thread }: { thread: FleetPeerThread }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const used = Math.min(thread.hops, thread.hopLimit)
  const warn = thread.status === 'paused' || used >= thread.hopLimit - 1
  return (
    <View
      accessible
      accessibilityLabel={t('threads.detail.hopsLabel', { used, count: thread.hopLimit })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
    >
      <View aria-hidden style={{ flexDirection: 'row', gap: 2 }}>
        {Array.from({ length: thread.hopLimit }, (_, index) => (
          <View
            key={index}
            style={{
              width: 5,
              height: 9,
              borderRadius: 1.5,
              backgroundColor: index < used ? (warn ? palette.cue : palette.brass) : palette.lineStrong,
            }}
          />
        ))}
      </View>
      <AppText variant="small" style={{ fontSize: 12, color: warn ? palette.cueInk : palette.muted }}>
        {t('threads.detail.hops', { used, count: thread.hopLimit })}
      </AppText>
    </View>
  )
}

/** A run's report: what it did, and what goes to its next runs; pending work and notes open on demand. */
function RunReport({ run }: { run: FleetRoutineRun }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [more, setMore] = useState(false)
  const report = run.report
  if (!report) return null
  const extra = [
    report.pending ? { label: t('runs.report.pending'), text: report.pending } : null,
    report.notes ? { label: t('runs.report.notes'), text: report.notes } : null,
  ].filter((entry): entry is { label: string; text: string } => !!entry)
  return (
    <View
      style={{
        gap: 6,
        paddingVertical: 11,
        paddingHorizontal: 13,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: mix(palette.moss, palette.line, 0.4),
        backgroundColor: mix(palette.moss, palette.canvas, 0.07),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="clipboard" size={14} color={palette.moss} />
        <AppText
          accessibilityRole="header"
          variant="small"
          style={{ flex: 1, color: palette.moss, fontFamily: fonts.bodySemi }}
        >
          {t('runs.report.title')}
        </AppText>
        <AppText variant="small" tone="faint" style={{ fontSize: 11.5 }}>
          {t('runs.report.next')}
        </AppText>
      </View>
      <AppText variant="small" tone="muted" style={{ fontFamily: fonts.bodySemi }}>
        {t('runs.report.did')}
      </AppText>
      <AppText selectable variant="sub">
        {report.summary}
      </AppText>
      {more
        ? extra.map((entry) => (
            <View key={entry.label} style={{ gap: 2 }}>
              <AppText variant="small" tone="muted" style={{ fontFamily: fonts.bodySemi }}>
                {entry.label}
              </AppText>
              <AppText selectable variant="sub">
                {entry.text}
              </AppText>
            </View>
          ))
        : null}
      {extra.length ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={more}
          onPress={() => setMore((value) => !value)}
          hitSlop={8}
          style={{ alignSelf: 'flex-start' }}
        >
          <AppText variant="small" style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>
            {more ? t('runs.report.less') : t('runs.report.more')}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  )
}

/** What the bot brought back to the owner's conversation from a thread it opened there. */
function ThreadReport({ thread }: { thread: FleetPeerThread }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  if (!thread.report) return null
  return (
    <View
      style={{
        gap: 6,
        paddingVertical: 11,
        paddingHorizontal: 13,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: mix(palette.moss, palette.line, 0.4),
        backgroundColor: mix(palette.moss, palette.canvas, 0.07),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="bring-back" size={14} color={palette.moss} />
        <AppText
          accessibilityRole="header"
          variant="small"
          style={{ flex: 1, color: palette.moss, fontFamily: fonts.bodySemi }}
        >
          {t('threads.report.title')}
        </AppText>
        <Pressable accessibilityRole="button" onPress={backToBot} hitSlop={8}>
          <AppText variant="small" style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>
            {t('threads.report.open')}
          </AppText>
        </Pressable>
      </View>
      <AppText selectable variant="sub">
        {thread.report}
      </AppText>
    </View>
  )
}

/** What stays of a conversation that was deleted: when, and the files kept in the bot's folder. */
function Deleted({
  when,
  body,
  folderLabel,
  kept,
  noFiles,
}: {
  when: string
  body: string
  folderLabel: string
  kept: FleetRoutineRunKept | null
  noFiles: string
}) {
  const { palette } = useTheme()
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          gap: 10,
          padding: 14,
          borderRadius: 14,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: palette.lineStrong,
        }}
      >
        <Icon name="trash" size={16} color={palette.muted} />
        <View style={{ flex: 1, gap: 4 }}>
          <AppText variant="sub">{when}</AppText>
          <AppText variant="small" tone="muted">
            {body}
          </AppText>
        </View>
      </View>
      {kept?.folder ? (
        <View style={{ gap: 6, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.line }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="folder" size={14} color={palette.muted} />
            <AppText variant="small" tone="muted" style={{ flex: 1 }}>
              {folderLabel}
            </AppText>
          </View>
          <AppText variant="mono" selectable>
            {kept.folder}/
          </AppText>
          {kept.files.length ? (
            kept.files.map((file) => (
              <View key={file.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon
                  name={file.kind === 'image' ? 'image' : file.kind === 'video' ? 'play' : 'file'}
                  size={13}
                  color={palette.muted}
                />
                <AppText numberOfLines={1} variant="small" style={{ flex: 1 }}>
                  {file.name}
                </AppText>
              </View>
            ))
          ) : (
            <AppText variant="small" tone="muted">
              {noFiles}
            </AppText>
          )}
        </View>
      ) : null}
    </View>
  )
}

/** A thread the bots paused after their messages in a row without the owner: write to steer it, or let it go on. */
function Paused({ bot, thread }: { bot: FleetBot; thread: FleetPeerThread }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 6,
        marginHorizontal: 12,
        marginBottom: 6,
        paddingVertical: 11,
        paddingHorizontal: 13,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: mix(palette.cue, palette.line, 0.55),
        backgroundColor: palette.cueSoft,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="alert" size={15} color={palette.cueInk} />
        <AppText style={{ flex: 1, fontFamily: fonts.bodySemi, fontSize: 14, color: palette.cueInk }}>
          {t('threads.paused.title', { count: thread.hopLimit })}
        </AppText>
      </View>
      <AppText variant="small" tone="muted">
        {t('threads.paused.body', { name: bot.name, peer: thread.peer.name })}
      </AppText>
      <Button
        label={t('threads.paused.resume', { count: thread.hopLimit })}
        size="sm"
        variant="secondary"
        busy={busy}
        style={{ alignSelf: 'flex-start' }}
        onPress={async () => {
          setBusy(true)
          setFailed(false)
          try {
            await controller.patchThread(bot.id, thread.id, { resume: true })
          } catch {
            setFailed(true)
          } finally {
            setBusy(false)
          }
        }}
      />
      {failed ? (
        <AppText accessibilityRole="alert" style={{ fontSize: 13, color: palette.brick }}>
          {t('outbox.error.generic')}
        </AppText>
      ) : null}
    </View>
  )
}

type Action = {
  key: string
  label: string
  sub?: string
  icon: 'cite' | 'pin' | 'trash'
  danger?: boolean
  run: () => void
}

/** The actions on a run or a thread that the header has no room for: citing it, keeping it, deleting it. */
function Actions({
  title,
  open,
  onClose,
  actions,
}: {
  title: string
  open: boolean
  onClose: () => void
  actions: Action[]
}) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <Group>
        {actions.map((action) => (
          <Cell
            key={action.key}
            icon={action.icon}
            label={action.label}
            sub={action.sub}
            tone={action.danger ? 'brick' : 'ink'}
            onPress={() => {
              onClose()
              // A confirmation over a sheet that is closing would not show: it waits for the sheet to go.
              setTimeout(action.run, 350)
            }}
          />
        ))}
      </Group>
    </Sheet>
  )
}

/**
 * One of a bot's side conversations in full, over its own conversation: a routine run's (everything it did, its
 * report, and changes the owner asks for there) or a thread's with another bot (the bots' messages, what it brought
 * back, and the owner's word to steer it). A deleted one shows what was kept.
 */
export function LaneView({ botId, lane }: { botId: string; lane: LaneRef }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const controller = useFleetController()
  const kind = lane.kind
  const laneId = lane.id
  const bot = useFleet(
    useCallback((state: FleetState) => state.bots.find((item) => item.id === botId) ?? null, [botId])
  )
  const run = useFleet(
    useCallback(
      (state: FleetState) =>
        kind === 'run' ? (state.runs[botId]?.runs.find((item) => item.id === laneId) ?? null) : null,
      [botId, kind, laneId]
    )
  )
  const thread = useFleet(
    useCallback(
      (state: FleetState) =>
        kind === 'thread' ? (state.threads[botId]?.threads.find((item) => item.id === laneId) ?? null) : null,
      [botId, kind, laneId]
    )
  )
  const listLoaded = useFleet(
    useCallback(
      (state: FleetState) => (kind === 'run' ? !!state.runs[botId]?.loaded : !!state.threads[botId]?.loaded),
      [botId, kind]
    )
  )
  useEffect(() => {
    if (kind === 'run') controller.ensureRuns(botId)
    else controller.ensureThreads(botId)
  }, [controller, botId, kind])

  let body: ReactNode = null
  if (bot && run) body = <RunLane bot={bot} run={run} />
  else if (bot && thread) body = <ThreadLane bot={bot} thread={thread} />
  if (body) return <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: palette.canvas }}>{body}</View>
  return (
    <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: palette.canvas }}>
      <Header title={bot?.name ?? ''} sub="" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        {bot && !listLoaded ? (
          <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
        ) : (
          <AppText tone="muted" style={{ textAlign: 'center' }}>
            {t('lanes.gone')}
          </AppText>
        )}
      </View>
    </View>
  )
}

/** The conversation of a run or a thread, with what every row needs, and its composer while it has one. */
function LaneConversation({
  bot,
  lane,
  own,
  live,
  extras,
  placeholder,
  composer,
}: {
  bot: FleetBot
  lane: LaneRef
  /** Its conversation exists: deleted ones and runs from before conversations of their own have none. */
  own: boolean
  /** A turn works there now: the conversation shows the bot thinking until it says something. */
  live: boolean
  extras: ExtraRow[]
  /** Shown instead of the conversation when it has none. */
  placeholder: ReactNode
  composer: ReactNode
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const { active } = useServers()
  const online = useFleet(selectOnline)
  const features = useFleet(selectFeatures)
  const key = laneKey(bot.id, lane.id)
  const transcript = useFleet(useCallback((state: FleetState) => state.lanes[key] ?? null, [key]))
  const inbox = useFleet(
    useCallback((state: FleetState) => state.inbox.filter((item) => item.botId === bot.id), [bot.id])
  )
  const kind = lane.kind
  const laneId = lane.id
  useEffect(() => {
    if (!own) return
    void controller.openLane(bot.id, { kind, id: laneId })
    return () => controller.closeLane(bot.id, laneId)
  }, [controller, bot.id, kind, laneId, own])
  const input = useRef<TextInputInstance>(null)
  const focusComposer = useCallback(() => input.current?.focus(), [])
  const supported = lanesSupported(features, bot)
  const context = useMemo<ConversationContextValue>(
    () => ({
      bot,
      name: bot.name,
      online,
      focusComposer,
      interactionFor: (item: FleetTranscriptItem) =>
        inbox.find((entry) => entry.interaction.itemId === item.id)?.interaction.id ?? null,
      resolve: (interactionId, resolution) => controller.resolve(bot.id, interactionId, resolution),
      imageSource: (imageId) => controller.source.imageSource(bot.id, imageId, laneId),
      files: botFileAccess(controller, bot.id, active?.id === DEMO_SERVER.id),
      // A run can open a thread with another bot: its card leads there too.
      lanes: {
        runs: supported.runs,
        threads: supported.threads,
        openRun: (runId) => openLaneScreen(bot.id, { kind: 'run', id: runId }),
        openThread: (threadId) => openLaneScreen(bot.id, { kind: 'thread', id: threadId }),
        cite: (cited) => {
          setCitation(citationKey(controller.source.serverId, bot.id), cited)
          backToBot()
        },
      },
    }),
    [bot, online, focusComposer, inbox, controller, active?.id, laneId, supported.runs, supported.threads]
  )
  const items = transcript?.items ?? []
  const thinking =
    live && !items.some((item) => (item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming)

  let list: ReactNode
  if (!own) list = <View style={{ flex: 1, padding: 16, gap: 12 }}>{placeholder}</View>
  else if (transcript?.failed && !transcript.loaded)
    list = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
        <AppText accessibilityRole="alert" tone="muted" style={{ textAlign: 'center' }}>
          {t('lanes.loadFailed')}
        </AppText>
        <Pressable
          accessibilityRole="button"
          onPress={() => void controller.reloadLane(bot.id, { kind, id: laneId })}
          hitSlop={10}
        >
          <AppText style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>{t('common.tryAgain')}</AppText>
        </Pressable>
      </View>
    )
  else
    list = (
      <ConversationList
        items={items}
        extras={extras}
        loaded={!!transcript?.loaded}
        loadingOlder={!!transcript?.loading && !!transcript.before}
        thinking={thinking}
        emptyText={t('lanes.empty')}
        onLoadOlder={() => controller.loadOlderLane(bot.id, { kind, id: laneId })}
        hasOlder={!!transcript?.before}
      />
    )
  return (
    <ConversationContext.Provider value={context}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {list}
        {own ? composer : null}
      </KeyboardAvoidingView>
    </ConversationContext.Provider>
  )
}

/** The composer of a run's or a thread's conversation: messages go at once, without the bot's outbox. */
function LaneComposer({
  bot,
  lane,
  placeholder,
  hint,
  working,
  blocked,
  stopLabel,
  above,
}: {
  bot: FleetBot
  lane: LaneRef
  placeholder: string
  hint: string
  working: boolean
  /** Why nothing can be sent now, such as a run still at work; null when messages can go. */
  blocked: string | null
  stopLabel: string
  above?: ReactNode
}) {
  const { t } = useI18n()
  const controller = useFleetController()
  const features = useFleet(selectFeatures)
  return (
    <View>
      {above}
      <AppText variant="small" tone="faint" style={{ marginHorizontal: 22, marginBottom: 2 }}>
        {hint}
      </AppText>
      <ComposerShell
        draftKey={`${controller.source.serverId}:lane:${bot.id}:${lane.id}`}
        placeholder={placeholder}
        filesEnabled={features.includes(FLEET_FILES_FEATURE) && bot.capabilities.includes(FLEET_FILES_FEATURE)}
        setup={null}
        stopLabel={working ? stopLabel : null}
        onStop={() => controller.cancelLane(bot.id, lane.id)}
        onSend={async (text, files) => {
          if (blocked) throw new ShownError(blocked)
          try {
            await controller.sendLane(bot.id, lane, text, files)
          } catch (cause) {
            throw new ShownError(
              cause instanceof LaneConflictError
                ? t(lane.kind === 'run' ? 'runs.delete.conflict' : 'threads.delete.conflict')
                : shownError(cause, t('composer.failed'))
            )
          }
        }}
      />
    </View>
  )
}

function RunLane({ bot, run }: { bot: FleetBot; run: FleetRoutineRun }) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const controller = useFleetController()
  const [actions, setActions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = runState(run, bot)
  const look = runLook(state, palette)
  const working = runWorking(state)
  const own = run.conversation === 'own'
  const title = run.routineTitle || t('lanes.routine')
  useEffect(() => controller.markRunSeen(bot.id, run.id), [controller, bot.id, run.id])

  const duration = runDuration(run)
  const sub = [
    formatDateTime(run.deliveredAt, locale),
    t(run.trigger === 'manual' ? 'runs.detail.manual' : 'runs.detail.scheduled'),
    working || duration === null
      ? null
      : duration < 60
        ? t('runs.durationSeconds', { count: duration })
        : t('runs.durationMinutes', {
            minutes: Math.floor(duration / 60),
            seconds: String(duration % 60).padStart(2, '0'),
          }),
  ]
    .filter(Boolean)
    .join(' · ')
  const expires = expiresInDays(run, Date.now())
  const retention = run.pinned
    ? t('runs.detail.kept')
    : working
      ? t('runs.detail.startsWhenDone')
      : expires === null
        ? t('runs.detail.never')
        : expires === 0
          ? t('runs.detail.expiresToday')
          : plural('runs.detail.expires', expires)

  const fail = (cause: unknown) =>
    setError(
      cause instanceof LaneConflictError ? t('runs.delete.conflict') : shownError(cause, t('outbox.error.generic'))
    )
  const list: Action[] = [
    ...(run.conversation !== 'primary' && !working
      ? [
          {
            key: 'cite',
            label: t('runs.actions.cite'),
            sub: t('runs.actions.citeSub', { name: bot.name }),
            icon: 'cite' as const,
            run: () => {
              setCitation(citationKey(controller.source.serverId, bot.id), run)
              backToBot()
            },
          },
        ]
      : []),
    ...(own
      ? [
          {
            key: 'pin',
            label: t(run.pinned ? 'runs.actions.unpin' : 'runs.actions.pin'),
            sub: t('runs.actions.pinSub'),
            icon: 'pin' as const,
            run: () => {
              setError(null)
              controller.pinRun(bot.id, run.id, !run.pinned).catch(fail)
            },
          },
        ]
      : []),
    ...(own && !working
      ? [
          {
            key: 'delete',
            label: t('runs.actions.delete'),
            icon: 'trash' as const,
            danger: true,
            run: async () => {
              const sure = await confirm({
                title: t('runs.delete.title'),
                message: t('runs.delete.body', { name: bot.name }),
                confirmLabel: t('runs.actions.delete'),
                cancelLabel: t('common.cancel'),
                destructive: true,
              })
              if (!sure) return
              setError(null)
              controller.deleteRunConversation(bot.id, run.id).catch(fail)
            },
          },
        ]
      : []),
  ]
  const extras: ExtraRow[] = !working && run.report ? [{ key: 'report', node: <RunReport run={run} /> }] : []
  const deletedAt = run.conversationDeletedAt ? formatDateTime(run.conversationDeletedAt, locale) : ''
  const placeholder =
    run.conversation === 'deleted' ? (
      <>
        <Deleted
          when={t('runs.tomb.deleted', { when: deletedAt })}
          body={t('runs.tomb.body', { name: bot.name })}
          folderLabel={t('runs.tomb.folder', { name: bot.name })}
          kept={run.kept}
          noFiles={t('runs.tomb.noFiles')}
        />
        <RunReport run={run} />
      </>
    ) : (
      <>
        <AppText
          tone="muted"
          style={{
            padding: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: palette.lineStrong,
          }}
        >
          {t('runs.detail.legacy', { name: bot.name })}
        </AppText>
        <RunReport run={run} />
      </>
    )

  return (
    <>
      <Header
        title={title}
        sub={sub}
        right={list.length ? <IconButton icon="more" label={t('lanes.more')} onPress={() => setActions(true)} /> : null}
      />
      <Strip>
        <Tag text={t(`runs.state.${state}`)} color={look.color} background={look.background} />
        {own ? <StripText icon="branch" text={t('runs.detail.separate')} /> : null}
        {own ? (
          <StripText
            icon={run.pinned ? 'pin' : 'clock'}
            text={retention}
            cue={!run.pinned && expires !== null && expires <= 7}
          />
        ) : null}
      </Strip>
      {error ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginHorizontal: 16, marginTop: 8, fontSize: 13, color: palette.brick }}
        >
          {error}
        </AppText>
      ) : null}
      <LaneConversation
        bot={bot}
        lane={{ kind: 'run', id: run.id }}
        own={own}
        live={state === 'running'}
        extras={extras}
        placeholder={placeholder}
        composer={
          <LaneComposer
            bot={bot}
            lane={{ kind: 'run', id: run.id }}
            placeholder={working ? t('runs.composer.working') : t('runs.composer.placeholder')}
            hint={t('runs.composer.hint', { name: bot.name })}
            working={state === 'running'}
            blocked={working ? t('runs.composer.working') : null}
            stopLabel={t('runs.actions.stop')}
          />
        }
      />
      <Actions title={title} open={actions} onClose={() => setActions(false)} actions={list} />
    </>
  )
}

function ThreadLane({ bot, thread }: { bot: FleetBot; thread: FleetPeerThread }) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const controller = useFleetController()
  const [actions, setActions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tint = usePeerTint(thread.peer.botId)
  const state = threadState(thread, bot)
  const look = threadLook(state, palette)
  const working = threadWorking(thread, bot)
  const own = thread.conversation === 'own'
  useEffect(
    () => controller.markThreadSeen(bot.id, thread.id, thread.lastActivityAt),
    [controller, bot.id, thread.id, thread.lastActivityAt]
  )

  const origin =
    thread.origin === 'primary'
      ? t('threads.origin.primary')
      : thread.origin === 'side'
        ? t('threads.origin.side', { name: bot.name })
        : t('threads.origin.peer', { peer: thread.peer.name })
  const sub = [t('threads.with', { name: bot.name, peer: thread.peer.name }), origin].join(' · ')
  const expires = expiresInDays(thread, Date.now())
  const retention = thread.pinned
    ? t('threads.detail.kept')
    : expires === null
      ? t('threads.detail.never')
      : expires === 0
        ? t('runs.detail.expiresToday')
        : plural('runs.detail.expires', expires)
  const fail = (cause: unknown) =>
    setError(
      cause instanceof LaneConflictError ? t('threads.delete.conflict') : shownError(cause, t('outbox.error.generic'))
    )
  const list: Action[] = own
    ? [
        {
          key: 'pin',
          label: t(thread.pinned ? 'threads.actions.unpin' : 'threads.actions.pin'),
          sub: t('threads.actions.pinSub'),
          icon: 'pin',
          run: () => {
            setError(null)
            controller.patchThread(bot.id, thread.id, { pinned: !thread.pinned }).catch(fail)
          },
        },
        ...(!working
          ? [
              {
                key: 'delete',
                label: t('threads.actions.delete'),
                icon: 'trash' as const,
                danger: true,
                run: async () => {
                  const sure = await confirm({
                    title: t('threads.delete.title'),
                    message: t('threads.delete.body', { name: bot.name, peer: thread.peer.name }),
                    confirmLabel: t('threads.actions.delete'),
                    cancelLabel: t('common.cancel'),
                    destructive: true,
                  })
                  if (!sure) return
                  setError(null)
                  controller.deleteThreadConversation(bot.id, thread.id).catch(fail)
                },
              },
            ]
          : []),
      ]
    : []
  const extras: ExtraRow[] = [
    ...(thread.peerWorking
      ? [
          {
            key: 'peer-working',
            node: (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="swap" size={14} color={palette.muted} />
                <AppText variant="small" tone="muted">
                  {t('threads.detail.peerWorking', { peer: thread.peer.name })}
                </AppText>
              </View>
            ),
          },
        ]
      : []),
    ...(thread.report ? [{ key: 'report', node: <ThreadReport thread={thread} /> }] : []),
  ]
  const deletedAt = thread.conversationDeletedAt ? formatDateTime(thread.conversationDeletedAt, locale) : ''

  return (
    <>
      <Header
        title={thread.title}
        sub={sub}
        lead={<PairAvatars bot={bot} peer={{ name: thread.peer.name, tint }} size={26} />}
        right={list.length ? <IconButton icon="more" label={t('lanes.more')} onPress={() => setActions(true)} /> : null}
      />
      <Strip>
        <Tag text={t(`threads.state.${state}`)} color={look.color} background={look.background} />
        {own ? (
          <StripText
            icon={thread.pinned ? 'pin' : 'clock'}
            text={retention}
            cue={!thread.pinned && expires !== null && expires <= 7}
          />
        ) : null}
        {own ? <HopMeter thread={thread} /> : null}
      </Strip>
      {error ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginHorizontal: 16, marginTop: 8, fontSize: 13, color: palette.brick }}
        >
          {error}
        </AppText>
      ) : null}
      <LaneConversation
        bot={bot}
        lane={{ kind: 'thread', id: thread.id }}
        own={own}
        live={working}
        extras={extras}
        placeholder={
          <>
            <Deleted
              when={t('threads.tomb.deleted', { when: deletedAt })}
              body={t('threads.tomb.body', { name: bot.name, peer: thread.peer.name })}
              folderLabel={t('threads.tomb.folder', { name: bot.name })}
              kept={thread.kept}
              noFiles={t('threads.tomb.noFiles')}
            />
            <ThreadReport thread={thread} />
          </>
        }
        composer={
          <LaneComposer
            bot={bot}
            lane={{ kind: 'thread', id: thread.id }}
            placeholder={t('threads.composer.placeholder', { name: bot.name })}
            hint={t('threads.composer.hint', { name: bot.name, peer: thread.peer.name })}
            working={working}
            blocked={null}
            stopLabel={t('threads.actions.stop', { name: bot.name })}
            above={state === 'paused' ? <Paused bot={bot} thread={thread} /> : null}
          />
        }
      />
      <Actions title={thread.title} open={actions} onClose={() => setActions(false)} actions={list} />
    </>
  )
}
