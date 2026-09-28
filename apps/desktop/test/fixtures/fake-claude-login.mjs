#!/usr/bin/env node
// Mimics the Claude Code login surface Maestrly relies on (2.1.263).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
const args = process.argv.slice(2)
const dir = process.env.CLAUDE_CONFIG_DIR
const marker = path.join(dir, 'fake-logged-in')
if (args[0] === '--version') {
  console.log('2.1.263 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  // Adapt the fields to what the manager's status parser requires (see parseAuthStatus in manager.ts).
  console.log(
    JSON.stringify(
      existsSync(marker)
        ? {
            loggedIn: true,
            apiProvider: 'firstParty',
            authMethod: 'claude.ai',
            subscriptionType: 'max',
            email: 'owner@example.com',
          }
        : { loggedIn: false }
    )
  )
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'login') {
  if (process.env.FAKE_CLAUDE_SILENT === '1') setInterval(() => {}, 1000)
  else {
    const finish = () => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(marker, 'ok')
      process.exit(0)
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost')
      if (
        url.pathname === '/callback' &&
        url.searchParams.get('code') === 'good' &&
        url.searchParams.get('state') === 'fake-state'
      ) {
        res.writeHead(302, { Location: 'https://platform.claude.com/oauth/code/success?app=claude-code' }).end()
        server.close()
        finish()
      } else res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request')
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const url = (redirect) =>
        `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=${encodeURIComponent(redirect)}&state=fake-state`
      console.log('Opening browser to sign in…')
      execFile(process.env.BROWSER, [url(`http://localhost:${port}/callback`)], () => {})
      console.log(`If the browser didn't open, visit: ${url('https://platform.claude.com/oauth/code/callback')}`)
      process.stdout.write('Paste code here if prompted > ')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        if (line.trim() === 'good#fake-state') finish()
        else {
          console.log('Invalid code')
          process.exit(1)
        }
      })
    })
  }
}
