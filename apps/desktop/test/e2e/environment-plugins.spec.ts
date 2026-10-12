import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { type FixtureFiles, makeGitRepo } from '../helpers/plugin-fixtures'
import { createSettingsGateway } from './helpers/environment-settings-gateway'
import { desktop, instanceEnv, launchHost } from './helpers/remote-host'

/** A synthetic Codex marketplace written for this test: one plugin with a skill, a local server and a token setting. */
const marketplace = (): FixtureFiles => ({
  '.agents/plugins/marketplace.json': JSON.stringify({
    name: 'e2e-market',
    plugins: [{ name: 'release-notes', source: { source: 'local', path: './plugins/release-notes' } }],
  }),
  'plugins/release-notes/.codex-plugin/plugin.json': JSON.stringify({
    name: 'release-notes',
    version: '1.0.0',
    license: 'MIT',
  }),
  'plugins/release-notes/skills/draft/SKILL.md': '---\ndescription: Draft release notes\n---\nWrite them.\n',
  'plugins/release-notes/.mcp.json': JSON.stringify({
    mcpServers: {
      notes: { command: 'node', args: ['./mcp/server.mjs'] },
      tracker: { url: 'https://tracker.example.test/mcp', bearer_token_env_var: 'TRACKER_TOKEN' },
    },
  }),
  'plugins/release-notes/mcp/server.mjs': 'process.exit(0)\n',
})

// Three parts of a real setup on this machine: this computer's app, a synthetic gateway, and an environment's app (the
// built app in server mode) that the gateway forwards plugin operations to. Git sources are local folders; no network,
// account or third-party plugin is involved.
test('environment plugins: bring one from this computer, then switch it off and uninstall it', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The environment side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-env-plugins-')))
  const repos = path.join(root, 'repos')
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(repos)
  await mkdir(workspacesRoot)
  const repo = await makeGitRepo(marketplace(), { parent: repos, name: 'market' })
  const url = pathToFileURL(repo.dir).href
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  let gateway: Awaited<ReturnType<typeof createSettingsGateway>> | undefined
  try {
    const instance = await launchHost(path.join(root, 'host-profile'), workspacesRoot, {
      MAESTRLY_E2E_PLUGIN_GIT_ROOT: repos,
    })
    host = instance.app
    const environmentState = async () => {
      const response = await fetch(`http://127.0.0.1:${instance.port}/v1/settings/plugins`, {
        headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${instance.token}` },
      })
      return (await response.json()) as {
        installed: Array<{ key: string; commit: string; enabled: boolean; setup: { missingInputs: string[] } }>
      }
    }
    gateway = await createSettingsGateway({
      plugins: { origin: `http://127.0.0.1:${instance.port}`, token: instance.token },
    })

    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'client-profile'), 'env-plugins-e2e'),
        MAESTRLY_E2E_PLUGIN_GIT_ROOT: repos,
      },
    })
    gateway.setVersion(await client.evaluate(({ app }) => app.getVersion()))
    const page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

    // This computer has the plugin, with its local server approved and a token entered.
    const added = await api('pluginsMarketplaceAdd', { url })
    expect(added.ok).toBe(true)
    const inspected = await api('pluginsInspect', { marketplaceId: added.value.id, name: 'release-notes' })
    expect(inspected.ok).toBe(true)
    const tokenInput = inspected.value.inputs.find((input: { serverKey: string }) => input.serverKey === 'tracker')
    const installed = await api('pluginsInstall', {
      marketplaceId: added.value.id,
      name: 'release-notes',
      consent: { consentFingerprint: inspected.value.consentFingerprint, stdio: ['notes'], executables: true },
      scope: { kind: 'global' },
      inputs: { [tokenInput.id]: 'synthetic-tracker-token' },
    })
    expect(installed.ok).toBe(true)

    await api('fleetConnect', { url: gateway.url, code: 'ABCD-EFGH' })
    await page.getByRole('tab', { name: /^Bots/ }).click()
    const environment = gateway.environments.find((item) => item.id === 'studio')!
    await page
      .getByRole('group', { name: environment.name, exact: true })
      .getByRole('button', { name: new RegExp(`^Environment ${environment.name} ·`) })
      .click()
    await page.getByRole('button', { name: 'Environment settings', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: `${environment.name} settings` })
    await sheet
      .getByRole('tablist', { name: 'Environment settings sections', exact: true })
      .getByRole('tab', { name: /^Plugins\b/ })
      .click()
    const center = sheet.getByTestId('plugins-settings')
    await expect(center).toBeVisible()

    // Bring it: the environment fetches the same commit and checks it against the approval given here.
    await center.getByRole('button', { name: 'Bring from this computer', exact: true }).click()
    const bring = page.getByTestId('bring-plugins')
    await bring.getByRole('button', { name: /^Bring: / }).click()
    await expect(bring.getByText('In this environment', { exact: true })).toBeVisible({ timeout: 60_000 })
    const brought = (await environmentState()).installed
    expect(brought).toHaveLength(1)
    expect(brought[0]).toMatchObject({ commit: repo.commit, enabled: true, setup: { missingInputs: [] } })
    // The token went from this computer's main process to the environment, never through this window.
    const sent = gateway.requests.find((request) => request.key === 'settingsBringPlugin')
    expect(sent?.body.inputs).toEqual({ [tokenInput.id]: 'synthetic-tracker-token' })
    expect(JSON.stringify(await environmentState())).not.toContain('synthetic-tracker-token')
    await bring.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect(bring).toBeHidden()

    // Managed like this computer's own plugins: switched off, then uninstalled.
    await center.getByRole('tab', { name: /^Installed/ }).click()
    await center.getByRole('switch', { name: /^Enabled: / }).click()
    await expect.poll(async () => (await environmentState()).installed[0]?.enabled).toBe(false)
    await center.getByRole('button', { name: /^Uninstall: / }).click()
    await page
      .getByRole('dialog', { name: /^Uninstall / })
      .getByRole('button', { name: 'Uninstall', exact: true })
      .click()
    await expect.poll(async () => (await environmentState()).installed.length).toBe(0)
    expect((await api('pluginsState')).installed).toHaveLength(1)
    expect(gateway.errors).toEqual([])
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await gateway?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
