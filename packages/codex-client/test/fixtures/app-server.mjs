import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'

if (process.argv[2] === 'worker') {
  process.on('SIGTERM', () => {})
  const tick = () => writeFileSync(process.argv[3], String(Date.now()))
  tick()
  process.send('ready')
  setInterval(tick, 10)
} else {
  const worker = spawn(process.execPath, [import.meta.filename, 'worker', process.argv[2]], {
    stdio: [
      'ignore',
      process.argv[3] === 'closed-pipes' ? 'ignore' : 'inherit',
      process.argv[3] === 'closed-pipes' ? 'ignore' : 'inherit',
      'ipc',
    ],
  })
  worker.once('message', () => {
    const lines = readline.createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'initialize') {
        process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'tree-fixture' } })}\n`)
      } else if (message.method === 'test/pids') {
        process.stdout.write(
          `${JSON.stringify({ id: message.id, result: { root: process.pid, worker: worker.pid } })}\n`
        )
      } else if (message.method === 'test/exit') {
        process.exit(17)
      }
    })
    lines.on('close', () => {
      if (process.argv[3] !== 'stubborn') process.exit(0)
    })
    if (process.argv[3] === 'stubborn') process.on('SIGTERM', () => {})
  })
}
