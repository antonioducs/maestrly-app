import type { MobileChatItem } from '@maestrly/bot-fleet-protocol'
import { Pressable, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { CitationChip } from '../lanes/RunMarker'
import { AppText } from '../primitives/Text'
import { useConversation } from './CueCard'
import { TranscriptImage } from './TranscriptImage'

type UserItem = Extract<MobileChatItem, { kind: 'user' }>

/** A file sent with a message, as a small chip with its name. */
export function FileChip({
  name,
  onRemove,
  removeLabel,
}: {
  name: string
  onRemove?: () => void
  removeLabel?: string
}) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        height: 30,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 10,
        paddingRight: onRemove ? 4 : 10,
        borderRadius: 10,
        backgroundColor: palette.surface,
        maxWidth: 220,
      }}
    >
      <Icon name="file" size={15} color={palette.muted} />
      <AppText numberOfLines={1} style={{ fontSize: 13, flexShrink: 1 }}>
        {name}
      </AppText>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={removeLabel}
          onPress={onRemove}
          hitSlop={10}
          style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="x" size={14} color={palette.muted} />
        </Pressable>
      ) : null}
    </View>
  )
}

/** What the owner, a routine, another bot or the agent of another conversation sent. */
export function UserBubble({ item, note }: { item: UserItem; note?: string | null }) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const { bot, openChat, edit, lanes } = useConversation()
  const citation = 'citation' in item ? item.citation : undefined
  const editable = edit?.itemId === item.id ? edit : null
  const from = 'fromConversation' in item ? item.fromConversation : null
  const origin = from
    ? t(`user.from.${from.purpose}`, { name: from.name })
    : item.source === 'routine' && item.routine
      ? t('user.routine', { title: item.routine.title })
      : item.source === 'peer' && item.peer
        ? t('user.peer', { name: item.peer.name })
        : item.source === 'continuation'
          ? t('user.continuation')
          : null
  const queued = item.queued
    ? bot?.status === 'paused'
      ? t('user.queuedPaused', { name: bot.name })
      : t('user.queued')
    : null
  return (
    <View style={{ alignItems: 'flex-end', gap: 4 }}>
      <View
        style={{
          maxWidth: '84%',
          paddingVertical: 9,
          paddingHorizontal: 14,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          borderBottomLeftRadius: 20,
          borderBottomRightRadius: 6,
          backgroundColor: palette.surface,
        }}
      >
        {from && openChat ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={origin ?? undefined}
            accessibilityHint={t('user.fromOpen')}
            onPress={() => openChat(from.conversationId)}
            hitSlop={{ top: 12, bottom: 8, left: 8, right: 8 }}
            style={{ alignSelf: 'flex-start', marginBottom: 2 }}
          >
            <AppText variant="small" style={{ fontWeight: '600', color: palette.brass }}>
              {origin}
            </AppText>
          </Pressable>
        ) : origin ? (
          <AppText variant="small" tone="muted" style={{ fontWeight: '600', marginBottom: 2 }}>
            {origin}
          </AppText>
        ) : null}
        {citation ? (
          <View style={{ marginTop: 2, marginBottom: 4 }}>
            <CitationChip
              title={citation.routineTitle || t('lanes.routine')}
              at={citation.at}
              onOpen={lanes?.runs ? () => lanes.openRun(citation.runId) : undefined}
            />
          </View>
        ) : null}
        {item.images.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 4 }}>
            {item.images.map((image) => (
              <TranscriptImage
                key={image.id}
                imageId={image.id}
                label={image.name ?? plural('user.images', 1)}
                style={{ width: 120, height: 120, borderRadius: 12, backgroundColor: palette.raised }}
              />
            ))}
          </View>
        ) : null}
        {item.files?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 4 }}>
            {item.files.map((file) => (
              <FileChip key={file.id} name={file.name} />
            ))}
          </View>
        ) : null}
        {item.text ? <AppText selectable>{item.text}</AppText> : null}
      </View>
      {editable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('edit.action')}
          onPress={() => editable.start(item.id, item.text)}
          hitSlop={8}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            minHeight: 32,
            paddingHorizontal: 8,
            borderRadius: 10,
            backgroundColor: pressed ? palette.surface : 'transparent',
          })}
        >
          <Icon name="pencil" size={14} color={palette.muted} />
          <AppText variant="small" tone="muted">
            {t('edit.action')}
          </AppText>
        </Pressable>
      ) : null}
      {queued || note ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="clock" size={14} color={palette.muted} />
          <AppText variant="small" tone="muted">
            {note ?? queued}
          </AppText>
        </View>
      ) : null}
    </View>
  )
}
