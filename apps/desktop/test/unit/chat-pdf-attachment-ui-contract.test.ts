import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * PDF attachment UI wiring. Tests run in Node without a DOM, so they check source structure as in
 * attachment-image-gating-contract.test.ts, plus the localized strings the composer relies on.
 */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('PDF attachments in the chat UI', () => {
  it('offers PDFs in the file picker', () => {
    expect(read('../../src/renderer/components/chat/ChatPlusMenu.tsx')).toContain('application/pdf,.pdf')
  })

  it('classifies dropped files and maps PDF admission errors', () => {
    const view = read('../../src/renderer/components/chat/ChatView.tsx')
    expect(view).toContain('draftAttachmentKind(file)')
    expect(view).toContain("'pdf-unreadable'")
    expect(view).toContain("'invalid-attachment'")
  })

  it('has English and Portuguese strings', async () => {
    const { default: en } = await import('../../src/shared/i18n/en/chat')
    const { default: pt } = await import('../../src/shared/i18n/pt-BR/chat')
    for (const catalog of [en, pt]) {
      expect(catalog.view.errInvalidAttachment).toBeTruthy()
      expect(catalog.view.errPdfUnreadable).toBeTruthy()
      expect(catalog.messages.pdfPages_one).toContain('{{count}}')
      expect(catalog.messages.pdfPages_other).toContain('{{count}}')
    }
  })
})
