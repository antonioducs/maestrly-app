import { useState } from 'react'
import { Pressable, View } from 'react-native'
import type { MobileConversation } from '@maestrly/bot-fleet-protocol'
import { isWaitingChat, workspaceNodes, type WorkspaceGroup } from '../../chats/selectors'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'
import { ChatRow } from './ChatList'

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

/** Chats that share a branch, in a folder named after it that opens and closes. */
function BranchFolder({
  branch,
  chats,
  open,
  currentId,
  onToggle,
  onOpen,
}: {
  branch: string
  chats: MobileConversation[]
  open: boolean
  currentId: string | null
  onToggle: () => void
  onOpen: (id: string) => void
}) {
  const { palette } = useTheme()
  const { plural } = useI18n()
  const working = chats.some((chat) => chat.status === 'working')
  const waiting = chats.some(isWaitingChat)
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={`${branch}, ${plural('drawer.chatsCount', chats.length)}`}
        onPress={onToggle}
        style={({ pressed }) => ({
          minHeight: 40,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          paddingHorizontal: 10,
          borderRadius: 12,
          backgroundColor: pressed ? palette.surface : 'transparent',
        })}
      >
        <View style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }}>
          <Icon name="chev-down" size={13} color={palette.muted} />
        </View>
        <Icon name="branch" size={15} color={palette.brass} />
        <AppText numberOfLines={1} variant="mono" style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
          {branch}
        </AppText>
        {!open && waiting ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.cue }} />
        ) : null}
        {!open && working && !waiting ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.muted }} />
        ) : null}
        <AppText variant="small" tone="faint">
          {chats.length}
        </AppText>
      </Pressable>
      {open ? (
        <View style={{ marginLeft: 16, paddingLeft: 6, borderLeftWidth: 1, borderLeftColor: palette.line }}>
          {chats.map((chat) => (
            <ChatRow key={chat.id} chat={chat} current={chat.id === currentId} onPress={() => onOpen(chat.id)} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

/**
 * Every workspace with all of its chats, as the desktop sidebar shows them: chats that share a branch sit in a folder
 * named after the branch.
 */
export function WorkspaceList({
  groups,
  searching,
  currentId,
  onOpen,
  onNew,
}: {
  groups: WorkspaceGroup[]
  searching: boolean
  currentId: string | null
  onOpen: (id: string) => void
  onNew: (workspaceId: string) => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggle = (key: string, open: boolean) => setCollapsed((value) => ({ ...value, [key]: open }))
  return (
    <View>
      {groups.map((group) => {
        const { workspace, chats } = group
        const open = searching || !collapsed[workspace.id]
        return (
          <View key={workspace.id}>
            <WorkspaceHeader
              group={group}
              open={open}
              onToggle={() => toggle(workspace.id, open)}
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
                {workspaceNodes(chats).map((node) => {
                  if (node.kind === 'chat')
                    return (
                      <ChatRow
                        key={node.chat.id}
                        chat={node.chat}
                        current={node.chat.id === currentId}
                        onPress={() => onOpen(node.chat.id)}
                      />
                    )
                  const key = `${workspace.id}:branch:${node.branch}`
                  const folderOpen = searching || !collapsed[key]
                  return (
                    <BranchFolder
                      key={key}
                      branch={node.branch}
                      chats={node.chats}
                      open={folderOpen}
                      currentId={currentId}
                      onToggle={() => toggle(key, folderOpen)}
                      onOpen={onOpen}
                    />
                  )
                })}
              </View>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}
