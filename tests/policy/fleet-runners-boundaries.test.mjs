import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const runners = code('apps/bot-gateway/src/runners.ts')
const transfers = code('apps/bot-gateway/src/runner-transfers.ts')
const routes = code('apps/bot-gateway/src/routes/public.ts')
const store = read('apps/bot-gateway/src/store.ts')

test('the gateway keeps which computers run jobs for which bot and each job state, never files, logs or conversations', () => {
  const table = (name) => store.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([^;]*)\\);`))?.[1] ?? ''
  for (const name of ['runner_links', 'runner_devices', 'runner_jobs']) assert.ok(table(name), `${name} is stored`)
  assert.doesNotMatch(table('runner_links'), /workspace|grant|conversation|transcript|path|command|env/i)
  assert.doesNotMatch(table('runner_jobs'), /conversation|transcript|\blog\b|output|content|file/i)
  // A job's command and environment variables are kept only until it ends.
  assert.match(store, /ended \|\| !next\.spec \? null : JSON\.stringify\(next\.spec\)/)
})

test("a job and its cancel go to its runner's stream alone, and only that runner moves the job on", () => {
  assert.match(runners, /this\.events\.sendToRunner\(link\.deviceId, \{\s*type: 'runner\.job'/)
  assert.doesNotMatch(runners, /events\.emit\(\{\s*type: 'runner\.(job|cancel)'/)
  assert.match(runners, /job\.deviceId !== deviceId\) throw new GatewayError\('FORBIDDEN'/)
  for (const key of ['runnerJobAccept', 'runnerJobProgress', 'runnerJobFinish', 'runnerState'])
    assert.match(
      routes,
      new RegExp(`case '${key}':[\\s\\S]{0,240}ctx\\.auth\\.device\\(res\\.req\\?\\.headers\\.authorization\\)\\.id`),
      `${key} takes the runner from its own token`
    )
  // Only streams that asked for runner events receive them.
  assert.match(routes, /runners: fleetReaderWantsRunners\(url\.searchParams\)/)
})

test("a job's files stream through untouched to its own bot's environment, with the environment's token", () => {
  assert.match(transfers, /const botId = this\.deps\.authorize\(params\.jobId, deviceId, key\)/)
  assert.match(transfers, /request\.pipe\(upstream\)/)
  assert.match(transfers, /headers\.authorization = 'Bearer ' \+ target\.secret/)
  assert.doesNotMatch(transfers, /writeFile|createWriteStream|readBody/)
})
