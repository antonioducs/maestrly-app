import { describe, expect, it } from 'vitest'
import { clearFileReveal, fileRevealKey, pendingReveal, revealFile } from '../src/ui/conversation/file-reveal'

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
})
