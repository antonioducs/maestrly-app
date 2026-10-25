import type { FleetBot, FleetPeerThread } from '@maestrly/bot-fleet-protocol'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { formatWhen } from '../../fleet/format'
import {
  expiresInDays,
  threadGroups,
  threadPeers,
  threadSettingsOf,
  threadState,
  threadWorking,
  unseenThreads,
} from '../../fleet/lanes'
import { useFleet, useFleetController } from '../../fleet/react'
import { emptyThreads, type FleetState, selectThreadsSeen, threadsSeenMap } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { ThreadSettingsSheet } from './LaneSettings'
import { ChipRow, EmptyLane, ListHead, LoadFailed, PairAvatars, Tag, threadLook, usePeerTint } from './parts'

/** What a thread is about now: who is answering, what it brought back, or that it is gone. */
export function threadSummary(
  thread: FleetPeerThread,
  bot: FleetBot,
  t: ReturnType<typeof useI18n>['t']
): string | null {
  const state = threadState(thread, bot)
  if (state === 'working')
    return threadWorking(thread, bot)
      ? t('threads.summary.working', { name: bot.name })
      : t('threads.summary.peerWorking', { peer: thread.peer.name })
  if (state === 'deleted') return t('threads.summary.deleted')
  return thread.report
}

/** One conversation with another bot: its subject, the other bot, what it is doing, and how long it is kept. */
function ThreadRow({
  bot,
  thread,
  fresh,
  onOpen,
}: {
  bot: FleetBot
  thread: FleetPeerThread
  fresh: boolean
  onOpen: () => void
}) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const state = threadState(thread, bot)
  const look = threadLook(state, palette)
  const tint = usePeerTint(thread.peer.botId)
  const summary = threadSummary(thread, bot, t)
  const expires = expiresInDays(thread, Date.now())
  const paused = state === 'paused'
  const origin =
    thread.origin === 'primary'
      ? t('threads.origin.primary')
      : thread.origin === 'side'
        ? t('threads.origin.side', { name: bot.name })
        : t('threads.origin.peer', { peer: thread.peer.name })
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        thread.title,
        t('threads.with', { name: bot.name, peer: thread.peer.name }),
        t(`threads.state.${state}`),
        summary,
        fresh ? t('lanes.new') : null,
      ]
        .filter(Boolean)
        .join(', ')}
      onPress={onOpen}
      style={({ pressed }) => ({
        gap: 6,
        paddingVertical: 11,
        paddingHorizontal: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: paused ? mix(palette.cue, palette.line, 0.6) : fresh ? palette.brass : palette.line,
        backgroundColor: pressed ? palette.surface : paused ? palette.cueSoft : palette.raised,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <PairAvatars bot={bot} peer={{ name: thread.peer.name, tint }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <AppText
              numberOfLines={1}
              style={{
                flex: 1,
                fontFamily: fonts.bodySemi,
                fontSize: 14.5,
                lineHeight: 19,
                color: state === 'deleted' ? palette.muted : palette.ink,
              }}
            >
              {thread.title}
            </AppText>
            <AppText variant="mono" tone="muted" style={{ fontSize: 11.5 }}>
              {formatWhen(thread.lastActivityAt, locale, Date.now())}
            </AppText>
          </View>
          <AppText numberOfLines={1} variant="small" tone="muted">
            {`${thread.peer.name} · ${origin}`}
          </AppText>
        </View>
        {fresh && !paused ? (
          <View aria-hidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.brass }} />
        ) : null}
      </View>
      {paused ? (
        <AppText variant="sub" style={{ color: palette.cueInk }}>
          {t('threads.paused.title', { count: thread.hopLimit })}
        </AppText>
      ) : summary ? (
        <AppText
          numberOfLines={2}
          variant="sub"
          style={{ color: state === 'working' ? palette.brass : state === 'deleted' ? palette.muted : palette.ink }}
        >
          {summary}
        </AppText>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Tag text={t(`threads.state.${state}`)} color={look.color} background={look.background} />
        <Tag text={plural('threads.messages', thread.messages)} />
        {thread.pinned ? (
          <Tag text={t('threads.meta.kept')} color={palette.brass} background={palette.brassSoft} />
        ) : null}
        {expires !== null && expires <= 7 && state !== 'deleted' ? (
          <Tag
            text={expires === 0 ? t('runs.meta.expiresToday') : plural('runs.meta.expires', expires)}
            color={palette.cueInk}
            background={palette.cueSoft}
          />
        ) : null}
      </View>
    </Pressable>
  )
}

type Row =
  | { kind: 'head'; key: string; text: string; cue: boolean }
  | { kind: 'thread'; key: string; thread: FleetPeerThread }

/**
 * A bot's conversations with other bots, each apart from its conversation with the owner: those that wait for the
 * owner first, then those at work and the others. Opening one shows its whole conversation.
 */
export function ThreadsPane({ bot, onOpen }: { bot: FleetBot; onOpen: (thread: FleetPeerThread) => void }) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const controller = useFleetController()
  const threadsState = useFleet(useCallback((state: FleetState) => state.threads[bot.id] ?? emptyThreads, [bot.id]))
  const seen = useFleet(useCallback((state: FleetState) => selectThreadsSeen(state, bot.id), [bot.id]))
  const [filter, setFilter] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  useEffect(() => controller.ensureThreads(bot.id), [controller, bot.id])

  const peers = useMemo(() => threadPeers(threadsState.threads), [threadsState.threads])
  const shown = useMemo(
    () => (filter ? threadsState.threads.filter((thread) => thread.peer.botId === filter) : threadsState.threads),
    [filter, threadsState.threads]
  )
  const fresh = useMemo(
    () => new Set(seen ? unseenThreads(threadsState.threads, threadsSeenMap(seen)).map((item) => item.id) : []),
    [seen, threadsState.threads]
  )
  const rows = useMemo<Row[]>(
    () =>
      threadGroups(shown, bot).flatMap((group) => [
        {
          kind: 'head' as const,
          key: `head:${group.key}`,
          text: t(`threads.group.${group.key}`),
          cue: group.key === 'needs',
        },
        ...group.threads.map((thread) => ({ kind: 'thread' as const, key: thread.id, thread })),
      ]),
    [shown, bot, t]
  )
  const threadSettings = threadSettingsOf(bot)

  const settingsButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('threads.settings.title')}
      onPress={() => setSettings(true)}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: pressed ? palette.surface : palette.raised,
      })}
    >
      <Icon name="swap" size={14} color={palette.muted} />
      <AppText variant="small" tone="muted" style={{ fontSize: 12.5 }}>
        {plural('threads.hopsShort', threadSettings.hopLimit)}
      </AppText>
    </Pressable>
  )

  let body: ReactNode
  if (threadsState.failed && !threadsState.threads.length)
    body = <LoadFailed text={t('threads.loadFailed')} onRetry={() => void controller.reloadThreads(bot.id)} />
  else if (!threadsState.loaded)
    body = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
      </View>
    )
  else if (!threadsState.threads.length)
    body = <EmptyLane icon="swap" title={t('threads.empty.title')} body={t('threads.empty.body', { name: bot.name })} />
  else
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}
        renderItem={({ item: row }) =>
          row.kind === 'head' ? (
            <ListHead text={row.text} tone={row.cue ? 'cue' : undefined} />
          ) : (
            <ThreadRow
              bot={bot}
              thread={row.thread}
              fresh={fresh.has(row.thread.id)}
              onOpen={() => onOpen(row.thread)}
            />
          )
        }
        ListFooterComponent={
          <AppText variant="small" tone="faint" style={{ textAlign: 'center', paddingTop: 10, paddingHorizontal: 12 }}>
            {threadSettings.retentionDays === null
              ? t('threads.footerNever', { name: bot.name })
              : t('threads.footer', { count: threadSettings.retentionDays, name: bot.name })}
          </AppText>
        }
      />
    )

  return (
    <View style={{ flex: 1 }}>
      {threadsState.loaded && threadsState.threads.length ? (
        peers.length > 1 ? (
          <ChipRow
            label={t('threads.filters')}
            options={[
              { value: null, label: t('threads.all'), count: threadsState.threads.length },
              ...peers.map((peer) => ({ value: peer.id, label: peer.name, count: peer.count })),
            ]}
            value={filter}
            onChange={setFilter}
            trailing={settingsButton}
          />
        ) : (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              paddingHorizontal: 8,
              paddingVertical: 6,
              borderBottomWidth: 1,
              borderBottomColor: palette.line,
            }}
          >
            {settingsButton}
          </View>
        )
      ) : null}
      {body}
      <ThreadSettingsSheet bot={bot} open={settings} onClose={() => setSettings(false)} />
    </View>
  )
}
