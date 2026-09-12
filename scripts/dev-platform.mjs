#!/usr/bin/env node
import { spawn } from 'node:child_process'

const children = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', shell: false }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', shell: false }),
]

function stop(signal) {
  for (const child of children) child.kill(signal)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal))
await Promise.race(children.map((child) => new Promise((resolve) => child.once('exit', resolve))))
stop('SIGTERM')
