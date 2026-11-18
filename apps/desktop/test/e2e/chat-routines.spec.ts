import { createServer, type ServerResponse } from 'node:http'
import { access, mkdtemp, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { instanceEnv } from './helpers/remote-host'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

function writeChunk(res: ServerResponse, delta: Record<string, unknown>, finish: string | null = null) {
  res.write(
    `data: ${JSON.stringify({
      id: 'routine-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'routine-fixture',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  )
}

test('chat routines: + menu create, run now report, pause/edit/delete, and agent proposal', async () => {
  test.setTimeout(180_000)
  await access(path.join(desktop, 'out/main/index.js'))

  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-chat-routines-'))
  const profile = path.join(root, 'profile')
  let app: ElectronApplication | undefined
  let page!: Page
  const seenModels: string[] = []

  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            { id: 'routine-fixture', object: 'model' },
            { id: 'routine-secondary', object: 'model' },
          ],
        })
      )
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as {
      model?: string
      messages: Array<{ role: string; content: unknown }>
    }
    if (input.model) seenModels.push(input.model)
    res.setHeader('content-type', 'text/event-stream')

    const lastUserIdx = input.messages.map((m) => m.role).lastIndexOf('user')
    const userPrompt = lastUserIdx >= 0 ? messageText(input.messages[lastUserIdx]?.content) : ''
    const hasToolAfterUser = lastUserIdx >= 0 && input.messages.slice(lastUserIdx + 1).some((m) => m.role === 'tool')

    if (userPrompt.includes('PROPOSE_ROUTINE') && !hasToolAfterUser) {
      writeChunk(res, {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_propose_1',
            type: 'function',
            function: {
              name: 'routine_propose',
              arguments: JSON.stringify({
                title: 'Daily changelog watch',
                instruction: 'Check the latest changelog notes and summarize breaking updates.',
                schedule: { kind: 'weekly', time: '08:30', days: [1, 3, 5], timezone: 'UTC' },
                notify: 'notable',
                missed: 'catchup',
              }),
            },
          },
        ],
      })
      writeChunk(res, {}, 'tool_calls')
      res.end('data: [DONE]\n\n')
      return
    }

    if (userPrompt.includes('Check GRU -> LIS flight prices') && !hasToolAfterUser) {
      writeChunk(res, {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_report_1',
            type: 'function',
            function: {
              name: 'routine_run_report',
              arguments: JSON.stringify({
                outcome: 'notable',
                summary: 'Found price drop to R$ 3.870 on LATAM.',
                pending: null,
                notes_for_next_run: 'Last baseline R$ 3.870.',
              }),
            },
          },
        ],
      })
      writeChunk(res, {}, 'tool_calls')
      res.end('data: [DONE]\n\n')
      return
    }

    const reply = userPrompt.includes('PROPOSE_ROUTINE')
      ? 'Here is the proposed schedule.'
      : userPrompt.includes('Check GRU -> LIS flight prices')
        ? 'Checked flight prices and saved the report.'
        : 'Routine test reply.'
    writeChunk(res, { role: 'assistant', content: reply })
    writeChunk(res, {}, 'stop')
    res.end('data: [DONE]\n\n')
  })

  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(profile, 'chat-routines-e2e', 'en'),
        MAESTRLY_ENVIRONMENT_ID: '',
        MAESTRLY_BOT_CONTROL_PORT: '',
        MAESTRLY_BOT_CONTROL_TOKEN: '',
        MAESTRLY_BOT_CONTROL_HOST: '',
        MAESTRLY_BOT_GATEWAY_URL: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(await realpath(profile))

    const skipBtn = page.getByRole('button', { name: 'Skip', exact: true })
    if (await skipBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await skipBtn.click()
    }

    const port = (model.address() as { port: number }).port
    const provider = await call('chatAddProvider', {
      name: 'Routines fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'routine-fixture' })

    // 1. Create a routine from the + menu editor in a standalone chat.
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    const composer = page.locator('.chat-input[contenteditable="true"]:visible')
    await expect(composer).toBeVisible()
    await composer.fill('Check GRU -> LIS flight prices every weekday morning.')

    await page.locator('button[title="Add"]:visible').click()
    await page.getByRole('menuitem', { name: /Schedule as routine/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Instruction')).toHaveValue(/Check GRU -> LIS flight prices/)
    await dialog.getByLabel('Title').fill('Flight price watch')
    await dialog.getByRole('button', { name: 'Create routine', exact: true }).click()
    await expect(dialog).toBeHidden()

    // Origin chat shows the routine header chip and created card mark.
    await expect(page.getByRole('button', { name: '1 routine', exact: true })).toBeVisible()
    await expect(page.getByText('Routine created from + menu')).toBeVisible()

    // Routines sidebar tab lists the created routine.
    await page.locator('#sidebar-tab-routines').click()
    await expect(page.locator('#sidebar-panel-routines').getByText('Flight price watch')).toBeVisible()

    // 2. Open detail and click "Run now" -> starts run, then open its run conversation to verify report.
    await page.locator('#sidebar-panel-routines').getByText('Flight price watch').click()
    await expect(page.getByRole('heading', { name: 'Flight price watch' })).toBeVisible()
    await page.getByRole('button', { name: 'Run now', exact: true }).click()

    const runRow = page.getByRole('button', { name: /Found price drop to R\$ 3\.870 on LATAM/ })
    await expect(runRow).toBeVisible({ timeout: 30_000 })
    await runRow.click()

    await expect(page.getByText('Run now by you')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Run report')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Last baseline R$ 3.870.')).toBeVisible({ timeout: 20_000 })

    // 3. Pause, edit model to routine-secondary, and delete.
    await page.locator('#sidebar-tab-routines').click()
    await page.locator('#sidebar-panel-routines').getByText('Flight price watch').click()
    const activeSwitch = page.getByRole('switch', { name: 'Routine active' })
    await activeSwitch.click()
    await expect(activeSwitch).toHaveAttribute('aria-checked', 'false')

    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog).toBeVisible()
    const modelGroup = editDialog.getByRole('group', { name: 'Model' })
    await modelGroup.locator('button').first().click()
    await page.getByText('routine-secondary', { exact: false }).first().click()
    await editDialog.getByRole('button', { name: 'Save routine', exact: true }).click()
    await expect(editDialog).toBeHidden()
    await expect(page.locator('main').getByText('routine-secondary').first()).toBeVisible()

    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const confirmDialog = page.getByRole('dialog')
    await confirmDialog.getByRole('button', { name: 'Delete routine', exact: true }).click()
    await expect(page.locator('#sidebar-panel-routines').getByText('Flight price watch')).toHaveCount(0)

    // 4. Proposal card seeded by a fake routine_propose tool call.
    await page.locator('#sidebar-tab-chats').click()
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await page.locator('.chat-input[contenteditable="true"]:visible').fill('PROPOSE_ROUTINE')
    await page.locator('button[title="Send"]:visible').click()

    await expect(page.getByText('New routine · waiting for you')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Daily changelog watch')).toBeVisible()
    await page.getByRole('button', { name: 'Create routine', exact: true }).click()

    await expect(page.getByTestId('routine-proposal-created').getByText('Routine created', { exact: true })).toBeVisible()
    await page.locator('#sidebar-tab-routines').click()
    await expect(page.locator('#sidebar-panel-routines').getByText('Daily changelog watch')).toBeVisible()
    expect(seenModels.length).toBeGreaterThanOrEqual(2)
  } finally {
    await app?.close()
    await new Promise((resolve) => model.close(resolve))
    await removeTempDirEventually(root)
  }
})
