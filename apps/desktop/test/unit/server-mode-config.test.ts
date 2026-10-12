import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { isHeadlessInstance, isServerMode, parseServerModeConfig } from '../../src/main/remote-host/server/config'

const token = randomBytes(32).toString('base64url')
const server = { MAESTRLY_SERVER_MODE: '1', MAESTRLY_BOT_CONTROL_TOKEN: token }

describe('server mode configuration', () => {
  it('is off on a desktop and in a bot container', () => {
    expect(isServerMode({})).toBe(false)
    expect(parseServerModeConfig({})).toBeNull()
    expect(isHeadlessInstance({})).toBe(false)
    const bot = { MAESTRLY_BOT_MODE: '1', MAESTRLY_BOT_CONTROL_TOKEN: token }
    expect(isServerMode(bot)).toBe(false)
    expect(parseServerModeConfig(bot)).toBeNull()
    expect(isHeadlessInstance(bot)).toBe(true)
    // An image started with both set is a bot: the entrypoint of a workspaces host never sets bot mode.
    expect(isServerMode({ ...bot, MAESTRLY_SERVER_MODE: '1' })).toBe(false)
  })

  it('reads the control server of a workspaces host like a bot environment does', () => {
    expect(isServerMode(server)).toBe(true)
    expect(isHeadlessInstance(server)).toBe(true)
    expect(parseServerModeConfig(server)).toEqual({
      mode: '1',
      controlHost: '0.0.0.0',
      controlPort: 7680,
      controlToken: token,
      workspacesRoot: null,
    })
    expect(
      parseServerModeConfig({
        ...server,
        MAESTRLY_ENVIRONMENT_ID: 'workspaces',
        MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
        MAESTRLY_BOT_CONTROL_PORT: '7777',
        MAESTRLY_BOT_GATEWAY_URL: 'http://maestrly-bot-gateway:7444',
        MAESTRLY_WORKSPACES_ROOT: '/srv/maestrly',
      })
    ).toEqual({
      mode: '1',
      environmentId: 'workspaces',
      controlHost: '127.0.0.1',
      controlPort: 7777,
      controlToken: token,
      gatewayUrl: 'http://maestrly-bot-gateway:7444',
      workspacesRoot: '/srv/maestrly',
    })
    expect(parseServerModeConfig({ ...server, MAESTRLY_WORKSPACES_ROOT: 'relative/path' })?.workspacesRoot).toBeNull()
  })

  it('refuses to start a workspaces host without a valid control token', () => {
    expect(() => parseServerModeConfig({ MAESTRLY_SERVER_MODE: '1' })).toThrow(/controlToken/)
    expect(() => parseServerModeConfig({ ...server, MAESTRLY_BOT_CONTROL_TOKEN: 'short' })).toThrow(/controlToken/)
  })

  it('leaves the configuration of a bot environment as it was', () => {
    expect(parseBotInstanceConfig({})).toBeNull()
    expect(parseBotInstanceConfig(server)).toBeNull()
    expect(parseBotInstanceConfig({ MAESTRLY_BOT_MODE: '1', MAESTRLY_BOT_CONTROL_TOKEN: token })).toEqual({
      mode: '1',
      controlHost: '0.0.0.0',
      controlPort: 7680,
      controlToken: token,
    })
    expect(() => parseBotInstanceConfig({ MAESTRLY_BOT_MODE: '1' })).toThrow(/Invalid bot instance environment/)
  })
})
