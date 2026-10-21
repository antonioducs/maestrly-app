import type { FleetBot, FleetFilesUsage, FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { Pressable, View } from 'react-native'
import {
  FILE_CATEGORIES,
  fileCategory,
  filesCountLevel,
  filesLevel,
  filesSpaceLevel,
  formatSpace,
  type FileCategory,
  type FileSort,
  type FilesLevel,
} from '../../fleet/files'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix, type Palette } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'

/** Each type of file in the bar, from the app's palette. */
export const categoryColor = (palette: Palette, category: FileCategory) =>
  category === 'video'
    ? mix(palette.ink, palette.group, 0.82)
    : category === 'image'
      ? mix('#7d9fae', palette.group, 0.9)
      : category === 'archive'
        ? palette.brass
        : palette.muted

/** Text in a level's color: the brick of a full space, the cue of a nearly full one. */
export const levelInk = (palette: Palette, level: FilesLevel) =>
  level === 'full' ? palette.brick : level === 'near' ? palette.cueInk : palette.muted

/**
 * How much of its space a bot's files take: the total, what is left (or what the selection frees), a bar with a
 * segment per file colored by type, and, near or at a limit, what the owner can do about it.
 */
export function UsageCard({
  bot,
  usage,
  files,
  selected,
  filtering,
  visible,
  onSort,
}: {
  bot: FleetBot
  usage: FleetFilesUsage
  files: readonly FleetPublishedFile[]
  selected: ReadonlySet<string>
  /** A scope, a search or a type narrows the list: files outside it fade in the bar. */
  filtering: boolean
  visible: ReadonlySet<string>
  /** `all`: look at every file of the bot, not only the conversation's. */
  onSort: (sort: FileSort, all?: boolean) => void
}) {
  const { palette } = useTheme()
  const { t, plural, locale } = useI18n()
  const level = filesLevel(usage)
  const spaceLevel = filesSpaceLevel(usage)
  const countLevel = filesCountLevel(usage)
  const quota = formatSpace(usage.quotaBytes, locale)
  const used = formatSpace(usage.usedBytes, locale)
  const selectedBytes = files.reduce((sum, file) => (selected.has(file.id) ? sum + file.byteSize : sum), 0)
  const segments = [...files].sort(
    (a, b) =>
      FILE_CATEGORIES.indexOf(fileCategory(a)) - FILE_CATEGORIES.indexOf(fileCategory(b)) || b.byteSize - a.byteSize
  )
  const alert: { text: string; sort: 'size' | 'oldest' } | null =
    countLevel === 'full'
      ? { text: t('files.alert.countFull', { name: bot.name, max: usage.countMax }), sort: 'oldest' }
      : spaceLevel === 'full'
        ? { text: t('files.alert.spaceFull', { name: bot.name }), sort: 'size' }
        : countLevel === 'near'
          ? {
              text: plural('files.alert.countNear', usage.countMax - usage.count, { max: usage.countMax }),
              sort: 'oldest',
            }
          : spaceLevel === 'near'
            ? {
                text: t('files.alert.spaceNear', {
                  percent: Math.floor((usage.usedBytes / Math.max(1, usage.quotaBytes)) * 100),
                }),
                sort: 'size',
              }
            : null
  return (
    <View
      style={{
        marginTop: 14,
        padding: 14,
        borderRadius: 14,
        backgroundColor: palette.group,
        borderWidth: level === 'ok' ? 0 : 1,
        borderColor:
          level === 'full'
            ? mix(palette.brick, palette.group, 0.45)
            : level === 'near'
              ? mix(palette.cue, palette.group, 0.45)
              : 'transparent',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <AppText style={{ flexShrink: 1 }}>
          <AppText style={{ fontFamily: fonts.display, fontSize: 26, lineHeight: 30 }}>{used}</AppText>{' '}
          <AppText tone="muted" style={{ fontSize: 15 }}>
            {t('files.of', { quota })}
          </AppText>
        </AppText>
        {selected.size ? (
          <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 14, color: palette.brick }}>
            {t('files.frees', { size: formatSpace(selectedBytes, locale) })}
          </AppText>
        ) : (
          <AppText
            style={{
              fontFamily: spaceLevel === 'ok' ? fonts.bodyMedium : fonts.bodySemi,
              fontSize: 14,
              color: levelInk(palette, spaceLevel),
            }}
          >
            {t('files.free', { size: formatSpace(Math.max(0, usage.quotaBytes - usage.usedBytes), locale) })}
          </AppText>
        )}
      </View>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('files.bar', { used, quota })}
        style={{ height: 12, borderRadius: 4, overflow: 'hidden', backgroundColor: palette.surface }}
      >
        {Array.from({ length: 9 }, (_, index) => (
          <View
            key={index}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(index + 1) * 10}%`,
              width: 1,
              backgroundColor: mix(palette.ink, palette.surface, 0.1),
            }}
          />
        ))}
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' }}>
          {segments.map((file) => {
            const share = usage.quotaBytes ? (file.byteSize / usage.quotaBytes) * 100 : 0
            const chosen = selected.has(file.id)
            return (
              <View
                key={file.id}
                style={{
                  width: `${share}%`,
                  height: '100%',
                  backgroundColor: chosen ? palette.brick : categoryColor(palette, fileCategory(file)),
                  opacity: filtering && !chosen && !visible.has(file.id) ? 0.22 : 1,
                  borderRightWidth: share > 0.6 ? 1 : 0,
                  borderRightColor: palette.group,
                }}
              />
            )
          })}
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 7 }}>
        <AppText variant="small" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {t('files.spaceOf', { name: bot.name })}
        </AppText>
        <AppText variant="small" style={{ color: levelInk(palette, countLevel) }}>
          {t('files.count', { count: usage.count, max: usage.countMax })}
        </AppText>
      </View>
      {alert ? (
        <View
          accessibilityRole="alert"
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            marginTop: 11,
            paddingTop: 11,
            borderTopWidth: 1,
            borderTopColor: palette.line,
          }}
        >
          <Icon name="alert" size={17} color={level === 'full' ? palette.brick : palette.cue} />
          <View style={{ flex: 1, gap: 4 }}>
            <AppText style={{ fontSize: 13.5, lineHeight: 19 }}>{alert.text}</AppText>
            <Pressable
              accessibilityRole="button"
              onPress={() => (alert.sort === 'size' ? onSort('size') : onSort('oldest', true))}
              hitSlop={8}
              style={{ alignSelf: 'flex-start' }}
            >
              <AppText style={{ fontSize: 13.5, lineHeight: 19, fontFamily: fonts.bodySemi, color: palette.brass }}>
                {alert.sort === 'size' ? t('files.alert.largest') : t('files.alert.oldest')}
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  )
}
