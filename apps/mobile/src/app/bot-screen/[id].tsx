import type { FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef } from 'react'
import { useFleet } from '../../fleet/react'
import { botScreenSurface } from '../../fleet/selectors'
import type { FleetState } from '../../fleet/state'
import { useServers } from '../../servers/ServersProvider'
import { BotScreen } from '../../ui/screen/BotScreen'

/** A bot's screen, over the whole app; `give=1` opens it on the sheet that gives the screen back. */
export default function BotScreenRoute() {
  const { id, give } = useLocalSearchParams<{ id: string; give?: string }>()
  const { controller, active } = useServers()
  if (!controller || !active) return null
  return <BotScreenFor id={String(id)} deviceId={active.id} give={give === '1'} />
}

function BotScreenFor({ id, deviceId, give }: { id: string; deviceId: string; give: boolean }) {
  const bot = useFleet(useCallback((state: FleetState) => state.bots.find((item) => item.id === id) ?? null, [id]))
  const surface = useFleet(useCallback((state: FleetState) => (bot ? botScreenSurface(state, bot) : null), [bot]))
  // A bot that stops while its screen shows keeps it open, to say so; one that never had a screen here has none.
  const last = useRef<FleetScreenSurface | null>(null)
  if (surface) last.current = surface
  const shown = surface ?? last.current
  const close = useCallback(() => (router.canGoBack() ? router.back() : router.replace('/home')), [])
  useEffect(() => {
    if (!bot || !shown) close()
  }, [bot, shown, close])
  if (!bot || !shown) return null
  return <BotScreen bot={bot} surface={shown} deviceId={deviceId} giveOnOpen={give} onClose={close} />
}
