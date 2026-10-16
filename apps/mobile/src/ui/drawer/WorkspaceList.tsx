import { useState } from 'react'
import { Pressable, View } from 'react-native'
import type { WorkspaceGroup } from '../../chats/selectors'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'
import { ChatList, ChatRow } from './ChatList'

/** How many of a workspace's chats its group shows before "Show all". */
const PREVIEW = 3

function WorkspaceHeader({
  group,
  open,
  onToggle,
  onNew,
}: {
  group: WorkspaceGroup
  open: boolean
  onToggle: () => void
  onNew: () => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const { workspace } = group
  const count = plural('drawer.chatsCount', workspace.conversations.length)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 6 }}>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={[workspace.name, workspace.defaultBranch, count].filter(Boolean).join(', ')}
        onPress={onToggle}
        style={({ pressed }) => ({
          flex: 1,
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 10,
          borderRadius: 12,
          backgroundColor: pressed ? palette.surface : 'transparent',
        })}
      >
        <Icon name="folder" size={18} color={palette.ink} />
        <AppText numberOfLines={1} variant="bodyMedium" style={{ flexShrink: 1 }}>
          {workspace.name}
        </AppText>
        {workspace.defaultBranch ? (
          <AppText numberOfLines={1} variant="mono" tone="faint" style={{ flexShrink: 1, fontSize: 12 }}>
            {workspace.defaultBranch}
          </AppText>
        ) : null}
        <View style={{ flex: 1 }} />
        <View style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }}>
          <Icon name="chev-down" size={16} color={palette.muted} />
        </View>
      </Pressable>
      <IconButton icon="plus" label={t('drawer.newChatIn', { name: workspace.name })} onPress={onNew} />
    </View>
  )
}

/** Workspaces with their latest chats; "Show all" opens a workspace's every chat by date. */
export function WorkspaceList({
  groups,
  searching,
  currentId,
  onOpen,
  onNew,
  onShowAll,
}: {
  groups: WorkspaceGroup[]
  searching: boolean
  currentId: string | null
  onOpen: (id: string) => void
  onNew: (workspaceId: string) => void
  onShowAll: (workspaceId: string) => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  return (
    <View>
      {groups.map((group) => {
        const { workspace, chats } = group
        const open = searching || !collapsed[workspace.id]
        // The latest few, and the open chat when it is older; "Show all" has the rest.
        let shown = searching ? chats : chats.slice(0, PREVIEW)
        const current = chats.find((chat) => chat.id === currentId)
        if (current && !shown.includes(current)) shown = [...shown, current]
        const more = chats.length - shown.length
        return (
          <View key={workspace.id}>
            <WorkspaceHeader
              group={group}
              open={open}
              onToggle={() => setCollapsed((value) => ({ ...value, [workspace.id]: open }))}
              onNew={() => onNew(workspace.id)}
            />
            {open ? (
              <View style={{ paddingLeft: 18 }}>
                {chats.length === 0 ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                    }}
                  >
                    <AppText variant="sub" tone="muted">
                      {t('drawer.noWorkspaceChats')}
                    </AppText>
                    <Pressable accessibilityRole="button" onPress={() => onNew(workspace.id)} hitSlop={10}>
                      <AppText variant="sub" style={{ color: palette.cueInk, fontWeight: '600' }}>
                        {t('drawer.startOne')}
                      </AppText>
                    </Pressable>
                  </View>
                ) : null}
                {shown.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} current={chat.id === currentId} onPress={() => onOpen(chat.id)} />
                ))}
                {more > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onShowAll(workspace.id)}
                    style={({ pressed }) => ({
                      minHeight: 44,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      paddingHorizontal: 10,
                      borderRadius: 12,
                      backgroundColor: pressed ? palette.surface : 'transparent',
                    })}
                  >
                    <AppText variant="sub" tone="muted" style={{ fontWeight: '600' }}>
                      {plural('drawer.showAll', workspace.conversations.length)}
                    </AppText>
                    <Icon name="chev-right" size={14} color={palette.muted} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

/** Every chat of one workspace, by date, on its own page inside the menu. */
export function WorkspacePage({
  group,
  query,
  currentId,
  now,
  onBack,
  onOpen,
  onNew,
}: {
  group: WorkspaceGroup
  query: string
  currentId: string | null
  now: number
  onBack: () => void
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const { workspace, chats } = group
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        hitSlop={6}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, paddingHorizontal: 6 }}
      >
        <Icon name="chev-left" size={18} color={palette.ink} />
        <AppText variant="bodyMedium">{t('drawer.workspaces')}</AppText>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 6 }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            backgroundColor: palette.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="folder" size={18} color={palette.ink} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText numberOfLines={1} variant="bodyMedium" accessibilityRole="header">
            {workspace.name}
          </AppText>
          <AppText numberOfLines={1} variant="small" tone="muted">
            {[workspace.defaultBranch, plural('drawer.chatsCount', workspace.conversations.length)]
              .filter(Boolean)
              .join(' · ')}
          </AppText>
        </View>
        <IconButton icon="plus" label={t('drawer.newChatIn', { name: workspace.name })} onPress={onNew} />
      </View>
      {chats.length ? (
        <ChatList chats={chats} currentId={currentId} now={now} onOpen={onOpen} />
      ) : (
        <AppText variant="sub" tone="muted" style={{ paddingHorizontal: 10, paddingVertical: 14 }}>
          {query.trim()
            ? t('drawer.noMatchIn', { tab: workspace.name, query: query.trim() })
            : t('drawer.noWorkspaceChats')}
        </AppText>
      )}
    </View>
  )
}
