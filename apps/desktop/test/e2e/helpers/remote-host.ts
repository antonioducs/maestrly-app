import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, expect } from '@playwright/test'

export const desktop = fileURLToPath(new URL('../../..', import.meta.url))

export const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
export const portOf = (server: Server) => (server.address() as AddressInfo).port

export async function freePort(): Promise<number> {
  const probe = createServer()
  await listen(probe)
  const port = portOf(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** An OpenAI-compatible model that answers every turn with one fixed sentence, and records what it was asked. */
export function fixtureModel() {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'remote-fixture', object: 'model' }] }))
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    let body = ''
    for await (const part of req) body += part
    requests.push(JSON.parse(body))
    res.setHeader('content-type', 'text/event-stream')
    const chunk = (content: string, finish: string | null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'remote-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'remote-fixture',
          choices: [{ index: 0, delta: { content }, finish_reason: finish }],
        })}\n\n`
      )
    chunk(`Answered on the host, turn ${requests.length}.`, null)
    chunk('', 'stop')
    res.end('data: [DONE]\n\n')
  })
  return { server, requests }
}

/** The environment of an instance of the built app with a profile of its own and no mode or account of the machine. */
export const instanceEnv = (profile: string, instance: string, locale = 'en') => ({
  ...process.env,
  AGENTS_E2E: '1',
  AGENTS_CHANNEL: 'dev',
  AGENTS_INSTANCE: instance,
  AGENTS_USERDATA: profile,
  AGENTS_LOCALE: locale,
  ELECTRON_RENDERER_URL: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  MAESTRLY_BOT_MODE: '',
  MAESTRLY_SERVER_MODE: '',
  MAESTRLY_DEV_DIRECT_HOST: '',
})

export interface LaunchedHost {
  app: ElectronApplication
  /** The control token a gateway holds for this host; a computer never learns it. */
  token: string
  port: number
}

/**
 * Starts the built app in server mode, as the container of a workspaces environment runs it: no window to look at, the
 * control server a gateway talks to, and the bridge computers drive it through.
 */
export async function launchHost(
  profile: string,
  workspacesRoot: string,
  extraEnv: Record<string, string> = {}
): Promise<LaunchedHost> {
  const token = randomBytes(32).toString('base64url')
  const port = await freePort()
  const app = await electron.launch({
    args: [path.join(desktop, 'out/main/index.js')],
    env: {
      ...instanceEnv(profile, 'remote-host-e2e'),
      MAESTRLY_SERVER_MODE: '1',
      MAESTRLY_ENVIRONMENT_ID: 'workspaces',
      MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
      MAESTRLY_BOT_CONTROL_PORT: String(port),
      MAESTRLY_BOT_CONTROL_TOKEN: token,
      MAESTRLY_WORKSPACES_ROOT: workspacesRoot,
      ...extraEnv,
    },
  })
  // The host answers its health check once its control server listens.
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
            headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${token}` },
          })
          return response.ok ? ((await response.json()) as { ready?: boolean; busy?: boolean }) : null
        } catch {
          return null
        }
      },
      { timeout: 60_000 }
    )
    .toMatchObject({ ready: true, busy: false, capabilities: expect.arrayContaining(['workspaces-host']) })
  return { app, token, port }
}
