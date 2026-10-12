import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { Redirect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, type TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFleet, useFleetController } from '../fleet/react'
import { isComposerLocked } from '../fleet/selectors'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { Composer } from '../ui/composer/Composer'
import { LockedNotice } from '../ui/composer/LockedNotice'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { ConversationHeader } from '../ui/conversation/ConversationHeader'
import { ConversationContext } from '../ui/conversation/CueCard'
import { Transcript } from '../ui/conversation/Transcript'
import { Drawer } from '../ui/drawer/Drawer'
import { DrawerPanel } from '../ui/drawer/DrawerPanel'
import { Icon } from '../ui/icons'
import { AppText } from '../ui/primitives/Text'

const selectWaitingCount = (state: FleetState) => new Set(state.inbox.map((item) => item.botId)).size
const selectOnline = (state: FleetState) => state.connection === 'open'

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

function Conversation({ bot }: { bot: FleetBot }) {
  const controller = useFleetController()
  const online = useFleet(selectOnline)
  const input = useRef<TextInput>(null)
  const focusComposer = useCallback(() => input.current?.focus(), [])
  const context = useMemo(() => ({ bot, online, focusComposer }), [bot, online, focusComposer])

  useEffect(() => {
    void controller.openBot(bot.id)
    return () => controller.closeBot()
  }, [controller, bot.id])

  return (
    <ConversationContext.Provider value={context}>
      <Transcript bot={bot} />
      {isComposerLocked(bot) ? <LockedNotice bot={bot} /> : <Composer key={bot.id} bot={bot} inputRef={input} />}
    </ConversationContext.Provider>
  )
}

function HomeScreen() {
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

  return (
    <Drawer open={open} onOpenChange={setOpen} panel={<DrawerPanel open={open} currentBotId={currentBotId} onOpenBot={openBot} />}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, paddingTop: insets.top }}>
        <ConversationHeader bot={bot} waiting={waiting} onOpenMenu={() => setOpen(true)} />
        <ConnectionBanner />
        {bot ? <Conversation bot={bot} /> : <EmptyState />}
      </KeyboardAvoidingView>
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
