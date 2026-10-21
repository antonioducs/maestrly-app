import type { FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { Pressable, View } from 'react-native'
import { fileCategory, formatSpace } from '../../fleet/files'
import { formatWhen } from '../../fleet/format'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'

export const fileIcon = (file: FleetPublishedFile): IconName => {
  const category = fileCategory(file)
  return category === 'video' ? 'play' : category === 'image' ? 'image' : 'file'
}

/**
 * One file of the Files sheet: its name, size, when and where the bot shared it. In selection it checks; otherwise it
 * opens the file's actions. A long press starts the selection with it.
 */
export function FileRow({
  file,
  selecting,
  selected,
  progress,
  onPress,
  onLongPress,
  onDelete,
  locale,
  now,
}: {
  file: FleetPublishedFile
  selecting: boolean
  selected: boolean
  /** The download under way: its share, null while unknown. */
  progress?: number | null
  onPress: () => void
  onLongPress: () => void
  onDelete: () => void
  locale: string
  now: number
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const size = formatSpace(file.byteSize, locale)
  const when = formatWhen(file.sharedAt, locale, now)
  const origin = file.origin
  const downloading = progress !== undefined
  return (
    <Pressable
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      aria-checked={selecting ? selected : undefined}
      accessibilityLabel={
        selected ? t('files.rowSelected', { name: file.name }) : t('files.row', { name: file.name, size, when })
      }
      accessibilityActions={[{ name: 'delete', label: t('files.delete') }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'delete') onDelete()
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        minHeight: 62,
        paddingVertical: 10,
        paddingLeft: 14,
        paddingRight: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? palette.surface : palette.group,
      })}
    >
      {selecting ? (
        <View
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 1.5,
            borderColor: selected ? palette.brass : palette.lineStrong,
            backgroundColor: selected ? palette.brass : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? <Icon name="check" size={14} color={palette.canvas} /> : null}
        </View>
      ) : null}
      <View
        aria-hidden
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.surface,
        }}
      >
        <Icon name={fileIcon(file)} size={18} color={palette.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText numberOfLines={1} style={{ fontFamily: fonts.bodySemi, fontSize: 15, lineHeight: 20 }}>
          {file.name}
        </AppText>
        {downloading ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <View style={{ flex: 1, height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: palette.surface }}>
              <View
                style={{
                  width: `${Math.max(2, (progress ?? 0) * 100)}%`,
                  height: 4,
                  backgroundColor: palette.brass,
                }}
              />
            </View>
            <AppText variant="mono" tone="muted" style={{ fontSize: 11, minWidth: 30, textAlign: 'right' }}>
              {progress === null ? t('botFiles.downloading') : `${Math.round((progress ?? 0) * 100)}%`}
            </AppText>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, overflow: 'hidden' }}>
            <AppText
              variant="mono"
              style={{ fontSize: 12, lineHeight: 17, color: mix(palette.ink, palette.group, 0.75) }}
            >
              {size}
            </AppText>
            <AppText variant="small" tone="muted" style={{ opacity: 0.5 }}>
              ·
            </AppText>
            <AppText variant="small" tone="muted" numberOfLines={1}>
              {when}
            </AppText>
            {origin.kind !== 'primary' ? (
              <>
                <AppText variant="small" tone="muted" style={{ opacity: 0.5 }}>
                  ·
                </AppText>
                {origin.kind === 'unknown' ? null : (
                  <Icon name={origin.kind === 'routine' ? 'repeat' : 'swap'} size={11} color={palette.muted} />
                )}
                <AppText variant="small" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {origin.kind === 'unknown' ? t('files.origin.unknown') : origin.title}
                </AppText>
              </>
            ) : null}
            {file.originGone ? (
              <View style={{ paddingHorizontal: 5, borderRadius: 5, backgroundColor: palette.surface }}>
                <AppText style={{ fontSize: 11, lineHeight: 16 }}>{t('files.origin.gone')}</AppText>
              </View>
            ) : null}
          </View>
        )}
      </View>
      {selecting ? null : <Icon name="more" size={20} color={palette.faint} />}
    </Pressable>
  )
}
