/**
 * PDF attachment delivery policy. A PDF part always carries Maestrly's extracted text (`data`); runtimes and
 * endpoints known to read PDFs receive the original document instead, everything else receives the text.
 */
import type { ChatProviderKind, MessagePart } from '../../shared/chat'
import { MAX_ATTACHMENT_TEXT_BYTES, MAX_PDF_NATIVE_PAGES } from '../../shared/memory-policy'
import { catalogProviderForBaseURL } from './model-meta'

type FilePart = Extract<MessagePart, { type: 'file' }>

export type PdfRuntime = 'ai-sdk' | 'claude-agent-sdk' | 'codex' | 'github-copilot' | 'cursor'

export function supportsNativePdf(args: {
  runtime: PdfRuntime
  transport?: ChatProviderKind
  baseURL?: string
  modelPdf?: boolean
}): boolean {
  if (args.runtime === 'claude-agent-sdk') return true
  if (args.runtime !== 'ai-sdk') return false
  if (args.transport !== 'anthropic' && args.transport !== 'openai-responses') return false
  if (args.modelPdf !== undefined) return args.modelPdf
  // The anthropic adapter also serves third-party compatible hosts that reject document blocks.
  const home = args.baseURL ? catalogProviderForBaseURL(args.baseURL) : null
  return args.transport === 'anthropic' ? home === 'anthropic' : home === 'openai'
}

/** Oversized or unreadable PDFs fall back to text even when the runtime reads PDFs. */
export function sendPdfNatively(part: FilePart, nativePdf: boolean): boolean {
  return nativePdf && !!part.artifactId && part.pageCount != null && part.pageCount <= MAX_PDF_NATIVE_PAGES
}

export function pdfFallbackText(part: FilePart): string {
  const pages =
    part.pageCount == null ? 'unknown page count' : `${part.pageCount} page${part.pageCount === 1 ? '' : 's'}`
  const text = part.data?.trim()
  if (!text) return `[PDF "${part.name}" (${pages}) has no extractable text layer]`
  const cut = part.textTruncated
    ? `\n\n[text truncated: Maestrly extracted only the first ${MAX_ATTACHMENT_TEXT_BYTES / 1024} KB]`
    : ''
  return `Attached PDF "${part.name}" (${pages}; text extracted by Maestrly, layout and images omitted):\n\n${text}${cut}`
}
