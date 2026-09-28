/**
 * PDF text-extraction utilityProcess. One process per PDF: the host forks it, posts a single job
 * ({ bytes, maxTextBytes }) over process.parentPort and kills it after the reply, so parsing untrusted
 * documents stays isolated from main and no idle worker lifecycle is needed. Replies:
 * { type: 'result', pageCount, text, truncated } or { type: 'error', code: 'encrypted' | 'corrupt' }.
 */
import { extractPdfText, PdfExtractionError } from './pdf/extract'

const parentPort = process.parentPort

parentPort.once('message', async (e) => {
  const { bytes, maxTextBytes } = e.data as { bytes: Uint8Array; maxTextBytes: number }
  try {
    parentPort.postMessage({ type: 'result', ...(await extractPdfText(bytes, { maxTextBytes })) })
  } catch (error) {
    if (!(error instanceof PdfExtractionError)) console.error('unexpected extraction failure:', error)
    parentPort.postMessage({ type: 'error', code: error instanceof PdfExtractionError ? error.code : 'corrupt' })
  }
})
