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

  it('opens only persisted PDFs, through the ownership-checked IPC', () => {
    const chip = read('../../src/renderer/components/chat/PdfAttachmentChip.tsx')
    expect(read('../../src/renderer/components/chat/ChatMessageList.tsx')).toContain('<PdfAttachmentChip')
    expect(chip).toContain('if (!part.artifactId)')
    expect(chip).toContain('window.api.chatOpenAttachmentPdf(conversationId, messageId, part.id)')
    // The saved message replaces the optimistic bubble right after send, so the chip becomes clickable.
    expect(read('../../src/renderer/components/chat/ChatView.tsx')).toContain(
      'imagesSentRef.current = hasArtifactAttachment(atts)'
    )
  })

  it('attaches operating-system files dropped on the composer', () => {
    const composer = read('../../src/renderer/components/chat/ChatComposer.tsx')
    expect(composer).toContain('onDrop={onFileDrop}')
    expect(composer).toContain('onDragOver={onFileDragOver}')
    expect(composer).toContain('hasDraggedFiles(Array.from(e.dataTransfer.types))')
    expect(composer).toContain('onAddFiles?.(files)')
  })

  it('has English and Portuguese strings', async () => {
    const { default: en } = await import('../../src/shared/i18n/en/chat')
    const { default: pt } = await import('../../src/shared/i18n/pt-BR/chat')
    for (const catalog of [en, pt]) {
      expect(catalog.view.errInvalidAttachment).toBeTruthy()
      expect(catalog.view.errPdfUnreadable).toBeTruthy()
      expect(catalog.messages.pdfPages_one).toContain('{{count}}')
      expect(catalog.messages.pdfPages_other).toContain('{{count}}')
      expect(catalog.messages.openPdf).toContain('{{name}}')
      expect(catalog.messages.pdfOpenFailed).toBeTruthy()
      expect(catalog.composer.dropFiles).toBeTruthy()
    }
  })
})
