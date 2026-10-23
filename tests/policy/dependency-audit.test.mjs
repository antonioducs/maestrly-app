import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advisoryId, evaluateAuditReport } from '../../scripts/audit-dependencies.mjs'

const nodePath = 'node_modules/example-runtime/node_modules/undici'
const ghsa = 'GHSA-vrm6-8vpv-qv8q'

function report(url = `https://github.com/advisories/${ghsa}`, nodes = [nodePath]) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      undici: {
        name: 'undici',
        nodes,
        via: [
          {
            source: 1,
            name: 'undici',
            severity: 'high',
            url,
            range: '<6.24.0',
          },
        ],
      },
      'example-runtime': {
        name: 'example-runtime',
        nodes: ['node_modules/example-runtime'],
        via: ['undici'],
      },
    },
  }
}

function allowlist(overrides = {}) {
  return {
    schema: 1,
    exceptions: [
      {
        package: 'undici',
        path: nodePath,
        advisories: [ghsa],
        reason: 'Synthetic reviewed fixture for evaluator tests.',
        expiresOn: '2026-10-05',
        ...overrides,
      },
    ],
  }
}

test('accepts one exact advisory on one exact dependency path before expiry', () => {
  const result = evaluateAuditReport(report(), allowlist(), new Date('2026-09-05T12:00:00Z'))

  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.accepted.map((item) => item.id), [ghsa])
})

test('rejects an advisory that is not explicitly allowlisted', () => {
  const result = evaluateAuditReport(
    report('https://github.com/advisories/GHSA-aaaa-bbbb-cccc'),
    allowlist({ advisories: ['GHSA-aaaa-bbbb-dddd'] }),
    new Date('2026-09-05T12:00:00Z')
  )

  assert.ok(result.failures.some((message) => message.includes('unapproved advisory GHSA-aaaa-bbbb-cccc')))
})

test('rejects an advisory found at a different dependency path', () => {
  const result = evaluateAuditReport(
    report(`https://github.com/advisories/${ghsa}`, ['node_modules/undici']),
    allowlist(),
    new Date('2026-09-05T12:00:00Z')
  )

  assert.ok(result.failures.some((message) => message.includes('unapproved advisory')))
  assert.ok(result.failures.some((message) => message.includes('node_modules/undici')))
})

test('treats an exception as expired at midnight UTC on its expiry date', () => {
  const result = evaluateAuditReport(report(), allowlist(), new Date('2026-10-05T00:00:00Z'))

  assert.ok(result.failures.some((message) => message.includes(`expired exception ${ghsa}`)))
})

test('rejects a stale exception after an advisory disappears', () => {
  const result = evaluateAuditReport(
    { auditReportVersion: 2, vulnerabilities: {} },
    allowlist(),
    new Date('2026-09-05T12:00:00Z')
  )

  assert.ok(result.failures.some((message) => message.includes(`stale exception ${ghsa}`)))
})

test('rejects the same advisory, package and path listed twice', () => {
  const duplicate = allowlist()
  duplicate.exceptions.push({ ...duplicate.exceptions[0] })

  const result = evaluateAuditReport(report(), duplicate, new Date('2026-09-05T12:00:00Z'))

  assert.ok(result.failures.some((message) => message.includes(`duplicate exception ${ghsa} at ${nodePath}`)))
})

test('accepts one advisory at several exact paths only with an exception for each', () => {
  const otherPath = 'node_modules/another/undici'
  const both = allowlist()
  both.exceptions.push({ ...both.exceptions[0], path: otherPath })
  const found = report(`https://github.com/advisories/${ghsa}`, [nodePath, otherPath])
  const now = new Date('2026-09-05T12:00:00Z')

  const covered = evaluateAuditReport(found, both, now)
  assert.deepEqual(covered.failures, [])
  assert.deepEqual(covered.accepted.map((item) => item.path).sort(), [otherPath, nodePath].sort())

  const partial = evaluateAuditReport(found, allowlist(), now)
  assert.deepEqual(partial.failures, [`unapproved advisory ${ghsa} for undici at ${otherPath}`])
})

test('rejects the exception of a path where the advisory disappeared while another path still has it', () => {
  const both = allowlist()
  both.exceptions.push({ ...both.exceptions[0], path: 'node_modules/another/undici' })

  const result = evaluateAuditReport(report(), both, new Date('2026-09-05T12:00:00Z'))

  assert.deepEqual(result.failures, [`stale exception ${ghsa} at node_modules/another/undici`])
})

test('rejects a malformed audit report instead of treating it as clean', () => {
  const result = evaluateAuditReport('{not-json', allowlist(), new Date('2026-09-05T12:00:00Z'))

  assert.ok(result.failures.some((message) => message.includes('audit report must be an object')))
})

test('extracts only canonical GitHub advisory identifiers', () => {
  assert.equal(advisoryId(`https://github.com/advisories/${ghsa}`), ghsa)
  assert.equal(advisoryId(`https://github.com/advisories/${ghsa}/extra`), null)
  assert.equal(advisoryId(`https://example.com/advisories/${ghsa}`), null)
  assert.equal(advisoryId(null), null)
})
