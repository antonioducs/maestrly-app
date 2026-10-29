import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLogPage } from '../../src/main/runner/log-page'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function logFile(content: string | Buffer): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runner-log-page-'))
  dirs.push(dir)
  const file = path.join(dir, 'job.log')
  writeFileSync(file, content)
  return file
}

describe('reading a job log in pieces', () => {
  it('reads a log that does not exist yet as empty', async () => {
    expect(await readLogPage('/nonexistent/job.log', null)).toEqual({ start: 0, next: 0, size: 0, text: '' })
  })

  it('reads on from where the last piece ended, and reads nothing past the end', async () => {
    const file = logFile('one\ntwo\nthree\n')
    const first = await readLogPage(file, 0, 6)
    expect(first).toEqual({ start: 0, next: 6, size: 14, text: 'one\ntw' })
    const second = await readLogPage(file, first.next, 100)
    expect(second).toEqual({ start: 6, next: 14, size: 14, text: 'o\nthree\n' })
    expect(await readLogPage(file, second.next)).toEqual({ start: 14, next: 14, size: 14, text: '' })
    expect(await readLogPage(file, 999)).toEqual({ start: 14, next: 14, size: 14, text: '' })
  })

  it('reads the end of the log from the start of a line', async () => {
    const file = logFile('first line\nsecond line\nthird\n')
    const tail = await readLogPage(file, null, 15)
    expect(tail.text).toBe('third\n')
    expect(tail.next).toBe(tail.size)
    // A log shorter than the piece is read whole.
    expect((await readLogPage(file, null)).text).toBe('first line\nsecond line\nthird\n')
    // One long line is read from where the piece begins.
    expect((await readLogPage(logFile('x'.repeat(100)), null, 10)).text).toBe('x'.repeat(10))
  })

  it('never splits a character, so reading on loses nothing', async () => {
    const text = 'ação ✓ 🎬 fim'
    const file = logFile(text)
    let offset = 0
    let read = ''
    for (let i = 0; i < 100 && offset < Buffer.byteLength(text); i++) {
      const page = await readLogPage(file, offset, 3)
      read += page.text
      expect(page.text).not.toContain('\uFFFD')
      offset = page.next
    }
    expect(read).toBe(text)
    // An offset inside a character starts at the next one.
    expect((await readLogPage(file, 2, 100)).text).toBe('ão ✓ 🎬 fim')
  })

  it('keeps a piece within the largest a read returns', async () => {
    const file = logFile('a'.repeat(300 * 1024))
    const page = await readLogPage(file, 0, 10 * 1024 * 1024)
    expect(page.next).toBe(256 * 1024)
  })
})
