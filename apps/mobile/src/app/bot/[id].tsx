import { Redirect, router, useLocalSearchParams } from 'expo-router'
import { useEffect } from 'react'
import { useServers } from '../../servers/ServersProvider'

/** `maestrly://bot/<id>`: opens that bot's conversation; notifications will link here. */
export default function BotLink() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { servers, controller, setCurrentBotId } = useServers()
  useEffect(() => {
    if (!controller) return
    setCurrentBotId(typeof id === 'string' ? id : null)
    router.replace('/home')
  }, [controller, id, setCurrentBotId])
  return servers.length === 0 ? <Redirect href="/welcome" /> : null
}
