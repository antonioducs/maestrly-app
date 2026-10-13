import * as WebBrowser from 'expo-web-browser'
import { useCallback } from 'react'
import { DEMO_SERVER } from '../demo/demo-source'
import { useServers } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { ArtifactOpenError, artifactLink, type ArtifactPublication } from './artifacts'

/** Opens an artifact of the active server in the in-app browser, as its owner; rejects with an `ArtifactOpenError`. */
export function useOpenArtifact() {
  const { active, clientFor } = useServers()
  const { palette } = useTheme()
  return useCallback(
    async (artifact: ArtifactPublication) => {
      if (!active) throw new ArtifactOpenError('offline')
      if (active.id === DEMO_SERVER.id) throw new ArtifactOpenError('demo')
      const client = await clientFor(active)
      if (!client) throw new ArtifactOpenError('offline')
      const url = await artifactLink(client, active, artifact, __DEV__)
      // The system's browser view: the page's scripts never run inside the app, and its session stays out of it.
      await WebBrowser.openBrowserAsync(url, {
        controlsColor: palette.ink,
        toolbarColor: palette.canvas,
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        dismissButtonStyle: 'done',
        showTitle: true,
      })
    },
    [active, clientFor, palette]
  )
}
