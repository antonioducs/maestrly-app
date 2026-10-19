import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCommit } from '../../scripts/check-commits.mjs'

test('accepts conventional English subjects with optional scopes, bodies, or truthful trailers', () => {
  for (const message of [
    'feat(chat): persist messages locally',
    'docs: explain setup',
    'refactor!: remove hosted auth',
    'fix(ci): accept standard metadata\n\nExplain why the change is needed.',
    'build(deps): update packages\n\nSigned-off-by: dependabot[bot] <support@github.com>',
    'docs: credit collaborators\n\nCo-authored-by: Example User <contributor@example.com>',
    'fix(chat): accept OpenAI API-key chats in Ask/Agent, and refresh Codex PATH after Git installs (#263)',
    `feat: ${'x'.repeat(94)} (#263)`,
  ]) {
    assert.equal(validateCommit(message), null)
  }
})

test('rejects empty, malformed, padded, and oversized commit subjects', () => {
  for (const message of [
    '',
    '\nfeat: hidden below an empty subject',
    'finish',
    'Feat: change',
    ' feat: change',
    'feat: change ',
    `feat: ${'x'.repeat(95)}`,
    `feat: ${'x'.repeat(95)} (#263)`,
    `feat: ${'x'.repeat(45)} (#263) ${'y'.repeat(42)}`,
    `feat: ${'x'.repeat(101)}`,
  ]) {
    assert.notEqual(validateCommit(message), null)
  }
})
