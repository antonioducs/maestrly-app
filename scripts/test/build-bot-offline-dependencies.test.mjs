import test from 'node:test'
import assert from 'node:assert/strict'
import { inventory, verifyDownloadedInventory, cloud } from '../build-bot-offline-dependencies.mjs'
import { spawnSync } from 'node:child_process'

test('downloaded closure must match exact versions and architecture from the image', () => {
  const expected = inventory('xvfb\t2:21.1.12-1ubuntu1.6\nlibx11-6:arm64\t2:1.8.7-1build1\n')
  const deb = 'Package: xvfb\nVersion: 2:21.1.12-1ubuntu1.6\nArchitecture: arm64\n'
  assert.equal(verifyDownloadedInventory(deb, expected), 1)
  assert.throws(() => verifyDownloadedInventory(deb.replace('arm64', 'amd64'), expected))
  assert.throws(() => verifyDownloadedInventory(deb.replace('ubuntu1.6', 'ubuntu1.7'), expected))
  assert.throws(() => verifyDownloadedInventory(deb.replace('xvfb', 'unexpected'), expected))
  assert.throws(() => verifyDownloadedInventory(deb + deb, expected))
  assert.throws(() => verifyDownloadedInventory('', expected))
})
test('builder guest script parses and always shuts down on failure', () => {
  const config = cloud('false')
  const script = JSON.parse(config.split('  - [bash, -c, ')[1].slice(0, -2).trim())
  assert.equal(spawnSync('/bin/bash', ['-n'], { input: script }).status, 0)
  assert.match(script, /DEPENDENCIES_FAILED; shutdown -h now/)
})
