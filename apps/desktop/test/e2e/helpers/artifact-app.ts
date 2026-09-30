import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, expect, type Page } from '@playwright/test'
import { removeTempDirEventually } from './temp-cleanup'

const desktop = fileURLToPath(new URL('../../..', import.meta.url))

/** What one request to the scripted model carried. */
export interface ModelRequest {
  lastUser: string
  tools: string[]
  /** Results of the tool calls made so far in this turn, by call ID. */
  toolResults: Record<string, string>
}

/** The scripted model's answer to one request: a tool call, or the text that ends the turn. */
export type ModelReply = { call: { id: string; name: string; args: unknown } } | { text: string }

export interface ArtifactApp {
  app: ElectronApplication
  page: Page
  /** The loopback port of the artifact host. */
  port: number
  conversationId: string
  requests: ModelRequest[]
  api(name: string, ...args: unknown[]): Promise<any>
  /** Calls `window.api.artifacts[name]`, as the owner's interface does. */
  artifacts(name: string, ...args: unknown[]): Promise<any>
  /** Sends a message in the project conversation and waits for the model's closing text. */
  send(message: string, reply: string): Promise<void>
  /** The JSON result of a tool call the model made. */
  toolResult(callId: string): any
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Launches the built app on an isolated profile with a project conversation whose model is scripted by `respond`,
 * with Maestrly tools on and the artifact host on a free port. Agents then publish through the real tool path.
 */
export async function launchArtifactApp(options: {
  name: string
  locale?: string
  respond: (request: ModelRequest) => ModelReply
}): Promise<ArtifactApp> {
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), `maestrly-${options.name}-`))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])

  const requests: ModelRequest[] = []
  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'artifact-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'artifact-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const text = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
        : ''

  const model: Server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'artifact-model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as {
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      tools?: Array<{ function: { name: string } }>
    }
    const lastUserIndex = input.messages.map((message) => message.role).lastIndexOf('user')
    const request: ModelRequest = {
      lastUser: text(input.messages[lastUserIndex]?.content),
      tools: (input.tools ?? []).map((tool) => tool.function.name),
      // Only this turn's results, so a script can reuse call IDs across turns.
      toolResults: Object.fromEntries(
        input.messages
          .slice(lastUserIndex + 1)
          .filter((message) => message.role === 'tool' && message.tool_call_id)
          .map((message) => [message.tool_call_id!, text(message.content)])
      ),
    }
    requests.push(request)
    res.setHeader('content-type', 'text/event-stream')
    const reply = options.respond(request)
    if ('call' in reply) {
      chunk(res, {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: reply.call.id,
            type: 'function',
            function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) },
          },
        ],
      })
      chunk(res, {}, 'tool_calls')
    } else {
      chunk(res, { role: 'assistant', content: reply.text })
      chunk(res, {}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))

  let app: ElectronApplication | undefined
  const close = async () => {
    await app?.close().catch(() => {})
    await new Promise((resolve) => model.close(resolve))
    await removeTempDirEventually(root)
  }

  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `${options.name}-${Date.now().toString(36)}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: options.locale ?? 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
    const artifacts = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api.artifacts[name](...args), { name, args }) as Promise<any>
    await api('setOnboardingDone', true)

    // A free port keeps parallel runs and a developer's own Maestrly from colliding on 4010.
    const port = await freePort()
    await artifacts('setSettings', {
      ...(await artifacts('getSettings')),
      hostEnabled: true,
      port,
      ownerName: 'Antonio',
    })

    const provider = await api('chatAddProvider', {
      name: 'Artifact fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'artifact-model' })
    const workspace = await api('addWorkspace', repository)
    const conversation = await api('createConversation', {
      workspaceId: workspace.id,
      branch: 'feat/artifacts',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Artifacts',
    })
    await api('chatSetSelection', conversation.id, { providerId: provider.id, modelId: 'artifact-model' })
    expect((await api('chatSetPermMode', conversation.id, 'full')).ok).toBe(true)
    // Artifact tools are Maestrly app tools, which are off until the conversation enables them.
    expect((await api('chatSetConvTools', conversation.id, { app: true })).ok).toBe(true)
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.locator('li.conv-item', { hasText: 'Artifacts' }).first().click()

    return {
      app,
      page,
      port,
      conversationId: conversation.id,
      requests,
      api,
      artifacts,
      close,
      async send(message, reply) {
        expect((await api('chatSend', conversation.id, message)).ok).toBe(true)
        await expect(page.getByText(reply).last()).toBeVisible({ timeout: 60_000 })
      },
      toolResult(callId) {
        const request = [...requests].reverse().find((candidate) => callId in candidate.toolResults)
        if (!request) throw new Error(`The model never received the result of ${callId}`)
        return JSON.parse(request.toolResults[callId]!)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
