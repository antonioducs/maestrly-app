import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateConfig, sshArguments, DOCTOR_SCRIPT } from '../../../scripts/host-lab.mjs'
const valid = {
  sshAlias: 'lab-mac',
  expectedIdentity: '12345678-1234-1234-1234-123456789ABC',
  namespace: 'lab-test',
  caps: { cpus: 2, memoryMiB: 2048, diskGiB: 20 },
  authorizeInstall: false,
  authorizeSmoke: false,
}
test('requires explicit identity namespace and caps', () => {
  assert.deepEqual(validateConfig(valid), valid)
  for (const key of ['sshAlias', 'expectedIdentity', 'namespace', 'caps'])
    assert.throws(() => validateConfig({ ...valid, [key]: undefined }))
})
test('rejects SSH option and shell injection', () => {
  for (const sshAlias of ['-oProxyCommand=x', 'x;id', 'x\ny', 'user@host', 'a b'])
    assert.throws(() => validateConfig({ ...valid, sshAlias }))
  assert.throws(() => validateConfig({ ...valid, namespace: '../prod' }))
})
test('doctor has a fixed remote command with no alias interpolation', () => {
  const args = sshArguments(valid)
  for (const option of [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'ForwardAgent=no',
    'ClearAllForwardings=yes',
    'ForwardX11=no',
    'ControlMaster=no',
    'ControlPath=none',
  ])
    assert(args.includes(option))
  assert.deepEqual(args.slice(-3), ['--', 'lab-mac', '/bin/sh -s'])
  assert.match(DOCTOR_SCRIPT, /maestrly-host.*doctor/)
  assert.doesNotMatch(
    DOCTOR_SCRIPT.split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n'),
    /sudo|dscl|launchctl/
  )
})
test('caps cannot be missing or unbounded', () => {
  for (const n of [-1, 0, Infinity, 1.1])
    assert.throws(() => validateConfig({ ...valid, caps: { ...valid.caps, cpus: n } }))
  assert.throws(() => validateConfig({ ...valid, authorizeInstall: 'yes' }))
})

test('destructive lab authorization accepts only explicit booleans', () => {
  assert.equal(validateConfig(valid).authorizeDeleteData, undefined)
  for (const authorizeDeleteData of [false, true])
    assert.equal(validateConfig({ ...valid, authorizeDeleteData }).authorizeDeleteData, authorizeDeleteData)
  for (const authorizeDeleteData of ['true', 1, null])
    assert.throws(() => validateConfig({ ...valid, authorizeDeleteData }))
})
