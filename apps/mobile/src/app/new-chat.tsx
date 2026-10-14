import { router } from 'expo-router'
import { useCallback } from 'react'
import { View } from 'react-native'
import { useChats } from '../chats/react'
import type { ChatsState } from '../chats/state'
import { useFleet } from '../fleet/react'
import { botStatusLine, statusLineText } from '../fleet/selectors'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { BotAvatar } from '../ui/Avatar'
import { Icon } from '../ui/icons'
import { Cell } from '../ui/primitives/Cell'
import { Group } from '../ui/primitives/Group'
import { SheetScreen } from '../ui/SheetScreen'

const selectBots = (state: FleetState) => state.bots

function BotTargets({ onPick }: { onPick: (botId: string) => void }) {
  const text = useI18n()
  const list = useFleet(selectBots)
  if (!list.length) return null
  return (
    <Group label={text.t('target.bots')} foot={text.t('target.foot')}>
      {list.map((bot) => (
        <Cell
          key={bot.id}
          label={bot.name}
          sub={statusLineText(bot, botStatusLine(bot, text))}
          leading={<BotAvatar bot={bot} size={34} />}
          chevron
          onPress={() => onPick(bot.id)}
        />
      ))}
    </Group>
  )
}

/** Where a new chat starts: with no workspace, in one of the server's workspaces, or with a bot instead. */
export default function NewChatTarget() {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const { current, setCurrent, controller } = useServers()
  const workspaces = useChats(useCallback((state: ChatsState) => state.lists?.workspaces ?? [], []))
  const chosen = current?.kind === 'new' ? current.workspaceId : undefined
  const pick = (workspaceId: string | null) => {
    setCurrent({ kind: 'new', workspaceId })
    router.back()
  }
  return (
    <SheetScreen title={t('target.title')} onDone={() => router.back()}>
      <Group>
        <Cell
          icon="message"
          label={t('target.chat')}
          sub={t('target.chatSub')}
          role="radio"
          checked={chosen === null}
          onPress={() => pick(null)}
        />
      </Group>
      {workspaces.length ? (
        <Group label={t('target.inWorkspace')}>
          {workspaces.map((workspace) => (
            <Cell
              key={workspace.id}
              label={workspace.name}
              sub={[plural('drawer.chatsCount', workspace.conversations.length), workspace.defaultBranch]
                .filter(Boolean)
                .join(' · ')}
              leading={
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    backgroundColor: palette.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="folder" size={16} color={palette.ink} />
                </View>
              }
              role="radio"
              checked={chosen === workspace.id}
              onPress={() => pick(workspace.id)}
            />
          ))}
        </Group>
      ) : null}
      {controller ? (
        <BotTargets
          onPick={(id) => {
            setCurrent({ kind: 'bot', id })
            router.back()
          }}
        />
      ) : null}
    </SheetScreen>
  )
}
