import { describe, expect, it } from 'vitest'
import {
  clearFileReveal,
  fileRevealKey,
  pendingReveal,
  revealFile,
  revealStep,
} from '../src/ui/conversation/file-reveal'

describe('showing a file in its conversation', () => {
  it('keeps the file to show per conversation until it is shown', () => {
    const conversation = fileRevealKey('s', 'b')
    const run = fileRevealKey('s', 'b', 'run-1')
    expect(conversation).not.toBe(run)
    expect(pendingReveal(conversation)).toBeNull()
    revealFile(conversation, 'f-1')
    expect(pendingReveal(conversation)).toBe('f-1')
    expect(pendingReveal(run)).toBeNull()
    revealFile(run, 'f-2')
    clearFileReveal(conversation)
    expect(pendingReveal(conversation)).toBeNull()
    expect(pendingReveal(run)).toBe('f-2')
    clearFileReveal(run)
  })

  it('reads older pages until the file shows, and stops once a page asked for could not be read', () => {
    const page = { index: -1, loaded: true, loadingOlder: false, hasOlder: true, asked: false, failed: false }
    expect(revealStep({ ...page, loaded: false })).toBe('wait')
    expect(revealStep({ ...page, index: 3 })).toBe('found')
    expect(revealStep(page)).toBe('older')
    expect(revealStep({ ...page, asked: true, loadingOlder: true })).toBe('wait')
    expect(revealStep({ ...page, asked: true })).toBe('older')
    expect(revealStep({ ...page, asked: true, failed: true })).toBe('failed')
    // A read that failed before this file was asked for is tried again once.
    expect(revealStep({ ...page, failed: true })).toBe('older')
    expect(revealStep({ ...page, hasOlder: false })).toBe('missing')
  })
})
