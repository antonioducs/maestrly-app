import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOUND_ASSET_FILES, SOUND_ASSET_SHA256, resolveSoundAssetPath } from '../../src/main/sound/assets'
import { SOUND_VOICE_LABELS, SOUND_VOICES } from '../../src/shared/sound'

const soundsDir = join(process.cwd(), 'resources', 'sounds')

const expected = {
  glass: ['Crystal', 'glass_001.wav', '39182b395a30b34e18cbcf842922552b23da5b010a52b7777557e02a405f083e'],
  submarine: ['Bass Bell', 'bong_001.wav', 'f5d5f83b13edc5321352c2ba57972d1400151e3f27f1c18fcda07d261358511a'],
  ping: ['Cadence', 'confirmation_001.wav', 'f9d0ef5a5c740c2ac250ac3876db9e4340669044a5bf78ae09192918db3e2ebc'],
  pop: ['Pizzicato', 'pluck_001.wav', '7d676b0b09b56f7e5964ad274feb7e7307a4e552bed8cd98e1e3cecfb9c10c36'],
  hero: ['Crescendo', 'maximize_001.wav', 'c49992256551200a65d77cbdaf9cb691c8a698aaca0a37b56d6be03fef58aa77'],
  funk: ['Synth', 'glitch_001.wav', '2ea6b5166dc9295cda99d2845bffb030a00e48cfb8d3c52addd4adb5df6217d0'],
  sosumi: ['Dissonance', 'error_001.wav', 'd77546b0baa89f37eca6b86f59b54a654ce5afe3d5a73492d0963168cc4ab5bf'],
  tink: ['Baton', 'tick_001.wav', 'fee217e21731da4be1f0347fd2632296259b8bfdca343c936fe60dc64bce280e'],
} as const

describe('Maestrly sound assets', () => {
  it('preserves the eight approved IDs, labels, files, and hashes', () => {
    expect(SOUND_VOICES).toEqual(Object.keys(expected))
    expect(readdirSync(soundsDir).filter((name) => name.endsWith('.wav')).sort()).toEqual(
      Object.values(expected).map(([, file]) => file).sort(),
    )

    for (const voice of SOUND_VOICES) {
      const [label, file, hash] = expected[voice]
      expect(SOUND_VOICE_LABELS[voice]).toBe(label)
      expect(SOUND_ASSET_FILES[voice]).toBe(file)
      expect(SOUND_ASSET_SHA256[voice]).toBe(hash)
      expect(createHash('sha256').update(readFileSync(join(soundsDir, file))).digest('hex')).toBe(hash)
    }
  })

  it('uses RIFF/WAVE PCM 16-bit, 44.1 kHz with original channels', () => {
    const stereo = new Set(['error_001.wav', 'glitch_001.wav', 'pluck_001.wav'])
    for (const [, file] of Object.values(expected)) {
      const wav = readFileSync(join(soundsDir, file))
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
      expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
      expect(wav.readUInt16LE(20)).toBe(1)
      expect(wav.readUInt16LE(22)).toBe(stereo.has(file) ? 2 : 1)
      expect(wav.readUInt32LE(24)).toBe(44_100)
      expect(wav.readUInt16LE(34)).toBe(16)
    }
  })

  it('resolves assets outside ASAR in development and packaged builds', () => {
    expect(resolveSoundAssetPath('glass', { isPackaged: false })).toBe(
      join(process.cwd(), 'resources', 'sounds', 'glass_001.wav'),
    )
    expect(
      resolveSoundAssetPath('glass', {
        isPackaged: false,
        appPath: join(process.cwd(), 'out', 'main'),
        cwd: '/other-directory',
      }),
    ).toBe(join(process.cwd(), 'resources', 'sounds', 'glass_001.wav'))
    expect(resolveSoundAssetPath('glass', { isPackaged: false, appPath: '/app', cwd: '/other-directory' })).toBe(
      join('/app', 'resources', 'sounds', 'glass_001.wav'),
    )
    expect(resolveSoundAssetPath('glass', { isPackaged: true, resourcesPath: '/bundle/resources' })).toBe(
      join('/bundle/resources', 'sounds', 'glass_001.wav'),
    )
  })

  it('documents the source and verified provenance check', () => {
    const manifest = readFileSync(join(soundsDir, 'README.md'), 'utf8')
    const license = readFileSync(join(soundsDir, 'LICENSE.txt'), 'utf8')
    expect(manifest).toContain('f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232')
    expect(manifest).toContain('4596a49eaf5a533948d49a47467f606bcdea70ff')
    expect(manifest).toContain('without editing, resampling, normalization')
    expect(license).toContain('Creative Commons Zero (CC0) 1.0 Universal')
  })
})
