import { ActivityIndicator, View } from 'react-native'
import type { OutboxAttachment } from '../../fleet/attachments'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { FileChip } from '../conversation/UserBubble'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

export type OutboxRowEntry = {
  text: string
  attachments: OutboxAttachment[]
  state: 'waiting' | 'sending' | 'failed'
}

/** A message written on this phone that the server has not taken yet, with what holds it back. */
export function OutboxRow({
  entry,
  waitingText,
  failedReason,
  onRetry,
  onDelete,
}: {
  entry: OutboxRowEntry
  /** Why a waiting message waits: the connection, or a turn still running. */
  waitingText: string
  failedReason: string
  onRetry: () => void
  onDelete: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const failed = entry.state === 'failed'
  const status =
    entry.state === 'sending'
      ? t('outbox.sending')
      : failed
        ? t('outbox.failed', { reason: failedReason })
        : waitingText
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
          opacity: failed ? 1 : 0.7,
        }}
      >
        {entry.attachments.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 4 }}>
            {entry.attachments.map((attachment) => (
              <FileChip key={attachment.uri} name={attachment.name} />
            ))}
          </View>
        ) : null}
        {entry.text ? <AppText>{entry.text}</AppText> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }} accessibilityLiveRegion="polite">
        {entry.state === 'sending' ? (
          <ActivityIndicator size="small" color={palette.muted} />
        ) : (
          <Icon name={failed ? 'alert' : 'clock'} size={14} color={failed ? palette.brick : palette.muted} />
        )}
        <AppText variant="small" style={{ color: failed ? palette.brick : palette.muted }}>
          {status}
        </AppText>
      </View>
      {failed ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Button label={t('common.tryAgain')} size="sm" variant="secondary" onPress={onRetry} />
          <Button label={t('common.delete')} size="sm" variant="danger" onPress={onDelete} />
        </View>
      ) : null}
    </View>
  )
}
