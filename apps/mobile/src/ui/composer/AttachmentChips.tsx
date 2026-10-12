import { Image } from 'expo-image'
import { Pressable, View } from 'react-native'
import type { OutboxAttachment } from '../../fleet/attachments'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { FileChip } from '../conversation/UserBubble'
import { Icon } from '../icons'

/** What is attached to the message being written, each with a way to remove it. */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: OutboxAttachment[]
  onRemove: (uri: string) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  if (attachments.length === 0) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 4 }}>
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <View key={attachment.uri}>
            <Image
              source={{ uri: attachment.uri }}
              accessibilityLabel={attachment.name}
              contentFit="cover"
              style={{ width: 52, height: 52, borderRadius: 10, backgroundColor: palette.surface }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('attach.remove', { name: attachment.name })}
              onPress={() => onRemove(attachment.uri)}
              hitSlop={10}
              style={{
                position: 'absolute',
                top: -6,
                right: -6,
                width: 22,
                height: 22,
                borderRadius: 11,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.ink,
              }}
            >
              <Icon name="x" size={12} color={palette.canvas} strokeWidth={2.4} />
            </Pressable>
          </View>
        ) : (
          <FileChip
            key={attachment.uri}
            name={attachment.name}
            removeLabel={t('attach.remove', { name: attachment.name })}
            onRemove={() => onRemove(attachment.uri)}
          />
        )
      )}
    </View>
  )
}
