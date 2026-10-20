import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { sideTurns, type SideTurn } from '../../fleet/lanes'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'
import { formatElapsed, useNow } from '../useNow'

/** What a bot's conversation area shows: its own conversation, its routine runs, or its conversations with bots. */
export type LanePane = 'conversation' | 'runs' | 'threads'

/** One tab's count: news (brass) or, for threads, something waiting on the owner (amber). */
function Count({ count, cue }: { count: number; cue: boolean }) {
  const { palette } = useTheme()
  if (!count) return null
  return (
    <View
      aria-hidden
      style={{
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: cue ? palette.cueSoft : palette.brassSoft,
      }}
    >
      <AppText
        style={{
          fontFamily: fonts.bodySemi,
          fontSize: 11,
          lineHeight: 14,
          color: cue ? palette.cueInk : palette.brass,
        }}
      >
        {count}
      </AppText>
    </View>
  )
}

/** The side conversation at work now, one line under the tabs, which opens it; more of them show as `+n`. */
function WorkingNow({ turns, onOpen }: { turns: SideTurn[]; onOpen: (turn: SideTurn) => void }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const first = turns[0]
  const now = useNow(!!first?.startedAt)
  if (!first) return null
  const title = first.title || t(first.kind === 'routine' ? 'lanes.routine' : 'lanes.tab.threadsLabel')
  const text = t(first.kind === 'routine' ? 'lanes.running' : 'lanes.runningPeer', { title })
  const elapsed = first.startedAt ? formatElapsed(now - Date.parse(first.startedAt)) : null
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        turns.length > 1 ? t('lanes.runningMany', { titles: turns.map((turn) => turn.title).join(', ') }) : text
      }
      accessibilityHint={t('lanes.runningOpen')}
      onPress={() => onOpen(first)}
      style={({ pressed }) => ({
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        borderRadius: 10,
        backgroundColor: pressed ? palette.surface : palette.brassSoft,
      })}
    >
      <ActivityIndicator size="small" color={palette.brass} />
      <AppText numberOfLines={1} variant="small" style={{ flex: 1, color: palette.ink, fontFamily: fonts.bodyMedium }}>
        {text}
      </AppText>
      {elapsed ? (
        <AppText variant="mono" style={{ fontSize: 11.5, color: palette.brass }}>
          {elapsed}
        </AppText>
      ) : null}
      {turns.length > 1 ? (
        <AppText variant="small" style={{ fontFamily: fonts.bodySemi, color: palette.brass }}>
          +{turns.length - 1}
        </AppText>
      ) : null}
      <Icon name="chev-right" size={16} color={palette.brass} />
    </Pressable>
  )
}

/**
 * The tabs under the conversation header: the bot's own conversation, its routine runs and its conversations with
 * other bots, each apart from the others as on the desktop. One row, so the conversation keeps the screen; the side
 * conversation at work shows under it while the bot's own conversation is open.
 */
export function LaneBar({
  bot,
  pane,
  onPane,
  runs,
  threads,
  newRuns,
  newThreads,
  waitingThreads,
  onOpenTurn,
}: {
  bot: FleetBot
  pane: LanePane
  onPane: (pane: LanePane) => void
  /** Whether the bot keeps its runs, and its conversations with bots, in conversations of their own. */
  runs: boolean
  threads: boolean
  newRuns: number
  /** Threads with news or waiting on the owner; `waitingThreads` of them wait. */
  newThreads: number
  waitingThreads: number
  onOpenTurn: (turn: SideTurn) => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const tabs: { pane: LanePane; label: string; icon: IconName; count: number; cue: boolean; a11y: string }[] = [
    {
      pane: 'conversation',
      label: t('lanes.tab.conversation'),
      icon: 'message',
      count: 0,
      cue: false,
      a11y: t('lanes.tab.conversation'),
    },
    ...(runs
      ? [
          {
            pane: 'runs' as const,
            label: t('lanes.tab.runs'),
            icon: 'history' as const,
            count: newRuns,
            cue: false,
            a11y: newRuns ? `${t('lanes.tab.runs')}, ${plural('lanes.tab.runsNew', newRuns)}` : t('lanes.tab.runs'),
          },
        ]
      : []),
    ...(threads
      ? [
          {
            pane: 'threads' as const,
            label: t('lanes.tab.threads'),
            icon: 'swap' as const,
            count: newThreads,
            cue: waitingThreads > 0,
            a11y: newThreads
              ? `${t('lanes.tab.threadsLabel')}, ${plural('lanes.tab.threadsNew', newThreads)}`
              : t('lanes.tab.threadsLabel'),
          },
        ]
      : []),
  ]
  const working = sideTurns(bot).filter((turn) => (turn.kind === 'routine' ? runs : threads))
  return (
    <View
      style={{ paddingHorizontal: 12, paddingBottom: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: palette.line }}
    >
      <View
        accessibilityRole="tablist"
        accessibilityLabel={t('lanes.tabs', { name: bot.name })}
        style={{ flexDirection: 'row', gap: 2, padding: 3, borderRadius: 11, backgroundColor: palette.surface }}
      >
        {tabs.map((tab) => {
          const selected = tab.pane === pane
          return (
            <Pressable
              key={tab.pane}
              accessibilityRole="tab"
              aria-selected={selected}
              accessibilityLabel={tab.a11y}
              onPress={() => onPane(tab.pane)}
              hitSlop={4}
              style={{
                flex: 1,
                minHeight: 34,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                paddingHorizontal: 6,
                borderRadius: 8,
                backgroundColor: selected ? palette.raised : 'transparent',
                shadowColor: '#000',
                shadowOpacity: selected ? 0.14 : 0,
                shadowRadius: 3,
                shadowOffset: { width: 0, height: 1 },
                elevation: selected ? 1 : 0,
              }}
            >
              <Icon name={tab.icon} size={15} color={selected ? palette.ink : palette.muted} />
              <AppText
                numberOfLines={1}
                variant="small"
                tone={selected ? 'ink' : 'muted'}
                style={{ flexShrink: 1, fontSize: 13, fontFamily: selected ? fonts.bodySemi : fonts.bodyMedium }}
              >
                {tab.label}
              </AppText>
              <Count count={tab.count} cue={tab.cue} />
            </Pressable>
          )
        })}
      </View>
      {pane === 'conversation' ? <WorkingNow turns={working} onOpen={onOpenTurn} /> : null}
    </View>
  )
}
