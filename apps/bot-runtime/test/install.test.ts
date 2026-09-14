import { spawnSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { temporary } from './helpers.js'
const directory = fileURLToPath(new URL('../../../deploy/bot-runtime/linux/', import.meta.url))
test('all deployment shell scripts parse as POSIX shell', async () => {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.sh')) continue
    expect(spawnSync('/bin/sh', ['-n', join(directory, name)]).status).toBe(0)
  }
})
test('installer uses host marker contract and rejects wrong digest before installation', async () => {
  const source = await readFile(join(directory, 'install.sh'), 'utf8')
  expect(source).toContain('/var/lib/maestrly/bot-runtime')
  expect(source).toContain('installed.json')
  const root = await temporary()
  const bundle = join(root, 'bundle.tar')
  await writeFile(bundle, 'not a bundle')
  const result = spawnSync(
    '/bin/sh',
    [join(directory, 'install.sh'), '--bundle', bundle, '--sha256', '0'.repeat(64), '--version', '0.1.0'],
    {
      encoding: 'utf8',
      env: { ...process.env, MAESTRLY_BOT_INSTALL_ROOT: root },
    }
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('SHA256_MISMATCH')
})

test('packaged Chromium enables userns only at its fixed path and services share the display namespace', async () => {
  const profile = await readFile(join(directory, 'apparmor-maestrly-chromium'), 'utf8')
  expect(profile).toContain('/opt/maestrly-bot/chromium/chrome flags=(unconfined)')
  expect(profile).toContain('userns,')
  const installer = await readFile(join(directory, 'install.sh'), 'utf8')
  expect(installer).toContain('/usr/sbin/apparmor_parser -r /etc/apparmor.d/maestrly-chromium')
  expect(installer).not.toContain('sysctl')
  const unit = await readFile(join(directory, 'maestrly-bot-runtime.service'), 'utf8')
  expect(unit.split('[Service]')[0]).toContain('JoinsNamespaceOf=maestrly-bot-desktop.service')
  expect(unit.split('[Service]')[1]).not.toContain('JoinsNamespaceOf')
})

test('native shell cannot execute commands through the packaged helper', async () => {
  const root = await temporary()
  const marker = join(root, 'executed')
  for (const args of [['exec', '--', '/usr/bin/touch', marker], ['desktop-start'], ['desktop-stop'], []]) {
    const result = spawnSync('/bin/sh', [join(directory, 'maestrly-bot-helper.sh'), ...args], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ELEVATION_UNSUPPORTED')
  }
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  const sudoers = await readFile(join(directory, 'sudoers.d-maestrly-bot'), 'utf8')
  expect(sudoers.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))).toEqual([])
})
