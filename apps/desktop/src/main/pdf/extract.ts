/**
 * Text extraction for PDF chat attachments. Pure (no Electron): runs inside the pdf-worker utility process so
 * parsing untrusted documents never happens on the main thread. Text is capped at `maxTextBytes` on a page
 * boundary; only a single oversized first page is cut mid-page.
 */
import { getDocumentProxy } from 'unpdf'

export type PdfExtractionErrorCode = 'encrypted' | 'corrupt'

export class PdfExtractionError extends Error {
  readonly name = 'PdfExtractionError'
  constructor(
    readonly code: PdfExtractionErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface PdfTextExtraction {
  pageCount: number
  text: string
  truncated: boolean
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>

/** Cuts UTF-8 at a byte limit without leaving a partial multi-byte sequence. */
function cutUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�$/, '')
}

export async function extractPdfText(bytes: Uint8Array, opts: { maxTextBytes: number }): Promise<PdfTextExtraction> {
  let pdf: PdfDocument
  try {
    // Copy: pdf.js transfers (detaches) the buffer it receives. No font loading, system fonts or fetches.
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0,
    })
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    if (name === 'PasswordException') throw new PdfExtractionError('encrypted', 'The PDF is password-protected.')
    throw new PdfExtractionError('corrupt', `The PDF could not be parsed: ${(error as Error)?.message ?? error}`)
  }
  try {
    const blocks: string[] = []
    let used = 0
    let truncated = false
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      page.cleanup()
      const pageText = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .trim()
      if (!pageText) continue
      const block = `--- Page ${n} ---\n${pageText}`
      const size = Buffer.byteLength(block, 'utf8') + (blocks.length ? 2 : 0)
      if (used + size > opts.maxTextBytes) {
        truncated = true
        if (blocks.length === 0) blocks.push(cutUtf8(block, opts.maxTextBytes))
        break
      }
      blocks.push(block)
      used += size
    }
    return { pageCount: pdf.numPages, text: blocks.join('\n\n'), truncated }
  } catch (error) {
    throw new PdfExtractionError('corrupt', `The PDF could not be read: ${(error as Error)?.message ?? error}`)
  } finally {
    // PDF.js 6 releases documents through their loading task (the proxy no longer exposes destroy()).
    await pdf.loadingTask.destroy()
  }
}
