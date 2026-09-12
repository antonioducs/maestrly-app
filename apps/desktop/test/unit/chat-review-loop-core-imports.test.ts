import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as legacy from '../../src/main/chat/chatgpt-web/review-loop'
import { createReviewLoopController as createCoreReviewLoopController } from '../../src/main/chat/review-loop/controller'
import {
  isSafeRelativePath,
  validateFindingsShape,
  validateRemainingFindingsShape,
} from '../../src/main/chat/review-loop/evidence'
import { DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS } from '../../src/main/chat/review-loop/types'
import { fingerprintOf } from '../../src/main/chat/review-loop/workspace'

describe('review-loop core import compatibility', () => {
  it('keeps the existing ChatGPT Web utility exports wired to the generic core', () => {
    expect(legacy.DEFAULT_MAX_ITERATIONS).toBe(DEFAULT_MAX_ITERATIONS)
    expect(legacy.HARD_MAX_ITERATIONS).toBe(HARD_MAX_ITERATIONS)
    expect(legacy.fingerprintOf).toBe(fingerprintOf)
    expect(legacy.isSafeRelativePath).toBe(isSafeRelativePath)
    expect(legacy.validateFindingsShape).toBe(validateFindingsShape)
    expect(legacy.validateRemainingFindingsShape).toBe(validateRemainingFindingsShape)
    expect(typeof legacy.createReviewLoopController).toBe('function')
    expect(typeof createCoreReviewLoopController).toBe('function')
  })

  it('does not pull concrete ChatGPT Web, browser-surface, preview, or React types into the controller', () => {
    const controllerPath = fileURLToPath(new URL('../../src/main/chat/review-loop/controller.ts', import.meta.url))
    const source = readFileSync(controllerPath, 'utf8')

    expect(source).not.toMatch(/chatgpt-web|browser-surface|preview-runtime|from ['"]react/)
  })
})
