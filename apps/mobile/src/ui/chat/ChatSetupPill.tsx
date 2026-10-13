import type { MobileChatMode, MobileChatSetup } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useCallback, useEffect } from 'react'
import { Pressable } from 'react-native'
import { useChats, useChatsController } from '../../chats/react'
import { chatSetupSummary, optionFor } from '../../chats/selectors'
import type { ChatsState } from '../../chats/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from '../primitives/Text'

export const MODE_ICON: Record<MobileChatMode, IconName> = {
  agent: 'bot',
  design: 'palette',
  plan: 'clipboard',
  ask: 'message',
}

/** A chat's setup in one line, as its pill and its setup screen name it. */
export function useChatSummary(setup: MobileChatSetup | null): string | null {
  const { t } = useI18n()
  const models = useChats(useCallback((state: ChatsState) => state.models, []))
  if (!setup) return null
  const options = models?.options ?? []
  return chatSetupSummary(
    setup,
    optionFor(options, setup.selection),
    optionFor(options, models?.defaultSelection ?? null),
    t
  )
}

/** The chat's setup in one pill: its mode, model and effort, a bolt for Fast and a red shield for full access. */
export function ChatSetupPill({ conversationId }: { conversationId: string }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const open = useChats(useCallback((state: ChatsState) => state.bridge === 'open', []))
  const setup = useChats(useCallback((state: ChatsState) => state.setups[conversationId] ?? null, [conversationId]))
  const summary = useChatSummary(setup)

  useEffect(() => {
    if (!open) return
    void chats.loadSetup(conversationId).catch(() => {})
    void chats.loadModels().catch(() => {})
  }, [chats, conversationId, open])

  const full = setup?.permMode === 'full' && setup.experience !== 'maestro'
  const mode = setup ? (setup.experience === 'maestro' ? t('chat.mode.maestro') : t(`chat.mode.${setup.mode}`)) : null
  const spoken = [mode, summary, setup?.fastMode ? t('setup.fast') : null, full ? t('composer.fullAccess') : null]
    .filter(Boolean)
    .join(', ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('composer.setup', { summary: spoken || t('common.loading') })}
      onPress={() => router.push(`/chat-setup/${conversationId}`)}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        flexShrink: 1,
        minWidth: 0,
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginLeft: 2,
        paddingLeft: 9,
        paddingRight: 11,
        borderRadius: 17,
        backgroundColor: full ? mix(palette.brick, palette.raised, 0.13) : pressed ? palette.line : palette.surface,
      })}
    >
      {setup ? (
        <Icon
          name={setup.experience === 'maestro' ? 'sparkles' : MODE_ICON[setup.mode]}
          size={15}
          color={palette.muted}
        />
      ) : null}
      {full ? <Icon name="shield" size={15} color={palette.brick} /> : null}
      <AppText
        numberOfLines={1}
        style={{ flexShrink: 1, fontFamily: fonts.bodyMedium, fontSize: 13.5, lineHeight: 18 }}
      >
        {summary ?? t('chat.setup.label')}
      </AppText>
      {setup?.fastMode ? <Icon name="zap-fill" size={14} color={palette.brass} /> : null}
    </Pressable>
  )
}
