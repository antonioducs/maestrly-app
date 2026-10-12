import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { bindMount, imageTag } from '../../scripts/test-e2e-docker.mjs'

// `npm run test:e2e:docker` runs here against a fake `docker` only: a copy of the script in a synthetic repository, so
// the working tree it sends and the container it asks for can be checked without an engine or the real suite.
const root = path.resolve(import.meta.dirname, '../..')
const skip = process.platform === 'win32' && 'the fake docker command is a POSIX shell script'
const dockerfile = 'apps/desktop/test/docker/Dockerfile'

function fixture({ imageExists, exitCode = 0 }) {
  // The script runs main() only when argv[1] is its own path, so the temporary directory's symlinks are resolved.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'desktop e2e docker-')))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  for (const sub of ['scripts', 'apps/desktop/test/docker', 'apps/desktop/test-results/stale', 'node_modules', 'bin']) {
    mkdirSync(path.join(dir, sub), { recursive: true })
  }
  copyFileSync(path.join(root, 'scripts/test-e2e-docker.mjs'), path.join(dir, 'scripts/test-e2e-docker.mjs'))
  copyFileSync(path.join(root, dockerfile), path.join(dir, dockerfile))
  const lock = { packages: { 'node_modules/playwright-core': { version: '9.8.7' } } }
  writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock))
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nbin/\ntest-results/\n')
  writeFileSync(path.join(dir, 'tracked file.txt'), 'tracked\n')
  writeFileSync(path.join(dir, 'deleted.txt'), 'deleted\n')
  writeFileSync(path.join(dir, 'node_modules/ignored.js'), 'ignored\n')
  writeFileSync(path.join(dir, 'apps/desktop/test-results/stale/old.txt'), 'old\n')
  git('init', '-q')
  git('add', '.')
  git(
    '-c',
    'user.name=Maestrly fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'test: synthetic working tree'
  )
  rmSync(path.join(dir, 'deleted.txt'))
  writeFileSync(path.join(dir, 'untracked.txt'), 'untracked\n')

  // Records each call and the stdin of `run` in the ignored bin/; `image inspect` and `run` answer as configured.
  const calls = path.join(dir, 'bin/calls.jsonl')
  const stdin = path.join(dir, 'bin/stdin.bin')
  const client = path.join(dir, 'bin/fake-docker.mjs')
  writeFileSync(
    client,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[0] === 'image' && args[1] === 'inspect') process.exit(${imageExists ? 0 : 1})
if (args[0] === 'image' && args[1] === 'ls') process.stdout.write('maestrly-desktop-e2e:0123456789abcdef\\n')
if (args[0] === 'run') {
  writeFileSync(${JSON.stringify(stdin)}, readFileSync(0))
  process.exit(${exitCode})
}
if (args[0] === 'info') process.stdout.write('28.0.0\\n')
`
  )
  const docker = path.join(dir, 'bin/docker')
  writeFileSync(docker, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(client)} "$@"\n`)
  chmodSync(docker, 0o755)

  const run = (...args) =>
    spawnSync(process.execPath, [path.join(dir, 'scripts/test-e2e-docker.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` },
    })
  const recorded = () =>
    readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { dir, run, recorded, stdin: () => readFileSync(stdin, 'utf8') }
}

test('a run sends the working tree as Git sees it to a sandboxed container and returns its exit code', { skip }, () => {
  const { dir, run, recorded, stdin } = fixture({ imageExists: true, exitCode: 3 })
  try {
    const result = run('--grep', 'focus', 'detached-chats.spec.ts')
    assert.equal(result.status, 3, result.stderr)
    const calls = recorded()
    assert.ok(!calls.some((args) => args[0] === 'build'), 'an existing image is not built again')
    const runArgs = calls.find((args) => args[0] === 'run')
    const tag = imageTag(readFileSync(path.join(dir, dockerfile)), '9.8.7')
    const imageAt = runArgs.indexOf(tag)
    assert.ok(imageAt > 0, `runs ${tag}`)
    const options = runArgs.slice(0, imageAt)
    for (const option of ['--rm', '--interactive', '--init']) assert.ok(options.includes(option), option)
    const value = (flag) => options.flatMap((arg, index) => (arg === flag ? [options[index + 1]] : []))
    assert.deepEqual(value('--security-opt'), ['seccomp=unconfined'])
    assert.deepEqual(value('--mount'), [
      `type=bind,"source=${dir}",target=/src,readonly`,
      `type=bind,"source=${path.join(dir, 'apps/desktop/test-results')}",target=/results`,
    ])
    assert.deepEqual(value('--volume'), ['maestrly-desktop-e2e-cache:/home/ubuntu/.cache'])
    const [shell, flag, script, ...positional] = runArgs.slice(imageAt + 1)
    assert.deepEqual([shell, flag], ['bash', '-c'])
    // The runner comes from the copy, so edits to the working tree during the run cannot change it.
    assert.match(script, /--files-from=- .*\| tar -C \/work -xf -/)
    assert.match(script, /^exec bash \/work\/apps\/desktop\/test\/docker\/run-e2e\.sh "\$@"$/m)
    assert.doesNotMatch(script, /bash \/src\//)
    assert.deepEqual(positional, ['run-e2e', '--grep', 'focus', 'detached-chats.spec.ts'])
    const sent = stdin().split('\0')
    assert.equal(sent.pop(), '', 'every path ends with NUL')
    assert.deepEqual(sent.sort(), [
      '.gitignore',
      'apps/desktop/test/docker/Dockerfile',
      'package-lock.json',
      'scripts/test-e2e-docker.mjs',
      'tracked file.txt',
      'untracked.txt',
    ])
    assert.ok(!existsSync(path.join(dir, 'apps/desktop/test-results/stale')), 'earlier results are cleared')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing image is built from the Dockerfile with the locked Playwright version', { skip }, () => {
  const { dir, run, recorded } = fixture({ imageExists: false })
  try {
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    const build = recorded().find((args) => args[0] === 'build')
    const tag = imageTag(readFileSync(path.join(dir, dockerfile)), '9.8.7')
    assert.deepEqual(build, [
      'build',
      '--build-arg',
      'PLAYWRIGHT_VERSION=9.8.7',
      '--tag',
      tag,
      path.join(dir, 'apps/desktop/test/docker'),
    ])
    // Earlier images are only pointed out: another worktree may still use one.
    assert.match(result.stdout, /docker image rm maestrly-desktop-e2e:0123456789abcdef\n/)
    assert.ok(!recorded().some((args) => args[0] === 'rmi' || args[1] === 'rm'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bind mounts quote the host path for the CSV syntax of --mount', () => {
  assert.equal(bindMount('/a b,c:d"e', '/src', true), 'type=bind,"source=/a b,c:d""e",target=/src,readonly')
  assert.equal(
    bindMount('C:\\Users\\dev\\maestrly', '/results'),
    'type=bind,"source=C:\\Users\\dev\\maestrly",target=/results'
  )
})

test('the image tag follows the Dockerfile and the Playwright version', () => {
  assert.equal(imageTag('FROM a', '1.0.0'), imageTag(Buffer.from('FROM a'), '1.0.0'))
  assert.notEqual(imageTag('FROM a', '1.0.0'), imageTag('FROM b', '1.0.0'))
  assert.notEqual(imageTag('FROM a', '1.0.0'), imageTag('FROM a', '1.0.1'))
  assert.match(imageTag('FROM a', '1.0.0'), /^maestrly-desktop-e2e:[0-9a-f]{16}$/)
})

test('the container runs the Node.js release line of .nvmrc', () => {
  const node = /^FROM node:(\d+)\.\d+\.\d+-/m.exec(readFileSync(path.join(root, dockerfile), 'utf8'))?.[1]
  assert.equal(node, readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().split('.')[0])
})
