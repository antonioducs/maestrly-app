import { expect, it } from 'vitest'
import { parseReviewResult, REVIEW_RESULT_BLOCK, reviewContract } from '../../src/main/platform/delegation-review'
import type { CodeRevision } from '@maestrly/protocol'

const revision: CodeRevision = {
  id: 'revision-1',
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  contentDigest: 'd'.repeat(64),
  snapshotArtifactId: null,
  capturedAt: '2026-09-20T00:00:00.000Z',
}

const block = (value: unknown) => '```' + REVIEW_RESULT_BLOCK + '\n' + JSON.stringify(value, null, 2) + '\n```'

const approved = {
  verdict: 'approved',
  codeRevisionDigest: revision.contentDigest,
  findings: [],
  criteriaCoverage: [{ criterion: 'Tests pass', satisfied: true, evidence: 'npm test' }],
  notes: 'Looks correct.',
}

it('states the reviewed revision and the acceptance criteria in the contract', () => {
  const contract = reviewContract(revision, ['Tests pass', 'No regression'])
  expect(contract).toContain(revision.contentDigest)
  expect(contract).toContain(revision.headCommit!)
  expect(contract).toContain('- Tests pass')
  expect(contract).toContain('- No regression')
  expect(contract).toContain('read-only')
  const empty = reviewContract(revision, [])
  expect(empty).toContain('no explicit acceptance criteria')
})

it('accepts a verdict bound to the reviewed revision and keeps the last block', () => {
  const outcome = parseReviewResult(
    ['Some reasoning.', block({ ...approved, notes: 'draft' }), 'More reasoning.', block(approved)].join('\n'),
    revision
  )
  expect(outcome.ok).toBe(true)
  if (outcome.ok) {
    expect(outcome.result.verdict).toBe('approved')
    expect(outcome.result.notes).toBe('Looks correct.')
  }
})

it('rejects a missing, malformed or unbound verdict', () => {
  expect(parseReviewResult('The change looks good to me.', revision)).toMatchObject({
    ok: false,
    failure: 'missing-block',
  })
  expect(parseReviewResult('```' + REVIEW_RESULT_BLOCK + '\n{not json}\n```', revision)).toMatchObject({
    ok: false,
    failure: 'invalid-json',
  })
  expect(parseReviewResult(block({ verdict: 'approved' }), revision)).toMatchObject({
    ok: false,
    failure: 'invalid-shape',
  })
  expect(
    parseReviewResult(block({ ...approved, codeRevisionDigest: 'e'.repeat(64) }), revision)
  ).toMatchObject({ ok: false, failure: 'revision-mismatch' })
})

it('refuses an approval that contradicts its own findings or criteria', () => {
  const withFinding = {
    ...approved,
    findings: [
      {
        id: 'missing-test',
        severity: 'important',
        title: 'No test for the new branch',
        details: 'The new code path is untested.',
        paths: ['src/feature.ts'],
        recommendation: 'Add a focused test.',
        state: 'open',
      },
    ],
  }
  expect(parseReviewResult(block(withFinding), revision)).toMatchObject({
    ok: false,
    failure: 'approved-with-findings',
  })
  // The same findings with changes_requested are accepted.
  const requested = parseReviewResult(block({ ...withFinding, verdict: 'changes_requested' }), revision)
  expect(requested.ok).toBe(true)
  if (requested.ok) {
    expect(requested.result.findings[0]!.id).toBe('missing-test')
    expect(requested.result.findings[0]!.severity).toBe('important')
  }
  expect(
    parseReviewResult(
      block({ ...approved, criteriaCoverage: [{ criterion: 'Tests pass', satisfied: false, evidence: '' }] }),
      revision
    )
  ).toMatchObject({ ok: false, failure: 'approved-with-unsatisfied-criteria' })
  // An optional finding does not block an approval.
  const optional = parseReviewResult(
    block({
      ...approved,
      findings: [
        {
          id: 'style',
          severity: 'optional',
          title: 'Naming could be clearer',
          details: 'Consider renaming the helper.',
          paths: [],
          recommendation: '',
          state: 'open',
        },
      ],
    }),
    revision
  )
  expect(optional.ok).toBe(true)
})
