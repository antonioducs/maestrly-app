import type { FleetBot, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { useCallback } from 'react'
import { Pressable, View } from 'react-native'
import { threadState } from '../../fleet/lanes'
import { useFleet } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { PairAvatars, Tag, threadLook, usePeerTint } from './parts'

type PeerOut = Extract<FleetTranscriptItem, { kind: 'peer_out' }>

/**
 * Where the bot's own conversation shows a message that opened a conversation with another bot: that conversation
 * goes on apart, and what the bot brings back from it shows here, with a way to open it.
 */
export function ThreadBridge({ bot, item, onOpen }: { bot: FleetBot; item: PeerOut; onOpen: () => void }) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const threadId = item.thread?.id ?? ''
  // Undefined while the bot's threads load; null for a thread that is gone.
  const thread = useFleet(
    useCallback(
      (state: FleetState) => {
        const list = state.threads[bot.id]
        return list?.loaded ? (list.threads.find((entry) => entry.id === threadId) ?? null) : undefined
      },
      [bot.id, threadId]
    )
  )
  const tint = usePeerTint(item.to.botId)
  const state = thread ? threadState(thread, bot) : thread === null ? 'deleted' : null
  const look = state ? threadLook(state, palette) : null
  const status =
    state === 'working'
      ? t('threads.bridge.working')
      : state === 'paused'
        ? t('threads.state.paused')
        : state === 'deleted'
          ? t('threads.state.deleted')
          : thread?.report
            ? t('threads.bridge.answered')
            : thread
              ? plural('threads.messages', thread.messages)
              : null
  const title = t('threads.bridge.title', { peer: item.to.name })
  const gone = thread === null
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, thread?.title ?? item.text, status].filter(Boolean).join(', ')}
      accessibilityHint={t('threads.bridge.open')}
      aria-disabled={gone}
      disabled={gone}
      onPress={onOpen}
      style={({ pressed }) => ({
        borderRadius: 16,
        borderWidth: 1,
        borderColor: state === 'paused' ? mix(palette.cue, palette.line, 0.55) : palette.lineStrong,
        backgroundColor: pressed ? palette.surface : palette.raised,
        overflow: 'hidden',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
        <PairAvatars bot={bot} peer={{ name: item.to.name, tint }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText numberOfLines={1} style={{ fontFamily: fonts.bodySemi, fontSize: 14 }}>
            {title}
          </AppText>
          <AppText numberOfLines={1} variant="small" tone="muted">
            {thread?.title ?? item.text}
          </AppText>
        </View>
        {status && look ? <Tag text={status} color={look.color} background={look.background} /> : null}
        {gone ? null : <Icon name="chev-right" size={16} color={palette.faint} />}
      </View>
      {thread?.report ? (
        <View
          style={{
            gap: 3,
            paddingVertical: 9,
            paddingHorizontal: 12,
            borderTopWidth: 1,
            borderTopColor: palette.line,
            backgroundColor: palette.canvas,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="bring-back" size={13} color={palette.moss} />
            <AppText variant="small" style={{ color: palette.moss, fontFamily: fonts.bodySemi }}>
              {t('threads.report.title')}
            </AppText>
          </View>
          <AppText numberOfLines={4} variant="sub">
            {thread.report}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  )
}
