/**
 * Host for PDF text extraction. Forks one pdf-worker utility process per document and kills it after every
 * outcome (reply, crash, timeout, abort): untrusted PDF parsing never runs on the main thread nor outlives its job.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'

export const PDF_EXTRACTION_TIMEOUT_MS = 20_000

// electron-vite emits the worker next to the main bundle. `app.getAppPath()` is not enough: when Electron is launched
// with a script path (as the E2E suite does) it is the script's directory, not the package root.
const MAIN_BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url))

export function pdfWorkerPath(): string {
  return path.join(MAIN_BUNDLE_DIR, 'pdf-worker.js')
}

export type PdfTextError = 'encrypted' | 'corrupt' | 'timeout' | 'crashed' | 'aborted'

export type PdfTextResult =
  | { ok: true; pageCount: number; text: string; truncated: boolean }
  | { ok: false; error: PdfTextError }

type WorkerReply =
  | { type: 'result'; pageCount: number; text: string; truncated: boolean }
  | { type: 'error'; code?: string }

function resultOf(reply: WorkerReply): PdfTextResult {
  if (reply?.type === 'result') {
    return { ok: true, pageCount: reply.pageCount, text: reply.text, truncated: reply.truncated === true }
  }
  return { ok: false, error: reply?.type === 'error' && reply.code === 'encrypted' ? 'encrypted' : 'corrupt' }
}

export function extractPdfTextIsolated(
  bytes: Uint8Array,
  opts: { maxTextBytes: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<PdfTextResult> {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, error: 'aborted' })
  return new Promise((resolve) => {
    const child = utilityProcess.fork(pdfWorkerPath(), [], { serviceName: 'pdf-text', stdio: 'pipe' })
    let settled = false
    const onAbort = (): void => settle({ ok: false, error: 'aborted' })
    const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), opts.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS)
    function settle(result: PdfTextResult): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      try {
        child.kill()
      } catch {
        /* already exited */
      }
      resolve(result)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (d) => console.error('[pdf-text]', String(d).trim()))
    child.on('message', (reply: WorkerReply) => settle(resultOf(reply)))
    child.on('exit', () => settle({ ok: false, error: 'crashed' }))
    child.postMessage({ bytes, maxTextBytes: opts.maxTextBytes })
  })
}
