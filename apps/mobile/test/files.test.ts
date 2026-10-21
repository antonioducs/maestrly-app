import {
  fleetFileQuotaBytes,
  fleetPublishedFileSchema,
  type FleetFilesUsage,
  type FleetPublishedFile,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { botRecord } from '../src/fleet/factories'
import {
  fileCategory,
  filesCountLevel,
  filesLevel,
  filesManageSupported,
  filesShare,
  filesSpaceLevel,
  formatSpace,
  freshestUsage,
  quotaChoice,
  visibleFiles,
  type FilesFilter,
} from '../src/fleet/files'

const MiB = 1024 ** 2
const GiB = 1024 * MiB

const usage = (overrides: Partial<FleetFilesUsage> = {}): FleetFilesUsage => ({
  usedBytes: 0,
  count: 0,
  quotaBytes: GiB,
  countMax: 200,
  deleteWithConversations: true,
  updatedAt: null,
  ...overrides,
})

const published = (id: string, overrides: Partial<FleetPublishedFile> = {}): FleetPublishedFile =>
  fleetPublishedFileSchema.parse({
    id,
    name: `${id}.pdf`,
    mediaType: 'application/pdf',
    byteSize: MiB,
    sharedAt: '2026-10-12T12:00:00.000Z',
    origin: { kind: 'primary' },
    originGone: false,
    ...overrides,
  })

const filter = (overrides: Partial<FilesFilter> = {}): FilesFilter => ({
  scope: 'bot',
  query: '',
  category: 'all',
  sort: 'recent',
  ...overrides,
})
const ids = (files: FleetPublishedFile[]) => files.map((file) => file.id)

describe('files a bot shared', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('manages files only when both the server and the bot can', () => {
    const managing = botRecord({ id: 'pixel', name: 'Pixel', capabilities: ['files-manage'] })
    const plain = botRecord({ id: 'juno', name: 'Juno', capabilities: ['files'] })
    expect(filesManageSupported(['files-manage'], managing)).toBe(true)
    expect(filesManageSupported(['files'], managing)).toBe(false)
    expect(filesManageSupported(['files-manage'], plain)).toBe(false)
  })

  it('tells when the space or the count of files is near or at its limit', () => {
    expect(filesSpaceLevel(usage({ usedBytes: 100 * MiB }))).toBe('ok')
    expect(filesSpaceLevel(usage({ usedBytes: Math.ceil(0.85 * GiB) }))).toBe('near')
    expect(filesSpaceLevel(usage({ usedBytes: GiB - 9 * MiB }))).toBe('full')
    expect(filesCountLevel(usage({ count: 180 }))).toBe('near')
    expect(filesCountLevel(usage({ count: 200 }))).toBe('full')
    expect(filesLevel(null)).toBe('ok')
    expect(filesLevel(usage({ usedBytes: Math.ceil(0.85 * GiB), count: 200 }))).toBe('full')
  })

  it('measures how full the bot is by whichever limit is closer', () => {
    expect(filesShare(usage({ usedBytes: 71 * MiB, count: 188 }))).toBe(0.94)
  })

  it('keeps the newest reading of the space', () => {
    const older = usage({ usedBytes: 1, updatedAt: '2026-10-12T12:00:00.000Z' })
    const newer = usage({ usedBytes: 2, updatedAt: '2026-10-12T13:00:00.000Z' })
    const undated = usage({ usedBytes: 3 })
    expect(freshestUsage(older, newer)).toBe(newer)
    expect(freshestUsage(newer, older)).toBe(newer)
    expect(freshestUsage(undated, older)).toBe(older)
    expect(freshestUsage(older, undated)).toBe(older)
    expect(freshestUsage(null, null)).toBeNull()
  })

  it('sorts files into videos, images, documents and archives', () => {
    expect(fileCategory({ name: 'clip.mov', mediaType: 'application/octet-stream' })).toBe('video')
    expect(fileCategory({ name: 'shot', mediaType: 'image/png' })).toBe('image')
    expect(fileCategory({ name: 'x.zip', mediaType: 'application/octet-stream' })).toBe('archive')
    expect(fileCategory({ name: 'y.gz', mediaType: 'application/octet-stream' })).toBe('archive')
    expect(fileCategory({ name: 'report.pdf', mediaType: 'application/pdf' })).toBe('document')
  })

  it('scopes, searches, filters and sorts the files', () => {
    const files = [
      published('a', { name: 'Beta.pdf', byteSize: 3 * MiB, sharedAt: '2026-10-12T10:00:00.000Z' }),
      published('b', {
        name: 'alpha.png',
        mediaType: 'image/png',
        byteSize: 3 * MiB,
        sharedAt: '2026-10-12T11:00:00.000Z',
        origin: { kind: 'routine', runId: 'run-1', title: 'Weekly Review' },
      }),
      published('c', {
        name: 'gamma.mp4',
        mediaType: 'video/mp4',
        byteSize: 5 * MiB,
        sharedAt: '2026-10-12T09:00:00.000Z',
        origin: { kind: 'thread', threadId: 'th-1', title: 'Ledger' },
      }),
    ]
    expect(ids(visibleFiles(files, filter({ scope: 'conversation' }), 'en'))).toEqual(['a'])
    expect(ids(visibleFiles(files, filter({ query: 'BETA' }), 'en'))).toEqual(['a'])
    expect(ids(visibleFiles(files, filter({ query: 'weekly' }), 'en'))).toEqual(['b'])
    expect(ids(visibleFiles(files, filter({ query: 'ledger' }), 'en'))).toEqual(['c'])
    expect(ids(visibleFiles(files, filter({ category: 'image' }), 'en'))).toEqual(['b'])
    expect(ids(visibleFiles(files, filter({ sort: 'recent' }), 'en'))).toEqual(['b', 'a', 'c'])
    expect(ids(visibleFiles(files, filter({ sort: 'oldest' }), 'en'))).toEqual(['c', 'a', 'b'])
    // Same size: the newer first.
    expect(ids(visibleFiles(files, filter({ sort: 'size' }), 'en'))).toEqual(['c', 'b', 'a'])
    expect(ids(visibleFiles(files, filter({ sort: 'name' }), 'en'))).toEqual(['b', 'a', 'c'])
  })

  it('writes sizes in MB, then in GB with two decimals', () => {
    expect(formatSpace(6 * MiB, 'en')).toBe('6.0 MB')
    expect(formatSpace(6 * MiB, 'pt-BR')).toBe('6,0 MB')
    expect(formatSpace(819 * MiB, 'en')).toBe('819 MB')
    expect(formatSpace(1017 * MiB, 'en')).toBe('0.99 GB')
    expect(formatSpace(1017 * MiB, 'pt-BR')).toBe('0,99 GB')
    expect(formatSpace(1024 * MiB, 'en')).toBe('1 GB')
    expect(formatSpace(12_300, 'en')).toBe('12 KB')
  })

  it('writes sizes without number formats, as on Hermes', () => {
    vi.stubGlobal('Intl', {
      ...Intl,
      NumberFormat: () => {
        throw new Error('NumberFormat is not available')
      },
    })
    expect(formatSpace(1017 * MiB, 'en')).toBe('0.99 GB')
  })

  it('offers only spaces the files fit in and the disk can give', () => {
    const used = usage({ usedBytes: 1.5 * GiB, quotaBytes: fleetFileQuotaBytes(2) })
    expect(quotaChoice(1, used, null)).toBe('tooSmall')
    expect(quotaChoice(2, used, null)).toBe('current')
    expect(quotaChoice(20, used, 10 * GiB)).toBe('tooLarge')
    expect(quotaChoice(5, used, null)).toBe('ok')
  })
})
