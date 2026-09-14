import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('session workers fail closed without their unprivileged profile and graphical authority', async () => {
  for (const name of ['runtime', 'desktop']) {
    const unit = await readFile(`deploy/bot-runtime/linux/maestrly-bot-${name}@.service`, 'utf8')
    assert.match(unit, /User=nobody/)
    assert.match(unit, /MAESTRLY_BOT_SESSION_REQUIRED=1/)
  }
  const main = await readFile('apps/bot-runtime/src/main.ts', 'utf8')
  assert.match(main, /Installed bot workers must run as an unprivileged Linux user/)
  const profile = await readFile('apps/bot-runtime/src/vm/session-profile.ts', 'utf8')
  for (const setting of ['PrivateNetwork=yes', 'PrivateIPC=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectControlGroups=yes']) assert.ok(profile.includes(setting))
  const desktop = await readFile('deploy/bot-runtime/linux/desktop-session.sh', 'utf8')
  assert.match(desktop, /-auth "\$XAUTHORITY"/)
  assert.doesNotMatch(desktop, /-ac\b|-listen tcp/)
})
test('builders include the supervisor and measured profile; validation and lab scripts exist', async () => {
  const builder = await readFile('scripts/build-bot-runtime.mjs', 'utf8')
  assert.match(builder, /'vm\/main'/)
  assert.match(builder, /SESSION_EVIDENCE_REQUIRED/)
  const image = await readFile('scripts/build-bot-image-qemu.mjs', 'utf8')
  for (const dependency of ['xauth', 'xdotool', 'scrot']) assert.ok(image.includes(`'${dependency}'`))
  const root = JSON.parse(await readFile('package.json', 'utf8'))
  for (const script of ['check:bot-sessions', 'test:bot-sessions', 'lab:bot:sessions']) assert.ok(root.scripts[script])
  assert.ok(root.scripts['check:bot-sessions'].includes('build:guest-transport'))
})
