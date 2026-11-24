import { Fragment, memo, useRef } from 'react'
import { type AccessibilityActionEvent, Pressable, View } from 'react-native'
import { useI18n } from '../../i18n'
import type { MobileInboxItem } from '../../inbox'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Avatar } from '../Avatar'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'
import { formatInboxPlace, formatRowTime, inboxRowAccessibilityLabel, inboxRowKindSpec } from './format'
import { SwipeableInboxRow, type SwipeDismissHandle } from './SwipeableInboxRow'

function Lead({ item }: { item: MobileInboxItem }) {
  const { palette } = useTheme()
  if (item.source === 'bot') {
    return <Avatar name={item.bot?.name ?? item.title} tint={item.bot?.tint ?? palette.brass} status="idle" size={40} />
  }
  const icon: IconName = item.source === 'workspace' ? 'folder' : item.source === 'chat' ? 'message' : 'clock'
  return (
    <View
      aria-hidden
      style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: palette.surface,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} size={19} color={palette.ink} />
    </View>
  )
}

function Separator() {
  return (
    <AppText aria-hidden variant="small" tone="faint">
      ·
    </AppText>
  )
}

export const InboxRow = memo(function InboxRow({
  item,
  now,
  branch,
  serverCount,
  environmentCount,
  filtered,
  editing,
  swipeOpen,
  onSwipeOpenChange,
  onPress,
  onDismiss,
  onMarkRead,
}: {
  item: MobileInboxItem
  now: number
  branch: string | null
  serverCount: number
  environmentCount: number
  filtered: boolean
  editing: boolean
  swipeOpen: boolean
  onSwipeOpenChange: (open: boolean) => void
  onPress: (item: MobileInboxItem) => void
  onDismiss: (item: MobileInboxItem) => void
  onMarkRead: (key: string) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const swipeHandleRef = useRef<SwipeDismissHandle | null>(null)

  const read = item.group === 'read'
  const time = formatRowTime(item, now, t)
  const kindSpec = inboxRowKindSpec(item.kind, read)
  const place = formatInboxPlace(item, { serverCount, environmentCount, filtered })
  const label = inboxRowAccessibilityLabel(item, { branch, place, timeText: time.text, t })

  const lane = item.bot?.lane ?? 'main'
  const laneIcon: IconName = lane === 'routine' ? 'repeat' : lane === 'thread' ? 'swap' : 'bot'

  const accessibilityActions = item.unread
    ? [
        { name: 'dismiss', label: t('inbox.dismiss') },
        { name: 'markRead', label: t('inbox.markRead') },
      ]
    : [{ name: 'dismiss', label: t('inbox.dismiss') }]

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'dismiss') onDismiss(item)
    else if (event.nativeEvent.actionName === 'markRead' && item.unread) onMarkRead(item.key)
  }

  // Dim lead and content on stale items rather than the row background so the swipe action stays hidden.
  const dim = item.stale ? { opacity: 0.55 } : undefined

  const originSegments: React.ReactNode[] = []
  if (item.source === 'workspace') {
    if (item.project) {
      originSegments.push(
        <AppText
          key="project"
          variant="small"
          tone="muted"
          numberOfLines={1}
          style={{ flexShrink: 1, maxWidth: '50%' }}
        >
          {item.project}
        </AppText>
      )
    }
    if (branch) {
      originSegments.push(
        <View key="branch" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 4, minWidth: 0 }}>
          <Icon name="branch" size={12} color={palette.muted} />
          <AppText variant="mono" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {branch}
          </AppText>
        </View>
      )
    }
  } else if (item.source === 'chat') {
    originSegments.push(
      <View key="chat" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <Icon name="message" size={12} color={palette.muted} />
        <AppText variant="small" tone="muted" numberOfLines={1}>
          {t('inbox.source.chat')}
        </AppText>
      </View>
    )
  } else if (item.source === 'routine') {
    originSegments.push(
      <View key="routine" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <Icon name="clock" size={12} color={palette.muted} />
        <AppText variant="small" tone="muted" numberOfLines={1}>
          {t('inbox.source.routine')}
        </AppText>
      </View>
    )
  } else {
    originSegments.push(
      <View key="bot" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <Icon name={laneIcon} size={12} color={palette.muted} />
        <AppText variant="small" tone="muted" numberOfLines={1}>
          {t(`inbox.lane.${lane}`)}
        </AppText>
      </View>
    )
  }
  if (place) {
    originSegments.push(
      <View key="place" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {item.stale ? <Icon name="wifi-off" size={12} color={palette.brick} /> : null}
        <AppText variant="small" tone="muted" numberOfLines={1}>
          {place}
        </AppText>
      </View>
    )
  }

  const rowStyle = {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: editing ? 0 : 12,
    minHeight: 60,
    borderRadius: 12,
    backgroundColor: palette.canvas,
  }

  const rowBody = (
    <>
      <View style={dim}>
        <Lead item={item} />
      </View>
      <View style={[{ flex: 1, minWidth: 0 }, dim]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 21 }}>
          <AppText
            numberOfLines={1}
            variant="bodyMedium"
            style={{ flex: 1, fontFamily: item.unread ? fonts.bodySemi : fonts.bodyMedium }}
          >
            {item.title}
          </AppText>
          {item.unread ? (
            <View aria-hidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.badge }} />
          ) : null}
          {!editing ? (
            <AppText
              variant="small"
              tone={time.tone}
              style={{
                fontVariant: ['tabular-nums'],
                ...(time.bold ? { fontFamily: fonts.bodySemi } : null),
              }}
            >
              {time.text}
            </AppText>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}>
          <Icon name={kindSpec.icon} size={14} strokeWidth={2} color={kindSpec.iconColor(palette)} />
          <AppText variant="label" tone={kindSpec.labelTone} numberOfLines={1} style={{ flexShrink: 1 }}>
            {t(`inbox.kind.${item.kind}`)}
          </AppText>
        </View>
        {!read && item.summary ? (
          <AppText variant="sub" tone="muted" numberOfLines={item.group === 'waiting' ? 2 : 1} style={{ marginTop: 2 }}>
            {item.summary}
          </AppText>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, overflow: 'hidden' }}>
          {originSegments.map((segment, index) => (
            <Fragment key={index}>
              {index > 0 ? <Separator /> : null}
              {segment}
            </Fragment>
          ))}
        </View>
      </View>
      {editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('inbox.dismissItem', { title: item.title })}
          onPress={() => {
            if (swipeHandleRef.current) swipeHandleRef.current.dismiss()
            else onDismiss(item)
          }}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            alignSelf: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: palette.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="x" size={16} color={palette.muted} />
          </View>
        </Pressable>
      ) : null}
    </>
  )

  return (
    <SwipeableInboxRow
      open={swipeOpen}
      onOpenChange={onSwipeOpenChange}
      label={t('inbox.dismissItem', { title: item.title })}
      short={t('inbox.dismiss')}
      onDismiss={() => onDismiss(item)}
      disabled={editing}
      dismissRef={(handle) => {
        swipeHandleRef.current = handle
      }}
    >
      {editing ? (
        <View style={rowStyle}>{rowBody}</View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={handleAccessibilityAction}
          onPress={() => onPress(item)}
          style={({ pressed }) => [rowStyle, pressed ? { backgroundColor: palette.surface } : null]}
        >
          {rowBody}
        </Pressable>
      )}
    </SwipeableInboxRow>
  )
})
