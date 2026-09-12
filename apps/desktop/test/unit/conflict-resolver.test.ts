import { describe, it, expect } from 'vitest'
import { precheckPrMergeable, buildMergePrompt, conflictAgentFailureStatus } from '../../src/main/conflict-resolver'

/**
 * Pure conflict resolver tests map PR state to precheck status and build the worker prompt (#321).
 * These checks require neither Electron nor Git execution nor delegation.
 * Orchestration and post-merge verification are tested separately with their runtime dependencies.
 */

describe('precheckPrMergeable tri-state detection requires a PR', () => {
  it('no PR returns no-pr', () => {
    expect(precheckPrMergeable(null)).toBe('no-pr')
    expect(precheckPrMergeable(undefined)).toBe('no-pr')
  })
  it('UNKNOWN requests refresh without offering resolution', () => {
    expect(precheckPrMergeable({ mergeable: 'UNKNOWN' })).toBe('unknown')
  })
  it('MERGEABLE returns not-conflicting and hides the action', () => {
    expect(precheckPrMergeable({ mergeable: 'MERGEABLE' })).toBe('not-conflicting')
  })
  it('CONFLICTING returns null to allow resolution', () => {
    expect(precheckPrMergeable({ mergeable: 'CONFLICTING' })).toBeNull()
  })
})

describe('buildMergePrompt merges, pushes with an explicit refspec and aborts cleanly', () => {
  const prompt = buildMergePrompt('main', 'feature-321-x')

  it('updates and merges the PR base', () => {
    expect(prompt).toContain("git fetch origin 'main'")
    expect(prompt).toContain("git merge --no-edit 'origin/main'")
  })

  it('pushes with the explicit HEAD:<branch> refspec', () => {
    expect(prompt).toContain("git push origin 'HEAD:feature-321-x'")
    // A push without a refspec could target the wrong upstream, such as origin/main.
    expect(prompt).not.toContain('git push origin main')
  })

  it('requests a clean abort on failure and prohibits --force', () => {
    expect(prompt).toContain('git merge --abort')
    expect(prompt.toLowerCase()).toContain('never use --force')
  })

  it('interpolates the supplied base and branch', () => {
    const p2 = buildMergePrompt('develop', 'feature/y')
    expect(p2).toContain("git fetch origin 'develop'")
    expect(p2).toContain("git push origin 'HEAD:feature/y'")
  })

  it('shell-quotes refs before inserting them into commands', () => {
    const p = buildMergePrompt("release/it's$(ok)", 'feat/x;echo-pwned')
    expect(p).toContain("git fetch origin 'release/it'\\''s$(ok)'")
    expect(p).toContain("git merge --no-edit 'origin/release/it'\\''s$(ok)'")
    expect(p).toContain("git push origin 'HEAD:feat/x;echo-pwned'")
  })
})

describe('conflictAgentFailureStatus', () => {
  it('distinguishes unavailable and failed workers without exposing delegation states', () => {
    expect(conflictAgentFailureStatus('agent-unavailable')).toBe('agent-unavailable')
    expect(conflictAgentFailureStatus('agent-failed')).toBe('agent-failed')
    expect(conflictAgentFailureStatus(undefined)).toBe('agent-failed')
  })
})
