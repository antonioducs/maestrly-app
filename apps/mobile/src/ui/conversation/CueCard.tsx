import type { FleetBot, FleetInteractionResolution, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'

export type ImageSourceValue = { uri: string; headers?: Record<string, string> }

/**
 * What every row of a conversation needs, with a bot or in a chat: who asks, whether the server is reachable, how to
 * answer a request, where images come from, and the composer to return to.
 */
export type ConversationContextValue = {
  /** The bot, in a bot's conversation; null in a chat. */
  bot: FleetBot | null
  /** Who asks, as a card names it. */
  name: string
  online: boolean
  focusComposer: () => void
  /** The id that answers a request item now; null when it cannot be answered. */
  interactionFor: (item: FleetTranscriptItem) => string | null
  resolve: (interactionId: string, resolution: FleetInteractionResolution) => Promise<unknown>
  imageSource: (imageId: string) => ImageSourceValue | Promise<ImageSourceValue>
  /** Opens another chat of the server, such as one an agent started from here. */
  openChat?: (conversationId: string) => void
  /**
   * Gives the chat full access after asking the person, as its setup does; resolves with whether they agreed. Absent
   * in a bot's conversation, in Maestro chats, and once the chat already has full access.
   */
  allowEverything?: () => Promise<boolean>
}
export const ConversationContext = createContext<ConversationContextValue | null>(null)
export function useConversation(): ConversationContextValue {
  const value = useContext(ConversationContext)
  if (!value) throw new Error('useConversation must be used inside a conversation')
  return value
}

/** A card for something that waits on you: a request for approval, a question or a request for help. */
export function CueCard({ children }: { children: ReactNode }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { online } = useConversation()
  return (
    <View
      style={{
        paddingTop: 14,
        paddingHorizontal: 14,
        paddingBottom: 12,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: mix(palette.cue, palette.line, 0.55),
        backgroundColor: palette.cueSoft,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: palette.cue }} />
        <AppText
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            lineHeight: 14,
            letterSpacing: 0.66,
            color: palette.cueInk,
            textTransform: 'uppercase',
          }}
        >
          {t('cue.eyebrow')}
        </AppText>
      </View>
      {online ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Icon name="wifi-off" size={16} color={palette.brick} />
          <AppText style={{ fontSize: 13, color: palette.brick }}>{t('cue.offline')}</AppText>
        </View>
      )}
      {children}
    </View>
  )
}

/** The line a card leaves once it is answered. */
export function ResolvedLine({ icon, tone, text }: { icon: IconName; tone: 'ok' | 'denied' | 'muted'; text: string }) {
  const { palette } = useTheme()
  const color = tone === 'ok' ? palette.moss : tone === 'denied' ? palette.brick : palette.faint
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }} accessible accessibilityLabel={text}>
      <Icon name={icon} size={16} color={color} />
      <AppText variant="sub" tone="muted" style={{ flex: 1, fontSize: 13.5 }}>
        {text}
      </AppText>
    </View>
  )
}

/** A refusal worth showing as it is: a server's own reason, not a dropped connection. */
export const shownError = (cause: unknown, fallback: string): string =>
  cause instanceof Error && (cause as { retryable?: unknown }).retryable === false && cause.message
    ? cause.message
    : fallback

/** Sends an answer for one request, then hands focus back to the composer and says what happened. */
export function useResolver(item: FleetTranscriptItem) {
  const { t } = useI18n()
  const { online, focusComposer, interactionFor, resolve } = useConversation()
  const interactionId = interactionFor(item)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** `before` runs first, such as a confirmation; the request is answered only when it resolves with true. */
  const run = async (resolution: FleetInteractionResolution, announcement: string, before?: () => Promise<boolean>) => {
    if (!interactionId) return
    setBusy(true)
    setError(null)
    try {
      if (before && !(await before())) return
      await resolve(interactionId, resolution)
      AccessibilityInfo.announceForAccessibility(announcement)
      focusComposer()
    } catch (cause) {
      setError(shownError(cause, t('outbox.error.generic')))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, disabled: busy || !online || !interactionId }
}

export function CardError({ text }: { text: string | null }) {
  const { palette } = useTheme()
  if (!text) return null
  return (
    <AppText accessibilityRole="alert" style={{ marginTop: 8, fontSize: 13, color: palette.brick }}>
      {text}
    </AppText>
  )
}
