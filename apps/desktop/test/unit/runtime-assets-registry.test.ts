import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_ASSET_IDS, RUNTIME_ASSET_STATES, isUpdatableRuntimeAssetId } from '../../src/shared/runtime-assets'
import {
  CLAUDE_CODE_PINNED_VERSION,
  RUNTIME_ASSET_REGISTRY,
  RUNTIME_TARGET_IDS,
  WHISPER_MODEL_FILE,
  claudeCodeArtifactUrl,
  hostRuntimeTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from '../../src/main/runtime-assets/registry'

describe('runtime asset registry', () => {
  it('exposes immutable known IDs and every lifecycle state', () => {
    expect(RUNTIME_ASSET_IDS).toEqual([
      'codex-runtime',
      'claude-code-runtime',
      'github-copilot-runtime',
      'tunnel-client',
      'local-ml-runtime',
      'whisper-model',
      'antigravity-acp-runtime',
    ])
    expect(RUNTIME_ASSET_STATES).toEqual([
      'not-installed',
      'downloading',
      'verifying',
      'installing',
      'ready',
      'failed',
      'corrupt',
      'removing',
    ])
  })

  it('pins all six targets for the three fetched runtimes', () => {
    for (const id of ['codex-runtime', 'github-copilot-runtime', 'tunnel-client'] as const) {
      expect(Object.keys(RUNTIME_ASSET_REGISTRY[id].targets).sort()).toEqual([...RUNTIME_TARGET_IDS].sort())
      for (const target of Object.values(RUNTIME_ASSET_REGISTRY[id].targets)) {
        expect(target?.url).toMatch(/^https:\/\//)
        expect(target?.hash.digest).toBeTruthy()
        expect(target?.criticalPaths.length).toBeGreaterThan(0)
        expect(target?.executablePath).toBeTruthy()
        expect(target?.criticalPaths).toContain(target?.executablePath)
      }
    }
    expect(Object.keys(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets).sort()).toEqual([
      'linux-x64',
      'mac-arm64',
      'win-x64',
    ])
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets['mac-arm64']).toMatchObject({
      hash: { algorithm: 'sha256', digest: '81420b6005f370a693179fcaf8310a1a1c1217365cbef3f00550c6232d72315b' },
      downloadBytes: 43_252_201,
      unpackedBytes: 146_566_344,
    })
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets['linux-x64']).toMatchObject({
      hash: { algorithm: 'sha256', digest: 'ff229da7280bda61b0b4aeca30c351999a0ef00943dddb73fa2fcb25c753efbe' },
      downloadBytes: 51_758_967,
      unpackedBytes: 160_125_124,
    })
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets['win-x64']).toMatchObject({
      hash: { algorithm: 'sha256', digest: 'a405d52f41d2ce0bdc76c491c5447342296145843931a97def07d11d57ee98fe' },
      downloadBytes: 40_860_763,
      unpackedBytes: 134_071_112,
    })
    for (const target of Object.values(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets)) {
      expect(target?.criticalPaths).toContain('models/ggml-silero-v6.2.0.bin')
      expect(
        target?.criticalPaths.some((file) => /^node_modules\/@fugood\/node-whisper-[^/]+\/index\.node$/.test(file))
      ).toBe(true)
    }
  })

  it('matches the exact versions and representative script pins', () => {
    expect(RUNTIME_ASSET_REGISTRY['codex-runtime']).toMatchObject({ version: '0.155.1' })
    expect(RUNTIME_ASSET_REGISTRY['codex-runtime'].targets['mac-arm64']?.hash.digest).toBe(
      'cYxzGcRRoBrncyHlR8ed4yXwcoVJZC1pipGULSyJkGFKXJw/Uu57BklvzayuAptjJIipamnOk32CfUkk1F0bLw=='
    )
    expect(RUNTIME_ASSET_REGISTRY['github-copilot-runtime']).toMatchObject({ version: '1.0.71' })
    expect(RUNTIME_ASSET_REGISTRY['tunnel-client']).toMatchObject({ version: '0.0.10' })
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime']).toMatchObject({ version: '2.17.2-2' })
    expect(RUNTIME_ASSET_REGISTRY['tunnel-client'].targets['win-x64']?.hash.digest).toBe(
      '5e64a056f1d96786da0a6f8db1da5f5f4a03fd19a90d951a25cf2ca8d9093d00'
    )
  })

  it('accepts the real archive size of every fetched target', () => {
    // Measured sizes of the pinned (immutable) archives; a cap below these blocks the install.
    const measured: Record<string, Record<string, number>> = {
      'codex-runtime': {
        'mac-arm64': 127_465_533,
        'mac-x64': 135_811_357,
        'linux-arm64': 135_126_766,
        'linux-x64': 142_140_011,
        'win-arm64': 135_509_012,
        'win-x64': 145_165_338,
      },
      'github-copilot-runtime': {
        'mac-arm64': 130_336_069,
        'mac-x64': 146_101_321,
        'linux-arm64': 147_266_596,
        'linux-x64': 142_982_140,
        'win-arm64': 131_060_040,
        'win-x64': 130_154_451,
      },
      'tunnel-client': {
        'mac-arm64': 7_100_022,
        'mac-x64': 7_672_583,
        'linux-arm64': 6_789_903,
        'linux-x64': 7_508_561,
        'win-arm64': 6_839_760,
        'win-x64': 7_658_615,
      },
    }
    for (const [id, sizes] of Object.entries(measured))
      for (const [targetId, size] of Object.entries(sizes)) {
        const definition = RUNTIME_ASSET_REGISTRY[id as keyof typeof RUNTIME_ASSET_REGISTRY] as RuntimeAssetDefinition
        const target = definition.targets[targetId as RuntimeTargetId]
        expect(target?.maxDownloadBytes, `${id}/${targetId}`).toBeGreaterThanOrEqual(size)
        expect(target?.unpackedBytes, `${id}/${targetId}`).toBeGreaterThan(0)
      }
  })

  it('pins the Whisper model as one Hugging Face file for every local ML target', () => {
    const model = RUNTIME_ASSET_REGISTRY['whisper-model']
    expect(model.version).toBe('large-v3-turbo-q5')
    expect(Object.keys(model.targets).sort()).toEqual(
      Object.keys(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets).sort()
    )
    for (const target of Object.values(model.targets)) {
      expect(target).toMatchObject({
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin',
        archive: 'file',
        fileName: WHISPER_MODEL_FILE,
        hash: {
          algorithm: 'sha256',
          encoding: 'hex',
          digest: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
        },
        downloadBytes: 574_041_195,
        maxDownloadBytes: 574_041_195,
        unpackedBytes: 574_041_195,
        criticalPaths: [WHISPER_MODEL_FILE],
      })
    }
  })

  it('pins the Claude Code runtime the installed Agent SDK bundles, for the Linux targets bots run on', () => {
    const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const sdk = JSON.parse(readFileSync(path.join(path.dirname(sdkEntry), 'package.json'), 'utf8')) as {
      claudeCodeVersion?: string
    }
    expect(CLAUDE_CODE_PINNED_VERSION).toBe(sdk.claudeCodeVersion)
    const definition = RUNTIME_ASSET_REGISTRY['claude-code-runtime']
    expect(definition.version).toBe(CLAUDE_CODE_PINNED_VERSION)
    expect(Object.keys(definition.targets).sort()).toEqual(['linux-arm64', 'linux-x64'])
    for (const id of ['linux-arm64', 'linux-x64'] as const) {
      expect(definition.targets[id]).toMatchObject({
        url: claudeCodeArtifactUrl(CLAUDE_CODE_PINNED_VERSION, id),
        archive: 'tar.gz',
        hash: { algorithm: 'sha512', encoding: 'base64' },
        stripPrefix: 'package',
        criticalPaths: ['claude', 'package.json'],
        executablePath: 'claude',
      })
    }
    expect(definition.targets['linux-arm64']?.maxDownloadBytes).toBeGreaterThanOrEqual(107_804_240)
    expect(definition.targets['linux-x64']?.maxDownloadBytes).toBeGreaterThanOrEqual(107_536_804)
  })

  it('pins the Antigravity ACP server for every desktop target', () => {
    const definition = RUNTIME_ASSET_REGISTRY['antigravity-acp-runtime']
    expect(definition.version).toBe('1.2.1')
    expect(Object.keys(definition.targets).sort()).toEqual([...RUNTIME_TARGET_IDS].sort())
    for (const target of Object.values(definition.targets)) {
      expect(target?.url).toMatch(
        /^https:\/\/dl\.google\.com\/agy-extensions\/releases\/(macos|linux|windows)\/agy-acp-server-1\.2\.1-[a-z0-9_-]+\.zip$/
      )
      expect(target?.archive).toBe('zip')
      expect(target?.hash).toMatchObject({ algorithm: 'sha256', encoding: 'hex' })
      expect(target?.hash.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(target?.criticalPaths).toContain(target?.executablePath)
      expect(target?.maxDownloadBytes).toBeGreaterThanOrEqual(target?.downloadBytes ?? Number.POSITIVE_INFINITY)
    }
    expect(definition.targets['win-x64']?.executablePath).toBe('agy_acp_server.exe')
    expect(definition.targets['linux-x64']?.executablePath).toBe('agy_acp_server.par')
    expect(definition.targets['mac-arm64']).toMatchObject({
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip',
      hash: { digest: '0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c' },
      downloadBytes: 111_725_488,
      unpackedBytes: 397_584_640,
    })
    expect(isUpdatableRuntimeAssetId('antigravity-acp-runtime')).toBe(true)
  })

  it('maps supported hosts and rejects unsupported targets', () => {
    expect(hostRuntimeTarget('darwin', 'arm64')).toBe('mac-arm64')
    expect(hostRuntimeTarget('win32', 'x64')).toBe('win-x64')
    expect(() => hostRuntimeTarget('freebsd', 'x64')).toThrow(/unsupported/i)
  })
})
