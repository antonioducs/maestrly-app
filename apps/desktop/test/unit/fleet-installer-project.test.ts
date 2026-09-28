import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fleetUpdateState } from '../../src/shared/fleet-installer'
import { InstallerError, installerErrorOf } from '../../src/main/fleet/installer/errors'
import { BOT_SERVER_REGISTRY, botServerImages } from '../../src/main/fleet/installer/images'
import {
  bundledComposePath,
  composeArgs,
  displayNameFor,
  imageVersion,
  parseBotServerEnv,
  renderBotServerEnv,
  splitImageRef,
  timezoneOrUtc,
  withEnvValues,
  type BotServerEnvValues,
} from '../../src/main/fleet/installer/project'

const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const read = (relative: string) => readFileSync(path.join(repository, relative), 'utf8')

describe('bot server images', () => {
  it('pulls the images of the app version from the registry in a packaged app', () => {
    expect(botServerImages({ version: '0.9.4', isPackaged: true, env: {} })).toEqual({
      gateway: 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4',
      bot: 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.4',
      source: 'registry',
    })
  })

  it('uses the images built from this checkout in a development build', () => {
    expect(botServerImages({ version: '0.9.4', isPackaged: false, env: {} })).toEqual({
      gateway: 'maestrly/bot-gateway:local',
      bot: 'maestrly/bot-instance:local',
      source: 'local',
    })
  })

  it('takes another registry and tag from the environment, and refuses malformed ones', () => {
    const env = { MAESTRLY_BOT_SERVER_REGISTRY: 'host.orb.internal:5500/', MAESTRLY_BOT_SERVER_TAG: 'check' }
    for (const isPackaged of [true, false])
      expect(botServerImages({ version: '0.9.4', isPackaged, env })).toEqual({
        gateway: 'host.orb.internal:5500/maestrly-bot-gateway:check',
        bot: 'host.orb.internal:5500/maestrly-bot-instance:check',
        source: 'registry',
      })
    expect(
      botServerImages({ version: '0.9.4', isPackaged: false, env: { MAESTRLY_BOT_SERVER_TAG: 'e2e' } })
    ).toMatchObject({
      gateway: 'maestrly/bot-gateway:e2e',
      source: 'local',
    })
    expect(() =>
      botServerImages({ version: '0.9.4', isPackaged: true, env: { MAESTRLY_BOT_SERVER_REGISTRY: 'registry example' } })
    ).toThrow()
    expect(() =>
      botServerImages({ version: '0.9.4', isPackaged: true, env: { MAESTRLY_BOT_SERVER_TAG: 'a b' } })
    ).toThrow()
  })

  it('publishes under the owner the app updates from, and packages the Compose file', () => {
    const builder = read('apps/desktop/electron-builder.yml')
    const owner = /^publish:\n(?: {2}.*\n)*? {2}owner: (\S+)$/m.exec(builder)?.[1]
    expect(owner).toBeTruthy()
    expect(BOT_SERVER_REGISTRY).toBe('ghcr.io/' + owner!.toLowerCase())
    expect(builder).toMatch(/- from: \.\.\/\.\.\/deploy\/bot-fleet\/compose\.yml\n\s+to: bot-server\/compose\.yml/)
  })
})

describe('bot server project files', () => {
  const values: BotServerEnvValues = {
    gatewayImage: 'ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4',
    botImage: 'ghcr.io/antonioducs/maestrly-bot-instance:0.9.4',
    port: 7443,
    displayName: 'Estação de Trabalho',
    egress: 'public',
    timezone: 'America/Sao_Paulo',
  }

  it('renders the Compose environment Maestrly owns', () => {
    expect(renderBotServerEnv(values)).toBe(
      [
        'MAESTRLY_GATEWAY_IMAGE=ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4',
        'MAESTRLY_GATEWAY_BOT_IMAGE=ghcr.io/antonioducs/maestrly-bot-instance:0.9.4',
        'MAESTRLY_GATEWAY_BIND=127.0.0.1',
        'MAESTRLY_GATEWAY_PORT=7443',
        "MAESTRLY_GATEWAY_DISPLAY_NAME='Estação de Trabalho'",
        'MAESTRLY_GATEWAY_BOT_EGRESS=public',
        'MAESTRLY_GATEWAY_NETWORK=maestrly-bots',
        'TZ=America/Sao_Paulo',
        '',
      ].join('\n')
    )
    expect(() => renderBotServerEnv({ ...values, port: 0 })).toThrow()
    expect(() => renderBotServerEnv({ ...values, botImage: 'maestrly/bot instance:1' })).toThrow()
  })

  it('only sets variables the packaged Compose file reads', () => {
    const compose = read('deploy/bot-fleet/compose.yml')
    for (const line of renderBotServerEnv(values).trim().split('\n')) {
      const key = line.slice(0, line.indexOf('='))
      expect(compose, key).toContain('${' + key)
    }
  })

  it('reads back what it wrote, and ignores unknown values', () => {
    expect(parseBotServerEnv(renderBotServerEnv(values))).toEqual({
      gatewayImage: values.gatewayImage,
      botImage: values.botImage,
      egress: 'public',
      port: 7443,
    })
    expect(parseBotServerEnv('# comment\nMAESTRLY_GATEWAY_BOT_EGRESS=closed\nMAESTRLY_GATEWAY_PORT=abc\n')).toEqual({
      gatewayImage: null,
      botImage: null,
      egress: null,
      port: null,
    })
    expect(parseBotServerEnv('MAESTRLY_GATEWAY_IMAGE="maestrly/bot-gateway:0.9.1"\n').gatewayImage).toBe(
      'maestrly/bot-gateway:0.9.1'
    )
  })

  it('changes only the values it owns in an existing environment file', () => {
    const edited =
      "# Written by Maestrly\nMAESTRLY_GATEWAY_IMAGE=a/b:1\nMAESTRLY_GATEWAY_DISPLAY_NAME='Custom'\nTZ=Europe/Lisbon\n"
    expect(withEnvValues(edited, { MAESTRLY_GATEWAY_IMAGE: 'a/b:2', MAESTRLY_GATEWAY_BOT_EGRESS: 'open' })).toBe(
      "# Written by Maestrly\nMAESTRLY_GATEWAY_IMAGE=a/b:2\nMAESTRLY_GATEWAY_DISPLAY_NAME='Custom'\nTZ=Europe/Lisbon\nMAESTRLY_GATEWAY_BOT_EGRESS=open\n"
    )
    expect(withEnvValues('TZ=UTC', { MAESTRLY_GATEWAY_BOT_EGRESS: 'public' })).toBe(
      'TZ=UTC\nMAESTRLY_GATEWAY_BOT_EGRESS=public\n'
    )
    expect(() => withEnvValues(edited, { MAESTRLY_GATEWAY_BOT_EGRESS: 'closed' })).toThrow()
    expect(() => withEnvValues(edited, { MAESTRLY_GATEWAY_IMAGE: 'a b' })).toThrow()
  })

  it('splits an image reference without taking a registry port for a tag', () => {
    expect(splitImageRef('ghcr.io/o/maestrly-bot-gateway:0.9.4')).toEqual({
      repository: 'ghcr.io/o/maestrly-bot-gateway',
      tag: '0.9.4',
    })
    expect(splitImageRef('host.orb.internal:5500/maestrly-bot-gateway:check')).toEqual({
      repository: 'host.orb.internal:5500/maestrly-bot-gateway',
      tag: 'check',
    })
    expect(splitImageRef('host.orb.internal:5500/maestrly-bot-gateway')).toEqual({
      repository: 'host.orb.internal:5500/maestrly-bot-gateway',
      tag: null,
    })
  })

  it('names the server safely for the environment file', () => {
    expect(displayNameFor("O'Brien\n$HOME `x`")).toBe('OBrien HOME x')
    expect(displayNameFor('  ')).toBe('Maestrly')
    expect(displayNameFor('a'.repeat(80))).toHaveLength(64)
    expect(displayNameFor('Estação  de\tTrabalho')).toBe('Estação de Trabalho')
  })

  it('keeps a valid time zone and falls back to UTC', () => {
    expect(timezoneOrUtc('America/Sao_Paulo')).toBe('America/Sao_Paulo')
    expect(timezoneOrUtc('Nowhere/City')).toBe('Etc/UTC')
    expect(timezoneOrUtc(undefined)).toBe('Etc/UTC')
  })

  it('reads the version of an image from its tag', () => {
    expect(imageVersion('ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4-beta.1')).toBe('0.9.4-beta.1')
    expect(imageVersion('ghcr.io/antonioducs/maestrly-bot-gateway:0.9.4')).toBe('0.9.4')
    expect(imageVersion('maestrly/bot-gateway:local')).toBeNull()
    expect(imageVersion('host.orb.internal:5500/maestrly-bot-gateway')).toBeNull()
    expect(imageVersion('maestrly/bot-gateway@sha256:' + 'a'.repeat(64))).toBeNull()
  })

  it('runs Compose on the project with its own files', () => {
    expect(composeArgs('/opt/maestrly-bots', path.posix.join)).toEqual([
      'compose',
      '--project-name',
      'maestrly-bots',
      '--project-directory',
      '/opt/maestrly-bots',
      '--file',
      '/opt/maestrly-bots/compose.yml',
      '--env-file',
      '/opt/maestrly-bots/.env',
    ])
  })

  it('finds the Compose file in the package and in the checkout', () => {
    expect(bundledComposePath({ isPackaged: true, resourcesPath: '/Applications/App/Resources' })).toBe(
      path.join('/Applications/App/Resources', 'bot-server', 'compose.yml')
    )
    const checkout = bundledComposePath({ isPackaged: false, appPath: path.join(repository, 'apps/desktop') })
    expect(checkout).toBe(path.join(repository, 'deploy/bot-fleet/compose.yml'))
    expect(existsSync(checkout)).toBe(true)
  })
})

describe('bot server versions and errors', () => {
  it('offers an update when the server is older than the app, never a downgrade', () => {
    expect(fleetUpdateState('0.9.3', '0.9.4')).toBe('available')
    expect(fleetUpdateState('0.9.4', '0.9.4')).toBe('none')
    expect(fleetUpdateState('0.9.5', '0.9.4')).toBe('server-newer')
    expect(fleetUpdateState(null, '0.9.4')).toBe('available')
  })

  it('keeps the code of installer errors and bounds unknown ones', () => {
    expect(installerErrorOf(new InstallerError('docker-stopped', 'Docker is not running'))).toEqual({
      code: 'docker-stopped',
      detail: 'Docker is not running',
    })
    expect(installerErrorOf(new Error('x'.repeat(400)))).toEqual({ code: 'unknown', detail: 'x'.repeat(300) })
    expect(installerErrorOf('plain')).toEqual({ code: 'unknown', detail: 'plain' })
    expect(installerErrorOf(undefined)).toEqual({ code: 'unknown', detail: null })
  })
})
