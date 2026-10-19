import type { FleetRoutineRun } from '@maestrly/bot-fleet-protocol'
import { useCallback, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native'
import type { RunState, ThreadState } from '../../fleet/lanes'
import { useFleet } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix, type Palette } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'

/** A bot's color when the phone does not know it, such as a bot of another environment. */
export const UNKNOWN_TINT = '#73776f'

/** A bot's color as the phone knows it, for the other bot of a thread. */
export function usePeerTint(botId: string): string {
  return useFleet(
    useCallback((state: FleetState) => state.bots.find((item) => item.id === botId)?.tint ?? UNKNOWN_TINT, [botId])
  )
}

/** Two bots' initials side by side: the one whose conversation it is, and the other one. Decorative. */
export function PairAvatars({
  bot,
  peer,
  size = 24,
}: {
  bot: { name: string; tint: string }
  peer: { name: string; tint: string }
  size?: number
}) {
  const { palette } = useTheme()
  return (
    <View aria-hidden style={{ flexDirection: 'row' }}>
      {[bot, peer].map((who, index) => (
        <View
          key={index}
          style={{
            width: size,
            height: size,
            marginLeft: index ? -size * 0.28 : 0,
            borderRadius: size * 0.3,
            borderWidth: 2,
            borderColor: palette.canvas,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: mix(who.tint, palette.raised, 0.85),
          }}
        >
          <AppText style={{ fontFamily: fonts.display, fontSize: size * 0.46, lineHeight: size * 0.6, color: '#fff' }}>
            {who.name.slice(0, 1).toUpperCase()}
          </AppText>
        </View>
      ))}
    </View>
  )
}

type Look = { icon: IconName | 'spinner'; color: string; background: string }

export function runLook(state: RunState, palette: Palette): Look {
  switch (state) {
    case 'running':
      return { icon: 'spinner', color: palette.brass, background: palette.brassSoft }
    case 'queued':
      return { icon: 'clock', color: palette.brass, background: palette.brassSoft }
    case 'ok':
      return { icon: 'check', color: palette.moss, background: mix(palette.moss, palette.canvas, 0.14) }
    case 'failed':
      return { icon: 'alert', color: palette.brick, background: mix(palette.brick, palette.canvas, 0.14) }
    case 'quiet':
      return { icon: 'moon', color: palette.muted, background: palette.surface }
    case 'cancelled':
      return { icon: 'stop', color: palette.muted, background: palette.surface }
    case 'deleted':
      return { icon: 'trash', color: palette.muted, background: palette.surface }
    default:
      return { icon: 'clock', color: palette.muted, background: palette.surface }
  }
}

export function threadLook(state: ThreadState, palette: Palette): Look {
  switch (state) {
    case 'paused':
      return { icon: 'alert', color: palette.cueInk, background: palette.cueSoft }
    case 'working':
      return { icon: 'spinner', color: palette.brass, background: palette.brassSoft }
    case 'deleted':
      return { icon: 'trash', color: palette.muted, background: palette.surface }
    default:
      return { icon: 'swap', color: palette.muted, background: palette.surface }
  }
}

/** A square with a state's icon, before a run in its history. Decorative: the row says the state. */
export function StateMark({ look, size = 30 }: { look: Look; size?: number }) {
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: look.background,
      }}
    >
      {look.icon === 'spinner' ? (
        <ActivityIndicator size="small" color={look.color} />
      ) : (
        <Icon name={look.icon} size={size * 0.52} color={look.color} />
      )}
    </View>
  )
}

/** A small rounded label: a state, or how long a conversation is kept. */
export function Tag({ text, color, background }: { text: string; color?: string; background?: string }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 1,
        borderRadius: 6,
        backgroundColor: background ?? palette.surface,
      }}
    >
      <AppText variant="small" style={{ fontSize: 11.5, lineHeight: 16, color: color ?? palette.muted }}>
        {text}
      </AppText>
    </View>
  )
}

/** What a run's conversation holds, as small counts: images, videos and other files. */
export function MediaCounts({ media }: { media: FleetRoutineRun['media'] }) {
  const { palette } = useTheme()
  const { plural } = useI18n()
  if (!media || !(media.images || media.videos || media.files)) return null
  const items = [
    { count: media.images, icon: 'image' as const, label: plural('runs.meta.images', media.images) },
    { count: media.videos, icon: 'play' as const, label: plural('runs.meta.videos', media.videos) },
    { count: media.files, icon: 'file' as const, label: plural('runs.meta.files', media.files) },
  ].filter((item) => item.count > 0)
  return (
    <View
      accessible
      accessibilityLabel={items.map((item) => item.label).join(', ')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
    >
      {items.map((item) => (
        <View key={item.icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Icon name={item.icon} size={13} color={palette.muted} />
          <AppText variant="small" tone="muted" style={{ fontSize: 11.5 }}>
            {item.count}
          </AppText>
        </View>
      ))}
    </View>
  )
}

/** Choices that scroll sideways, such as the routines a history can show, with a button at the end. */
export function ChipRow({
  label,
  options,
  value,
  onChange,
  trailing,
}: {
  label: string
  options: { value: string | null; label: string; count?: number }[]
  value: string | null
  onChange: (value: string | null) => void
  trailing?: ReactNode
}) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 12,
        paddingRight: 8,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: palette.line,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 6, alignItems: 'center' }}
      >
        {options.map((option) => {
          const selected = option.value === value
          return (
            <Pressable
              key={option.value ?? ''}
              accessibilityRole="radio"
              aria-checked={selected}
              accessibilityLabel={option.count !== undefined ? `${option.label}, ${option.count}` : option.label}
              onPress={() => onChange(option.value)}
              hitSlop={4}
              style={{
                minHeight: 32,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                paddingHorizontal: 12,
                borderRadius: 16,
                backgroundColor: selected ? palette.ink : palette.surface,
              }}
            >
              <AppText
                variant="small"
                tone={selected ? 'inverse' : 'ink'}
                style={{ fontFamily: fonts.bodyMedium, fontSize: 13 }}
              >
                {option.label}
              </AppText>
              {option.count !== undefined ? (
                <AppText
                  variant="small"
                  style={{ fontSize: 12, color: selected ? mix(palette.canvas, palette.ink, 0.7) : palette.muted }}
                >
                  {option.count}
                </AppText>
              ) : null}
            </Pressable>
          )
        })}
      </ScrollView>
      {trailing}
    </View>
  )
}

/** The head of a group in a list: a day of runs, or the threads that wait for the owner. */
export function ListHead({ text, aside, tone }: { text: string; aside?: string | null; tone?: 'cue' }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingTop: 14,
        paddingBottom: 6,
        paddingHorizontal: 4,
      }}
    >
      <AppText
        accessibilityRole="header"
        style={{
          flex: 1,
          fontFamily: fonts.mono,
          fontSize: 11,
          lineHeight: 14,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: tone === 'cue' ? palette.cueInk : palette.faint,
        }}
      >
        {text}
      </AppText>
      {aside ? (
        <AppText variant="small" tone="faint" style={{ fontSize: 11.5 }}>
          {aside}
        </AppText>
      ) : null}
    </View>
  )
}

/** A list that could not be read, with a way to try again. */
export function LoadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ padding: 24, gap: 10, alignItems: 'center' }}>
      <AppText accessibilityRole="alert" tone="muted" style={{ textAlign: 'center' }}>
        {text}
      </AppText>
      <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={10}>
        <AppText style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>{t('common.tryAgain')}</AppText>
      </Pressable>
    </View>
  )
}

/** A list with nothing in it yet: what it will hold, and when. */
export function EmptyLane({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const { palette } = useTheme()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 }}>
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          marginBottom: 6,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.surface,
        }}
      >
        <Icon name={icon} size={24} color={palette.muted} />
      </View>
      <AppText variant="heading" accessibilityRole="header" style={{ textAlign: 'center' }}>
        {title}
      </AppText>
      <AppText tone="muted" style={{ textAlign: 'center' }}>
        {body}
      </AppText>
    </View>
  )
}
