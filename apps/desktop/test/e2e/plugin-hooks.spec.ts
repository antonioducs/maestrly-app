import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { type FixtureFiles, makeGitRepo } from '../helpers/plugin-fixtures'
import { desktop, instanceEnv, listen, portOf } from './helpers/remote-host'

/** One synthetic hook script for every event, answering with Claude Code's contract. */
const GUARD = `let raw = ''
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', () => {
  const input = JSON.parse(raw)
  const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
  switch (input.hook_event_name) {
    case 'SessionStart':
      return out('GUARD-SESSION:' + input.source)
    case 'UserPromptSubmit':
      return out(input.prompt.includes('forbidden') ? { decision: 'block', reason: 'GUARD-BLOCKED' } : 'GUARD-PROMPT')
    case 'PreToolUse':
      if (String(input.tool_input.command).includes('rm -rf'))
        return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'GUARD-DENIED' } })
      return
    case 'PostToolUse':
      return out({ systemMessage: 'GUARD-NOTICE', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'GUARD-POST' } })
    case 'Stop':
      return input.stop_hook_active ? undefined : out({ decision: 'block', reason: 'GUARD-STOP' })
  }
})
`

const hookEntry = (matcher?: string) => [
  {
    ...(matcher ? { matcher } : {}),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder, which Maestrly expands
    hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"' }],
  },
]

/** A synthetic Claude Code marketplace written for this test, with one plugin that has hooks on every event. */
const marketplace = (): FixtureFiles => ({
  '.claude-plugin/marketplace.json': JSON.stringify({
    name: 'hooks-market',
    owner: { name: 'Fixture' },
    plugins: [{ name: 'guard', source: './plugins/guard', description: 'Guards the chat.' }],
  }),
  'plugins/guard/.claude-plugin/plugin.json': JSON.stringify({
    name: 'guard',
    version: '1.0.0',
    description: 'Guards the chat.',
    license: 'MIT',
  }),
  'plugins/guard/LICENSE': 'MIT License (synthetic test fixture)\n',
  'plugins/guard/skills/check/SKILL.md': '---\ndescription: Check the work\n---\nCheck the work.\n',
  'plugins/guard/hooks/hooks.json': JSON.stringify({
    hooks: {
      SessionStart: hookEntry(),
      UserPromptSubmit: hookEntry(),
      PreToolUse: hookEntry('Bash'),
      PostToolUse: hookEntry('Bash'),
      Stop: hookEntry(),
    },
  }),
  'plugins/guard/hooks/guard.mjs': GUARD,
})

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>
}

/**
 * An OpenAI-compatible model. Asked to clean up, it first runs a command the hook denies, then one it allows, then
 * answers; asked to go on by a Stop hook, it answers once more.
 */
function hookModel() {
  const requests: ModelRequest[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'hooks-fixture', object: 'model' }] }))
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as ModelRequest
    requests.push(input)
    res.setHeader('content-type', 'text/event-stream')
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'hooks-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'hooks-fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      )
    const lastUser = input.messages.map((message) => message.role).lastIndexOf('user')
    const prompt = JSON.stringify(input.messages[lastUser]?.content)
    const toolResults = input.messages.slice(lastUser + 1).filter((message) => message.role === 'tool').length
    const bash = (id: string, command: string) => {
      chunk({
        role: 'assistant',
        tool_calls: [
          { index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } },
        ],
      })
      chunk({}, 'tool_calls')
    }
    if (prompt.includes('GUARD-STOP')) {
      chunk({ role: 'assistant', content: 'STOP-FOLLOWUP-DONE' })
      chunk({}, 'stop')
    } else if (prompt.includes('Clean up') && toolResults === 0) bash('call_denied', 'rm -rf build')
    else if (prompt.includes('Clean up') && toolResults === 1) bash('call_allowed', 'echo GUARD-ECHO')
    else {
      chunk({ role: 'assistant', content: prompt.includes('Clean up') ? 'HOOK-TURN-DONE' : 'PLAIN-DONE' })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  return { server, requests }
}

// Uses the real built application, a synthetic Git source under a temporary folder, and a local OpenAI-compatible
// model. No network, account, or third-party plugin is involved.
test('plugin hooks: approved hooks run around prompts, tools and turn ends with any model', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-plugin-hooks-')))
  const repos = path.join(root, 'repos')
  await mkdir(repos)
  const repo = await makeGitRepo(marketplace(), { parent: repos, name: 'market' })
  const model = hookModel()
  let app: ElectronApplication | undefined
  try {
    await listen(model.server)
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'profile'), 'plugin-hooks-e2e'),
        MAESTRLY_E2E_PLUGIN_GIT_ROOT: repos,
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

    // The plugin's hooks are listed before install and run only once approved.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
    const center = page.getByTestId('plugins-settings')
    await center.getByRole('button', { name: 'Add source', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add source' })
    await add.getByLabel('Repository').fill(pathToFileURL(repo.dir).href)
    await add.getByRole('button', { name: 'Add source', exact: true }).click()
    await expect(add).toHaveCount(0)
    const card = center.locator('[data-plugin="guard"]')
    await expect(card).toContainText('Works with every model')
    await card.click()
    const details = center.getByTestId('plugin-details')
    await details.getByRole('button', { name: 'Install', exact: true }).click()
    const install = page.getByRole('dialog', { name: /^Install / })
    const consent = install.getByTestId('consent-hooks')
    await expect(consent).toContainText('UserPromptSubmit')
    await expect(consent).toContainText('PreToolUse')
    await consent.getByRole('checkbox').check()
    const executables = install.getByRole('checkbox', { name: /scripts or executables/ })
    if (await executables.count()) await executables.check()
    await install.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(install).toHaveCount(0)
    await expect.poll(async () => (await api('pluginsState')).installed.length).toBe(1)

    const provider = await api('chatAddProvider', {
      name: 'Hooks fixture',
      kind: 'openai',
      key: 'synthetic-fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'hooks-fixture' })
    const chat = await api('createStandaloneConversation', { name: 'Hooks chat' })
    await api('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'hooks-fixture' })
    await api('chatSetPermMode', chat.id, 'full')
    expect((await api('chatSetMode', chat.id, 'agent')).ok).toBe(true)

    // The chat was created through the API: reload so the sidebar lists it.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page.locator('li.conv-item', { hasText: 'Hooks chat' }).first().click()
    const input = page.locator('.chat-input[contenteditable="true"]:visible')

    // A prompt the hook blocks never reaches the model, and the draft comes back.
    await input.fill('a forbidden request')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('A plugin hook blocked this message: GUARD-BLOCKED')).toBeVisible()
    expect(model.requests).toHaveLength(0)
    await expect(input).toContainText('a forbidden request')
    await input.fill('')

    // Session and prompt context reach the model; the hook denies one command and comments on the other; a Stop
    // hook keeps the agent going once.
    await input.fill('Clean up the build')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('STOP-FOLLOWUP-DONE')).toBeVisible({ timeout: 60_000 })
    const first = JSON.stringify(model.requests[0].messages)
    expect(first).toContain('GUARD-SESSION:startup')
    expect(first).toContain('GUARD-PROMPT')
    const results = model.requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.stringify(message.content))
    expect(results.some((result) => result.includes('Blocked by plugin hook: GUARD-DENIED'))).toBe(true)
    expect(results.some((result) => result.includes('GUARD-ECHO') && result.includes('GUARD-POST'))).toBe(true)
    expect(model.requests.some((request) => JSON.stringify(request.messages).includes('GUARD-STOP'))).toBe(true)
    await expect(page.getByText('HOOK-TURN-DONE')).toBeVisible()
    // Hook messages show above the composer and are never stored in the conversation.
    await expect(page.getByTestId('hook-notices')).toContainText('GUARD-NOTICE')
    const stored = JSON.stringify(await api('chatHistoryPage', chat.id, { limit: 200 }))
    expect(stored).toContain('HOOK-TURN-DONE')
    expect(stored).not.toContain('GUARD-NOTICE')

    // Ask conversations run no hooks: the same words reach the model.
    expect((await api('chatSetMode', chat.id, 'ask')).ok).toBe(true)
    const beforeAsk = model.requests.length
    await input.fill('another forbidden request')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLAIN-DONE')).toBeVisible({ timeout: 60_000 })
    expect(model.requests[beforeAsk].messages.at(-1)).toEqual({ role: 'user', content: 'another forbidden request' })
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
