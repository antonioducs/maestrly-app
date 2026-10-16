import type { MobileDispatchItem } from '@maestrly/bot-fleet-protocol'
import { ActivityIndicator, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { useConversation } from './CueCard'

/** The conversations an agent started from this chat, each with a way to open it, as the desktop's card shows them. */
export function DispatchCard({ item }: { item: MobileDispatchItem }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { openChat } = useConversation()
  const box = {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.raised,
  }
  if (item.state === 'running')
    return (
      <View
        style={[box, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}
        accessibilityRole="progressbar"
        accessibilityLabel={t('dispatch.starting')}
      >
        <ActivityIndicator size="small" color={palette.muted} />
        <AppText variant="sub" tone="muted">
          {t('dispatch.starting')}
        </AppText>
      </View>
    )
  return (
    <View style={box}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon name="message" size={14} color={palette.muted} />
        <AppText variant="small" tone="muted" style={{ fontFamily: fonts.bodySemi }} accessibilityRole="header">
          {t('dispatch.title')}
        </AppText>
      </View>
      {item.conversations.length === 0 ? (
        <AppText variant="sub" tone="muted">
          {item.state === 'error' ? t('dispatch.failed') : t('dispatch.none')}
        </AppText>
      ) : null}
      {item.conversations.map((entry, index) => {
        const ok = entry.status === 'started'
        const status = t(`dispatch.status.${entry.status === 'start-failed' ? 'startFailed' : entry.status}`)
        return (
          <View
            key={entry.conversationId ?? `${entry.title}-${index}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 6,
              borderTopWidth: index ? 1 : 0,
              borderTopColor: palette.line,
            }}
          >
            <Icon name={ok ? 'check' : 'alert'} size={16} color={ok ? palette.moss : palette.brick} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText numberOfLines={2} style={{ fontSize: 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>
                {entry.title}
              </AppText>
              <AppText variant="small" tone="muted" numberOfLines={2}>
                {[status, entry.workspaceName, entry.error].filter(Boolean).join(' · ')}
              </AppText>
            </View>
            {entry.conversationId && openChat ? (
              <Button
                label={t('dispatch.open')}
                accessibilityLabel={t('dispatch.openNamed', { title: entry.title })}
                size="sm"
                variant="secondary"
                onPress={() => openChat(entry.conversationId as string)}
              />
            ) : null}
          </View>
        )
      })}
    </View>
  )
}
