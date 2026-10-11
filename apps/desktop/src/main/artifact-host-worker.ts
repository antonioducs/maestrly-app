/**
 * Utility process entry for the artifact host: storage, admin RPC and the public loopback HTTP server. It receives
 * only its configuration from the main process and holds no app credentials.
 */
import {
  type ArtifactHost,
  type ArtifactHostConfig,
  ArtifactHostError,
  openArtifactHost,
  serveAdmin,
} from '@maestrly/artifact-host'

const parentPort = process.parentPort
let host: ArtifactHost | null = null

const channel = {
  post: (message: unknown) => parentPort.postMessage(message),
  onMessage: (listener: (message: unknown) => void) => {
    const handler = (event: { data: unknown }) => listener(event.data)
    parentPort.on('message', handler)
    return () => {
      parentPort.off('message', handler)
    }
  },
}

parentPort.on('message', async (event) => {
  const message = event.data as { type?: string; config?: ArtifactHostConfig }
  if (message?.type === 'init' && message.config && !host) {
    try {
      host = await openArtifactHost(message.config, {
        onEvent: (hostEvent) => parentPort.postMessage({ type: 'event', event: hostEvent }),
      })
      serveAdmin(channel, host.admin)
      parentPort.postMessage({ type: 'ready', port: host.port })
    } catch (error) {
      const code = error instanceof ArtifactHostError && error.code === 'port_in_use' ? 'port_in_use' : 'storage'
      console.error('[artifact-host] start failed:', error instanceof Error ? error.message : error)
      parentPort.postMessage({ type: 'init-error', code })
    }
  } else if (message?.type === 'shutdown') {
    await host?.close().catch(() => {})
    process.exit(0)
  }
})
