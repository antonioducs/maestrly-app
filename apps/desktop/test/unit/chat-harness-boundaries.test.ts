import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Architectural guard: model-specific behavior lives in harness profile folders. Consumers read the
 * resolved contract; they never select strategies by model or profile name again.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SRC = join(ROOT, 'src')
const HARNESS = join(SRC, 'main/chat/harness')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const files = walk(SRC).map((path) => ({ path, rel: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
const outsideHarness = files.filter((file) => !file.path.startsWith(HARNESS))

/** Identity strings and legacy selector names that must not drive decisions outside the harness. */
const FORBIDDEN_SELECTORS = [
  /\bisAstra\w*\b/,
  /\bisFable\w*\b/,
  /\bisOpus\w*\b/,
  /\bresolveClaudeBehaviorProfile\b/,
  /\bresolveModelHarnessProfile\b/,
  /\bserializableReasoningEffortForProfile\b/,
  /['"]openai-gpt-6-astra-v1['"]/,
  /['"]openai-gpt-5\.6-sol-v1['"]/,
  /['"]maestrly-fable-5\.1-v1['"]/,
  /['"]maestrly-opus-5-v1['"]/,
  /['"]maestrly-openai-gpt-6-astra@v1['"]/,
  /['"]codex-gpt-5\.6-sol@5bed644['"]/,
  /['"]chat\.(astraHarness|fable51Profile|opus5Profile)['"]/,
]

/** Legitimate non-selecting occurrences: user-facing settings keep their persisted flag key. */
const ALLOWED: Array<{ file: RegExp; pattern: RegExp }> = [
  { file: /src\/main\/chat\/service\.ts$/, pattern: /['"]chat\.astraHarness['"]/ },
]

describe('harness architectural boundaries', () => {
  it('keeps model-specific selectors inside the harness directory', () => {
    const violations: string[] = []
    for (const file of outsideHarness) {
      for (const pattern of FORBIDDEN_SELECTORS) {
        const matches = file.text.match(new RegExp(pattern.source, 'g')) ?? []
        const disallowed = matches.filter(
          (match) => !ALLOWED.some((entry) => entry.file.test(file.rel) && entry.pattern.test(match))
        )
        if (disallowed.length) violations.push(`${file.rel}: ${[...new Set(disallowed)].join(', ')}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('removed the legacy per-model modules', () => {
    for (const legacy of [
      'src/main/chat/model-harness-profile.ts',
      'src/main/chat/behavior-profile.ts',
      'src/main/chat/behavior-prompt.ts',
      'src/main/chat/harness.ts',
      'src/main/chat/fable',
      'src/main/chat/opus',
      'src/main/chat/codex-subscription/astra-runtime-profile.ts',
      'src/main/chat/openai/prompt.ts',
      'src/main/chat/openai/astra-prompt.ts',
      'src/main/chat/github-copilot/harness.ts',
    ]) {
      expect(() => statSync(join(ROOT, legacy)), legacy).toThrow()
    }
  })

  it('never imports profile folders or the catalog from outside the harness core', () => {
    const offenders = outsideHarness
      .filter((file) => /harness\/profiles\/|harness\/registry'/.test(file.text))
      .map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('keeps shared and renderer free of main-side harness code and prompt text', () => {
    const clientSide = files.filter((file) => /src\/(shared|renderer)\//.test(file.rel))
    const offenders = clientSide
      .filter((file) => /from ['"][^'"]*main\/chat\/harness|\.md\?raw/.test(file.text))
      .map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('keeps the pure harness core free of SDKs, store, service and runners', () => {
    const pure = ['types.ts', 'schema.ts', 'registry.ts', 'resolver.ts', 'policies.ts', 'compatibility.ts'].map(
      (name) => files.find((file) => file.path === join(HARNESS, name))!
    )
    for (const file of pure) {
      expect(file.text, file.rel).not.toMatch(
        /from ['"](electron|@anthropic-ai|@ai-sdk|ai)['"]|\/store['"]|\/service['"]|\/runner['"]|node:fs/
      )
    }
  })

  it('declares every profile flag in the catalog instead of in consumers', () => {
    const flagReaders = outsideHarness.filter((file) => /getAppFlag\(\s*(FABLE|OPUS|ASTRA)/.test(file.text))
    expect(flagReaders.map((file) => file.rel)).toEqual([])
  })
})
