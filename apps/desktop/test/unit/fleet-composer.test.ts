import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { FLEET_IMAGE_LIMITS, type FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import { formatFleetUsage, selectionPatch, validateAttachments } from '../../src/renderer/lib/fleet/composer'
import { bindFleetImageCache, createFleetImageCache } from '../../src/renderer/lib/fleet/image-cache'

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
  it('validates attachment type, per-image size, count, and aggregate size', () => {
    expect(validateAttachments([], [file(1, 'text/plain')])).toBe('type')
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
  it('deduplicates image reads and revokes least recently used URLs', async () => {
    const load = vi.fn(async () => ({ mediaType: 'image/png' as const, data: new Uint8Array([1]) }))
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:a').mockReturnValueOnce('blob:b')
    const revokeObjectURL = vi.fn()
    const cache = createFleetImageCache(load, { createObjectURL, revokeObjectURL }, 1)
    expect(await Promise.all([cache.get('bot', 'a'), cache.get('bot', 'a')])).toEqual(['blob:a', 'blob:a'])
    expect(load).toHaveBeenCalledTimes(1)
    await cache.get('bot', 'b')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a')
    cache.dispose()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b')
  })
  it('keeps serving images after a StrictMode effect replay (setup, cleanup, setup)', async () => {
    const load = vi.fn(async () => ({ mediaType: 'image/png' as const, data: new Uint8Array([1]) }))
    const revokeObjectURL = vi.fn()
    const cache = createFleetImageCache(load, { createObjectURL: () => 'blob:a', revokeObjectURL })
    // `npm run dev` mounts every effect twice; a memoized cache must survive the simulated unmount.
    const cleanup = bindFleetImageCache(cache)
    cleanup()
    const cleanupAgain = bindFleetImageCache(cache)
    await expect(cache.get('bot', 'a')).resolves.toBe('blob:a')
    // A real unmount still releases every object URL and refuses new ones.
    cleanupAgain()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a')
    await expect(cache.get('bot', 'b')).rejects.toThrow('Image cache disposed')
  })
  it('binds the conversation image cache through the StrictMode-safe effect', () => {
    const source = readFileSync(
      new URL('../../src/renderer/components/fleet/BotConversation.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('useEffect(() => bindFleetImageCache(imageCache), [imageCache])')
    expect(source).not.toContain('imageCache.dispose()')
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
