import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { SOUND_VOICES, coerceVolume, type SoundVoice } from '../../shared/sound'
import type { SoundPlaybackFailure } from '../../shared/sound-playback'

export const SOUND_ASSET_FILES: Record<SoundVoice, string> = {
  glass: 'glass_001.wav',
  submarine: 'bong_001.wav',
  ping: 'confirmation_001.wav',
  pop: 'pluck_001.wav',
  hero: 'maximize_001.wav',
  funk: 'glitch_001.wav',
  sosumi: 'error_001.wav',
  tink: 'tick_001.wav',
}

export const SOUND_ASSET_SHA256: Record<SoundVoice, string> = {
  glass: '39182b395a30b34e18cbcf842922552b23da5b010a52b7777557e02a405f083e',
  submarine: 'f5d5f83b13edc5321352c2ba57972d1400151e3f27f1c18fcda07d261358511a',
  ping: 'f9d0ef5a5c740c2ac250ac3876db9e4340669044a5bf78ae09192918db3e2ebc',
  pop: '7d676b0b09b56f7e5964ad274feb7e7307a4e552bed8cd98e1e3cecfb9c10c36',
  hero: 'c49992256551200a65d77cbdaf9cb691c8a698aaca0a37b56d6be03fef58aa77',
  funk: '2ea6b5166dc9295cda99d2845bffb030a00e48cfb8d3c52addd4adb5df6217d0',
  sosumi: 'd77546b0baa89f37eca6b86f59b54a654ce5afe3d5a73492d0963168cc4ab5bf',
  tink: 'fee217e21731da4be1f0347fd2632296259b8bfdca343c936fe60dc64bce280e',
}

export interface SoundAssetLocation {
  isPackaged?: boolean
  appPath?: string
  resourcesPath?: string
  cwd?: string
}

export function isSoundVoice(value: unknown): value is SoundVoice {
  return typeof value === 'string' && (SOUND_VOICES as readonly string[]).includes(value)
}

export function validSoundVolume(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? coerceVolume(value) : null
}

export function resolveSoundAssetPath(
  voice: SoundVoice,
  location: SoundAssetLocation = {},
): string {
  const isPackaged = location.isPackaged ?? app.isPackaged
  if (isPackaged) {
    return path.join(location.resourcesPath ?? process.resourcesPath, 'sounds', SOUND_ASSET_FILES[voice])
  }

  const appPath = location.appPath ?? app.getAppPath()
  const roots = [appPath, path.resolve(appPath, '..', '..'), location.cwd ?? process.cwd()]
  const root = roots.find((candidate) => existsSync(path.join(candidate, 'resources', 'sounds'))) ?? appPath
  return path.join(root, 'resources', 'sounds', SOUND_ASSET_FILES[voice])
}

export type SoundAssetReadResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: Extract<SoundPlaybackFailure, 'asset-missing' | 'asset-read-failed'> }

export function readSoundAsset(voice: SoundVoice): SoundAssetReadResult {
  try {
    return { ok: true, data: readFileSync(resolveSoundAssetPath(voice)) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { ok: false, reason: code === 'ENOENT' ? 'asset-missing' : 'asset-read-failed' }
  }
}
