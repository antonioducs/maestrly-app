import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { app } from 'electron'
import { applyE2EUserData } from './test-mode'

export type Channel = 'prod' | 'beta' | 'dev'

export interface ChannelInfo {
  channel: Channel
  /** Display name and packaged bundle name. */
  productName: string

  userDataDirName: string

  appId: string

  badgeLabel: string | null

  iconBase: string
}

const CHANNELS: Record<Channel, ChannelInfo> = {
  prod: {
    channel: 'prod',
    productName: 'Maestrly App',

    userDataDirName: 'maestrly-app',
    appId: 'io.github.antonioducs.maestrly',
    badgeLabel: null,
    iconBase: 'icon',
  },
  beta: {
    channel: 'beta',
    productName: 'Maestrly App Beta',
    userDataDirName: 'maestrly-app-beta',
    appId: 'io.github.antonioducs.maestrly.beta',
    badgeLabel: 'BETA',
    iconBase: 'icon-beta',
  },
  dev: {
    channel: 'dev',
    productName: 'Maestrly App Dev',

    userDataDirName: 'maestrly-app-dev',
    appId: 'io.github.antonioducs.maestrly.dev',
    badgeLabel: 'DEV',
    iconBase: 'icon-dev',
  },
}

function isChannel(v: string): v is Channel {
  return v === 'prod' || v === 'beta' || v === 'dev'
}

const INSTANCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/

let resolved: Channel | null = null

export function getInstanceId(): string | null {
  const raw = process.env.AGENTS_INSTANCE?.trim()
  if (!raw) return null
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(
      `[channel] Invalid AGENTS_INSTANCE: "${raw}". Use letters, numbers, and hyphens (maximum 32; do not start with a hyphen).`
    )
  }
  return raw
}

/** Invalid configured channels fail closed instead of opening production data. */
export function getChannel(): Channel {
  if (resolved) return resolved
  const fromEnv = process.env.AGENTS_CHANNEL?.trim()
  const fromBuild = (import.meta.env.MAIN_VITE_CHANNEL ?? '').trim()
  const raw = fromEnv || fromBuild
  if (raw) {
    if (!isChannel(raw)) {
      const src = fromEnv ? 'AGENTS_CHANNEL' : 'MAIN_VITE_CHANNEL'
      throw new Error(`[channel] invalid value in ${src}: "${raw}". Use one of: ${Object.keys(CHANNELS).join(' | ')}.`)
    }
    resolved = raw
  } else {
    resolved = app.isPackaged ? 'prod' : 'dev'
  }
  return resolved
}

export function getChannelInfo(): ChannelInfo {
  return CHANNELS[getChannel()]
}

/** Apply before the instance lock or store initialization; never reuse original Maestrly profiles. */
export function applyChannelIdentity(): void {
  const info = getChannelInfo()
  const instanceId = getInstanceId()
  let userDataDirName = info.userDataDirName
  if (instanceId) {
    userDataDirName = `${userDataDirName}-${instanceId}`
  }
  app.setName(info.productName)
  const dir = path.join(app.getPath('appData'), userDataDirName)
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)

  applyE2EUserData()
}
