import { describe, expect, it } from 'vitest'
import { pdfFallbackText, sendPdfNatively, supportsNativePdf } from '../../src/main/chat/pdf-attachments'
import type { MessagePart } from '../../src/shared/chat'

/**
 * Native-vs-text decision for PDF attachments. Native delivery is limited to runtimes and endpoints known to
 * accept PDF documents; everything else receives Maestrly's extracted text through pdfFallbackText.
 */
type FilePart = Extract<MessagePart, { type: 'file' }>

const pdf = (over: Partial<FilePart> = {}): FilePart => ({
  type: 'file',
  id: 'p',
  name: 'a.pdf',
  mediaType: 'application/pdf',
  kind: 'pdf',
  artifactId: 'abc',
  byteSize: 10,
  pageCount: 2,
  data: '--- Page 1 ---\nHello',
  ...over,
})

describe('supportsNativePdf', () => {
  it.each([
    [{ runtime: 'claude-agent-sdk' }, true],
    [{ runtime: 'codex' }, false],
    [{ runtime: 'github-copilot' }, false],
    [{ runtime: 'cursor' }, false],
    [{ runtime: 'ai-sdk', transport: 'openai', modelPdf: true }, false],
    [{ runtime: 'ai-sdk', transport: 'anthropic', modelPdf: true }, true],
    [{ runtime: 'ai-sdk', transport: 'anthropic', modelPdf: false, baseURL: 'https://api.anthropic.com/v1' }, false],
    [{ runtime: 'ai-sdk', transport: 'anthropic', baseURL: 'https://api.anthropic.com/v1' }, true],
    [{ runtime: 'ai-sdk', transport: 'anthropic', baseURL: 'https://api.z.ai/api/anthropic' }, false],
    [{ runtime: 'ai-sdk', transport: 'openai-responses', baseURL: 'https://api.openai.com/v1' }, true],
    [{ runtime: 'ai-sdk', transport: 'openai-responses', baseURL: 'https://gateway.example/v1' }, false],
    [{ runtime: 'ai-sdk', transport: 'anthropic' }, false],
  ] as const)('%o → %s', (args, expected) => {
    expect(supportsNativePdf(args)).toBe(expected)
  })
})

describe('sendPdfNatively', () => {
  it('sends only readable PDFs within the native page ceiling', () => {
    expect(sendPdfNatively(pdf({ pageCount: 100 }), true)).toBe(true)
    expect(sendPdfNatively(pdf({ pageCount: 101 }), true)).toBe(false)
    expect(sendPdfNatively(pdf({ artifactId: undefined }), true)).toBe(false)
    expect(sendPdfNatively(pdf(), false)).toBe(false)
    expect(sendPdfNatively(pdf({ pageCount: undefined }), true)).toBe(false)
  })
})

describe('pdfFallbackText', () => {
  it('labels the extracted text with the page count', () => {
    const text = pdfFallbackText(pdf())

    expect(
      text.startsWith('Attached PDF "a.pdf" (2 pages; text extracted by Maestrly, layout and images omitted):\n\n')
    ).toBe(true)
    expect(text).toContain('--- Page 1 ---\nHello')
  })

  it('uses the singular for one page', () => {
    expect(pdfFallbackText(pdf({ pageCount: 1 }))).toContain('(1 page;')
  })

  it('marks truncated text', () => {
    expect(
      pdfFallbackText(pdf({ textTruncated: true })).endsWith(
        '[text truncated: Maestrly extracted only the first 256 KB]'
      )
    ).toBe(true)
  })

  it('explains PDFs without a text layer', () => {
    expect(pdfFallbackText(pdf({ data: '' }))).toBe('[PDF "a.pdf" (2 pages) has no extractable text layer]')
  })
})
