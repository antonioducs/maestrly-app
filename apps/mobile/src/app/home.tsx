import { Redirect } from 'expo-router'
import { useCallback, useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFleet } from '../fleet/react'
import { botStatusLine, statusLineText } from '../fleet/selectors'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { fonts } from '../theme/tokens'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { Drawer } from '../ui/drawer/Drawer'
import { DrawerPanel } from '../ui/drawer/DrawerPanel'
import { Icon } from '../ui/icons'
import { IconButton } from '../ui/primitives/IconButton'
import { AppText } from '../ui/primitives/Text'

const selectWaitingCount = (state: FleetState) => new Set(state.inbox.map((item) => item.botId)).size

function EmptyState() {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 }}>
      <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
        <Icon name="bot" size={28} color={palette.muted} />
      </View>
      <AppText variant="title" accessibilityRole="header" style={{ textAlign: 'center' }}>
        {t('home.empty.title')}
      </AppText>
      <AppText tone="muted" style={{ textAlign: 'center' }}>
        {t('home.empty.body')}
      </AppText>
    </View>
  )
}

function HomeScreen() {
  const { palette } = useTheme()
  const text = useI18n()
  const { t } = text
  const insets = useSafeAreaInsets()
  const { currentBotId, setCurrentBotId } = useServers()
  const [open, setOpen] = useState(!currentBotId)
  const waiting = useFleet(selectWaitingCount)
  const bot = useFleet(useCallback((state: FleetState) => state.bots.find((item) => item.id === currentBotId) ?? null, [currentBotId]))
  const openBot = useCallback(
    (botId: string) => {
      setCurrentBotId(botId)
      setOpen(false)
    },
    [setCurrentBotId]
  )
  const line = bot ? botStatusLine(bot, text) : null

  return (
    <Drawer open={open} onOpenChange={setOpen} panel={<DrawerPanel open={open} currentBotId={currentBotId} onOpenBot={openBot} />}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
          <IconButton
            icon="menu"
            label={waiting ? t('home.openMenuWaiting', { count: waiting }) : t('home.openMenu')}
            onPress={() => setOpen(true)}
            badge={
              waiting ? (
                <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: palette.cue, borderWidth: 2, borderColor: palette.canvas }} />
              ) : null
            }
          />
          <View style={{ flex: 1, alignItems: 'center', minWidth: 0 }} accessible={!!bot} accessibilityRole="header">
            {bot && line ? (
              <>
                <AppText numberOfLines={1} style={{ fontFamily: fonts.display, fontSize: 17, lineHeight: 22 }}>
                  {bot.name}
                </AppText>
                <AppText
                  numberOfLines={1}
                  variant={line.tone === 'mono' ? 'mono' : 'small'}
                  tone={line.tone === 'cue' ? 'cue' : 'muted'}
                  style={line.tone === 'cue' ? { fontFamily: fonts.bodySemi } : undefined}
                >
                  {statusLineText(bot, line)}
                </AppText>
              </>
            ) : null}
          </View>
          <IconButton icon="compose" label={t('home.newChatSoon')} onPress={() => {}} disabled />
        </View>
        <ConnectionBanner />
        {bot ? <View style={{ flex: 1 }} /> : <EmptyState />}
      </View>
    </Drawer>
  )
}

export default function Home() {
  const { palette } = useTheme()
  const { servers, controller } = useServers()
  if (servers.length === 0) return <Redirect href="/welcome" />
  if (!controller) return <View style={{ flex: 1, backgroundColor: palette.canvas }} />
  return <HomeScreen />
}
