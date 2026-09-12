import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTempDirEventually } from '../e2e/helpers/temp-cleanup'

describe('E2E temporary directory cleanup', () => {
  it('removes files recreated shortly after the first successful removal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-cleanup-test-'))
    writeFileSync(path.join(root, 'initial'), 'initial')
    const recreate = setTimeout(() => {
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'late-helper-write'), 'late')
    }, 50)

    try {
      await removeTempDirEventually(root, 2_000)
      expect(existsSync(root)).toBe(false)
    } finally {
      clearTimeout(recreate)
      await removeTempDirEventually(root)
    }
  })
})
