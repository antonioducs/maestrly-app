import { Redirect } from 'expo-router'
import { useServers } from '../servers/ServersProvider'

/** The app opens on the pairing flow until a server is paired, then on the bots. */
export default function Index() {
  const { servers } = useServers()
  return <Redirect href={servers.length ? '/home' : '/welcome'} />
}
