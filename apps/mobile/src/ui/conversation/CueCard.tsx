import type { FleetBot, FleetInteractionResolution } from '@maestrly/bot-fleet-protocol'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { useFleetController } from '../../fleet/react'
import { GatewayError } from '../../gateway/client'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'

/** What every card in a conversation needs: the bot, whether the server is reachable, and the composer to return to. */
export type ConversationContextValue = {
  bot: FleetBot
  online: boolean
  focusComposer: () => void
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
          style={{ fontFamily: fonts.mono, fontSize: 11, lineHeight: 14, letterSpacing: 0.66, color: palette.cueInk, textTransform: 'uppercase' }}
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

/** Sends an answer for one request, then hands focus back to the composer and says what happened. */
export function useResolver(interactionId: string | null) {
  const { t } = useI18n()
  const controller = useFleetController()
  const { bot, online, focusComposer } = useConversation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (resolution: FleetInteractionResolution, announcement: string) => {
    if (!interactionId) return
    setBusy(true)
    setError(null)
    try {
      await controller.resolve(bot.id, interactionId, resolution)
      AccessibilityInfo.announceForAccessibility(announcement)
      focusComposer()
    } catch (cause) {
      setError(cause instanceof GatewayError && !cause.retryable ? cause.message : t('outbox.error.generic'))
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
