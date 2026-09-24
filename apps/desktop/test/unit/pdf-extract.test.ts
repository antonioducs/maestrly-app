import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdfText, PdfExtractionError } from '../../src/main/pdf/extract'
import { makeEncryptedPdf, makeTextPdf } from '../helpers/pdf-fixtures'

/**
 * PDF text extraction runs in the pdf-worker utility process. These tests exercise the pure extractor with
 * synthetic documents: page headers, the byte cap at page boundaries, and the error classification the
 * admission path turns into user-facing messages.
 */
describe('extractPdfText', () => {
  it('extracts text per page with page headers', async () => {
    const result = await extractPdfText(makeTextPdf(['Hello PDF', 'Second page']), { maxTextBytes: 10_000 })

    expect(result.pageCount).toBe(2)
    expect(result.text).toContain('--- Page 1 ---\nHello PDF')
    expect(result.text).toContain('--- Page 2 ---\nSecond page')
    expect(result.truncated).toBe(false)
  })

  it('returns empty text for pages without a text layer', async () => {
    const result = await extractPdfText(makeTextPdf(['', '']), { maxTextBytes: 10_000 })

    expect(result).toEqual({ pageCount: 2, text: '', truncated: false })
  })

  it('cuts at a page boundary when the next page would exceed the cap', async () => {
    const pages = ['a', 'b', 'c'].map((c) => c.repeat(100))
    const result = await extractPdfText(makeTextPdf(pages), { maxTextBytes: 150 })

    expect(result.pageCount).toBe(3)
    expect(result.text).toBe(`--- Page 1 ---\n${'a'.repeat(100)}`)
    expect(result.truncated).toBe(true)
  })

  it('cuts a single oversized first page to the byte cap', async () => {
    const result = await extractPdfText(makeTextPdf(['x'.repeat(500)]), { maxTextBytes: 100 })

    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(100)
    expect(result.text.startsWith('--- Page 1 ---\nxxx')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('classifies password-protected PDFs as encrypted', async () => {
    const error = await extractPdfText(makeEncryptedPdf(), { maxTextBytes: 10_000 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PdfExtractionError)
    expect((error as PdfExtractionError).code).toBe('encrypted')
  })

  it('classifies unparseable documents as corrupt', async () => {
    const error = await extractPdfText(Buffer.from('%PDF-1.4\ngarbage'), { maxTextBytes: 10_000 }).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(PdfExtractionError)
    expect((error as PdfExtractionError).code).toBe('corrupt')
  })
})

describe('bundled PDF.js build', () => {
  // PDF.js 6 no longer exposes `isEvalSupported`; the eval-based font path (CVE-2024-4367 class) is gone.
  // Guard the bundled build so an upgrade cannot silently reintroduce dynamic code evaluation for untrusted PDFs.
  it('contains no dynamic code evaluation', () => {
    const require = createRequire(import.meta.url)
    const bundle = readFileSync(path.join(path.dirname(require.resolve('unpdf')), 'pdfjs.mjs'), 'utf8')

    expect(bundle).not.toMatch(/new Function\s*\(/)
    expect(bundle).not.toMatch(/(^|[^\w.$])eval\s*\(/)
  })
})
