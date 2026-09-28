import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from '../fixtures/fake-ssh-server'
import { FakeDockerEngine, FakeGateway, FakeVps, startFakeDockerCli } from './helpers/fake-bot-server'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const repository = path.resolve(desktop, '..', '..')
/** A registry the tests name; its images exist only in the fake engines. */
const REGISTRY = 'registry.e2e.test/maestrly'
const REMOTE_ENV = '/opt/maestrly-bots/.env'

async function launch(root: string, instance: string, env: Record<string, string> = {}) {
  const app = await electron.launch({
    args: [path.join(desktop, 'out/main/index.js')],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_E2E_SKILLS_HOME: root,
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: instance,
      AGENTS_USERDATA: path.join(root, 'profile'),
      AGENTS_LOCALE: 'pt-BR',
      ELECTRON_RENDERER_URL: '',
      MAESTRLY_BOT_SERVER_REGISTRY: REGISTRY,
      MAESTRLY_BOT_SERVER_TAG: '',
      ...env,
    },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean((window as any).api))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  return { app, page }
}

async function openBotServer(page: Page) {
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  await page.getByRole('button', { name: 'Servidor de bots' }).first().click()
}

const installerStatus = (page: Page) => page.evaluate(() => window.api.fleetInstallerStatus())
const connected = (page: Page) => page.getByRole('main').getByRole('status').filter({ hasText: 'Conectado' })
/**
 * Starts an installer job and waits for it to end, failing with its steps and error, so that a failed setup is not
 * reported as a missing status. Slow runners take several seconds per step.
 */
async function runJob(page: Page, start: () => Promise<void>) {
  const before = (await installerStatus(page)).job?.id ?? null
  await start()
  await expect
    .poll(
      async () => {
        const job = (await installerStatus(page)).job
        return job && job.id !== before ? job.state : 'waiting'
      },
      { timeout: 120_000 }
    )
    .not.toMatch(/^(waiting|running)$/)
  const job = (await installerStatus(page)).job
  expect(job?.state, JSON.stringify(job)).toBe('succeeded')
}
/** After setup the fleet client reconnects through the lasting tunnel with backoff, which can take a few seconds. */
const CONNECTED = { timeout: 45_000 }
const images = (version: string) => [
  `${REGISTRY}/maestrly-bot-gateway:${version}`,
  `${REGISTRY}/maestrly-bot-instance:${version}`,
]

test('sets up the bot server on this computer, changes its network access, and removes it', async () => {
  test.skip(process.platform === 'win32', 'The fake docker CLI is a POSIX shell script.')
  test.setTimeout(180_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-server-local-'))
  const project = path.join(root, 'profile', 'bot-server')
  const gateway = new FakeGateway('fleet-local-host')
  const engine = new FakeDockerEngine({
    gateway,
    engineName: 'Docker Desktop',
    readFile: (file) => readFile(file, 'utf8').catch(() => null),
    listenPort: (published) => published,
  })
  engine.daemon = 'stopped'
  const cli = await startFakeDockerCli(engine, path.join(root, 'bin'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(root, 'bot-server-local-e2e', { MAESTRLY_BOT_SERVER_DOCKER: cli.path })
    app = launched.app
    const page = launched.page
    await expect(page.getByRole('tab', { name: 'Bots' }).getByTitle('Experimental')).toBeVisible()

    await openBotServer(page)
    await expect(page.getByRole('heading', { name: 'Onde os bots vão rodar?' })).toBeVisible()
    await page.getByRole('button', { name: /^Neste computador/ }).click()
    await expect(page.getByText('Abra o Docker e espere ele iniciar.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Instalar servidor de bots' })).toHaveCount(0)
    engine.daemon = 'running'
    await page.getByRole('button', { name: 'Verificar de novo' }).click()
    await expect(page.getByText('Docker 28.0.1 pronto (Docker Desktop)')).toBeVisible()
    const privateNetwork = page.getByRole('switch', {
      name: 'Deixar os bots acessarem este computador e a rede local',
    })
    await expect(privateNetwork).toHaveAttribute('aria-checked', 'false')
    await page.getByLabel('Nome do dispositivo').fill('Mesa E2E')
    await runJob(page, () => page.getByRole('button', { name: 'Instalar servidor de bots' }).click())

    await expect(connected(page)).toContainText('fleet-local-host', CONNECTED)
    await expect(page.getByRole('heading', { name: 'Neste computador' })).toBeVisible()
    const installed = await installerStatus(page)
    const version = installed.appVersion
    expect(installed.record).toMatchObject({ mode: 'local', version, port: gateway.port, allowPrivateNetwork: false })
    expect(installed.job?.steps.map((step) => [step.id, step.state])).toEqual([
      ['check', 'done'],
      ['files', 'done'],
      ['images', 'done'],
      ['start', 'done'],
      ['pair', 'done'],
    ])
    await expect(page.getByText(`Servidor ${version} · Maestrly ${version}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Atualizar servidor' })).toHaveCount(0)
    expect(engine.commands(['pull'])).toEqual(images(version).map((ref) => ['pull', ref]))
    expect(engine.commands(['compose', 'up'])).toEqual([['compose', 'up', '-d', '--no-build']])
    expect(gateway.pairings).toEqual([{ code: expect.any(String), deviceName: 'Mesa E2E', deviceId: 'device-1' }])
    const env = await readFile(path.join(project, '.env'), 'utf8')
    for (const line of [
      `MAESTRLY_GATEWAY_IMAGE=${images(version)[0]}`,
      `MAESTRLY_GATEWAY_BOT_IMAGE=${images(version)[1]}`,
      'MAESTRLY_GATEWAY_BIND=127.0.0.1',
      `MAESTRLY_GATEWAY_PORT=${gateway.port}`,
      'MAESTRLY_GATEWAY_BOT_EGRESS=public',
    ])
      expect(env).toContain(line)
    expect(await readFile(path.join(project, 'compose.yml'), 'utf8')).toBe(
      await readFile(path.join(repository, 'deploy/bot-fleet/compose.yml'), 'utf8')
    )

    await privateNetwork.click()
    await expect(privateNetwork).toHaveAttribute('aria-checked', 'true')
    expect(await readFile(path.join(project, '.env'), 'utf8')).toContain('MAESTRLY_GATEWAY_BOT_EGRESS=open')
    expect(engine.commands(['compose', 'up'])).toHaveLength(2)
    await expect(connected(page)).toContainText('fleet-local-host', CONNECTED)

    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await page.getByRole('tab', { name: 'Bots' }).click()
    await page
      .getByRole('button', { name: /fleet-local-host/ })
      .first()
      .click()
    await expect(page.getByText('Os bots rodam aqui')).toBeVisible()
    await expect(page.getByText('Se este computador dormir ou desligar, os bots param.')).toBeVisible()

    await openBotServer(page)
    await page.getByRole('button', { name: 'Remover servidor de bots' }).click()
    const removal = page.getByRole('dialog', { name: 'Remover servidor de bots' })
    const confirm = removal.getByRole('button', { name: 'Remover servidor de bots' })
    await expect(confirm).toBeDisabled()
    await removal.getByRole('textbox').fill('remover')
    await confirm.click()
    await expect(page.getByRole('heading', { name: 'Onde os bots vão rodar?' })).toBeVisible()
    expect(await installerStatus(page)).toMatchObject({ record: null, job: { kind: 'remove', state: 'succeeded' } })
    expect(gateway.requests.map((request) => request.key)).toEqual(
      expect.arrayContaining(['environmentArchive', 'archivedEnvironmentDelete', 'devicesSelfDelete'])
    )
    expect(engine.commands(['compose', 'down'])).toEqual([['compose', 'down', '-v', '--remove-orphans']])
    expect(engine.commands(['image', 'rm'])).toEqual(images(version).map((ref) => ['image', 'rm', ref]))
    expect(engine.images.size).toBe(0)
    expect(gateway.running).toBe(false)
    expect(existsSync(project)).toBe(false)
  } finally {
    await app?.close()
    await gateway.stop()
    await cli.close()
    await removeTempDirEventually(root)
  }
})

test('sets up a VPS over SSH, joins it again at an older version, and updates it', async () => {
  test.setTimeout(240_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-server-vps-'))
  const gateway = new FakeGateway('fleet-vps')
  const vps = new FakeVps(gateway, 'fleet-vps')
  // Mutable: the password changes once Maestrly signs in with its own key.
  const users: Record<string, string> = { root: 'synthetic-root-password' }
  let ssh: FakeSshServer | undefined
  let app: ElectronApplication | undefined
  try {
    ssh = await startFakeSshServer({ users, exec: vps.exec, forwardTo: vps.forwardTo })
    vps.authorizedKeys = ssh.authorizedKeys
    const server = ssh
    const launched = await launch(root, 'bot-server-vps-e2e')
    app = launched.app
    const page = launched.page
    const installOnServer = async (password: string) => {
      await page.getByRole('button', { name: /^Num servidor \(VPS\)/ }).click()
      await page.getByLabel('Endereço do servidor').fill('127.0.0.1')
      await expect(page.getByLabel('Usuário')).toHaveValue('root')
      await page.getByLabel('Senha', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Opções avançadas' }).click()
      await page.getByLabel('Porta SSH').fill(String(server.port))
      await runJob(page, () => page.getByRole('button', { name: 'Instalar no servidor' }).click())
    }

    await openBotServer(page)
    await installOnServer('synthetic-root-password')
    await expect(connected(page)).toContainText('fleet-vps', CONNECTED)
    await expect(page.getByRole('heading', { name: 'Servidor 127.0.0.1 (SSH)' })).toBeVisible()
    const installed = await installerStatus(page)
    const version = installed.appVersion
    expect(installed.record).toMatchObject({
      mode: 'remote',
      version,
      allowPrivateNetwork: false,
      remote: { host: '127.0.0.1', port: server.port, username: 'root', hostKey: server.fingerprint },
    })
    expect(installed.job?.hostKey).toBe(server.fingerprint)
    // The lasting tunnel signs in with Maestrly's key in the background once setup ends.
    await expect.poll(async () => (await installerStatus(page)).tunnel).toBe('connected')
    expect(JSON.stringify(installed)).not.toContain('synthetic-root-password')
    expect(vps.scripts(server.commands)).toEqual([
      'probe',
      'install-docker',
      'write-file',
      'write-file',
      'authorize-key',
    ])
    expect(server.authorizedKeys).toEqual([
      expect.stringMatching(new RegExp(`^ssh-ed25519 \\S+ ${installed.record?.remote?.keyTag}$`)),
    ])
    expect(vps.engine.commands(['pull'])).toEqual(images(version).map((ref) => ['pull', ref]))
    const env = vps.files.get(REMOTE_ENV) ?? ''
    for (const line of [
      `MAESTRLY_GATEWAY_IMAGE=${images(version)[0]}`,
      `MAESTRLY_GATEWAY_BOT_IMAGE=${images(version)[1]}`,
      'MAESTRLY_GATEWAY_BIND=127.0.0.1',
      'MAESTRLY_GATEWAY_PORT=7443',
      "MAESTRLY_GATEWAY_DISPLAY_NAME='fleet-vps'",
      'MAESTRLY_GATEWAY_BOT_EGRESS=public',
    ])
      expect(env).toContain(line)
    expect(vps.files.get('/opt/maestrly-bots/compose.yml')).toBe(
      await readFile(path.join(repository, 'deploy/bot-fleet/compose.yml'), 'utf8')
    )

    // From now on Maestrly signs in with its own key: the tunnel comes back after the password changed.
    users.root = 'rotated-root-password'
    const connections = server.connections
    await server.restart()
    await expect.poll(() => server.connections).toBeGreaterThan(connections)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.api.fleetRefresh().then(
            (snapshot) => snapshot.host?.hostname ?? null,
            (error: unknown) => String(error)
          )
        )
      )
      .toBe('fleet-vps')

    await page.getByRole('button', { name: 'Desconectar este computador' }).click()
    await page
      .getByRole('dialog', { name: 'Desconectar este computador' })
      .getByRole('button', { name: 'Desconectar este computador' })
      .click()
    await expect(page.getByRole('heading', { name: 'Onde os bots vão rodar?' })).toBeVisible()
    expect(server.authorizedKeys).toEqual([])
    expect(gateway.requests.filter((request) => request.key === 'devicesSelfDelete')).toHaveLength(1)
    expect((await installerStatus(page)).record).toBeNull()

    // Another computer's older app installed this server: its `.env` names older images, still on the server.
    const older = images('0.0.1')
    vps.files.set(REMOTE_ENV, env.replace(images(version)[0], older[0]).replace(images(version)[1], older[1]))
    for (const ref of older) vps.engine.images.add(ref)
    const commandsBeforeJoin = server.commands.length
    await installOnServer('rotated-root-password')
    await expect(connected(page)).toContainText('fleet-vps', CONNECTED)
    await expect(page.getByText(`Servidor 0.0.1 · Maestrly ${version}`)).toBeVisible()
    const joined = await installerStatus(page)
    expect(joined.job?.steps.map((step) => [step.id, step.state])).toEqual([
      ['connect', 'done'],
      ['check', 'done'],
      ['docker', 'skipped'],
      ['files', 'skipped'],
      ['images', 'skipped'],
      ['start', 'done'],
      ['tunnel', 'done'],
      ['pair', 'done'],
      ['key', 'done'],
    ])
    expect(joined.record).toMatchObject({ version: '0.0.1', allowPrivateNetwork: false })
    expect(vps.scripts(server.commands.slice(commandsBeforeJoin))).toEqual(['probe', 'authorize-key'])
    expect(gateway.pairings.map((pairing) => pairing.deviceId)).toEqual(['device-1', 'device-2'])

    await runJob(page, () => page.getByRole('button', { name: 'Atualizar servidor' }).click())
    await expect(page.getByText(`Servidor ${version} · Maestrly ${version}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Atualizar servidor' })).toHaveCount(0)
    expect((await installerStatus(page)).job).toMatchObject({ kind: 'update', state: 'succeeded' })
    const updated = vps.files.get(REMOTE_ENV) ?? ''
    for (const line of [
      `MAESTRLY_GATEWAY_IMAGE=${images(version)[0]}`,
      `MAESTRLY_GATEWAY_BOT_IMAGE=${images(version)[1]}`,
      "MAESTRLY_GATEWAY_DISPLAY_NAME='fleet-vps'",
      'MAESTRLY_GATEWAY_BOT_EGRESS=public',
    ])
      expect(updated).toContain(line)
    // The older images are removed once the server runs the new ones.
    expect([...vps.engine.images].sort()).toEqual([...images(version)].sort())
    await expect(connected(page)).toContainText('fleet-vps', CONNECTED)

    // A reinstalled server, or someone in between: the tunnel stops for good and the panel asks to set it up again.
    await server.restart({ newHostKey: true })
    await expect(page.getByText('A identidade do servidor mudou')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Configurar de novo' })).toBeVisible()
    expect((await installerStatus(page)).tunnel).toBe('host-key-changed')
  } finally {
    await app?.close()
    await ssh?.close()
    await gateway.stop()
    await removeTempDirEventually(root)
  }
})
