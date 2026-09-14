#!/usr/bin/env node
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import { ACCOUNT_CODEX_VERSION } from './fetch-account-runtime.mjs'
import { sha256 } from './host-build-utils.mjs'

/** Real pinned Codex, synthetic credentials and a loopback-only backend. Never uses an existing profile. */
export async function verifyAccountRuntime(manifestFile, reportFile) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { CodexAppServerClient } = await import(pathToFileURL(path.join(root, 'packages/codex-client/dist/index.js')))
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (manifest.version !== ACCOUNT_CODEX_VERSION || manifest.architecture !== process.arch || await sha256(manifest.binary.path) !== manifest.binary.sha256) throw new Error('ACCOUNT_RUNTIME_PIN_MISMATCH')
  const directory = await mkdtemp('/tmp/ma-account-contract-')
  await mkdir(path.join(directory, 'codex'), { mode: 0o700 })
  const token = generation => `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'fixture@example.invalid', generation, 'https://api.openai.com/auth': { chatgpt_account_id: 'contract-account', chatgpt_plan_type: 'plus' } })).toString('base64url')}.fixture`
  const initial = token(1), rotated = token(2)
  const requests = []
  let refreshes = 0
  const server = createServer((req, res) => {
    req.resume()
    const fresh = req.headers.authorization === `Bearer ${rotated}`
    const original = req.headers.authorization === `Bearer ${initial}`
    requests.push({ method: req.method, path: req.url, credential: fresh ? 'rotated' : original ? 'initial' : 'absent' })
    if (!req.url?.includes('responses')) {
      res.writeHead(req.url?.includes('/mcp') ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [], items: [], plugins: [] })); return
    }
    res.writeHead(fresh ? 400 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: fresh ? 'Synthetic account contract test complete' : 'Synthetic expired token', type: 'invalid_request_error' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  let client
  try {
    client = await CodexAppServerClient.connect({ binaryPath: manifest.binary.path,
      binaryArgs: ['app-server', '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'model_provider="account_fixture"',
        '-c', 'model_providers.account_fixture.name="Account contract fixture"', '-c', `model_providers.account_fixture.base_url="${address}"`,
        '-c', 'model_providers.account_fixture.wire_api="responses"', '-c', 'model_providers.account_fixture.requires_openai_auth=true',
        '-c', `chatgpt_base_url="${address}"`, '-c', 'features.responses_websockets=false', '-c', 'features.responses_websockets_v2=false'],
      clientInfo: { name: 'maestrly_bot_account_contract', title: 'Maestrly Bot Account Contract', version: '0.1.0' }, capabilities: { experimentalApi: true },
      cwd: directory, minimalEnvironment: true, env: { HOME: directory, CODEX_HOME: path.join(directory, 'codex'), PATH: '/usr/bin:/bin', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', RUST_LOG: 'off' }, stderrBufferLimit: 0,
      serverRequestHandler: async request => {
        if (request.method !== 'account/chatgptAuthTokens/refresh') throw new Error('No tools permitted in account contract test')
        if (request.params?.previousAccountId !== 'contract-account') throw new Error('Wrong account refresh scope')
        refreshes++
        return { accessToken: rotated, chatgptAccountId: 'contract-account', chatgptPlanType: 'plus' }
      },
    })
    const login = await client.startAccountLogin({ type: 'chatgptAuthTokens', accessToken: initial, chatgptAccountId: 'contract-account', chatgptPlanType: 'plus' })
    if (login.type !== 'chatgptAuthTokens') throw new Error('ACCOUNT_DELEGATION_REJECTED')
    const account = await client.readAccount({ refreshToken: false })
    if (account.account?.type !== 'chatgpt') throw new Error('ACCOUNT_DELEGATION_NOT_ACTIVE')
    let completed
    const notifications = []
    const done = new Promise(resolve => { completed = resolve })
    const unsubscribe = client.onNotification(notification => {
      if (notification.method === 'turn/completed') completed(notification.params?.turn?.status)
      if (notification.method === 'error') notifications.push(notification.params?.error?.message ?? 'Provider error')
    })
    const thread = await client.startThread({ model: 'fixture-model', cwd: directory, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })
    await client.startTurn({ threadId: thread.thread.id, input: [{ type: 'text', text: 'Synthetic account transport test. Do not use tools.', text_elements: [] }] })
    const deadline = setTimeout(() => completed('timeout'), 15000)
    const outcome = await done
    clearTimeout(deadline); unsubscribe()
    if (outcome === 'timeout' || refreshes !== 1 || !requests.some(request => request.credential === 'initial' && request.path?.includes('responses')) || !requests.some(request => request.credential === 'rotated' && request.path?.includes('responses'))) {
      throw new Error('ACCOUNT_REFRESH_CONTRACT_FAILED: ' + JSON.stringify({ outcome, refreshes, requests, errors: notifications.slice(0, 2) }))
    }
    const persisted = await readFile(path.join(directory, 'codex/auth.json'), 'utf8').then(() => true, () => false)
    if (persisted) throw new Error('DELEGATED_CREDENTIAL_PERSISTED')
    await client.logoutAccount()
    if ((await client.readAccount()).account !== null) throw new Error('ACCOUNT_LOGOUT_NOT_APPLIED')
    const result = { version: 1, runtimeVersion: manifest.version, binarySha256: manifest.binary.sha256, experimentalApiRequired: true,
      delegatedLogin: true, refreshes, retryWithRotatedCredential: true, persistentCredentials: false, logout: true,
      backend: 'loopback fixture', realAccountUsed: false, realModelTask: false, createdAt: new Date().toISOString() }
    if (reportFile) await writeFile(reportFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return result
  } finally { await client?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: verify-account-runtime.mjs <manifest.json> [new-report.json]')
  console.log(JSON.stringify(await verifyAccountRuntime(process.argv[2], process.argv[3])))
}
