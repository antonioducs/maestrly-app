#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCommit } from './check-commits.mjs'
import { nodeCommand } from './node-command.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export function parseOptions(args) {
  const options = { full: false, package: false, plan: false, prePush: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--full') options.full = true
    else if (arg === '--package') options.package = true
    else if (arg === '--plan') options.plan = true
    else if (arg === '--pre-push') options.prePush = true
    else if (arg === '--title') {
      options.title = args[++index]
      if (options.title === undefined) throw new Error('--title requires the actual pull request title.')
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (options.prePush && options.plan) throw new Error('A pre-push check cannot use --plan.')
  if (options.title !== undefined) {
    const error = validateCommit(options.title)
    if (error || /[\r\n]/.test(options.title)) throw new Error(`Invalid PR title: ${error ?? 'Use a single line.'}`)
  }
  return options
}

export function verificationSteps(options, platform = process.platform, env = process.env) {
  const steps = []
  const npm = (script) => steps.push({ command: 'npm', args: ['run', script] })
  npm('check:history')
  npm('test:policy')
  npm('test:docs')
  npm('check')
  const desktop = (command, args) =>
    steps.push(
      platform === 'linux' && !env.DISPLAY ? { command: 'xvfb-run', args: ['-a', command, ...args] } : { command, args }
    )
  if (options.full) {
    npm('audit:dependencies')
    steps.push({
      command: 'go',
      args: [
        'run',
        'github.com/zricethezav/gitleaks/v8@v8.30.1',
        'git',
        '.',
        '--config',
        '.gitleaks.toml',
        '--no-banner',
        '--redact',
        '--log-opts=HEAD',
      ],
    })
    desktop('npm', ['run', 'test:e2e'])
    npm('test:integration')
    npm('test:e2e:platform')
    desktop('node', ['scripts/test-project-chat-e2e.mjs'])
    desktop('node', ['scripts/test-bot-conversations-e2e.mjs'])
    npm('smoke:platform')
  }
  if (options.package) {
    const script = { darwin: 'package', linux: 'package:linux', win32: 'package:win' }[platform]
    if (!script) throw new Error(`No native package check configured for ${platform}.`)
    desktop('npm', ['run', script])
    desktop('npm', ['run', 'smoke:packaged-desktop'])
    desktop('npm', ['run', 'smoke:packaged-local-ml-runtime'])
  }
  return steps
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim())
  return result.stdout.trim()
}

export function assertCleanHead(cwd, head) {
  if (git(['rev-parse', 'HEAD'], cwd) !== head) throw new Error('HEAD changed during verification. Run the push again.')
  if (git(['status', '--porcelain', '--untracked-files=all'], cwd)) {
    throw new Error('Commit or stash pending changes before pushing so verification tests the exact commit being sent.')
  }
}

export function preparePush(input, cwd = root) {
  const updates = input
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 4 || !/^[0-9a-f]{40,64}$/.test(fields[1]) || !/^[0-9a-f]{40,64}$/.test(fields[3])) {
        throw new Error('Invalid Git pre-push input.')
      }
      return { ref: fields[0], sha: fields[1] }
    })
    .filter(({ sha }) => !/^0+$/.test(sha))
  if (!updates.length) return null
  const head = git(['rev-parse', 'HEAD'], cwd)
  for (const { ref, sha } of updates) {
    // Peel annotated tags while still checking the exact object supplied by Git.
    if (git(['rev-parse', '--verify', `${sha}^{commit}`], cwd) !== head) {
      throw new Error(`Check out the commit for ${ref} before pushing it; only the current HEAD can be verified.`)
    }
  }
  assertCleanHead(cwd, head)
  return head
}

export function runSteps(steps, { cwd = root, env = process.env, run = spawnSync, log = console.log } = {}) {
  env = { ...env, CI: 'true' }
  // Git exports repository context variables to hooks. Clear them for child
  // checks so fixture repositories can run their own Git commands safely.
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
  ])
    delete env[key]
  // The harness supplies its own isolated endpoints. Do not reuse another
  // worktree's server or a previously packaged executable from the caller.
  for (const key of [
    'MAESTRLY_WEB_URL',
    'MAESTRLY_E2E_EXTERNAL',
    'MAESTRLY_LIVE_E2E',
    'MAESTRLY_PACKAGED_EXECUTABLE',
    'MAESTRLY_DESKTOP_E2E',
    'MAESTRLY_PROJECT_CHAT_E2E',
  ])
    delete env[key]
  for (const { command, args } of steps) {
    log(`\n[verify:pr] ${command} ${args.join(' ')}`)
    const started = Date.now()
    const { command: executable, args: argv } = nodeCommand(command, args, env)
    const result = run(executable, argv, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], shell: false })
    if (result.error || result.status !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`}).`
      )
    }
    log(`[verify:pr] Passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  const head = options.prePush ? preparePush(readFileSync(0, 'utf8')) : null
  if (options.prePush && !head) {
    console.log('[verify:pr] No commits to push; nothing to verify.')
    return
  }
  const steps = verificationSteps(options)
  if (options.plan) {
    for (const step of steps) console.log(`${step.command} ${step.args.join(' ')}`)
    console.log('[verify:pr] Plan only; no checks were executed.')
    return
  }
  const started = Date.now()
  runSteps(steps)
  if (head) assertCleanHead(root, head)
  console.log(
    `\n[verify:pr] Local validation passed in ${((Date.now() - started) / 1000).toFixed(1)}s. GitHub platform checks still need to pass.`
  )
  if (options.title === undefined)
    console.log('[verify:pr] PR title not checked. Use --title with the actual title before opening or updating a PR.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[verify:pr] ${error.message}`)
    process.exitCode = 1
  }
}
