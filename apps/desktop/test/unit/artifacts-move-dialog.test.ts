import { describe, expect, it } from 'vitest'
import { moveDialogModel } from '../../src/renderer/components/artifacts/artifacts-view'
import type { ArtifactServerStatus, LegacyArtifactView } from '../../src/shared/artifacts'

const item = (id: string, overrides: Partial<LegacyArtifactView> = {}): LegacyArtifactView => ({
  id,
  title: `Title ${id}`,
  versionCount: 1,
  commentCount: 0,
  storageBytes: 100,
  shared: false,
  ...overrides,
})
const ready = (overrides: Partial<Extract<ArtifactServerStatus, { state: 'ready' }>> = {}): ArtifactServerStatus => ({
  state: 'ready',
  canOpen: true,
  canMove: true,
  artifactCount: 0,
  storageBytes: 0,
  quotaBytes: 1000,
  problem: null,
  ...overrides,
})

describe('moving artifacts from this computer', () => {
  it('fits what moves against the free space on the server', () => {
    const items = [item('a'), item('b', { storageBytes: 300 })]
    expect(moveDialogModel(items, ready())).toEqual({
      blocked: null,
      enableFirst: false,
      neededBytes: 400,
      freeBytes: 1000,
      fits: true,
      shared: [],
    })
    expect(moveDialogModel(items, ready({ storageBytes: 700 }))).toMatchObject({ freeBytes: 300, fits: false })
    expect(moveDialogModel(items, ready({ storageBytes: 2000 }))).toMatchObject({ freeBytes: 0, fits: false })
  })

  it('names the shared artifacts, which become private', () => {
    const shared = item('b', { shared: true })
    expect(moveDialogModel([item('a'), shared], ready()).shared).toEqual([shared])
  })

  it('turns hosting on first when it is off, without guessing the space', () => {
    expect(moveDialogModel([item('a')], { state: 'off', canMove: true })).toMatchObject({
      blocked: null,
      enableFirst: true,
      freeBytes: null,
      fits: true,
    })
  })

  it('says why moving cannot start', () => {
    const blocked = (server: ArtifactServerStatus | null) => moveDialogModel([item('a')], server).blocked
    expect(blocked({ state: 'absent' })).toBe('absent')
    expect(blocked({ state: 'unsupported' })).toBe('unsupported')
    expect(blocked(ready({ canMove: false }))).toBe('unsupported')
    expect(blocked({ state: 'off', canMove: false })).toBe('unsupported')
    expect(blocked({ state: 'unreachable' })).toBe('unreachable')
    expect(blocked(ready({ problem: 'storage' }))).toBe('unreachable')
    expect(blocked(null)).toBe('unreachable')
  })
})
