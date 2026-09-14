import test from 'node:test'
import assert from 'node:assert/strict'
import {
  imageBuildUserData,
  requiredBotPackages,
  validateBotPackages,
} from '../scripts/build-bot-image-qemu.mjs'

const packages = Object.fromEntries(requiredBotPackages.map((name) => [name, '1:2.3-4ubuntu5']))
const id = '12345678-1234-1234-1234-123456789abc'
test('bot image requires exact versions for the complete allowlisted prerequisite set', () => {
  validateBotPackages(packages)
  assert.throws(() => validateBotPackages({ ...packages, xvfb: undefined }), /BOT_PACKAGES/)
  assert.throws(() => validateBotPackages({ ...packages, xvfb: 'latest' }), /BOT_PACKAGES/)
  assert.throws(() => validateBotPackages({ ...packages, xvfb: "1'; reboot #" }), /BOT_PACKAGES/)
  assert.throws(() => validateBotPackages({ ...packages, 'ubuntu-desktop': '1' }), /BOT_PACKAGES/)
})
test('guest provisioning installs no recommends, measures the desktop, then sanitizes the image', () => {
  const data = imageBuildUserData({ packages, guestAgentVersion: packages['qemu-guest-agent'] }, id, {
    'desktop-session.sh': '#!/bin/sh\nexit 0\n',
  })
  const command = JSON.parse(data.split('  - [sh, -c, ')[1].trim().slice(0, -1))
  assert.match(command, /apt-get install -y --no-install-recommends/)
  assert.match(command, /'xvfb=1:2.3-4ubuntu5'/)
  assert.match(command, /pgrep -u maestrlybot -x pcmanfm/)
  assert.match(command, /MAESTRLY_DESKTOP_MEASURE_BEGIN/)
  assert.match(command, /cloud-init clean --logs --machine-id --seed/)
  assert.match(command, /rm -f \/etc\/ssh\/ssh_host_/)
  assert.ok(command.indexOf('MAESTRLY_DESKTOP_MEASURE_END') < command.indexOf('cloud-init clean'))
  assert.ok(command.indexOf('cloud-init clean') < command.indexOf(`MAESTRLY_IMAGE_BUILT:${id}`))
})
