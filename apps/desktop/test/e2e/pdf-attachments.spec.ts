import { createServer } from 'node:http'
import { access, mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { makeTextPdf } from '../helpers/pdf-fixtures'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

// Real built application, real pdf-worker utility process and a local OpenAI-compatible provider (which receives
// PDFs as extracted text). The operating-system viewer is replaced by a recorder in the main process.
test('PDF attachments: drop onto the composer, send as text, open from the chip', async () => {
  test.setTimeout(120_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-pdf-'))
  const profile = path.join(root, 'profile')
  let app: ElectronApplication | undefined
  let page!: Page
  const requests: Array<{ messages: unknown[] }> = []
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'pdf-fixture', object: 'model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    requests.push(JSON.parse(body))
    res.setHeader('content-type', 'text/event-stream')
    for (const [content, finish] of [
      ['PDF reply.', null],
      ['', 'stop'],
    ] as const) {
      res.write(
        `data: ${JSON.stringify({
          id: 'pdf-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'pdf-fixture',
          choices: [{ index: 0, delta: { content }, finish_reason: finish }],
        })}\n\n`
      )
    }
    res.end('data: [DONE]\n\n')
  })
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const pdf = makeTextPdf(['E2E PDF proof'])
  const dispatchFileDrag = (type: 'dragenter' | 'drop') =>
    page.locator('.chat-input[contenteditable="true"]:visible').evaluate(
      (el, { type, base64 }) => {
        const w = window as unknown as { __pdfTransfer?: DataTransfer }
        if (!w.__pdfTransfer) {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          w.__pdfTransfer = new DataTransfer()
          w.__pdfTransfer.items.add(new File([bytes], 'proof.pdf', { type: 'application/pdf' }))
        }
        el.dispatchEvent(new DragEvent(type, { dataTransfer: w.__pdfTransfer, bubbles: true, cancelable: true }))
      },
      { type, base64: pdf.toString('base64') }
    )

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'pdf-attachments-e2e',
        AGENTS_USERDATA: profile,
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const provider = await call('chatAddProvider', {
      name: 'PDF fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'pdf-fixture' })
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect.poll(async () => (await call('listStandaloneConversations', true)).length).toBe(1)
    const conversation = (await call('listStandaloneConversations', true))[0]
    await call('chatSetSelection', conversation.id, { providerId: provider.id, modelId: 'pdf-fixture' })

    // Dragging files over the composer shows the drop target; dropping attaches them.
    await dispatchFileDrag('dragenter')
    await expect(page.getByText('Drop files to attach', { exact: true })).toBeVisible()
    await dispatchFileDrag('drop')
    await expect(page.getByText('Drop files to attach', { exact: true })).toHaveCount(0)
    await expect(page.getByText('proof.pdf', { exact: true }).first()).toBeVisible()

    await page.locator('.chat-input[contenteditable="true"]:visible').fill('summarize the attachment')
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('PDF reply.', { exact: true })).toBeVisible()
    await expect(page.locator('button[title="Stop"]:visible')).toHaveCount(0)
    // An OpenAI-compatible provider receives the text extracted by the pdf-worker process.
    const request = JSON.stringify(requests[0]?.messages)
    expect(request).toContain('Attached PDF \\"proof.pdf\\" (1 page;')
    expect(request).toContain('E2E PDF proof')

    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __openedPdfs: string[]; __openPath: typeof shell.openPath }
      g.__openedPdfs = []
      g.__openPath = shell.openPath
      shell.openPath = async (target: string) => {
        g.__openedPdfs.push(target)
        return ''
      }
    })
    const chip = page.locator('button[title="Open proof.pdf"]:visible')
    await chip.click()
    const opened = () => app!.evaluate(() => (globalThis as unknown as { __openedPdfs: string[] }).__openedPdfs)
    await expect.poll(async () => (await opened()).length).toBe(1)
    const [copy] = await opened()
    // The viewer gets a read-only copy named after the attachment, never the stored artifact.
    expect(path.basename(copy)).toBe('proof.pdf')
    expect(
      copy.startsWith(path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'chat-attachment-previews'))
    ).toBe(true)
    expect((await readFile(copy)).equals(pdf)).toBe(true)
    expect((await stat(copy)).mode & 0o222).toBe(0)

    // A viewer failure is reported on the chip.
    await app.evaluate(({ shell }) => {
      shell.openPath = async () => 'no application to open the file'
    })
    await chip.click()
    await expect(page.locator('button[title^="Couldn\'t open the PDF"]:visible')).toBeVisible()
    await app.evaluate(({ shell }) => {
      shell.openPath = (globalThis as unknown as { __openPath: typeof shell.openPath }).__openPath
    })
  } finally {
    await app?.close()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
