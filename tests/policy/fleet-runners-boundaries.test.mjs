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

test('what a running job uses stays in memory: sampled by its runner, shown while it runs, never stored or announced', () => {
  assert.doesNotMatch(
    store.match(/CREATE TABLE IF NOT EXISTS runner_jobs \(([^;]*)\);/)?.[1] ?? '',
    /usage|cpu|memory|process/i
  )
  assert.match(runners, /private readonly usages = new Map<string, FleetRunnerJobUsage>\(\)/)
  assert.doesNotMatch(runners, /this\.store\.\w+\([^)]*usage/i)
  // The last sample goes with the job, its runner and its bot.
  assert.match(runners, /this\.usages\.set\(jobId, \{ \.\.\.sample, at: iso\(this\.now\(\)\) \}\)/)
  assert.match(runners, /this\.usages\.delete\(jobId\)/)
  assert.match(
    runners,
    /for \(const job of this\.store\.runnerJobsOfDevice\(deviceId, ACTIVE\)\) this\.usages\.delete\(job\.id\)/
  )
  assert.match(runners, /\[this\.acceptBy, this\.cancelBy, this\.skips, this\.usages\]/)
  // A sample changes no state: it neither emits an event nor reaches the bot's environment.
  const usage = runners.match(/\n {2}usage\([\s\S]*?\n {2}\}\n/)?.[0] ?? ''
  assert.ok(usage, 'Runners.usage is there')
  assert.doesNotMatch(usage, /changed\(|emit|deliver|environments|store\./)
  // The environment is told states, not samples.
  assert.match(runners, /const \{ usage: _usage, \.\.\.state \} = this\.view\(job\)/)
})

test("a job's log is read from its bot's environment as it is asked for, and kept nowhere here", () => {
  assert.match(
    routes,
    /case 'botRunnerJobLogRead':[\s\S]{0,160}ctx\.runners!\.readLog\(id, params\.jobId, logQuery\(url\)\)/
  )
  const read = runners.match(/\n {2}async readLog\([\s\S]*?\n {2}\}\n/)?.[0] ?? ''
  assert.ok(read, 'Runners.readLog is there')
  assert.match(read, /this\.job\(botId, jobId\)/)
  assert.doesNotMatch(read, /store\.|writeFile|cache/i)
})

test("a job and its cancel go to its runner's stream alone, and only that runner moves the job on", () => {
  assert.match(runners, /this\.events\.sendToRunner\(link\.deviceId, \{\s*type: 'runner\.job'/)
  assert.doesNotMatch(runners, /events\.emit\(\{\s*type: 'runner\.(job|cancel)'/)
  assert.match(runners, /job\.deviceId !== deviceId\) throw new GatewayError\('FORBIDDEN'/)
  for (const key of ['runnerJobAccept', 'runnerJobProgress', 'runnerJobUsage', 'runnerJobFinish', 'runnerState'])
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
