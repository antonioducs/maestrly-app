import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { cachedFilePath, fileKind, removedFileIds } from '../src/fleet/bot-files'
import { formatBytes } from '../src/fleet/format'
import { emptyFiles } from '../src/fleet/state'

const file = (name: string, mediaType: string): FleetFileRef => ({ id: 'f1', name, mediaType, byteSize: 1024 })

describe('files a bot shares', () => {
  it('plays the videos each phone can play, and names images and anything else', () => {
    for (const os of ['ios', 'android'] as const) {
      expect(fileKind(file('a.mp4', 'video/mp4'), os)).toBe('video')
      expect(fileKind(file('a.m4v', 'video/x-m4v'), os)).toBe('video')
      expect(fileKind(file('a.mov', 'video/quicktime'), os)).toBe('video')
      expect(fileKind(file('a.png', 'image/png'), os)).toBe('image')
      expect(fileKind(file('a.csv', 'text/csv'), os)).toBe('other')
      expect(fileKind(file('a.avi', 'video/x-msvideo'), os)).toBe('other')
      // Bots from before video types were known send videos as raw bytes; their extension still counts.
      expect(fileKind(file('clip.MP4', 'application/octet-stream'), os)).toBe('video')
      expect(fileKind(file('notes.bin', 'application/octet-stream'), os)).toBe('other')
    }
    // iOS has no WebM decoder.
    expect(fileKind(file('a.webm', 'video/webm'), 'android')).toBe('video')
    expect(fileKind(file('a.webm', 'video/webm'), 'ios')).toBe('other')
    expect(fileKind(file('a.webm', 'application/octet-stream'), 'ios')).toBe('other')
  })

  it('keeps each download apart in the cache, under a name that cannot leave its folder', () => {
    expect(cachedFilePath('s1', 'juno', 'f1', '../a b.mp4')).toBe('bot-files/s1/juno/f1/_a_b.mp4')
    expect(cachedFilePath('s 1', 'juno', 'f1', '..')).toBe('bot-files/s_1/juno/f1/file')
    expect(
      cachedFilePath('s1', 'juno', 'f1', 'x'.repeat(200) + '.mp4')
        .split('/')
        .at(-1)
    ).toHaveLength(120)
  })

  it('says how big a file is', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MB')
    expect(formatBytes(3.2 * 1024 * 1024 * 1024)).toBe('3.2 GB')
  })

  it('knows which files the bot deleted lately, so their cards say so', () => {
    expect(removedFileIds(undefined).size).toBe(0)
    expect(removedFileIds(emptyFiles).size).toBe(0)
    const usage = {
      usedBytes: 0,
      count: 0,
      quotaBytes: 1024 ** 3,
      countMax: 200,
      deleteWithConversations: true,
      updatedAt: null,
    }
    const removed = removedFileIds({
      ...emptyFiles,
      loaded: true,
      list: {
        files: [],
        removed: [
          { id: 'f-1', removedAt: '2026-10-12T12:00:00.000Z' },
          { id: 'f-2', removedAt: '2026-10-12T12:00:01.000Z' },
        ],
        usage,
        diskFreeBytes: null,
      },
    })
    expect([...removed].sort()).toEqual(['f-1', 'f-2'])
  })
})
