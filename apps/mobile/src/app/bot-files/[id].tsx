import { useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { useFleet } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useServers } from '../../servers/ServersProvider'
import { BotFilesScreen } from '../../ui/files/BotFilesScreen'

/** A bot's Files sheet; `from=conversation` opens it on the conversation's files, largest first. */
export default function BotFilesRoute() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>()
  const { controller } = useServers()
  if (!controller) return null
  return <BotFilesFor id={String(id)} from={from === 'conversation' ? 'conversation' : undefined} />
}

function BotFilesFor({ id, from }: { id: string; from?: 'conversation' }) {
  const bot = useFleet(useCallback((state: FleetState) => state.bots.find((item) => item.id === id) ?? null, [id]))
  return bot ? <BotFilesScreen bot={bot} from={from} /> : null
}
