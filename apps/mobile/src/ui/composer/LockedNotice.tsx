import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { BotAction } from '../../fleet/controller'
import { useFleetController } from '../../fleet/react'
import { useI18n, type MessageKey } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon, type IconName } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

/** Shown instead of the composer while the bot cannot take messages from the phone, with what would let it. */
export function LockedNotice({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const controller = useFleetController()
  const [busy, setBusy] = useState(false)
  const name = bot.name
  const needsCompaction = bot.activity?.kind === 'setup' && bot.activity.need === 'compaction'
  const spec: { icon: IconName; title: MessageKey; body: MessageKey; action?: { label: string; run: BotAction } } =
    bot.status === 'offline'
      ? { icon: 'pause', title: 'locked.offline.title', body: 'locked.offline.body', action: { label: t('locked.start', { name }), run: 'start' } }
      : bot.status === 'starting'
        ? { icon: 'clock', title: 'locked.starting.title', body: 'locked.starting.body' }
        : bot.status === 'paused'
          ? { icon: 'pause', title: 'locked.paused.title', body: 'locked.paused.body', action: { label: t('locked.resume'), run: 'resume' } }
          : bot.status === 'human'
            ? { icon: 'hand', title: 'locked.human.title', body: 'locked.human.body' }
            : {
                icon: 'alert',
                title: needsCompaction ? 'locked.setupCompaction.title' : 'locked.setupAccount.title',
                body: 'locked.setup.body',
              }
  const action = spec.action
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: insets.bottom + 6 }}>
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
        <Icon name={spec.icon} size={20} color={palette.muted} />
        <View style={{ flex: 1 }}>
          <AppText style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{t(spec.title, { name })}</AppText>
          <AppText variant="sub" tone="muted">
            {t(spec.body)}
          </AppText>
        </View>
        {action ? (
          <Button
            label={action.label}
            size="sm"
            busy={busy}
            onPress={() => {
              setBusy(true)
              void controller.action(bot.id, action.run).finally(() => setBusy(false))
            }}
          />
        ) : null}
      </View>
    </View>
  )
}
