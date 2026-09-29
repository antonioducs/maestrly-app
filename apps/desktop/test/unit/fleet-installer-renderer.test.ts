import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FLEET_INSTALLER_ERROR_CODES,
  FLEET_INSTALLER_STEP_IDS,
  type FleetInstallerStatus,
} from '../../src/shared/fleet-installer'
import { resources } from '../../src/shared/i18n/resources'
import { formatElapsed, panelState, stepLabelKey, validateRemoteForm } from '../../src/renderer/lib/fleet/installer'
import type { FleetConnectionView } from '../../src/preload/api-fleet'

const source = (path: string) => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')
const connection = (state: FleetConnectionView['state']): FleetConnectionView => ({
  features: [],
  state,
  deviceId: null,
  url: 'https://example.test',
  hostname: null,
  error: null,
  tokenPersistence: 'secure',
})
const status = (
  mode: 'local' | 'remote' | null,
  update: FleetInstallerStatus['update'] = 'none',
  busy = false
): FleetInstallerStatus => ({
  record: mode
    ? {
        mode,
        version: '1.0.0',
        port: 7443,
        allowPrivateNetwork: false,
        remote:
          mode === 'remote'
            ? { host: 'example.test', port: 22, username: 'root', hostKey: 'SHA256:test', keyTag: 'key' }
            : null,
        installedAt: '2026-09-27',
      }
    : null,
  appVersion: '1.1.0',
  update,
  tunnel: 'connected',
  keyPersistence: null,
  job: busy
    ? {
        id: 'job',
        kind: 'update',
        mode: mode ?? 'local',
        steps: [],
        state: 'running',
        error: null,
        startedAt: '2026-09-27',
        hostKey: null,
      }
    : null,
})
const lookup = (catalog: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)

describe('bot server renderer helpers', () => {
  it('labels the check step by mode', () => {
    expect(stepLabelKey('check', 'local')).toBe('botServer.step.checkLocal')
    expect(stepLabelKey('check', 'remote')).toBe('botServer.step.checkRemote')
    expect(stepLabelKey('images', 'remote')).toBe('botServer.step.images')
  })
  it('offers actions for installed, manual, newer, and busy states', () => {
    expect(panelState(status('local', 'available'), connection('connected'))).toEqual({
      mode: 'local',
      canUpdate: true,
      serverNewer: false,
      canRemove: true,
      canTogglePrivateNetwork: true,
      busy: false,
    })
    expect(panelState(status('remote', 'server-newer'), connection('reconnecting'))).toEqual({
      mode: 'remote',
      canUpdate: false,
      serverNewer: true,
      canRemove: false,
      canTogglePrivateNetwork: false,
      busy: false,
    })
    expect(panelState(status(null), connection('connected')).mode).toBe('manual')
    expect(panelState(status('local', 'available', true), connection('connected')).busy).toBe(true)
  })
  it('never offers to move back a server whose gateway reports a newer version', () => {
    // Recorded 1.0.0, app 1.1.0: without a reported version the update stands.
    expect(panelState(status('local', 'available'), connection('connected'), null).canUpdate).toBe(true)
    const newer = panelState(status('local', 'available'), connection('connected'), '1.2.0')
    expect(newer.canUpdate).toBe(false)
    expect(newer.serverNewer).toBe(true)
    const current = panelState(status('local', 'available'), connection('connected'), '1.1.0')
    expect([current.canUpdate, current.serverNewer]).toEqual([false, false])
    // Not a release version: the recorded one counts.
    expect(panelState(status('local', 'available'), connection('connected'), 'test').canUpdate).toBe(true)
  })
  it('validates remote fields and credentials', () => {
    const valid = {
      host: 'example.test',
      port: '22',
      username: 'root',
      password: 'secret',
      useKey: false,
      privateKey: '',
    }
    expect(validateRemoteForm(valid)).toEqual({})
    expect(validateRemoteForm({ ...valid, host: '' }).host).toBeTruthy()
    expect(validateRemoteForm({ ...valid, port: '70000' }).port).toBeTruthy()
    expect(validateRemoteForm({ ...valid, username: 'root user' }).username).toBeTruthy()
    expect(validateRemoteForm({ ...valid, password: '' }).password).toBeTruthy()
    expect(validateRemoteForm({ ...valid, useKey: true, privateKey: '' }).privateKey).toBeTruthy()
    for (const host of ['203.0.113.10', '2001:db8::1', '[2001:db8::1]'])
      expect(validateRemoteForm({ ...valid, host }).host, host).toBeUndefined()
    for (const host of ['https://vps.example.test', 'vps.example.test:22', 'root@vps.example.test'])
      expect(validateRemoteForm({ ...valid, host }).host, host).toBeTruthy()
  })
  it('formats elapsed time', () => expect(formatElapsed(65_000)).toBe('1:05'))
})

describe('bot server UI contract and copy', () => {
  it('routes settings through choice, progress and panel without native selects', () => {
    const settings = source('components/settings/FleetSettings.tsx')
    for (const component of ['BotServerChoice', 'BotServerProgress', 'BotServerPanel'])
      expect(settings).toContain(`<${component}`)
    for (const file of [
      'BotServerChoice',
      'BotServerLocalSetup',
      'BotServerRemoteSetup',
      'BotServerManualSetup',
      'BotServerProgress',
      'BotServerPanel',
      'PrivateNetworkSwitch',
    ])
      expect(source(`components/settings/bot-server/${file}.tsx`)).not.toMatch(/<select\b/)
  })
  it('uses only the existing installer, fleet, app info and external-link APIs', () => {
    const files = [
      'components/settings/FleetSettings.tsx',
      ...[
        'BotServerChoice',
        'BotServerLocalSetup',
        'BotServerRemoteSetup',
        'BotServerManualSetup',
        'BotServerProgress',
        'BotServerPanel',
        'PrivateNetworkSwitch',
      ].map((name) => `components/settings/bot-server/${name}.tsx`),
      'lib/fleet/use-fleet-installer.ts',
    ]
    for (const file of files)
      for (const match of source(file).matchAll(/window\.api\.([A-Za-z0-9_]+)/g))
        expect(
          /^(fleet|onFleetInstallerStatus$|platformInfo$|getAppInfo$|openExternalUrl$)/.test(match[1]),
          `${file}: ${match[1]}`
        ).toBe(true)
  })
  it('translates every installer step and error', () => {
    for (const language of ['en', 'pt-BR'] as const) {
      const catalog = resources[language].fleet
      for (const step of FLEET_INSTALLER_STEP_IDS)
        expect(
          lookup(catalog, `botServer.step.${step === 'check' ? 'checkLocal' : step}`),
          `${language} ${step}`
        ).toEqual(expect.any(String))
      expect(lookup(catalog, 'botServer.step.checkRemote')).toEqual(expect.any(String))
      for (const code of FLEET_INSTALLER_ERROR_CODES)
        expect(lookup(catalog, `botServer.error.${code}`), `${language} ${code}`).toEqual(expect.any(String))
    }
  })
  it('translates every key the components build from a state, a kind or a mode', () => {
    const keys = [
      ...['missing', 'stopped', 'no-permission', 'no-compose', 'dev-fleet', 'ready', 'readyEngine'].map(
        (state) => `botServer.local.${state}`
      ),
      ...['install-local', 'install-remote', 'update', 'private-network', 'remove'].map(
        (kind) => `botServer.job.${kind}`
      ),
      ...['local', 'remote'].flatMap((mode) => [
        `botServer.choice.${mode}Title`,
        `botServer.choice.${mode}Note`,
        `botServer.privateNetwork.${mode}Label`,
        `botServer.privateNetwork.${mode}Help`,
        `botServer.panel.disconnectConfirm.${mode}`,
        `botServer.panel.removeConfirm.${mode}`,
      ]),
      ...['mac', 'win', 'linux'].map((os) => `settings.deviceNameDefault.${os}`),
    ]
    for (const language of ['en', 'pt-BR'] as const)
      for (const key of keys)
        expect(lookup(resources[language].fleet, key), `${language} ${key}`).toEqual(expect.any(String))
  })
})
