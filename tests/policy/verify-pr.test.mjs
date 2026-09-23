import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertCleanHead, parseOptions, preparePush, runSteps, verificationSteps } from '../../scripts/verify-pr.mjs'
import { nodeCommand } from '../../scripts/node-command.mjs'

test('PR title and arguments fail before verification can be skipped', () => {
  assert.equal(parseOptions(['--title', 'fix(ci): validate push']).title, 'fix(ci): validate push')
  for (const args of [
    ['--title'],
    ['--title', 'bad'],
    ['--title', 'fix: title\nbody'],
    ['--unknown'],
    ['--pre-push', '--plan'],
  ]) {
    assert.throws(() => parseOptions(args))
  }
})

test('baseline preserves all workspace checks; full adds CI suites and platform-specific packaging', () => {
  const baseline = verificationSteps(parseOptions([]))
  assert.deepEqual(
    baseline.map((step) => step.args[1]),
    ['check:history', 'test:policy', 'test:docs', 'check']
  )
  const steps = verificationSteps(parseOptions(['--full', '--package']), 'linux', {})
  // The Local ML toolchain preflight fails packaging runs before the slower suites.
  assert.deepEqual(steps[0], { command: 'npm', args: ['run', 'check:local-ml-toolchain'] })
  assert.deepEqual(steps.slice(1, baseline.length + 1), baseline)
  assert.ok(
    !verificationSteps(parseOptions(['--full']), 'linux', {}).some((step) =>
      step.args.includes('check:local-ml-toolchain')
    )
  )
  assert.ok(steps.some((step) => step.command === 'go' && step.args.includes('--log-opts=HEAD')))
  assert.ok(steps.some((step) => step.args.includes('test:integration')))
  assert.ok(steps.some((step) => step.args.includes('test:e2e:platform')))
  assert.ok(steps.some((step) => step.args.includes('smoke:platform')))
  assert.deepEqual(
    steps.filter((step) => step.command === 'xvfb-run').map((step) => step.args.at(-1)),
    [
      'test:e2e',
      'scripts/test-project-chat-e2e.mjs',
      'scripts/test-bot-conversations-e2e.mjs',
      'package:linux',
      'smoke:packaged-desktop',
      'smoke:packaged-local-ml-runtime',
    ]
  )
  for (const [platform, script] of [
    ['darwin', 'package'],
    ['win32', 'package:win'],
  ]) {
    assert.deepEqual(
      verificationSteps({ package: true }, platform)
        .slice(-3)
        .map((step) => step.args[1]),
      [script, 'smoke:packaged-desktop', 'smoke:packaged-local-ml-runtime']
    )
  }
})

test('runner stops at the first failure, including signals and missing executables', () => {
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('ENOENT') }]) {
    let calls = 0
    assert.throws(
      () =>
        runSteps(verificationSteps({}), {
          env: { npm_execpath: '/path with spaces/npm-cli.js' },
          log() {},
          run(command, args, options) {
            calls++
            assert.equal(command, process.execPath)
            assert.equal(args[0], '/path with spaces/npm-cli.js')
            assert.equal(options.shell, false)
            return result
          },
        }),
      /failed/
    )
    assert.equal(calls, 1)
  }
})

test('verification forces CI settings without inheriting external test targets or mutating caller environment', () => {
  const env = {
    CI: '',
    MAESTRLY_WEB_URL: 'http://another-worktree',
    MAESTRLY_E2E_EXTERNAL: '1',
    MAESTRLY_PACKAGED_EXECUTABLE: '/old/app',
  }
  runSteps([{ command: 'node', args: ['fixture.mjs'] }], {
    env,
    log() {},
    run(command, args, options) {
      assert.equal(command, process.execPath)
      assert.deepEqual(args, ['fixture.mjs'])
      assert.equal(options.env.CI, 'true')
      for (const key of Object.keys(env).filter((key) => key !== 'CI')) assert.equal(options.env[key], undefined)
      return { status: 0 }
    },
  })
  assert.equal(env.CI, '')
  assert.equal(env.MAESTRLY_E2E_EXTERNAL, '1')
})

test('npm subprocesses use the JS entry point without shell parsing on every platform', () => {
  const cli = 'C:\\Program Files\\nodejs\\npm-cli.js'
  assert.deepEqual(nodeCommand('npm', ['run', 'check'], { npm_execpath: cli }), {
    command: process.execPath,
    args: [cli, 'run', 'check'],
  })
  assert.deepEqual(nodeCommand('docker', ['info'], {}), { command: 'docker', args: ['info'] })
})

function repository(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-pre-push-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'core.hooksPath', path.join(cwd, 'no-hooks'))
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(path.join(cwd, 'file.txt'), 'first')
  git('add', '.')
  git('commit', '-m', 'test: initial commit')
  return { cwd, git, head: git('rev-parse', 'HEAD') }
}

const zero = '0'.repeat(40)
const update = (sha) => `refs/heads/topic ${sha} refs/heads/topic ${zero}\n`

test('push validates new and existing branches, annotated tags and deletion without a remote lookup', (t) => {
  const { cwd, git, head } = repository(t)
  assert.equal(preparePush(update(head), cwd), head)
  assert.equal(preparePush(update(head).replace(`${zero}\n`, `${head}\n`), cwd), head)
  git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v1', '-m', 'test tag')
  assert.equal(preparePush(`refs/tags/v1 ${git('rev-parse', 'v1')} refs/tags/v1 ${zero}\n`, cwd), head)
  writeFileSync(path.join(cwd, 'untracked.txt'), 'pending')
  assert.equal(preparePush(`(delete) ${zero} refs/heads/old ${head}\n`, cwd), null)
  assert.throws(() => preparePush(update(head), cwd), /Commit or stash/)
})

test('push rejects staged/unstaged changes, non-HEAD commits, mixed refs and changed HEAD', (t) => {
  const { cwd, git, head } = repository(t)
  writeFileSync(path.join(cwd, 'file.txt'), 'second')
  assert.throws(() => preparePush(update(head), cwd), /Commit or stash/)
  git('add', '.')
  assert.throws(() => preparePush(update(head), cwd), /Commit or stash/)
  git('commit', '-m', 'test: second commit')
  const next = git('rev-parse', 'HEAD')
  assert.throws(() => preparePush(update(head), cwd), /Check out/)
  assert.throws(() => preparePush(update(next) + update(head), cwd), /Check out/)
  assert.throws(() => assertCleanHead(cwd, head), /HEAD changed/)
  assert.equal(preparePush(update(next), cwd), next)
  assert.throws(() => preparePush('invalid input', cwd), /Invalid/)
})

test('installed hook blocks a real local push on check failure and permits it after correction', (t) => {
  const { cwd, git } = repository(t)
  const root = path.resolve(import.meta.dirname, '../..')
  mkdirSync(path.join(cwd, 'scripts'))
  mkdirSync(path.join(cwd, '.githooks'))
  for (const file of [
    'scripts/verify-pr.mjs',
    'scripts/check-commits.mjs',
    'scripts/node-command.mjs',
    '.githooks/pre-push',
  ]) {
    copyFileSync(path.join(root, file), path.join(cwd, file))
  }
  chmodSync(path.join(cwd, '.githooks/pre-push'), 0o755)
  const manifest = {
    type: 'module',
    scripts: {
      'verify:pr': 'node scripts/verify-pr.mjs',
      'check:history': 'node scripts/check-commits.mjs',
      'test:policy': 'node -e "process.exit(0)"',
      'test:docs': 'node -e "process.exit(0)"',
      check: 'node -e "process.exit(1)"',
    },
  }
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
  git('add', '.')
  git('commit', '-m', 'test: install verifier')
  git('config', 'core.hooksPath', '.githooks')
  const remote = path.join(cwd, '.git', 'test-remote.git')
  git('init', '--bare', remote)
  const push = () => spawnSync('git', ['push', remote, 'HEAD:refs/heads/topic'], { cwd, encoding: 'utf8' })
  const failed = push()
  assert.notEqual(failed.status, 0)
  assert.match(failed.stdout + failed.stderr, /npm run check failed/)
  assert.equal(git('--git-dir', remote, 'for-each-ref'), '')
  manifest.scripts.check = 'node -e "process.exit(0)"'
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
  git('add', '.')
  git('commit', '-m', 'test: correct check')
  const passed = push()
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/topic'), git('rev-parse', 'HEAD'))
})
