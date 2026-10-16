import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectChatMessages } from '../../src/main/fleet/instance/transcript'
import { previewImages, previewScript, readPreviewMessages } from '../../src/main/genui-preview'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import {
  expandGenUiPreviews,
  GENUI_WIDGET_FRAME_URL,
  GENUI_WIDGET_MAX_HEIGHT,
  genUiPreviewsOf,
  genUiWidgetHash,
} from '../../src/shared/genui-widget'

const preview = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../../src/main/genui-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/genui-preview')>()),
  renderGenUiPreview: preview.render,
}))

const CARD = '<div class="card"><img src="https://example.com/a.jpg" alt=""><b>Mac mini</b></div>'
const ID = genUiWidgetHash(CARD)

function previewPart(
  html: unknown,
  options: { toolName?: string; status?: 'completed' | 'running' | 'error' } = {}
): MessagePart {
  const status = options.status ?? 'completed'
  return {
    type: 'tool',
    id: `call-${String(html).length}`,
    toolCallId: `call-${String(html).length}`,
    toolName: options.toolName ?? 'mcp__maestrly__preview_interface',
    input: { html },
    state:
      status === 'completed'
        ? { status, output: 'Preview' }
        : status === 'error'
          ? { status, error: 'failed' }
          : { status },
  }
}

describe('previews an answer shows by name', () => {
  const previews = new Map([[ID, CARD]])

  it('names a preview after its HTML', () => {
    expect(genUiWidgetHash(CARD)).toBe(ID)
    expect(genUiWidgetHash(`${CARD} `)).not.toBe(ID)
    expect(ID).toMatch(/^[0-9a-z]{1,7}$/)
  })

  it('collects the completed previews of a message, whatever prefix the runtime gives the tool', () => {
    const other = '<p>other</p>'
    const found = genUiPreviewsOf([
      { type: 'text', id: 't', text: 'Here.' },
      previewPart(CARD),
      previewPart(other, { toolName: 'maestrly__preview_interface' }),
      previewPart('<p>running</p>', { status: 'running' }),
      previewPart('<p>failed</p>', { status: 'error' }),
      previewPart('<p>elsewhere</p>', { toolName: 'browser_screenshot' }),
      previewPart(42),
    ])
    expect([...found]).toEqual([
      [ID, CARD],
      [genUiWidgetHash(other), other],
    ])
  })

  it('replaces a closed reference with the preview, in a fence no line of it can close', () => {
    expect(expandGenUiPreviews(`Two options:\n\n\`\`\`inline-html preview=${ID}\n\`\`\`\n\nDone.`, previews)).toBe(
      `Two options:\n\n\`\`\`inline-html\n${CARD}\n\`\`\`\n\nDone.`
    )
    const code = '<pre>````js\nx\n````</pre>'
    const id = genUiWidgetHash(code)
    expect(expandGenUiPreviews(`~~~inline-html preview=${id}\n\n~~~`, new Map([[id, code]]))).toBe(
      `\`\`\`\`\`inline-html\n${code}\n\`\`\`\`\``
    )
  })

  it('leaves unknown previews, unclosed references and examples in other code blocks as written', () => {
    const unknown = '```inline-html preview=zzzz\n```'
    const streaming = `\`\`\`inline-html preview=${ID}\n`
    const example = `\`\`\`markdown\n\`\`\`inline-html preview=${ID}\n\`\`\`\n`
    for (const text of [unknown, streaming, example, `\`\`\`inline-html preview=${ID}\n<p>x</p>\n\`\`\``])
      expect(expandGenUiPreviews(text, previews)).toBe(text)
    expect(expandGenUiPreviews(`text\n\`\`\`inline-html preview=${ID}\n\`\`\``, new Map())).toBe(
      `text\n\`\`\`inline-html preview=${ID}\n\`\`\``
    )
  })

  it('shows them in chats, where the message holds its previews', () => {
    const viewer = readFileSync(new URL('../../src/renderer/components/MarkdownViewer.tsx', import.meta.url), 'utf8')
    expect(viewer).toContain('previews ? expandGenUiPreviews(markdown, previews) : markdown')
    expect(viewer).toContain('{source}\n      </ReactMarkdown>')
  })

  it('shows them in bot transcripts, which carry answers but not tool inputs', () => {
    const message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      createdAt: 1,
      finishReason: 'stop',
      parts: [previewPart(CARD), { type: 'text', id: 't', text: `Look:\n\`\`\`inline-html preview=${ID}\n\`\`\`` }],
    } as ChatMessage
    const answer = projectChatMessages([message]).find((item) => item.kind === 'assistant')
    expect(answer).toMatchObject({ kind: 'assistant', text: `Look:\n\`\`\`inline-html\n${CARD}\n\`\`\`` })
  })
})

describe('interface preview rendering', () => {
  const frame = (fields: Record<string, unknown>) => ({ source: 'maestrly-widget', ...fields })

  it('keeps the last height the frame asked for and each problem once', () => {
    expect(
      readPreviewMessages([
        frame({ type: 'ready' }),
        frame({ type: 'size', height: 300.2 }),
        frame({ type: 'issue', kind: 'image', detail: 'https://example.com/a.jpg' }),
        frame({ type: 'issue', kind: 'image', detail: 'https://example.com/a.jpg' }),
        frame({ type: 'size', height: 412 }),
        frame({ type: 'issue', kind: 'nonsense', detail: 'x' }),
        { type: 'size', height: 9999 },
        frame({ type: 'loaded' }),
      ])
    ).toEqual({ height: 412, capped: false, issues: [{ kind: 'image', detail: 'https://example.com/a.jpg' }] })
    expect(readPreviewMessages(undefined)).toEqual({ height: 160, capped: false, issues: [] })
  })

  it('says when the height was capped', () => {
    expect(readPreviewMessages([frame({ type: 'size', height: 1e6 })])).toMatchObject({
      height: GENUI_WIDGET_MAX_HEIGHT,
      capped: true,
    })
    expect(
      readPreviewMessages([
        frame({ type: 'size', height: 800 }),
        frame({ type: 'issue', kind: 'viewport', detail: '' }),
      ])
    ).toMatchObject({ height: 800, capped: true })
  })

  it('cuts a tall screenshot into readable parts at one pixel per CSS pixel', () => {
    const crops: Array<{ y: number; height: number }> = []
    const resized: number[] = []
    const image = (width: number, height: number) => ({
      getSize: () => ({ width, height }),
      crop: (rect: { x: number; y: number; width: number; height: number }) => {
        crops.push({ y: rect.y, height: rect.height })
        const part = image(rect.width, rect.height)
        return part
      },
      resize: (options: { width: number }) => {
        resized.push(options.width)
        return image(options.width, 1)
      },
      toPNG: () => Buffer.from('png'),
    })
    // A window painted at twice the CSS size
    const parts = previewImages(image(1400, 4800) as never, 700, 2000)
    expect(parts).toHaveLength(2)
    expect(crops).toEqual([
      { y: 0, height: 2400 },
      { y: 2400, height: 1600 },
    ])
    expect(resized).toEqual([700, 700])
  })

  it('answers the frame like a chat does, then reports once the block loaded and settled', async () => {
    const posted: unknown[] = []
    const timers = new Map<number, () => void>()
    let nextTimer = 1
    const listeners: Array<(event: unknown) => void> = []
    const contentWindow = { postMessage: (data: unknown) => posted.push(data) }
    const iframe = { setAttribute: vi.fn(), style: { height: '' }, src: '', contentWindow }
    const appended: unknown[] = []
    const sandbox = {
      window: { addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.push(listener) },
      document: { createElement: () => iframe, body: { appendChild: (node: unknown) => appended.push(node) } },
      setTimeout: (callback: () => void) => {
        timers.set(nextTimer, callback)
        return nextTimer++
      },
      clearTimeout: (id: number) => timers.delete(id),
    }
    const result = vm.runInNewContext(previewScript(CARD), sandbox) as Promise<{
      messages: Array<Record<string, unknown>>
      timedOut: boolean
    }>
    expect(appended).toEqual([iframe])
    expect(iframe.src).toBe(GENUI_WIDGET_FRAME_URL)
    expect(iframe.setAttribute).toHaveBeenCalledWith('sandbox', 'allow-scripts')
    const send = (data: unknown, source: unknown = contentWindow) => {
      for (const listener of listeners) listener({ source, data })
    }
    send({ source: 'maestrly-widget', type: 'ready' })
    expect(posted).toEqual([{ source: 'maestrly-host', type: 'render', html: CARD, theme: {} }])
    send({ source: 'maestrly-widget', type: 'size', height: 5000 })
    expect(iframe.style.height).toBe(`${GENUI_WIDGET_MAX_HEIGHT}px`)
    send({ source: 'maestrly-widget', type: 'size', height: 321.4 }, {})
    expect(iframe.style.height).toBe(`${GENUI_WIDGET_MAX_HEIGHT}px`)
    send({ source: 'maestrly-widget', type: 'issue', kind: 'script', detail: 'e'.repeat(1000) })
    send({ source: 'maestrly-widget', type: 'loaded' })
    // The render limit and the settle timer: only settling finishes it
    const settle = [...timers.entries()].at(-1)!
    settle[1]()
    const { messages, timedOut } = await result
    expect(timedOut).toBe(false)
    expect(messages.map((item) => item.type)).toEqual(['ready', 'size', 'issue', 'loaded'])
    expect(String(messages[2].detail)).toHaveLength(300)
  })
})

describe('preview_interface tool', () => {
  type Handler = (
    args: { html: string; width?: number },
    extra: { signal: AbortSignal }
  ) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>
  let handler: Handler

  beforeEach(async () => {
    preview.render.mockReset()
    const { registerInterfaceTools } = await import('../../src/main/mcp/tools/interfaces')
    const server = {
      registerTool: (name: string, _config: unknown, callback: Handler) => {
        expect(name).toBe('preview_interface')
        handler = callback
      },
    }
    registerInterfaceTools({ server, convId: 'c1', locale: 'en', t: ((key: string) => key) as never } as never)
  })

  it('returns the screenshots, then the id, the problems and how to show it', async () => {
    preview.render.mockResolvedValue({
      images: [Buffer.from('top'), Buffer.from('bottom')],
      width: 700,
      height: 1800,
      capped: false,
      timedOut: false,
      issues: [{ kind: 'image', detail: 'https://example.com/a.jpg' }],
    })
    const result = await handler({ html: CARD }, { signal: new AbortController().signal })
    expect(preview.render).toHaveBeenCalledWith(expect.objectContaining({ html: CARD }))
    expect(result.content.slice(0, 2)).toEqual([
      { type: 'image', data: Buffer.from('top').toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: Buffer.from('bottom').toString('base64'), mimeType: 'image/png' },
    ])
    expect(String(result.content[2].text).split('\n')).toEqual([
      'returns.interfaces.rendered',
      'returns.interfaces.issues',
      '- returns.interfaces.kinds.image: https://example.com/a.jpg',
      'returns.interfaces.show',
    ])
  })

  it('tells the model to go on without a preview when rendering fails', async () => {
    preview.render.mockRejectedValue(new Error('no display'))
    const result = await handler({ html: CARD }, { signal: new AbortController().signal })
    expect(result).toEqual({ content: [{ type: 'text', text: 'errors.interfacePreview' }], isError: true })
  })
})
