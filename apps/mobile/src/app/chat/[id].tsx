import { Redirect, useLocalSearchParams } from 'expo-router'
import { useOpenLink } from '../../servers/use-open-link'

/** `maestrly://chat/<id>?server=<server>`: opens that chat, as a notification does. */
export default function ChatLink() {
  const { id, server } = useLocalSearchParams<{ id: string; server?: string }>()
  const paired = useOpenLink(typeof id === 'string' ? { kind: 'chat', id } : null, server)
  return paired ? null : <Redirect href="/welcome" />
}
