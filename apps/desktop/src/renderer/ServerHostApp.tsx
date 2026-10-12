import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../preload'

/**
 * The window of a Maestrly that hosts workspaces on a server. Nobody looks at it: chats and workspaces of this host
 * are used from Maestrly on the owner's computers, over the bridge. The window only exists to parent the native views
 * of the agent's browser, so it shows what the app is rather than a desktop that could start work outside the bridge.
 */
export function ServerHostApp() {
  const { t } = useTranslation('ui')
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.getAppInfo().then(setInfo)
  }, [])
  return (
    <main className="flex h-full flex-col items-center justify-center gap-2 bg-background p-8 text-center text-foreground">
      <h1 className="text-lg font-medium">{t('serverHost.title')}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{t('serverHost.description')}</p>
      {info ? <p className="text-xs text-muted-foreground">{t('about.version', { version: info.version })}</p> : null}
    </main>
  )
}
