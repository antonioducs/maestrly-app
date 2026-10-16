import { Redirect, useLocalSearchParams } from 'expo-router'
import { useOpenLink } from '../../servers/use-open-link'

/** `maestrly://bot/<id>?server=<server>`: opens that bot's conversation, as a notification does. */
export default function BotLink() {
  const { id, server } = useLocalSearchParams<{ id: string; server?: string }>()
  const paired = useOpenLink(typeof id === 'string' ? { kind: 'bot', id } : null, server)
  return paired ? null : <Redirect href="/welcome" />
}
