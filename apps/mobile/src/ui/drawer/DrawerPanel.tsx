import { router } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFleet } from '../../fleet/react'
import { botsByEnvironment, waitingItems } from '../../fleet/selectors'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { BotList } from './BotList'
import { ServerRow } from './ServerRow'
import { TabBar } from './TabBar'
import { WaitingStrip } from './WaitingStrip'

const selectWaiting = (state: FleetState) => waitingItems(state)
const selectOnline = (state: FleetState) => state.connection === 'open'
const selectState = (state: FleetState) => state

/** The menu: search, the server, what waits on you, and the bots by environment. */
export function DrawerPanel({
  open,
  currentBotId,
  onOpenBot,
}: {
  open: boolean
  currentBotId: string | null
  onOpenBot: (botId: string) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const { active } = useServers()
  const [query, setQuery] = useState('')
  const waiting = useFleet(selectWaiting)
  const online = useFleet(selectOnline)
  const state = useFleet(selectState)
  const groups = botsByEnvironment(state, query, t('drawer.bots'))
  const scroll = useRef<ScrollView>(null)
  const groupY = useRef(new Map<string, number>())
  const botY = useRef(new Map<string, { groupId: string; y: number }>())
  // The drawer well sits on the drawer itself: in light mode the surface color is nearly the drawer's.
  const well = mix(palette.ink, palette.drawer, 0.07)

  useEffect(() => {
    if (!open || !currentBotId) return
    const row = botY.current.get(currentBotId)
    if (!row) return
    const y = (groupY.current.get(row.groupId) ?? 0) + row.y
    scroll.current?.scrollTo({ y: Math.max(0, y - 60), animated: false })
  }, [open, currentBotId])

  const onGroupLayout = useCallback((id: string, y: number) => groupY.current.set(id, y), [])
  const onBotLayout = useCallback((id: string, groupId: string, y: number) => botY.current.set(id, { groupId, y }), [])

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <View style={{ paddingTop: 6, paddingBottom: 4, paddingLeft: 14, paddingRight: 14 }}>
        <View
          style={{
            height: 40,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: well,
          }}
        >
          <Icon name="search" size={18} color={palette.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('drawer.search')}
            placeholderTextColor={palette.faint}
            accessibilityLabel={t('drawer.search')}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={{ flex: 1, minWidth: 0, height: 40, color: palette.ink, fontFamily: fonts.body, fontSize: 16 }}
          />
        </View>
      </View>
      {active ? <ServerRow name={active.name} online={online} onPress={() => router.push('/servers')} /> : null}
      {query.trim() ? null : <WaitingStrip items={waiting} onOpen={onOpenBot} />}
      <TabBar tabs={[{ id: 'bots', label: t('drawer.bots') }]} value="bots" onChange={() => {}} />
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}>
        {groups.length > 0 ? (
          <BotList
            groups={groups}
            currentBotId={currentBotId}
            onOpen={onOpenBot}
            onGroupLayout={onGroupLayout}
            onBotLayout={onBotLayout}
          />
        ) : (
          <AppText variant="sub" tone="muted" style={{ paddingHorizontal: 10, paddingVertical: 14, fontSize: 13.5 }}>
            {query.trim() ? t('drawer.noMatch', { query: query.trim() }) : state.loaded ? t('drawer.noBots') : t('common.loading')}
          </AppText>
        )}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('drawer.settings')}
        onPress={() => router.push('/settings')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          marginHorizontal: 8,
          paddingTop: 12,
          paddingHorizontal: 10,
          paddingBottom: insets.bottom + 10,
          borderTopWidth: 1,
          borderTopColor: palette.line,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name="settings" size={20} color={palette.ink} />
        <AppText variant="bodyMedium">{t('drawer.settings')}</AppText>
      </Pressable>
    </View>
  )
}
