import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../src/renderer/components/chat/AttachmentImage.tsx', import.meta.url), 'utf8')

/**
 * Attachment thumbnail fetch limits (review loop round 5).
 * Sidecar fetching is lazy by viewport, with bounded concurrency, cancellation on unmount,
 * and idle release, matching GeneratedImageCard and ToolImagePreview.
 * Tests run in Node without a DOM, so they check source structure as in
 * chat-messagelist-renderpart-contract.test.ts.
 */
describe('AttachmentImage thumbnail memory limits', () => {
  it('observes the viewport with IntersectionObserver before fetching', () => {
    expect(source).toContain('new IntersectionObserver(')
    expect(source).toContain("rootMargin: '600px 0px'")
    // nearViewport gates artifact fetching before the fetch call.
    const gate = source.indexOf('if (!nearViewport) return')
    const fetch = source.indexOf('withImageFetchSlot(() =>')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(fetch).toBeGreaterThan(gate)
  })

  it('fetches sidecar bytes through the bounded withImageFetchSlot pool', () => {
    expect(source).toContain('withImageFetchSlot(() => window.api.chatAttachmentImage')
  })

  it('aborts fetch on unmount or part changes and revokes the object URL on cleanup', () => {
    expect(source).toContain('controller.abort(')
    expect(source).toContain('URL.revokeObjectURL(objectUrl)')
  })

  it('releases the object URL after IMAGE_OBJECT_URL_IDLE_MS outside the viewport', () => {
    expect(source).toContain('IMAGE_OBJECT_URL_IDLE_MS')
    expect(source).toContain('setTimeout(() => setNearViewport(false), IMAGE_OBJECT_URL_IDLE_MS)')
  })

  it('displays optimistic data URL and previewUrl immediately without fetching', () => {
    // Optimistic branches precede the artifact-backed branch, which alone fetches bytes.
    const dataBranch = source.indexOf("part.data?.startsWith('data:')")
    const previewBranch = source.indexOf('if (part.previewUrl)')
    const artifactFetch = source.indexOf('withImageFetchSlot(() =>')
    expect(dataBranch).toBeGreaterThanOrEqual(0)
    expect(previewBranch).toBeGreaterThan(dataBranch)
    expect(artifactFetch).toBeGreaterThan(previewBranch)
  })

  it('keeps the observer target mounted with nonzero area before fetching', () => {
    // Reserve nonzero thumbnail area so intersection-based loading can begin.
    expect(source).toContain('<span ref={containerRef} className="inline-flex">')
    expect(source).toContain('<span className="block h-20 w-20" />')
  })
})
