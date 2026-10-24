import type { FleetBot, FleetScreenSurface } from '@maestrly/bot-fleet-protocol'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { AppState } from 'react-native'
import type { FleetController } from '../../fleet/controller'
import { ownsTakeover } from '../../fleet/selectors'
import { base64Of } from '../../screen/base64'
import { SCREEN_KEYS, textKeysyms, type ScreenKey } from '../../screen/keysyms'
import { screenOutcome, type ScreenLink, type ScreenMode, type ScreenOutcome } from '../../screen/link'
import type { ScreenPageMessage } from '../../screen/screen-page'
import type { ScreenViewHandle } from './screen-view-props'

export type ScreenPhase = 'connecting' | 'live' | 'ended'
/** Why the screen is not live: how its stream ended, or a phone that cannot decode it. */
export type ScreenIssue = Exclude<ScreenOutcome, 'retry'> | 'unsupported'

/**
 * A bot's screen on the phone: watched until this phone takes control, then controlled until it gives the screen
 * back. The mode follows the bot's takeover, so a takeover that ends elsewhere (given back from a computer, or after
 * the gateway's wait for a lost controller) turns the screen back into watching.
 */
export function useBotScreen(options: {
  controller: FleetController
  bot: FleetBot
  surface: FleetScreenSurface
  /** This phone's device id on the server. */
  deviceId: string
  page: RefObject<ScreenViewHandle | null>
  /** The label of the spot where the bot stopped. */
  stopLabel: string
  /** A tap while only watching. */
  onWatchTap: () => void
  /** Control ended without this phone giving the screen back. */
  onControlLost: () => void
}) {
  const { controller, bot, surface, deviceId, page } = options
  const owns = ownsTakeover(bot.takeover, deviceId)
  // Control that ended while the bot's takeover still reads as this phone's, until its update arrives.
  const [lost, setLost] = useState(false)
  const mode: ScreenMode = owns && !lost ? 'control' : 'view'
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<ScreenPhase>('connecting')
  const [issue, setIssue] = useState<ScreenIssue | null>(null)
  const [view, setView] = useState({ stop: false, fit: true })
  const link = useRef<ScreenLink | null>(null)
  const size = useRef<{ w: number; h: number } | null>(null)
  const retried = useRef(false)
  const giving = useRef(false)
  const callbacks = useRef(options)
  callbacks.current = options

  const send = useCallback((command: Parameters<ScreenViewHandle['send']>[0]) => page.current?.send(command), [page])

  // A new takeover of this phone may control again.
  useEffect(() => {
    if (!owns) setLost(false)
  }, [owns])

  useEffect(() => {
    const open = controller.source.openScreen
    if (!open) {
      setPhase('ended')
      setIssue('error')
      return
    }
    setPhase('connecting')
    setIssue(null)
    size.current = null
    send({ t: 'mode', mode })
    const current = open({ botId: bot.id, mode, surface }, (event) => {
      if (link.current !== current) return
      if (event.type === 'open') {
        size.current = { w: event.width, h: event.height }
        retried.current = false
        setPhase('live')
        send({ t: 'open', w: event.width, h: event.height })
      } else if (event.type === 'frame') {
        send({ t: 'frame', id: event.id, key: event.key, codec: event.codec, data: base64Of(event.data) })
      } else if (event.type === 'picture') send({ t: 'picture', uri: event.uri })
      else if (event.type === 'pointer') send({ t: 'pointer', x: event.x, y: event.y })
      else {
        link.current = null
        const outcome = screenOutcome(event.end, mode)
        if (outcome === 'retry' && !retried.current) {
          retried.current = true
          setAttempt((value) => value + 1)
          return
        }
        if ((outcome === 'released' || outcome === 'lost') && mode === 'control') {
          // Given back from here: the screen closes. Given back elsewhere: watch again.
          if (!giving.current) {
            setLost(true)
            callbacks.current.onControlLost()
          }
          return
        }
        setPhase('ended')
        setIssue(outcome === 'retry' ? 'error' : outcome)
      }
    })
    link.current = current
    return () => {
      if (link.current === current) link.current = null
      current.close()
    }
  }, [controller, bot.id, surface, mode, attempt, send])

  const reconnect = useCallback(() => {
    retried.current = false
    setAttempt((value) => value + 1)
  }, [])

  // A phone that went to the background (to read a code in another app) loses its connection: back in front, the
  // screen connects again on its own.
  const ended = useRef({ phase, issue })
  ended.current = { phase, issue }
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const { phase: now, issue: why } = ended.current
      if (state === 'active' && now === 'ended' && (why === 'error' || why === 'offline')) reconnect()
    })
    return () => subscription.remove()
  }, [reconnect])

  const onPageMessage = useCallback(
    (message: ScreenPageMessage) => {
      const current = link.current
      switch (message.t) {
        case 'ready':
          // A page that loaded again (its process ended, or the theme changed) knows nothing yet.
          send({ t: 'labels', stop: callbacks.current.stopLabel })
          send({ t: 'mode', mode })
          if (size.current) {
            send({ t: 'open', w: size.current.w, h: size.current.h })
            current?.decoderFailed()
          }
          break
        case 'decoded':
          current?.decoded(message.id)
          break
        case 'failed':
          current?.decoderFailed()
          break
        case 'fatal':
          link.current = null
          current?.close()
          setPhase('ended')
          setIssue(message.reason === 'unsupported' ? 'unsupported' : 'error')
          break
        case 'tap':
          if (!current || mode !== 'control') break
          current.pointer(message.x, message.y, 0)
          current.pointer(message.x, message.y, 1)
          current.pointer(message.x, message.y, 0)
          break
        case 'scroll':
          if (!current || mode !== 'control') break
          current.pointer(message.x, message.y, 0)
          current.wheel(message.dx, message.dy)
          break
        case 'watch':
          callbacks.current.onWatchTap()
          break
        case 'view':
          setView({ stop: message.stop, fit: message.fit })
          break
      }
    },
    [mode, send]
  )

  /** Types text where the remote screen's focus is; false when the screen is not there to take it. */
  const typeText = useCallback(
    (text: string) => {
      const current = link.current
      if (!current || mode !== 'control') return false
      for (const keysym of textKeysyms(text)) {
        current.key(keysym, true)
        current.key(keysym, false)
      }
      return true
    },
    [mode]
  )
  const pressKey = useCallback(
    (key: ScreenKey) => {
      const current = link.current
      if (!current || mode !== 'control') return
      current.key(SCREEN_KEYS[key], true)
      current.key(SCREEN_KEYS[key], false)
    },
    [mode]
  )

  return {
    mode,
    phase,
    issue,
    /** Whether the page knows where the bot stopped, and whether the whole screen is in view. */
    view,
    onPageMessage,
    reconnect,
    typeText,
    pressKey,
    focusStop: () => send({ t: 'focus' }),
    fit: () => send({ t: 'fit' }),
    /** Marks a release from here, whose closed control session is expected. */
    giving: (value: boolean) => {
      giving.current = value
    },
  }
}
