import { describe, expect, it } from 'vitest'
import { classifyAttachment, validateAttachments, type OutboxAttachment } from '../src/fleet/attachments'

const MiB = 1024 * 1024
const image = (byteSize = MiB, mediaType = 'image/png'): OutboxAttachment => ({
  name: 'photo.png',
  kind: 'image',
  mediaType,
  uri: 'file:///photo.png',
  byteSize,
})
const pdf = (byteSize = MiB): OutboxAttachment => ({
  name: 'spec.pdf',
  kind: 'pdf',
  mediaType: 'application/pdf',
  uri: 'file:///spec.pdf',
  byteSize,
})

describe('attachments', () => {
  it('accepts what the gateway accepts', () => {
    expect(validateAttachments([image()], [image(), pdf()], true)).toBeNull()
  })
  it('names the first limit a message breaks', () => {
    expect(
      validateAttachments(
        [],
        Array.from({ length: 9 }, () => image()),
        true
      )
    ).toBe('count')
    expect(validateAttachments([], [image(6 * MiB)], true)).toBe('size')
    expect(
      validateAttachments(
        [],
        Array.from({ length: 5 }, () => pdf()),
        true
      )
    ).toBe('pdfs')
    expect(validateAttachments([], [pdf()], false)).toBe('unsupported')
    expect(validateAttachments([], [image(MiB, 'image/heic')], true)).toBe('type')
    expect(
      validateAttachments([image(4.5 * MiB), image(4.5 * MiB)], [image(4 * MiB), image(4 * MiB), image(4 * MiB)], true)
    ).toBe('total')
  })
  it('classifies files by type and name', () => {
    expect(classifyAttachment('a.jpg', 'image/jpeg')).toBe('image')
    expect(classifyAttachment('a.pdf', 'application/pdf')).toBe('pdf')
    expect(classifyAttachment('notes.md', 'text/markdown')).toBe('text')
    expect(classifyAttachment('notes.md', null)).toBe('text')
    expect(classifyAttachment('a.heic', 'image/heic')).toBeNull()
  })
})
