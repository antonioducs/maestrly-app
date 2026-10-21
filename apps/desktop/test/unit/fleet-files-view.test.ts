import { describe, expect, it } from 'vitest'
import { fleetPublishedFileSchema, type FleetFilesUsage, type FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { tFor } from '../../src/shared/i18n'
import {
  clampPage,
  filesCountLevel,
  filesLevel,
  filesMeter,
  filesSpaceLevel,
  fleetFileKind,
  freshestUsage,
  pageCount,
  pageNumbers,
  pageOf,
  scopedFiles,
  sharedAtLabel,
  sharedIn,
  spaceLabel,
  usageSegments,
  visibleFiles,
} from '../../src/renderer/lib/fleet/files'

const MIB = 1024 ** 2
const GIB = 1024 ** 3

function file(id: string, overrides: Partial<FleetPublishedFile> = {}): FleetPublishedFile {
  return fleetPublishedFileSchema.parse({
    id,
    name: `${id}.pdf`,
    mediaType: 'application/pdf',
    byteSize: 100,
    sharedAt: '2026-10-20T10:00:00.000Z',
    origin: { kind: 'primary' },
    originGone: false,
    ...overrides,
  })
}

function usage(overrides: Partial<FleetFilesUsage> = {}): FleetFilesUsage {
  return {
    usedBytes: 100 * MIB,
    count: 10,
    quotaBytes: GIB,
    countMax: 200,
    deleteWithConversations: true,
    updatedAt: null,
    ...overrides,
  }
}

describe('bot shared files view logic', () => {
  it('classifies file kinds by mediaType and extension', () => {
    expect(fleetFileKind({ name: 'clip.mov', mediaType: 'application/octet-stream' })).toBe('video')
    expect(fleetFileKind({ name: 'photo.png', mediaType: 'image/png' })).toBe('image')
    expect(fleetFileKind({ name: 'bundle.zip', mediaType: 'application/zip' })).toBe('archive')
    expect(fleetFileKind({ name: 'x.gz', mediaType: 'application/octet-stream' })).toBe('archive')
    expect(fleetFileKind({ name: 'report.pdf', mediaType: 'application/pdf' })).toBe('document')
  })

  it('computes space and count warning levels', () => {
    expect(filesLevel(null)).toBe('ok')
    expect(filesSpaceLevel(usage({ usedBytes: Math.ceil(0.85 * GIB), quotaBytes: GIB }))).toBe('near')
    expect(filesSpaceLevel(usage({ usedBytes: GIB - 5 * MIB, quotaBytes: GIB }))).toBe('full')
    expect(filesCountLevel(usage({ count: 180, countMax: 200 }))).toBe('near')
    expect(filesCountLevel(usage({ count: 200, countMax: 200 }))).toBe('full')
    expect(filesLevel(usage({ usedBytes: Math.ceil(0.85 * GIB), count: 200 }))).toBe('full')
  })

  it('picks whichever of space or count is closer to the limit for the header meter', () => {
    expect(filesMeter(usage({ usedBytes: 71 * MIB, quotaBytes: GIB, count: 188, countMax: 200 }))).toEqual({
      text: '188/200',
      ratio: 0.94,
    })
    expect(filesMeter(usage({ usedBytes: GIB - 6 * MIB, quotaBytes: GIB, count: 36, countMax: 200 }))).toMatchObject({
      text: '99%',
    })
  })

  it('filters by scope, type, and search query, and sorts by recent, oldest, size, or name', () => {
    const a = file('f-a', {
      name: 'Alpha.pdf',
      mediaType: 'application/pdf',
      byteSize: 200,
      sharedAt: '2026-10-20T08:00:00.000Z',
      origin: { kind: 'primary' },
    })
    const b = file('f-b', {
      name: 'beta.mp4',
      mediaType: 'video/mp4',
      byteSize: 500,
      sharedAt: '2026-10-20T12:00:00.000Z',
      origin: { kind: 'routine', runId: 'r1', title: 'Relatório Diário' },
    })
    const c = file('f-c', {
      name: 'álbum.png',
      mediaType: 'image/png',
      byteSize: 500,
      sharedAt: '2026-10-20T14:00:00.000Z',
      origin: { kind: 'thread', threadId: 't1', title: 'Research Bot' },
    })
    const all = [a, b, c]

    expect(sharedIn(a, { kind: 'primary' })).toBe(true)
    expect(sharedIn(b, { kind: 'primary' })).toBe(false)
    expect(scopedFiles(all, { kind: 'primary' }).map((f) => f.id)).toEqual(['f-a'])
    expect(scopedFiles(all, { kind: 'routine', runId: 'r1' }).map((f) => f.id)).toEqual(['f-b'])
    expect(scopedFiles(all, { kind: 'thread', threadId: 't1' }).map((f) => f.id)).toEqual(['f-c'])
    expect(scopedFiles(all, null).map((f) => f.id)).toEqual(['f-a', 'f-b', 'f-c'])

    expect(
      visibleFiles(all, { conversation: null, query: 'relatório', kind: 'all', sort: 'recent' }, 'pt-BR').map(
        (f) => f.id
      )
    ).toEqual(['f-b'])
    expect(
      visibleFiles(all, { conversation: null, query: 'ALPHA', kind: 'all', sort: 'recent' }).map((f) => f.id)
    ).toEqual(['f-a'])
    expect(
      visibleFiles(all, { conversation: null, query: '', kind: 'video', sort: 'recent' }, 'pt-BR').map((f) => f.id)
    ).toEqual(['f-b'])

    expect(
      visibleFiles(all, { conversation: null, query: '', kind: 'all', sort: 'recent' }, 'pt-BR').map((f) => f.id)
    ).toEqual(['f-c', 'f-b', 'f-a'])
    expect(
      visibleFiles(all, { conversation: null, query: '', kind: 'all', sort: 'oldest' }, 'pt-BR').map((f) => f.id)
    ).toEqual(['f-a', 'f-b', 'f-c'])
    expect(
      visibleFiles(all, { conversation: null, query: '', kind: 'all', sort: 'size' }, 'pt-BR').map((f) => f.id)
    ).toEqual(['f-c', 'f-b', 'f-a'])
    expect(
      visibleFiles(all, { conversation: null, query: '', kind: 'all', sort: 'name' }, 'pt-BR').map((f) => f.id)
    ).toEqual(['f-c', 'f-a', 'f-b'])
  })

  it('paginates lists and builds compact page numbers', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(29)).toBe(3)
    expect(clampPage(5, 12)).toBe(2)
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(pageNumbers(1, 19)).toEqual([1, 2, 3, 4, 'gap', 19])
    expect(pageNumbers(10, 19)).toEqual([1, 'gap', 9, 10, 11, 'gap', 19])
    expect(pageNumbers(19, 19)).toEqual([1, 'gap', 16, 17, 18, 19])
    const items = Array.from({ length: 29 }, (_, i) => i)
    expect(pageOf(items, 3)).toHaveLength(9)
  })

  it('orders usage segments by kind (video, image, document, archive) then by size descending', () => {
    const doc = file('f-doc', { name: 'a.pdf', mediaType: 'application/pdf', byteSize: 100 })
    const arch = file('f-arch', { name: 'b.zip', mediaType: 'application/zip', byteSize: 400 })
    const vidSmall = file('f-v1', { name: 'c.mp4', mediaType: 'video/mp4', byteSize: 200 })
    const vidBig = file('f-v2', { name: 'd.mp4', mediaType: 'video/mp4', byteSize: 300 })
    const img = file('f-img', { name: 'e.png', mediaType: 'image/png', byteSize: 150 })
    const segments = usageSegments([doc, arch, vidSmall, vidBig, img], 1000)
    expect(segments.map((s) => s.id)).toEqual(['f-v2', 'f-v1', 'f-img', 'f-doc', 'f-arch'])
    expect(segments[0]?.percent).toBe(30)
  })

  it('formats sharedAt relative to today and yesterday or as a short date', () => {
    const t = tFor('pt-BR', 'fleet')
    const now = new Date(2026, 9, 20, 15, 0, 0).getTime()
    const today = new Date(2026, 9, 20, 11, 20, 0).toISOString()
    const yesterday = new Date(2026, 9, 19, 18, 5, 0).toISOString()
    const older = new Date(2026, 9, 10, 9, 0, 0)
    expect(sharedAtLabel(today, now, 'pt-BR', t)).toBe('hoje, 11:20')
    expect(sharedAtLabel(yesterday, now, 'pt-BR', t)).toBe('ontem, 18:05')
    expect(sharedAtLabel(older.toISOString(), now, 'pt-BR', t)).toBe(
      new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' }).format(older)
    )
  })
  it('reads a nearly full gigabyte in gigabytes, with two decimals', () => {
    const MB = 1024 ** 2
    expect(spaceLabel(6 * MB, 'en')).toBe('6 MB')
    expect(spaceLabel(819 * MB, 'en')).toBe('819 MB')
    expect(spaceLabel(1018 * MB, 'en')).toBe('0.99 GB')
    expect(spaceLabel(1018 * MB, 'pt-BR')).toBe('0,99 GB')
    expect(spaceLabel(1024 * MB, 'en')).toBe('1 GB')
    expect(spaceLabel(20 * 1024 * MB, 'pt-BR')).toBe('20 GB')
  })
  it('reads the newer of the drawer list and the bot status', () => {
    const listed = usage({ usedBytes: 10, updatedAt: '2026-10-20T10:00:05.000Z' })
    const reported = usage({ usedBytes: 20, updatedAt: '2026-10-20T10:00:01.000Z' })
    expect(freshestUsage(listed, reported)).toBe(listed)
    expect(freshestUsage(reported, listed)).toBe(listed)
    expect(freshestUsage(null, reported)).toBe(reported)
    expect(freshestUsage(listed, undefined)).toBe(listed)
    expect(freshestUsage(null, null)).toBeNull()
    expect(freshestUsage(usage({ updatedAt: null }), reported)).toBe(reported)
  })
})
