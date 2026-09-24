import { describe, expect, it } from 'vitest'
import { draftAttachmentKind, hasArtifactAttachment, hasDraggedFiles } from '../../src/renderer/lib/attachment-kind'

/** Classifies files dropped, pasted or picked in the chat composer. */
describe('draftAttachmentKind', () => {
  it.each([
    [{ name: 'shot.png', type: 'image/png' }, 'image'],
    [{ name: 'spec.pdf', type: 'application/pdf' }, 'pdf'],
    [{ name: 'A.PDF', type: '' }, 'pdf'],
    [{ name: 'notes.md', type: 'text/markdown' }, 'text'],
  ] as const)('%o → %s', (file, kind) => {
    expect(draftAttachmentKind(file)).toBe(kind)
  })
})

describe('hasArtifactAttachment', () => {
  it('reloads the saved message for images and PDFs, not for text files', () => {
    expect(hasArtifactAttachment([{ kind: 'text' }, { kind: 'pdf' }])).toBe(true)
    expect(hasArtifactAttachment([{ kind: 'image' }])).toBe(true)
    expect(hasArtifactAttachment([{ kind: 'text' }])).toBe(false)
    expect(hasArtifactAttachment([])).toBe(false)
  })
})

describe('hasDraggedFiles', () => {
  it('accepts operating-system file drags only', () => {
    expect(hasDraggedFiles(['Files'])).toBe(true)
    expect(hasDraggedFiles(['text/plain', 'Files'])).toBe(true)
    expect(hasDraggedFiles(['text/plain', 'text/html'])).toBe(false)
    expect(hasDraggedFiles([])).toBe(false)
  })
})
