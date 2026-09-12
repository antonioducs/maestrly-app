import { describe, expect, it } from 'vitest'
import { boundDraftAttachments, type BudgetedAttachment } from '../../src/renderer/lib/draft-attachment-budget'
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
} from '../../src/shared/memory-policy'

/**
 * Draft image count and bytes accumulate across successive addFiles batches (memory review round 8).
 * A new selection cannot reset the budget, and text does not consume the image quota.
 */

const MiB = 1024 * 1024

const image = (id: string, bytes: number, previewUrl?: string): BudgetedAttachment => ({
  id,
  kind: 'image',
  byteSize: bytes,
  ...(previewUrl ? { previewUrl } : {}),
})
const text = (id: string, bytes: number): BudgetedAttachment => ({ id, kind: 'text', byteSize: bytes })

const imageBytesOf = (kept: readonly BudgetedAttachment[]): number =>
  kept.reduce((sum, a) => sum + (a.kind === 'image' ? (a.byteSize ?? 0) : 0), 0)

describe('boundDraftAttachments preserves the budget across batches', () => {
  it('rejects a whole second batch that exceeds the aggregate byte budget', () => {
    // First selection: five 4 MiB images exactly fill the 20 MiB limit.
    const batch1 = Array.from({ length: 5 }, (_, i) => image(`a${i}`, 4 * MiB))
    const first = boundDraftAttachments([], batch1)
    expect(first.kept).toHaveLength(5)
    expect(first.rejected).toHaveLength(0)

    // Second selection: two 4 MiB images must both be rejected against the accumulated budget.
    const batch2 = Array.from({ length: 2 }, (_, i) => image(`b${i}`, 4 * MiB))
    const second = boundDraftAttachments(first.kept, batch2)

    expect(second.kept).toHaveLength(5)
    expect(second.rejected.map((a) => a.id)).toEqual(['b0', 'b1'])
    expect(imageBytesOf(second.kept)).toBeLessThanOrEqual(MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE)
  })

  it('counts images across the draft and incoming batch up to the limit', () => {
    const batch1 = Array.from({ length: MAX_ATTACHMENT_IMAGES_PER_MESSAGE - 2 }, (_, i) => image(`a${i}`, MiB))
    const batch2 = Array.from({ length: 4 }, (_, i) => image(`b${i}`, MiB))

    const result = boundDraftAttachments(boundDraftAttachments([], batch1).kept, batch2)

    expect(result.kept.filter((a) => a.kind === 'image')).toHaveLength(MAX_ATTACHMENT_IMAGES_PER_MESSAGE)
    expect(result.rejected.map((a) => a.id)).toEqual(['b2', 'b3']) // Two fit up to the limit and two are rejected.
  })

  it('text does not consume the image count or byte budget', () => {
    const draft = Array.from({ length: 4 }, (_, i) => text(`t${i}`, 1024))
    const images = Array.from({ length: MAX_ATTACHMENT_IMAGES_PER_MESSAGE }, (_, i) => image(`i${i}`, MiB))

    const result = boundDraftAttachments(draft, images)

    // All eight images fit despite four existing text files; text cannot consume image slots.
    expect(result.kept).toHaveLength(4 + MAX_ATTACHMENT_IMAGES_PER_MESSAGE)
    expect(result.rejected).toHaveLength(0)
    expect(result.kept.filter((a) => a.kind === 'image')).toHaveLength(MAX_ATTACHMENT_IMAGES_PER_MESSAGE)
  })

  it('never drops the existing draft for a new batch', () => {
    const draft = Array.from({ length: 8 }, (_, i) => image(`d${i}`, 2.5 * MiB)) // 20 MiB
    const incoming = [image('x', MiB)]

    const result = boundDraftAttachments(draft, incoming)

    expect(result.kept).toHaveLength(8)
    expect(result.rejected.map((a) => a.id)).toEqual(['x'])
  })
})

describe('boundDraftAttachments per-file limits', () => {
  it('rejects images above 5 MiB before reading later batch entries', () => {
    const result = boundDraftAttachments([], [image('big', MAX_ATTACHMENT_IMAGE_BYTES + 1), image('ok', 1024)])

    expect(result.rejected.map((a) => a.id)).toEqual(['big'])
    expect(result.kept.map((a) => a.id)).toEqual(['ok'])
  })

  it('rejects text above 256 KiB', () => {
    const result = boundDraftAttachments([], [text('big', MAX_ATTACHMENT_TEXT_BYTES + 1), text('ok', 1024)])

    expect(result.rejected.map((a) => a.id)).toEqual(['big'])
    expect(result.kept.map((a) => a.id)).toEqual(['ok'])
  })
})

describe('boundDraftAttachments rejected previews', () => {
  it('returns previewUrl with rejected items so the caller can revoke blobs', () => {
    const draft = Array.from({ length: 8 }, (_, i) => image(`d${i}`, 2.5 * MiB, `blob:draft${i}`))
    const incoming = [image('x', MiB, 'blob:x')]

    const result = boundDraftAttachments(draft, incoming)

    expect(result.rejected[0]?.previewUrl).toBe('blob:x')
    // Existing drafts retain their previews without changes from the new batch.
    expect(result.kept.every((a) => a.previewUrl?.startsWith('blob:draft'))).toBe(true)
  })
})
