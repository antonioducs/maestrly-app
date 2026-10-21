import type { MobileConversationBot } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { AccessibilityInfo, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChatsController } from '../../chats/react'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { confirm } from '../confirm'
import { shownError } from '../conversation/CueCard'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

/** Releasing asks first, as on a computer: the bot keeps the chat and is not told what the person writes. */
function useManualChat(conversationId: string, bot: MobileConversationBot) {
  const { t } = useI18n()
  const chats = useChatsController()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function apply(enabled: boolean) {
    if (enabled) {
      const sure = await confirm({
        title: t('chat.bot.releaseTitle'),
        message: t('chat.bot.releaseBody', { name: bot.name }),
        confirmLabel: t('chat.bot.release'),
        cancelLabel: t('common.cancel'),
      })
      if (!sure) return
    }
    setBusy(true)
    setError(null)
    try {
      await chats.setBotManualChat(conversationId, enabled)
      AccessibilityInfo.announceForAccessibility(
        enabled ? t('chat.bot.shared', { name: bot.name }) : t('chat.bot.heldTitle', { name: bot.name })
      )
    } catch (cause) {
      setError(shownError(cause, t('chat.bot.failed')))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, apply }
}

/** Shown instead of the composer while the bot that started the chat holds it, with what lets the person write. */
export function BotHeldNotice({
  conversationId,
  bot,
  online,
}: {
  conversationId: string
  bot: MobileConversationBot
  online: boolean
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const { busy, error, apply } = useManualChat(conversationId, bot)
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: insets.bottom + 6 }}>
      {error ? (
        <AppText
          accessibilityRole="alert"
          style={{ marginHorizontal: 8, marginBottom: 6, fontSize: 13, color: palette.brick }}
        >
          {error}
        </AppText>
      ) : null}
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          padding: 12,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: palette.line,
          backgroundColor: palette.raised,
        }}
      >
        <Icon name="bot" size={20} color={palette.muted} />
        <View style={{ flex: 1 }}>
          <AppText style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>
            {t('chat.bot.heldTitle', { name: bot.name })}
          </AppText>
          <AppText variant="sub" tone="muted">
            {t('chat.bot.heldBody')}
          </AppText>
        </View>
        <Button
          label={t('chat.bot.release')}
          size="sm"
          busy={busy}
          disabled={!online}
          onPress={() => void apply(true)}
        />
      </View>
    </View>
  )
}

/** Over the composer of a chat the person released: whom it is shared with, and blocking their messages again. */
export function BotSharedStrip({
  conversationId,
  bot,
  online,
}: {
  conversationId: string
  bot: MobileConversationBot
  online: boolean
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { busy, error, apply } = useManualChat(conversationId, bot)
  return (
    <View style={{ paddingHorizontal: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="bot" size={14} color={palette.muted} />
        <AppText variant="small" tone="muted" style={{ flex: 1 }}>
          {t('chat.bot.shared', { name: bot.name })}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.bot.block')}
          disabled={busy || !online}
          hitSlop={8}
          onPress={() => void apply(false)}
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingHorizontal: 6,
            opacity: busy || !online ? 0.5 : 1,
          }}
        >
          <Icon name="lock" size={13} color={palette.brass} />
          <AppText variant="small" style={{ color: palette.brass, fontFamily: fonts.bodySemi }}>
            {t('chat.bot.block')}
          </AppText>
        </Pressable>
      </View>
      {error ? (
        <AppText accessibilityRole="alert" style={{ fontSize: 13, color: palette.brick }}>
          {error}
        </AppText>
      ) : null}
    </View>
  )
}
