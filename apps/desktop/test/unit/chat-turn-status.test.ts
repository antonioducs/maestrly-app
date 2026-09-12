import { describe, it, expect } from 'vitest'
import { finalTurnCompletion, finalTurnStatus } from '../../src/main/chat/turn-status'

describe('finalTurnStatus — final chat turn status', () => {
  it('normal turn → ready with the green status', () => {
    expect(finalTurnStatus({ aborted: false, hadError: false, interrupted: false })).toBe('ready')
  })

  it('user abort → idle (does not advance the interrupted card)', () => {
    expect(finalTurnStatus({ aborted: true, hadError: false, interrupted: false })).toBe('idle')
  })

  it('stream failure → error', () => {
    expect(finalTurnStatus({ aborted: false, hadError: true, interrupted: false })).toBe('error')
  })

  it('interrupted stream → error, preventing the card auto-advance regression', () => {
    expect(finalTurnStatus({ aborted: false, hadError: false, interrupted: true })).toBe('error')
  })

  it('abort takes precedence over interrupted/error (intentional user stop → idle)', () => {
    expect(finalTurnStatus({ aborted: true, hadError: true, interrupted: true })).toBe('idle')
  })

  it('a submitted plan keeps ready and marks the transition as silent', () => {
    expect(finalTurnCompletion({ aborted: false, hadError: false, interrupted: false, planSubmitted: true })).toEqual({
      status: 'ready',
      silentReady: true,
    })
  })

  it('normal turns, aborts, errors, and interruptions do not wrongly suppress sound', () => {
    expect(finalTurnCompletion({ aborted: false, hadError: false, interrupted: false, planSubmitted: false })).toEqual({
      status: 'ready',
      silentReady: false,
    })
    expect(finalTurnCompletion({ aborted: true, hadError: false, interrupted: false, planSubmitted: true })).toEqual({
      status: 'idle',
      silentReady: false,
    })
    expect(finalTurnCompletion({ aborted: false, hadError: true, interrupted: false, planSubmitted: true })).toEqual({
      status: 'error',
      silentReady: false,
    })
    expect(finalTurnCompletion({ aborted: false, hadError: false, interrupted: true, planSubmitted: true })).toEqual({
      status: 'error',
      silentReady: false,
    })
  })
})

// CUT_FINISH_REASONS is shared by the UI banner, service error status and card advancement,
// and runner transparent retry. Assert the set to prevent repeated regressions to ready.
import { CUT_FINISH_REASONS } from '../../src/shared/chat'

describe('CUT_FINISH_REASONS — interrupted turn classification', () => {
  it('includes interruption reasons, including codex-proxy other/unknown and MAX_STEPS tool-calls', () => {
    for (const r of ['interrupted', 'length', 'other', 'tool-calls', 'unknown']) {
      expect(CUT_FINISH_REASONS.has(r), r).toBe(true)
    }
  })
  it('excludes clean completion, abort, and filtering', () => {
    for (const r of ['stop', 'aborted', 'content-filter']) {
      expect(CUT_FINISH_REASONS.has(r), r).toBe(false)
    }
  })
})
