import { describe, expect, it } from 'vitest'
import { draftAttachmentKind } from '../../src/renderer/lib/attachment-kind'

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
