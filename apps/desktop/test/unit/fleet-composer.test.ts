import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { FLEET_IMAGE_LIMITS, type FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import {
  fleetUsageLimit,
  formatFleetTokens,
  formatFleetUsage,
  readBotDraft,
  selectionPatch,
  validateAttachments,
  writeBotDraft,
} from '../../src/renderer/lib/fleet/composer'
import { createFleetImageCache, holdFleetImage } from '../../src/renderer/lib/fleet/image-cache'
import type { FleetImageData } from '../../src/preload/api-fleet'

const file = (size: number, type = 'image/png') => ({ name: 'picture.png', size, type })
const model: FleetSelectionOption = {
  id: 'provider::model',
  providerId: 'provider',
  providerLabel: 'Provider',
  modelId: 'model',
  modelLabel: 'Model',
  efforts: ['medium', 'high'],
  fastMode: true,
}

describe('fleet composer helpers', () => {
  it('keeps each bot unsent draft apart until it is cleared', () => {
    writeBotDraft('bot-a', 'half written')
    writeBotDraft('bot-b', 'other')
    expect(readBotDraft('bot-a')).toBe('half written')
    expect(readBotDraft('bot-b')).toBe('other')
    writeBotDraft('bot-a', '')
    expect(readBotDraft('bot-a')).toBe('')
    expect(readBotDraft('bot-c')).toBe('')
  })

  it('validates attachment type, per-image size, count, and aggregate size', () => {
    expect(validateAttachments([], [file(1, 'application/zip')])).toBe('type')
    expect(validateAttachments([], [file(FLEET_IMAGE_LIMITS.attachmentMaxBytes + 1)])).toBe('size')
    expect(validateAttachments(Array(8).fill(file(1)), [file(1)])).toBe('count')
    expect(validateAttachments(Array(4).fill(file(5 * 1024 * 1024)), [file(1)])).toBe('total')
    expect(validateAttachments([], [file(3)])).toBeNull()
  })
  it('patches the effective selection and preserves supported settings', () => {
    const current = { providerId: 'provider', modelId: 'model', reasoning: 'high', fastMode: true }
    expect(selectionPatch(current, { reasoning: 'medium' })).toEqual({ ...current, reasoning: 'medium' })
    expect(selectionPatch(current, { fastMode: false })).toEqual({ ...current, fastMode: false })
    expect(selectionPatch(current, { model })).toEqual(current)
    expect(selectionPatch(current, { model: null })).toBeNull()
    expect(selectionPatch(null, { model })).toEqual({
      providerId: 'provider',
      modelId: 'model',
      reasoning: 'medium',
      fastMode: false,
    })
  })
  it('formats usage with the desktop meter convention', () => {
    expect(
      formatFleetUsage({
        contextUsedTokens: 804900,
        contextWindowTokens: 1000000,
        contextQuality: 'measured',
        costUsd: 129.69,
        updatedAt: null,
      })
    ).toBe('~804.9k/1.0M 80.5% · ~$129.69')
    expect(
      formatFleetUsage({
        contextUsedTokens: 22600,
        contextWindowTokens: 828400,
        contextQuality: 'estimated',
        costUsd: null,
        updatedAt: null,
      })
    ).toBe('~22.6k/828.4k 2.7%')
  })
  it('shows the owner cap as a limit only when it bounds the window', () => {
    const usage = {
      contextUsedTokens: 120_000,
      contextWindowTokens: 300_000,
      contextQuality: 'measured' as const,
      costUsd: null,
      updatedAt: null,
    }
    const compaction = { providerId: 'p', modelId: 'm', reasoning: null, fastMode: false, intervalTokens: 100_000 }
    expect(fleetUsageLimit(usage, { ...compaction, contextLimitTokens: 300_000 })).toBe(300_000)
    expect(
      fleetUsageLimit({ ...usage, contextWindowTokens: 200_000 }, { ...compaction, contextLimitTokens: 300_000 })
    ).toBeNull()
    expect(fleetUsageLimit(usage, compaction)).toBeNull()
    expect(fleetUsageLimit(usage, null)).toBeNull()
    expect(formatFleetTokens(300_000)).toBe('300.0k')
  })
  it('deduplicates concurrent reads and serves a loaded image again without reloading it', async () => {
    const load = vi.fn(async () => ({ mediaType: 'image/png' as const, data: new Uint8Array([1]) }))
    const cache = createFleetImageCache(load, { createObjectURL: () => 'blob:a', revokeObjectURL: vi.fn() })
    expect(await Promise.all([cache.acquire('bot', 'a'), cache.acquire('bot', 'a')])).toEqual(['blob:a', 'blob:a'])
    cache.release('bot', 'a')
    cache.release('bot', 'a')
    // Leaving the conversation and coming back shows the image at once.
    await expect(cache.acquire('bot', 'a')).resolves.toBe('blob:a')
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('evicts only images nobody shows, oldest first, within the count and byte budgets', async () => {
    const load = vi.fn(async () => ({ mediaType: 'image/png' as const, data: new Uint8Array(4) }))
    let next = 0
    const revokeObjectURL = vi.fn()
    const cache = createFleetImageCache(load, { createObjectURL: () => `blob:${next++}`, revokeObjectURL }, 2, 10)
    await cache.acquire('bot', 'a')
    await cache.acquire('bot', 'b')
    cache.release('bot', 'b')
    // 12 bytes would exceed the 10-byte budget: the unused `b` goes, the displayed `a` stays.
    await cache.acquire('bot', 'c')
    expect(revokeObjectURL.mock.calls).toEqual([['blob:1']])
    await cache.acquire('bot', 'd')
    // Everything left is on screen: over budget rather than revoking a displayed image.
    expect(revokeObjectURL.mock.calls).toEqual([['blob:1']])
    cache.release('bot', 'a')
    expect(revokeObjectURL.mock.calls).toEqual([['blob:1'], ['blob:0']])
  })
  it('keeps images loading across StrictMode replays and remounts, releasing each hold exactly once', async () => {
    let resolveLoad = (_value: FleetImageData) => {}
    const load = vi.fn((_botId: string, imageId: string) =>
      imageId === 'a'
        ? new Promise<FleetImageData>((resolve) => {
            resolveLoad = resolve
          })
        : Promise.resolve({ mediaType: 'image/png' as const, data: new Uint8Array([2, 2]) })
    )
    const revokeObjectURL = vi.fn()
    const cache = createFleetImageCache(
      load,
      { createObjectURL: (blob) => `blob:${(blob as Blob).size}`, revokeObjectURL },
      1
    )
    const ready = vi.fn()
    const failed = vi.fn()
    // `npm run dev`: the tile mounts, is torn down before its image arrives, and mounts again.
    const firstMount = holdFleetImage(cache, 'bot', 'a', ready, failed)
    firstMount()
    const secondMount = holdFleetImage(cache, 'bot', 'a', ready, failed)
    resolveLoad({ mediaType: 'image/png', data: new Uint8Array([1]) })
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith('blob:1'))
    expect(ready).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    // Still displayed by the second mount: another image cannot evict it.
    await cache.acquire('bot', 'b')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    // Once the tile unmounts nothing holds it: it is the one evicted, and only once.
    secondMount()
    secondMount()
    expect(revokeObjectURL.mock.calls).toEqual([['blob:1']])
  })
  it('shares one app-lifetime cache instead of one per conversation mount', () => {
    const source = readFileSync(
      new URL('../../src/renderer/components/fleet/BotConversation.tsx', import.meta.url),
      'utf8'
    )
    // A cache disposed on unmount broke every image when returning to a bot in dev mode.
    expect(source).toContain('const imageCache = fleetImageCache')
    expect(source).not.toMatch(/createFleetImageCache|dispose\(/)
    const tiles = readFileSync(
      new URL('../../src/renderer/components/fleet/BotTranscriptImages.tsx', import.meta.url),
      'utf8'
    )
    expect(tiles).toContain('holdFleetImage(')
  })
  it('wires the desktop controls and never uses a native select', () => {
    const source = readFileSync(new URL('../../src/renderer/components/fleet/BotComposer.tsx', import.meta.url), 'utf8')
    for (const name of [
      'ChatReasoningPicker',
      'FastModeChip',
      'ChatMicButton',
      'fleetSendMessage',
      'fleetListSelections',
    ])
      expect(source).toContain(name)
    expect(source).toContain('source.bot?.updateSelection(next)')
    expect(source).toContain('<ChatComposer')
    expect(source).not.toMatch(/<select\b/)
  })
})
