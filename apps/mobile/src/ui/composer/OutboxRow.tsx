import { ActivityIndicator, View } from 'react-native'
import { useFleetController } from '../../fleet/react'
import type { OutboxEntry } from '../../fleet/outbox'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { FileChip } from '../conversation/UserBubble'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

/** A message written on this phone that the server has not confirmed yet, with what holds it back. */
export function OutboxRow({ entry }: { entry: OutboxEntry }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const failed = entry.state === 'failed'
  const status =
    entry.state === 'sending'
      ? t('outbox.sending')
      : failed
        ? t('outbox.failed', { reason: t(`outbox.error.${entry.error ?? 'generic'}`) })
        : t('outbox.waiting')
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
          <Button label={t('common.tryAgain')} size="sm" variant="secondary" onPress={() => void controller.retryOutbox(entry.id)} />
          <Button label={t('common.delete')} size="sm" variant="danger" onPress={() => void controller.deleteOutbox(entry.id)} />
        </View>
      ) : null}
    </View>
  )
}
