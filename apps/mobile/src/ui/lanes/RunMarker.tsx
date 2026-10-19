import type { FleetRoutineRun } from '@maestrly/bot-fleet-protocol'
import { Pressable, View } from 'react-native'
import { formatWhen } from '../../fleet/format'
import { runSummary } from '../../fleet/lanes'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { MediaCounts } from './parts'

/**
 * A run that finished, where the bot's conversation shows it: a notice for the owner that the bot never reads, with
 * what the run did, a way to open its conversation and a way to bring it up in this one.
 */
export function RunMarker({ run, onOpen, onCite }: { run: FleetRoutineRun; onOpen: () => void; onCite: () => void }) {
  const { palette } = useTheme()
  const { t, locale } = useI18n()
  const failed = run.status === 'failed'
  const title = run.routineTitle || t('lanes.routine')
  const at = formatWhen(run.finishedAt ?? run.deliveredAt, locale, Date.now())
  const summary = run.conversation === 'deleted' ? t('runs.summary.deleted') : runSummary(run)
  const accent = failed ? palette.brick : palette.brass
  const headline = t(failed ? 'runs.marker.failed' : 'runs.marker.finished', { title })
  return (
    <View
      style={{
        gap: 8,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: mix(accent, palette.line, 0.55),
        backgroundColor: mix(accent, palette.canvas, 0.07),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={failed ? 'alert' : 'repeat'} size={15} color={accent} />
        <AppText numberOfLines={1} style={{ flex: 1, fontFamily: fonts.bodySemi, fontSize: 14, color: palette.ink }}>
          {headline}
        </AppText>
        <AppText variant="mono" tone="muted" style={{ fontSize: 11.5 }}>
          {at}
        </AppText>
      </View>
      {summary ? (
        <AppText numberOfLines={3} variant="sub">
          {summary}
        </AppText>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <AppText variant="small" tone="faint" style={{ fontSize: 11.5 }}>
            {t('runs.marker.outside')}
          </AppText>
          <MediaCounts media={run.media} />
        </View>
        {run.conversation !== 'primary' ? (
          <Button
            label={t('runs.marker.cite')}
            accessibilityLabel={t('runs.marker.citeLabel', { title })}
            icon="cite"
            size="sm"
            variant="ghost"
            onPress={onCite}
          />
        ) : null}
        <Button
          label={t('runs.marker.open')}
          accessibilityLabel={t('runs.marker.openLabel', { title, time: at })}
          size="sm"
          variant="secondary"
          onPress={onOpen}
        />
      </View>
    </View>
  )
}

/** The run a message refers to: on the owner's bubble, and above the composer before it is sent. */
export function CitationChip({
  title,
  at,
  pending,
  onOpen,
  onRemove,
}: {
  title: string
  at: string
  /** Above the composer: says the message will cite it, and can be removed. */
  pending?: boolean
  onOpen?: () => void
  onRemove?: () => void
}) {
  const { palette } = useTheme()
  const { t, locale } = useI18n()
  const when = formatWhen(at, locale, Date.now())
  const text = pending ? t('runs.cite.chip', { title, when }) : `${title} · ${when}`
  return (
    <View
      style={{
        alignSelf: pending ? 'stretch' : 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: pending ? 34 : 26,
        paddingLeft: 9,
        paddingRight: onRemove ? 2 : 9,
        borderRadius: pending ? 12 : 8,
        backgroundColor: palette.brassSoft,
      }}
    >
      <Pressable
        accessibilityRole={onOpen ? 'link' : undefined}
        accessibilityLabel={text}
        accessibilityHint={onOpen ? t('runs.cite.open') : undefined}
        disabled={!onOpen}
        onPress={onOpen}
        hitSlop={6}
        // On the bubble the chip is as wide as its text; `flex: 0` would collapse it on the web.
        style={{ ...(pending ? { flex: 1 } : null), flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}
      >
        <Icon name="cite" size={14} color={palette.brass} />
        <AppText
          numberOfLines={1}
          variant="small"
          style={{ flexShrink: 1, color: palette.brass, fontFamily: fonts.bodySemi }}
        >
          {text}
        </AppText>
      </Pressable>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('runs.cite.remove')}
          onPress={onRemove}
          hitSlop={8}
          style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="x" size={14} color={palette.brass} />
        </Pressable>
      ) : null}
    </View>
  )
}
