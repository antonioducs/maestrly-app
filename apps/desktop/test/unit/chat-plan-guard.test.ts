import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLAN_GUARD_PROMPT, shouldGuardPlanSubmission, type PlanGuardSignals } from '../../src/main/chat/plan-guard'

const ended: PlanGuardSignals = {
  behavior: 'plan',
  planSubmitted: false,
  aborted: false,
  hadError: false,
  interrupted: false,
  alreadyGuarded: false,
  planReviewAvailable: true,
}

describe('Plan-mode submission guard', () => {
  it('asks for the submission when a Plan turn ends well without a plan', () => {
    expect(shouldGuardPlanSubmission(ended)).toBe(true)
  })

  it('stays out when the plan was submitted', () => {
    expect(shouldGuardPlanSubmission({ ...ended, planSubmitted: true })).toBe(false)
  })

  it.each(['ask', 'agent', 'design', 'maestro'] as const)('does not apply in %s', (behavior) => {
    expect(shouldGuardPlanSubmission({ ...ended, behavior })).toBe(false)
  })

  it.each([
    ['aborted', { aborted: true }],
    ['failed', { hadError: true }],
    ['interrupted', { interrupted: true }],
  ] as const)('does not continue a turn that was %s', (_name, signal) => {
    expect(shouldGuardPlanSubmission({ ...ended, ...signal })).toBe(false)
  })

  it('never chains: the guard continuation (or a turn after it) does not guard again', () => {
    expect(shouldGuardPlanSubmission({ ...ended, alreadyGuarded: true })).toBe(false)
  })

  it('does not ask where nobody can review a plan', () => {
    expect(shouldGuardPlanSubmission({ ...ended, planReviewAvailable: false })).toBe(false)
  })

  it('tells the model to submit with review_plan without investigating again, or to ask what is missing', () => {
    expect(PLAN_GUARD_PROMPT).toContain('`review_plan`')
    expect(PLAN_GUARD_PROMPT).toContain('Do not investigate again')
    expect(PLAN_GUARD_PROMPT).toContain('`ask_question`')
  })
})

describe('Plan-mode guard wiring', () => {
  const service = readFileSync(path.resolve(__dirname, '../../src/main/chat/service.ts'), 'utf8')

  it('decides from the admitted behavior and the turn outcome, and runs an internal continuation marked as guarded', () => {
    const decision = service.slice(service.indexOf('shouldGuardPlanSubmission({'))
    expect(decision.slice(0, 520)).toContain('behavior: turnBehavior')
    expect(decision.slice(0, 520)).toContain('alreadyGuarded: opts?.planGuardContinued === true')
    expect(service).toContain('planGuardContinuation = { prompt: PLAN_GUARD_PROMPT }')
    const guard = service.slice(service.indexOf("failure: 'plan-guard'"))
    expect(guard.slice(0, 300)).toContain('planGuardContinued: true')
  })

  it('carries the mark through a Stop-hook continuation, so one user turn gets one guard at most', () => {
    const stop = service.slice(service.indexOf("failure: 'stop-hook'"))
    expect(stop.slice(0, 400)).toContain('planGuardContinued: true')
  })
})
