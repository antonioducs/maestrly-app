import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A fake `docker` command for the container executor's tests: an executable node script that records what it was
 * called with (and the env file it was given) and acts as a Docker whose behaviour the test sets in a config file.
 * POSIX only: the script is run through its shebang.
 */

export type FakeDockerConfig = {
  /** `docker info`: `stopped` fails like a daemon that is not running. */
  info?: {
    state?: 'ready' | 'stopped'
    version?: string
    runtimes?: Record<string, unknown>
    /** CDI devices; left out, the field does not exist, as on older Docker. */
    devices?: Array<{ Source: string; ID: string }>
    error?: string
  }
  /** `docker image inspect`: whether the image is on the computer. */
  image?: { present?: boolean; error?: string }
  /** `docker pull`: the output and the exit code; a pull that works makes the image present. */
  pull?: { exit?: number; stdout?: string; stderr?: string; hang?: boolean }
  /** The job's `docker run`. */
  run?: {
    exit?: number
    stdout?: string
    stderr?: string
    /** Keeps running until `docker stop` reaches it. */
    hang?: boolean
    /** The exit code after a stop; Docker reports 143 for a command ended by SIGTERM. */
    stopExit?: number
    /** How long after being called the container starts, which is when `docker stop` begins to find it. */
    startDelayMs?: number
  }
  /**
   * `docker stats --no-stream --format '{{json .}}' <name>`, answered while the container has started: the three
   * fields it reads, an `exit` code to fail with, `raw` to print instead of the JSON, and how long an answer takes.
   */
  stats?: { cpu?: string; mem?: string; pids?: string; exit?: number; raw?: string; delayMs?: number }
  /** The cache volume preparation (`docker run --entrypoint chown`). */
  prepare?: { exit?: number; stderr?: string }
  /** `docker ps -a` lines: `<id> <job id>`. */
  containers?: string[]
  /** `docker volume ls -q` names; the filter matches anywhere in a name, as Docker's does. */
  volumes?: string[]
}

export type FakeDockerCall = {
  argv: string[]
  /** What the `--env-file` held, and its mode, when the call was made. */
  envFile?: { path: string; mode: number; content: string } | null
}

const SCRIPT = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const dir = __dirname
const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
const config = read()
const args = process.argv.slice(2)
const record = { argv: args }
const envIndex = args.indexOf('--env-file')
if (envIndex >= 0) {
  const file = args[envIndex + 1]
  try {
    record.envFile = { path: file, mode: fs.statSync(file).mode & 0o777, content: fs.readFileSync(file, 'utf8') }
  } catch {
    record.envFile = null
  }
}
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(record) + '\n')
const marker = (name, kind) => path.join(dir, name + '.' + kind)
const finish = (code, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exit(code)
}
const last = args[args.length - 1]

if (args[0] === 'info') {
  const info = config.info || {}
  if (info.state === 'stopped')
    finish(1, '', (info.error || 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?') + '\n')
  const format = args[2]
  if (format === '{{json .ServerVersion}}') finish(0, JSON.stringify(info.version || '27.0.1') + '\n')
  if (format === '{{json .Runtimes}}') finish(0, JSON.stringify(info.runtimes || { runc: { path: 'runc' } }) + '\n')
  if (format === '{{json .DiscoveredDevices}}') {
    if (info.devices === undefined) finish(1, '', 'template: :1:8: executing "" at <.DiscoveredDevices>: can not evaluate field DiscoveredDevices\n')
    finish(0, JSON.stringify(info.devices) + '\n')
  }
  finish(1, '', 'unexpected info format ' + format + '\n')
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const image = config.image || {}
  if (image.error) finish(1, '', image.error + '\n')
  if (image.present) finish(0, 'sha256:abc\n')
  finish(1, '', 'Error response from daemon: No such image: ' + last + '\n')
} else if (args[0] === 'pull') {
  const pull = config.pull || {}
  if (pull.hang) {
    if (pull.stdout) process.stdout.write(pull.stdout)
    setInterval(() => {}, 1000)
  } else {
    if ((pull.exit || 0) === 0) {
      config.image = { ...(config.image || {}), present: true }
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
    }
    finish(pull.exit || 0, pull.stdout, pull.stderr)
  }
} else if (args[0] === 'run') {
  if (args[args.indexOf('--entrypoint') + 1] === 'chown') {
    const prepare = config.prepare || {}
    finish(prepare.exit || 0, '', prepare.stderr ? prepare.stderr + '\n' : '')
  }
  const run = config.run || {}
  const name = args[args.indexOf('--name') + 1]
  setTimeout(() => {
    fs.writeFileSync(marker(name, 'started'), '')
    if (run.stdout) process.stdout.write(run.stdout)
    if (run.stderr) process.stderr.write(run.stderr)
    if (!run.hang) process.exit(run.exit || 0)
    const timer = setInterval(() => {
      if (fs.existsSync(marker(name, 'stopped'))) {
        clearInterval(timer)
        process.exit(run.stopExit === undefined ? 143 : run.stopExit)
      }
    }, 10)
  }, run.startDelayMs || 0)
} else if (args[0] === 'stats') {
  const stats = config.stats || {}
  const running = marker(last, 'stats-running')
  // A second question while one is being answered is recorded: the executor must ask one at a time.
  if (fs.existsSync(running)) fs.writeFileSync(marker(last, 'stats-overlap'), '')
  fs.writeFileSync(running, '')
  setTimeout(() => {
    fs.rmSync(running, { force: true })
    if (stats.exit) finish(stats.exit, '', 'Error response from daemon: stats failed\n')
    if (!fs.existsSync(marker(last, 'started')) || fs.existsSync(marker(last, 'stopped')))
      finish(1, '', 'Error response from daemon: No such container: ' + last + '\n')
    finish(0, stats.raw !== undefined ? stats.raw : JSON.stringify({
      BlockIO: '0B / 0B',
      CPUPerc: stats.cpu || '0.00%',
      Container: last,
      ID: 'abc',
      MemPerc: '1.00%',
      MemUsage: stats.mem || '10MiB / 1GiB',
      Name: last,
      NetIO: '0B / 0B',
      PIDs: stats.pids || '1',
    }) + '\n')
  }, stats.delayMs || 0)
} else if (args[0] === 'stop') {
  if (!fs.existsSync(marker(last, 'started'))) finish(1, '', 'Error response from daemon: No such container: ' + last + '\n')
  fs.writeFileSync(marker(last, 'stopped'), '')
  finish(0, last + '\n')
} else if (args[0] === 'rm') {
  finish(0, '')
} else if (args[0] === 'ps') {
  finish(0, (config.containers || []).map((line) => line + '\n').join(''))
} else if (args[0] === 'volume' && args[1] === 'ls') {
  const filter = args[args.indexOf('--filter') + 1].replace(/^name=/, '')
  finish(0, (config.volumes || []).filter((name) => name.includes(filter)).map((name) => name + '\n').join(''))
} else if (args[0] === 'volume' && args[1] === 'rm') {
  finish(0, '')
} else {
  finish(1, '', 'fake docker: unsupported command ' + args.join(' ') + '\n')
}
`

export interface FakeDocker {
  /** The executable to pass as the Docker CLI. */
  path: string
  /** Replaces parts of the behaviour; a part is replaced whole. */
  configure(patch: FakeDockerConfig): void
  /** Every call so far, in order. */
  calls(): FakeDockerCall[]
  /** The calls of one Docker command (`run`, `stop`, `pull`...), as argument lists. */
  argvOf(command: string): string[][]
  /** Whether the container of that name has started. */
  started(name: string): boolean
  /** Whether a `docker stats` for that container began while another was still being answered. */
  statsOverlapped(name: string): boolean
}

/** Writes the fake into `directory` (created if needed) and returns its controls. */
export function createFakeDocker(directory: string, config: FakeDockerConfig = {}): FakeDocker {
  mkdirSync(directory, { recursive: true })
  const script = path.join(directory, 'docker')
  const configFile = path.join(directory, 'config.json')
  const callsFile = path.join(directory, 'calls.jsonl')
  writeFileSync(script, `#!${process.execPath}\n${SCRIPT}`)
  chmodSync(script, 0o755)
  writeFileSync(configFile, JSON.stringify(config))
  const calls = (): FakeDockerCall[] =>
    existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeDockerCall)
      : []
  return {
    path: script,
    configure(patch) {
      writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), ...patch }))
    },
    calls,
    argvOf(command) {
      return calls()
        .map((call) => call.argv)
        .filter((argv) => argv[0] === command)
    },
    started: (name) => existsSync(path.join(directory, `${name}.started`)),
    statsOverlapped: (name) => existsSync(path.join(directory, `${name}.stats-overlap`)),
  }
}
