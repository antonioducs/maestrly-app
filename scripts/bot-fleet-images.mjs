#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: options.stdio ?? 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })
}

function parse(argv) {
  const options = { platform: 'linux/arm64', only: null, fromHead: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--platform') options.platform = argv[++i]
    else if (arg.startsWith('--platform=')) options.platform = arg.slice(11)
    else if (arg === '--only') options.only = argv[++i]
    else if (arg.startsWith('--only=')) options.only = arg.slice(7)
    else if (arg === '--from-head') options.fromHead = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!['linux/arm64', 'linux/amd64'].includes(options.platform))
    throw new Error('Use --platform linux/arm64 or linux/amd64')
  if (options.only && !['bot', 'gateway'].includes(options.only)) throw new Error('Use --only bot or --only gateway')
  return options
}

async function main() {
  const options = parse(process.argv.slice(2))
  let context = root
  let temporary
  try {
    if (options.fromHead) {
      temporary = mkdtempSync(path.join(os.tmpdir(), 'maestrly-bot-head-'))
      const archive = path.join(temporary, 'head.tar')
      const archived = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
        cwd: root,
        maxBuffer: 128 * 1024 * 1024,
      })
      if (archived.status !== 0) throw new Error(`git archive exited ${archived.status}: ${archived.stderr}`)
      writeFileSync(archive, archived.stdout)
      await run('tar', ['-xf', archive, '-C', temporary])
      rmSync(archive)
      // Image definitions are this task's uncommitted source; all application source remains HEAD.
      cpSync(path.join(root, 'deploy/bot-fleet'), path.join(temporary, 'deploy/bot-fleet'), { recursive: true })
      context = temporary
    }
    for (const kind of options.only ? [options.only] : ['gateway', 'bot']) {
      const name = kind === 'bot' ? 'bot-instance' : 'bot-gateway'
      const tags = [`maestrly/${name}:${version}`, `maestrly/${name}:local`]
      const start = performance.now()
      await run('docker', [
        'buildx',
        'build',
        '--load',
        '--platform',
        options.platform,
        '-f',
        path.join(context, 'deploy/bot-fleet', `${name === 'bot-instance' ? 'bot-instance' : 'gateway'}.Dockerfile`),
        '-t',
        tags[0],
        '-t',
        tags[1],
        context,
      ])
      const size = await new Promise((resolve, reject) => {
        let data = ''
        const child = spawn('docker', ['image', 'inspect', tags[0], '--format', '{{.Size}}'], {
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        child.stdout.on('data', (chunk) => {
          data += chunk
        })
        child.once('error', reject)
        child.once('exit', (code) =>
          code === 0 ? resolve(Number(data.trim())) : reject(new Error(`docker inspect exited ${code}`))
        )
      })
      console.log(
        `${name}: ${(performance.now() - start) / 1000}s, ${(size / 1024 ** 3).toFixed(2)} GiB, ${tags.join(', ')}`
      )
    }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
