import { router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChats } from '../chats/react'
import { allConversations } from '../chats/state'
import { useOptionalFleetController } from '../fleet/react'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { type InboxUndo, type MobileInboxItem, useInbox } from '../inbox'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { fonts, mix } from '../theme/tokens'
import { Icon } from '../ui/icons'
import { formatCompactAge, formatInboxCounts, groupInboxItems } from '../ui/inbox/format'
import { InboxRow } from '../ui/inbox/InboxRow'
import { UndoToast } from '../ui/inbox/UndoToast'
import { Button } from '../ui/primitives/Button'
import { IconButton } from '../ui/primitives/IconButton'
import { AppText } from '../ui/primitives/Text'
import { useNow } from '../ui/useNow'

const TOAST_DURATION_MS = 6000
const idleFleet = { subscribe: () => () => {}, getState: () => null as FleetState | null }

function useOptionalFleetConnection() {
  const fleet = useOptionalFleetController()
  const store = fleet?.store ?? idleFleet
  return useSyncExternalStore(store.subscribe, store.getState)?.connection ?? null
}

export default function InboxScreen() {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const insets = useSafeAreaInsets()
  const inbox = useInbox()
  const { active, controller, environmentId: activeEnvironmentId } = useServers()
  const fleetConnection = useOptionalFleetConnection()
  const chatsState = useChats((state) => state.lists)
  const now = useNow(true, 60_000)

  const [serverFilter, setServerFilter] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [openSwipeKey, setOpenSwipeKey] = useState<string | null>(null)
  const [toast, setToast] = useState<{ id: number; title: string; undo: InboxUndo } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastSeqRef = useRef(0)

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // Reset server filter if the selected server disappears (e.g. unpaired while viewing).
  useEffect(() => {
    if (serverFilter && !inbox.servers.some((server) => server.id === serverFilter)) {
      setServerFilter(null)
    }
  }, [inbox.servers, serverFilter])

  const isEditing = editing && inbox.items.length > 0

  const serverById = useMemo(() => new Map(inbox.servers.map((server) => [server.id, server])), [inbox.servers])

  const branchByConversationId = useMemo(() => {
    const map = new Map<string, string>()
    for (const chat of allConversations(chatsState)) {
      if (chat.branch) map.set(chat.id, chat.branch)
    }
    return map
  }, [chatsState])

  const countByServer = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of inbox.items) {
      counts.set(item.serverId, (counts.get(item.serverId) ?? 0) + 1)
    }
    return counts
  }, [inbox.items])

  const visibleItems = useMemo(
    () => (serverFilter ? inbox.items.filter((item) => item.serverId === serverFilter) : inbox.items),
    [inbox.items, serverFilter]
  )

  const groups = useMemo(() => groupInboxItems(visibleItems), [visibleItems])

  const unreachableServers = useMemo(() => {
    return inbox.servers.filter((server) => {
      if (server.reachable) return false
      if (serverFilter && serverFilter !== server.id) return false
      return inbox.items.some((item) => item.serverId === server.id)
    })
  }, [inbox.servers, inbox.items, serverFilter])

  const latestAtByServer = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of inbox.items) {
      const prev = map.get(item.serverId)
      if (prev === undefined || item.at > prev) map.set(item.serverId, item.at)
    }
    return map
  }, [inbox.items])

  const showChips = inbox.servers.length > 1 && inbox.items.length > 0
  const anyUnread = useMemo(() => inbox.items.some((item) => item.unread), [inbox.items])

  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
  }, [])

  const handleDismiss = useCallback(
    (item: MobileInboxItem) => {
      setOpenSwipeKey(null)
      const undo = inbox.dismiss(item.key)
      clearToastTimer()
      const id = ++toastSeqRef.current
      setToast({ id, title: item.title, undo })
      toastTimerRef.current = setTimeout(() => {
        toastTimerRef.current = null
        setToast((current) => (current?.id === id ? null : current))
      }, TOAST_DURATION_MS)
    },
    [clearToastTimer, inbox]
  )

  const handleUndo = useCallback(() => {
    if (!toast) return
    clearToastTimer()
    const current = toast
    setToast(null)
    inbox.restore(current.undo)
  }, [clearToastTimer, inbox, toast])

  const handleOpenItem = useCallback(
    (item: MobileInboxItem) => {
      if (openSwipeKey !== null) {
        setOpenSwipeKey(null)
        return
      }
      void inbox.open(item)
    },
    [inbox, openSwipeKey]
  )

  const handleMarkRead = useCallback(
    (key: string) => {
      inbox.markRead([key])
    },
    [inbox]
  )

  const toggleEdit = useCallback(() => {
    setOpenSwipeKey(null)
    setEditing((prev) => !prev)
  }, [])

  const selectFilter = useCallback((id: string | null) => {
    setOpenSwipeKey(null)
    setServerFilter(id)
  }, [])

  const filteredServerName = serverFilter ? (serverById.get(serverFilter)?.name ?? '') : ''

  return (
    <View style={{ flex: 1, backgroundColor: palette.canvas, paddingTop: insets.top }}>
      {/* Header (52 pt) */}
      <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
        <View style={{ width: 64, flexDirection: 'row', alignItems: 'center' }}>
          <IconButton icon="chev-left" size={24} label={t('common.back')} onPress={() => router.back()} />
        </View>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          <AppText
            numberOfLines={1}
            accessibilityRole="header"
            style={{ fontFamily: fonts.display, fontSize: 17, lineHeight: 22 }}
          >
            {t('inbox.title')}
          </AppText>
          <AppText numberOfLines={1} variant="small" tone="muted">
            {formatInboxCounts(inbox.counts, t)}
          </AppText>
        </View>
        <View style={{ width: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
          {inbox.items.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isEditing ? t('common.done') : t('inbox.edit')}
              onPress={toggleEdit}
              style={({ pressed }) => ({
                minHeight: 44,
                paddingHorizontal: 10,
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 16, lineHeight: 23, color: palette.brass }}>
                {isEditing ? t('common.done') : t('inbox.edit')}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Server filter chips */}
      {showChips ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 }}
          accessibilityRole="radiogroup"
          accessibilityLabel={t('inbox.filter')}
        >
          {[
            { id: null as string | null, label: t('inbox.all'), count: inbox.items.length, reachable: true },
            ...inbox.servers.map((server) => ({
              id: server.id,
              label: server.name,
              count: countByServer.get(server.id) ?? 0,
              reachable: server.reachable,
            })),
          ].map((option) => {
            const selected = serverFilter === option.id
            const a11yLabel = option.reachable
              ? `${option.label}, ${option.count}`
              : `${option.label}, ${option.count}, ${t('inbox.offline')}`
            return (
              <Pressable
                key={option.id ?? '__all__'}
                accessibilityRole="radio"
                aria-checked={selected}
                accessibilityLabel={a11yLabel}
                hitSlop={4}
                onPress={() => selectFilter(option.id)}
                style={{
                  minHeight: 36,
                  paddingHorizontal: 14,
                  borderRadius: 18,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: selected ? palette.ink : palette.surface,
                }}
              >
                {!option.reachable ? (
                  <Icon name="wifi-off" size={14} color={selected ? palette.canvas : palette.brick} />
                ) : null}
                <AppText variant="bodyMedium" tone={selected ? 'inverse' : 'ink'} style={{ fontSize: 14.5 }}>
                  {option.label}
                </AppText>
                <AppText
                  variant="small"
                  tone={selected ? 'inverse' : 'muted'}
                  style={{ fontVariant: ['tabular-nums'], ...(selected ? { opacity: 0.7 } : null) }}
                >
                  {option.count}
                </AppText>
              </Pressable>
            )
          })}
        </ScrollView>
      ) : null}

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        onScrollBeginDrag={() => {
          if (openSwipeKey !== null) setOpenSwipeKey(null)
        }}
        contentContainerStyle={{
          paddingHorizontal: 8,
          paddingBottom: insets.bottom + 12 + (toast ? 60 : 0),
        }}
      >
        {unreachableServers.map((server) => {
          const isActiveServer = server.id === active?.id
          const reconnecting = isActiveServer && fleetConnection === 'connecting'
          const latestAt = latestAtByServer.get(server.id)
          return (
            <View
              key={server.id}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                marginHorizontal: 4,
                marginBottom: 6,
                paddingVertical: 8,
                paddingLeft: 12,
                paddingRight: 8,
                borderRadius: 12,
                backgroundColor: mix(palette.brick, palette.raised, 0.12),
              }}
            >
              <Icon name="wifi-off" size={18} color={palette.brick} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText style={{ fontSize: 13.5, lineHeight: 18 }}>
                  {reconnecting
                    ? t('conn.reconnecting', { server: server.name })
                    : t('conn.offline', { server: server.name })}
                </AppText>
                {!reconnecting && latestAt !== undefined ? (
                  <AppText variant="small" tone="muted">
                    {t('inbox.staleSince', { time: formatCompactAge(now - latestAt, t) })}
                  </AppText>
                ) : null}
              </View>
              {!reconnecting && isActiveServer && controller ? (
                <Button
                  label={t('conn.retryNow')}
                  onPress={() => controller.foreground()}
                  variant="secondary"
                  size="sm"
                />
              ) : null}
            </View>
          )
        })}

        {inbox.items.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 96, paddingHorizontal: 32 }}>
            <View
              aria-hidden
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: mix(palette.moss, palette.canvas, 0.14),
              }}
            >
              <Icon name="check" size={24} color={palette.moss} strokeWidth={2} />
            </View>
            <AppText variant="heading" style={{ marginTop: 14, textAlign: 'center' }}>
              {t('inbox.emptyTitle')}
            </AppText>
            <AppText
              variant="sub"
              tone="muted"
              style={{ marginTop: 6, maxWidth: 300, lineHeight: 19, textAlign: 'center' }}
            >
              {t('inbox.emptyBody')}
            </AppText>
            <Button
              size="sm"
              variant="secondary"
              icon="bell"
              label={t('inbox.settings')}
              onPress={() => router.push('/settings')}
              style={{ marginTop: 16 }}
            />
          </View>
        ) : visibleItems.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 96, paddingHorizontal: 32 }}>
            <View
              aria-hidden
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.surface,
              }}
            >
              <Icon name="server" size={24} color={palette.muted} />
            </View>
            <AppText variant="heading" style={{ marginTop: 14, textAlign: 'center' }}>
              {t('inbox.emptyFilteredTitle', { server: filteredServerName })}
            </AppText>
            <AppText
              variant="sub"
              tone="muted"
              style={{ marginTop: 6, maxWidth: 300, lineHeight: 19, textAlign: 'center' }}
            >
              {plural('inbox.emptyFilteredBody', inbox.items.length)}
            </AppText>
            <Button
              size="sm"
              variant="secondary"
              label={t('inbox.showAll')}
              onPress={() => selectFilter(null)}
              style={{ marginTop: 16 }}
            />
          </View>
        ) : (
          groups.map((section, sectionIndex) => (
            <View key={section.group}>
              <View
                accessibilityRole="header"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 10,
                  paddingTop: sectionIndex === 0 ? 6 : 14,
                  paddingBottom: 4,
                }}
              >
                <AppText variant="label" tone={section.group === 'waiting' ? 'cue' : 'muted'}>
                  {t(`inbox.group.${section.group}`)}
                </AppText>
                <View
                  style={{
                    minWidth: 20,
                    height: 20,
                    paddingHorizontal: 6,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: section.group === 'waiting' ? palette.cue : palette.surface,
                  }}
                >
                  <AppText
                    style={{
                      fontSize: 11.5,
                      lineHeight: 14,
                      fontWeight: '700',
                      fontVariant: ['tabular-nums'],
                      color: section.group === 'waiting' ? '#1f201e' : palette.muted,
                    }}
                  >
                    {section.items.length}
                  </AppText>
                </View>
                {section.group === 'waiting' ? (
                  <AppText variant="small" tone="faint" style={{ marginLeft: 'auto' }}>
                    {t('inbox.caption.waiting')}
                  </AppText>
                ) : null}
              </View>
              {section.items.map((item) => {
                const branch =
                  item.source === 'workspace' &&
                  item.serverId === active?.id &&
                  item.environmentId === activeEnvironmentId &&
                  item.target.kind === 'conversation'
                    ? (branchByConversationId.get(item.target.conversationId) ?? null)
                    : null
                const environmentCount = serverById.get(item.serverId)?.environments ?? 1
                return (
                  <InboxRow
                    key={item.key}
                    item={item}
                    now={now}
                    branch={branch}
                    serverCount={inbox.servers.length}
                    environmentCount={environmentCount}
                    filtered={serverFilter !== null}
                    editing={isEditing}
                    swipeOpen={openSwipeKey === item.key}
                    onSwipeOpenChange={(nextOpen) => setOpenSwipeKey(nextOpen ? item.key : null)}
                    onPress={handleOpenItem}
                    onDismiss={handleDismiss}
                    onMarkRead={handleMarkRead}
                  />
                )
              })}
            </View>
          ))
        )}
      </ScrollView>

      {/* Edit-mode bottom bar */}
      {isEditing ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: palette.line,
            paddingTop: 4,
            paddingHorizontal: 8,
            paddingBottom: insets.bottom + 4,
            backgroundColor: palette.canvas,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('inbox.markAllRead')}
            aria-disabled={!anyUnread}
            disabled={!anyUnread}
            onPress={() => inbox.markAllRead()}
            style={({ pressed }) => ({
              minHeight: 44,
              paddingHorizontal: 10,
              justifyContent: 'center',
              opacity: !anyUnread ? 0.35 : pressed ? 0.7 : 1,
            })}
          >
            <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 16, lineHeight: 23, color: palette.brass }}>
              {t('inbox.markAllRead')}
            </AppText>
          </Pressable>
        </View>
      ) : null}

      <UndoToast toast={toast} onUndo={handleUndo} bottomOffset={isEditing ? 52 : 0} />
    </View>
  )
}
