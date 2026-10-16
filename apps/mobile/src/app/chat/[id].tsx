import { Redirect, useLocalSearchParams } from 'expo-router'
import { useOpenLink } from '../../servers/use-open-link'

/** `maestrly://chat/<id>?server=<server>&env=<environment>`: opens that chat, as a notification does. */
export default function ChatLink() {
  const { id, server, env } = useLocalSearchParams<{ id: string; server?: string; env?: string }>()
  const paired = useOpenLink(
    typeof id === 'string' ? { kind: 'chat', id } : null,
    server,
    typeof env === 'string' ? env : undefined
  )
  return paired ? null : <Redirect href="/welcome" />
}
