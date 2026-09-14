import { createServer } from 'node:http'
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
export async function accountBackend() {
  const token = generation => `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'fixture@example.invalid', generation, 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-fixture', chatgpt_plan_type: 'plus' } })).toString('base64url')}.fixture`
  const initial = token(1), rotated = token(2), requests = []
  const server = createServer((req, res) => {
    req.resume()
    const credential = req.headers.authorization === `Bearer ${rotated}` ? 'rotated' : req.headers.authorization === `Bearer ${initial}` ? 'initial' : 'absent'
    requests.push({ path: req.url, credential })
    res.writeHead(!req.url?.includes('responses') ? req.url?.includes('/mcp') ? 404 : 200 : credential === 'rotated' ? 400 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url?.includes('responses') ? { error: { message: 'Synthetic account transport verification', type: 'invalid_request_error' } } : { models: [], items: [], plugins: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { initial, rotated, requests, port: server.address().port, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
export async function verifySessionAccounts({ backend, HostStore, AccountAuthority, work, facts, sessions, execute, upload, reconnect, broker, management }) {
  const directory = join(work, 'account-authority')
  await mkdir(directory, { mode: 0o700 })
  const store = new HostStore(directory)
  let current = backend.initial, refreshes = 0
  const value = () => ({ type: 'chatgptAuthTokens', accessToken: current, chatgptAccountId: 'shared-fixture', chatgptPlanType: 'plus' })
  const status = () => ({ state: 'connected', provider: 'codex', method: 'device' })
  const authority = new AccountAuthority({ store, directory: join(directory, 'accounts'), provider: async () => ({
    status: async () => status(), startDevice: async () => status(), startApiKey: async () => status(), cancel: async () => status(), logout: async () => status(),
    models: async () => [], credential: async forced => { if (forced) { refreshes++; current = backend.rotated }; return value() }, close: async () => {},
  }) })
  await authority.ready()
  const account = authority.create({ idempotencyKey: 'synthetic-shared-account', name: 'Synthetic shared account' })
  const attach = async session => {
    session.setAccountHandler((forced, hash) => authority.credential(account.id, forced, hash))
    const response = await session.request('auth.delegate', { credential: await authority.credential(account.id, false) })
    if (response.state !== 'connected') throw Error('Shared account did not reconnect')
  }
  try {
    for (const fact of facts) {
      const config = ['model_provider="account_fixture"', 'model_providers.account_fixture.name="Account fixture"', 'model_providers.account_fixture.base_url="http://account.test"',
        'model_providers.account_fixture.wire_api="responses"', 'model_providers.account_fixture.requires_openai_auth=true', 'chatgpt_base_url="http://account.test"',
        'features.responses_websockets=false', 'features.responses_websockets_v2=false'].join('\n') + '\n'
      await upload(fact.state + '/codex/config.toml', Buffer.from(config))
      await execute('/bin/chown', [fact.username + ':' + fact.username, fact.state + '/codex/config.toml'])
      await execute('/bin/systemctl', ['restart', `maestrly-bot-runtime@${fact.id}.service`])
    }
    await reconnect(1)
    const completions = [], turnIds = [], listeners = []
    for (const [index, fact] of facts.entries()) {
      fact.pid = (await execute('/bin/systemctl', ['show', `maestrly-bot-runtime@${fact.id}.service`, '--property=MainPID', '--value'])).trim()
      const session = sessions[index]
      session.setAccountHandler((forced, hash) => authority.credential(account.id, forced, hash))
      const turnId = randomUUID(); turnIds.push(turnId)
      completions.push(new Promise(resolve => {
        listeners.push(session.onEvent((event, ack) => {
          void appendFile(join(work, `account-events-${index}.jsonl`), JSON.stringify(event) + '\n').then(() => {
            ack()
            if (event.turnId === turnId && event.kind === 'turn.status' && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(event.detail?.status)) resolve(event.detail.status)
          })
        }))
      }))
      const policy = { mode: 'allowlist', domains: ['account.test'], revision: 5 }
      broker.updatePolicy('test-vm', policy, fact.id)
      await session.request('policy.update', { network: policy, permissionMode: 'ask' })
      if ((await session.request('auth.delegate', { credential: { ...value(), accessToken: backend.initial } })).state !== 'connected') throw Error('Delegated login rejected')
    }
    await Promise.all(facts.map(async (fact, index) => {
      const session = sessions[index], turnId = turnIds[index]
      const record = await management().request('session.inspect', { sessionId: fact.id })
      await management().request('session.lease', { sessionId: fact.id, generation: record.generation, turnId, leaseMs: 30000 })
      await session.request('turn.start', { botId: fact.botId, conversationId: `account-${fact.botId}`, turnId, generation: 1, permissionMode: 'ask', policyRevision: 5,
        network: { mode: 'allowlist', domains: ['account.test'], revision: 5 }, instructions: 'Synthetic transport test. No tools.', memory: [], recentMessages: [],
        message: 'Verify the synthetic account transport without tools.', attachments: [], model: { model: 'fixture-model' }, leaseMs: 30000,
        limits: { activeMs: 20000, maxTools: 1, maxLogBytes: 1048576 } }, 30000)
    }))
    let timeout
    const outcomes = await Promise.race([Promise.all(completions), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Synthetic account turns did not complete')), 30000) })]).finally(() => clearTimeout(timeout))
    if (refreshes !== 1 || outcomes.some(outcome => outcome !== 'failed') || backend.requests.filter(request => request.path?.includes('responses') && request.credential === 'rotated').length < 2) throw Error('Shared account rotation was not verified in both sessions')
    for (const [index, fact] of facts.entries()) {
      const record = await management().request('session.inspect', { sessionId: fact.id })
      await management().request('session.release', { sessionId: fact.id, generation: record.generation, turnId: turnIds[index] })
      const policy = { mode: 'offline', domains: [], revision: 6 }
      broker.updatePolicy('test-vm', policy, fact.id)
      await sessions[index].request('policy.update', { network: policy, permissionMode: 'ask' })
      await execute('/usr/bin/test', ['!', '-e', fact.state + '/codex/auth.json'])
    }
    listeners.forEach(unsubscribe => unsubscribe())
    console.log('Two real Codex workers renewed one synthetic shared account through their private control channels.')
    return { attach, report: { syntheticProviderTurns: 2, sharedRefreshes: refreshes, privateChannelRefresh: true, credentialsPersistedInWorkers: false, applicationWindowRequired: false, realAccountUsed: false }, async close() { await authority.close(); store.close() } }
  } catch (error) { await authority.close(); store.close(); throw error }
}
