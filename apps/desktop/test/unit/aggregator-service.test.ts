import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { removeAggregatorDir } from '../../src/main/aggregator-service'

/**
 * Multi-repository aggregator cleanup must preserve real worktrees (#167).
 * Windows links can be junctions even when isSymbolicLink() returns false.
 * Recursive removal must never traverse such links into the real worktree.
 * These tests retain a directory link in the aggregator and exercise removal.
 * The linked worktree and all its contents must remain intact.
 */

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agg-test-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('removeAggregatorDir preserves surviving link targets', () => {
  it('preserves the real worktree when removing an aggregator with a surviving link', async () => {
    // A real worktree outside the aggregator with a sentinel file.
    const worktreeReal = path.join(tmp, 'worktree-real')
    mkdirSync(worktreeReal, { recursive: true })
    const sentinel = path.join(worktreeReal, 'IMPORTANTE.txt')
    writeFileSync(sentinel, 'do not delete me')

    // A directory link simulates a surviving junction or symlink.
    const aggDir = path.join(tmp, 'agg')
    mkdirSync(aggDir, { recursive: true })
    symlinkSync(worktreeReal, path.join(aggDir, 'backend'), 'dir')

    await removeAggregatorDir(aggDir)

    expect(existsSync(aggDir)).toBe(false) // The aggregator was removed.
    expect(existsSync(worktreeReal)).toBe(true) // The real worktree remains.
    expect(existsSync(sentinel)).toBe(true) // Its contents remain intact.
  })

  it('removes aggregator-owned files and preserves the link target', async () => {
    const worktreeReal = path.join(tmp, 'wt')
    mkdirSync(worktreeReal, { recursive: true })
    writeFileSync(path.join(worktreeReal, 'keep.txt'), 'keep')

    const aggDir = path.join(tmp, 'agg')
    mkdirSync(aggDir, { recursive: true })
    writeFileSync(path.join(aggDir, '.own-junk'), 'disposable') // Aggregator-owned disposable file.
    symlinkSync(worktreeReal, path.join(aggDir, 'frontend'), 'dir')

    await removeAggregatorDir(aggDir)

    expect(existsSync(aggDir)).toBe(false)
    expect(existsSync(path.join(worktreeReal, 'keep.txt'))).toBe(true)
  })

  it('removes an empty aggregator without links', async () => {
    const aggDir = path.join(tmp, 'agg-empty')
    mkdirSync(aggDir, { recursive: true })
    await removeAggregatorDir(aggDir)
    expect(existsSync(aggDir)).toBe(false)
  })

  it('does not throw when the aggregator does not exist', async () => {
    await expect(removeAggregatorDir(path.join(tmp, 'inexistente'))).resolves.toBeUndefined()
  })

  it('keeps the real worktree as a valid directory', async () => {
    const worktreeReal = path.join(tmp, 'wt2')
    mkdirSync(path.join(worktreeReal, 'sub'), { recursive: true })
    writeFileSync(path.join(worktreeReal, 'sub', 'a.txt'), 'x')
    const aggDir = path.join(tmp, 'agg3')
    mkdirSync(aggDir, { recursive: true })
    symlinkSync(worktreeReal, path.join(aggDir, 'repo'), 'dir')

    await removeAggregatorDir(aggDir)

    expect(readdirSync(path.join(worktreeReal, 'sub'))).toEqual(['a.txt'])
  })
})
