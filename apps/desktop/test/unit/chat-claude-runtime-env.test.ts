import { describe, expect, it } from 'vitest'
import {
  CLAUDE_RUNTIME_ENV_ALLOWLIST,
  CLAUDE_SUBSCRIPTION_RUNTIME_FLAGS,
  claudeSubscriptionRuntimeEnvironment,
} from '../../src/main/chat/claude-agent-sdk/runtime-env'

const DESKTOP_SESSION = {
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-0',
  XAUTHORITY: '/home/test/.Xauthority',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_SESSION_TYPE: 'x11',
  XDG_CURRENT_DESKTOP: 'XFCE',
  DESKTOP_SESSION: 'xfce',
  XDG_DATA_HOME: '/home/test/.local/share',
  XDG_DATA_DIRS: '/usr/share/xfce4:/usr/local/share:/usr/share',
  XDG_CONFIG_HOME: '/home/test/.config',
  XDG_CONFIG_DIRS: '/etc/xdg',
  BROWSER: 'firefox',
}

/** Variables that authenticate or reroute Claude Code: any of them could move a subscription to API billing. */
const BILLING_OR_CREDENTIALS = {
  ANTHROPIC_API_KEY: 'private-api-key',
  ANTHROPIC_AUTH_TOKEN: 'private-auth-token',
  ANTHROPIC_BASE_URL: 'https://billing.example',
  ANTHROPIC_CUSTOM_HEADERS: 'x-private: 1',
  CLAUDE_CODE_OAUTH_TOKEN: 'private-oauth',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  AWS_ACCESS_KEY_ID: 'private-aws',
  AWS_SECRET_ACCESS_KEY: 'private-aws-secret',
  AWS_BEARER_TOKEN_BEDROCK: 'private-bedrock',
  GOOGLE_APPLICATION_CREDENTIALS: '/private/gcp.json',
  ANTHROPIC_VERTEX_PROJECT_ID: 'private-project',
  OPENAI_API_KEY: 'private-openai',
  GITHUB_TOKEN: 'private-github',
}

describe('Claude runtime environment allowlist', () => {
  it('forwards the Linux desktop session so Claude Code can open the browser', () => {
    const environment = claudeSubscriptionRuntimeEnvironment('/isolated/claude-profile', {
      PATH: '/usr/bin',
      HOME: '/home/test',
      ...DESKTOP_SESSION,
    })
    expect(environment).toMatchObject(DESKTOP_SESSION)
  })

  it('never forwards credentials or endpoints that could switch the subscription to API billing', () => {
    const environment = claudeSubscriptionRuntimeEnvironment('/isolated/claude-profile', {
      PATH: '/usr/bin',
      HOME: '/home/test',
      ...DESKTOP_SESSION,
      ...BILLING_OR_CREDENTIALS,
    })
    for (const name of Object.keys(BILLING_OR_CREDENTIALS)) expect(environment).not.toHaveProperty(name)
    expect(JSON.stringify(environment)).not.toContain('private')
  })

  it('lists no credential, provider-selection or endpoint variable', () => {
    for (const name of CLAUDE_RUNTIME_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH_|ANTHROPIC|BEDROCK|VERTEX|FOUNDRY|AWS_|_URL$/)
      expect(name.startsWith('CLAUDE_CODE_USE_')).toBe(false)
    }
  })

  it('pins the isolated profile and runtime flags over the inherited environment', () => {
    const environment = claudeSubscriptionRuntimeEnvironment('/isolated/claude-profile', {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/test/.claude',
      DISABLE_AUTOUPDATER: '0',
    })
    expect(environment).toEqual({
      PATH: '/usr/bin',
      ...CLAUDE_SUBSCRIPTION_RUNTIME_FLAGS,
      CLAUDE_CONFIG_DIR: '/isolated/claude-profile',
    })
  })

  it('omits empty and missing session variables', () => {
    const environment = claudeSubscriptionRuntimeEnvironment('/isolated/claude-profile', {
      PATH: '/usr/bin',
      DISPLAY: '',
    })
    expect(environment).not.toHaveProperty('DISPLAY')
    expect(environment).not.toHaveProperty('WAYLAND_DISPLAY')
  })
})
