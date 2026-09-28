import { useEffect } from 'react'
import { BotInstanceApp } from './BotInstanceApp'
import { DesktopApp } from './DesktopApp'

export function App() {
  useEffect(() => {
    const root = document.documentElement
    const os = window.api.platformInfo.os
    root.classList.toggle('is-windows', os === 'win')
    root.classList.toggle('is-linux', os === 'linux')
    root.classList.toggle('is-mac', os === 'mac')
  }, [])
  // A bot's own Maestrly only offers its settings; the full desktop never runs inside a bot.
  return window.api.platformInfo.botMode ? <BotInstanceApp /> : <DesktopApp />
}
