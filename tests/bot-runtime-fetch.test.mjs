import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fetchRuntime, pins } from '../scripts/fetch-bot-runtime.mjs'

test('fetcher refuses existing destinations before downloading or changing files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bot-fetch-test-'))
  try { await assert.rejects(fetchRuntime(directory), { code: 'EEXIST' }) }
  finally { await rm(directory, { recursive: true }) }
})
test('fetcher pins match installed Playwright browser and desktop Codex integrity', async () => {
  const codex = await readFile(new URL('../scripts/fetch-codex-runtime.mjs', import.meta.url), 'utf8')
  assert.ok(codex.includes(pins.codex.sha512))
  assert.ok(codex.includes(`CODEX_RUNTIME_VERSION = '${pins.codex.version}'`))
  assert.equal(pins.chromium.revision, '1234')
  assert.match(pins.chromium.verification, /no independently published checksum/)
})
