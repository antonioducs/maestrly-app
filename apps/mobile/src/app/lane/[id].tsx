import { Redirect, useLocalSearchParams } from 'expo-router'
import { useEffect } from 'react'
import { useServers } from '../../servers/ServersProvider'
import { LaneView } from '../../ui/lanes/LaneView'

/**
 * `/lane/<bot>?kind=run|thread&lane=<id>[&server=<server>]`: one of a bot's routine runs, or one of its conversations
 * with a bot. When `server` is provided, activates that server first so inbox links can jump across servers.
 */
export default function LaneScreen() {
  const { id, kind, lane, server } = useLocalSearchParams<{
    id: string
    kind: string
    lane: string
    server?: string
  }>()
  const { servers, active, controller, activate } = useServers()
  const known = typeof server === 'string' && servers.some((item) => item.id === server)
  useEffect(() => {
    if (known && server && active?.id !== server) void activate(server)
  }, [known, server, active?.id, activate])
  if (typeof id !== 'string' || typeof lane !== 'string' || (kind !== 'run' && kind !== 'thread'))
    return <Redirect href="/home" />
  if (known && server && controller?.source.serverId !== server) return null
  if (!controller) return <Redirect href="/home" />
  return <LaneView key={`${controller.source.serverId}:${id}:${lane}`} botId={id} lane={{ kind, id: lane }} />
}
