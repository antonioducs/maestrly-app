import { Redirect, useLocalSearchParams } from 'expo-router'
import { useServers } from '../../servers/ServersProvider'
import { LaneView } from '../../ui/lanes/LaneView'

/** `/lane/<bot>?kind=run|thread&lane=<id>`: one of a bot's routine runs, or one of its conversations with a bot. */
export default function LaneScreen() {
  const { id, kind, lane } = useLocalSearchParams<{ id: string; kind: string; lane: string }>()
  const { controller } = useServers()
  if (!controller || typeof id !== 'string' || typeof lane !== 'string' || (kind !== 'run' && kind !== 'thread'))
    return <Redirect href="/home" />
  return <LaneView key={`${id}:${lane}`} botId={id} lane={{ kind, id: lane }} />
}
