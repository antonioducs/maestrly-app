import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
// Executable ESM scripts intentionally do not ship declaration files.
// @ts-expect-error
import { checkBundleSizeReport, updateBaseline } from '../../../../scripts/check-bundle-size.mjs'
// @ts-expect-error
import { createBundleSizeReport } from '../../../../scripts/report-bundle-size.mjs'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture({ includeMl = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-bundle-size-'))
  tempDirs.push(root)
  const resources = path.join(root, 'mac-arm64', 'Maestrly.app', 'Contents', 'Resources')
  const source = path.join(root, 'asar-source')
  mkdirSync(source, { recursive: true })
  if (includeMl) {
    mkdirSync(path.join(source, 'node_modules', '@xenova', 'transformers'), { recursive: true })
    writeFileSync(path.join(source, 'node_modules', '@xenova', 'transformers', 'index.js'), 'ml payload')
  }
  writeFileSync(path.join(source, 'package.json'), '{}')
  mkdirSync(resources, { recursive: true })
  await createPackage(source, path.join(resources, 'app.asar'))
  mkdirSync(path.join(resources, 'sounds'), { recursive: true })
  writeFileSync(path.join(resources, 'sounds', 'tick.wav'), 'sound')
  const frameworks = path.join(root, 'mac-arm64', 'Maestrly.app', 'Contents', 'Frameworks')
  mkdirSync(frameworks, { recursive: true })
  writeFileSync(path.join(frameworks, 'Electron'), 'framework')
  writeFileSync(path.join(root, 'Maestrly-arm64.dmg'), Buffer.alloc(100))
  return { root, resources }
}

describe('bundle size report', () => {
  it('reports package sections, module aggregates and artifacts', async () => {
    const { root } = await fixture()
    const report = await createBundleSizeReport(root)
    expect(report.packages).toHaveLength(1)
    const item = report.packages[0]
    expect(item.id).toBe('mac-arm64')
    expect(item.appAsarBytes).toBeGreaterThan(0)
    expect(item.frameworksBytes).toBe(9)
    expect(item.extraResources).toContainEqual({ name: 'sounds', bytes: 5 })
    expect(item.mlAggregateBytes).toBeGreaterThan(0)
    expect(report.artifacts).toContainEqual({ path: 'Maestrly-arm64.dmg', bytes: 100 })
    const direct = await createBundleSizeReport(path.join(root, 'mac-arm64', 'Maestrly.app'))
    expect(direct.packages).toHaveLength(1)
  })

  it('detects forbidden runtime resources and refuses to baseline leakage', async () => {
    const { root, resources } = await fixture()
    mkdirSync(path.join(resources, 'codex'))
    const report = await createBundleSizeReport(root)
    expect(report.packages[0].leakage).toContain('Resources/codex')
    expect(() => updateBaseline(report, { schema: 1, targets: {} })).toThrow(/refusing baseline with leakage/)
  })

  it('updates a measured baseline with headroom and enforces it', async () => {
    const { root } = await fixture({ includeMl: false })
    const report = await createBundleSizeReport(root)
    const config = updateBaseline(report, { schema: 1, baselineHeadroomPercent: 10, targets: {} })
    expect(config.targets['mac-arm64'].status).toBe('measured')
    expect(checkBundleSizeReport(report, config).failures).toEqual([])

    const oversized = structuredClone(report)
    oversized.packages[0].appAsarBytes = config.targets['mac-arm64'].budgets.appAsarBytes + 1
    expect(checkBundleSizeReport(oversized, config).failures.join('\n')).toMatch(/appAsarBytes.*exceeds/)
  })

  it('covers every release target and enforces fallback budgets', () => {
    const config = JSON.parse(readFileSync(path.join(process.cwd(), '..', '..', 'config', 'bundle-size-budgets.json'), 'utf8'))
    const targets = ['mac-arm64', 'win-x64', 'linux-x64']
    expect(Object.keys(config.targets)).toEqual(expect.arrayContaining(targets))
    expect(config.targets['mac-arm64']).toMatchObject({ status: 'measured' })
    expect(config.targets['mac-arm64'].budgets).not.toHaveProperty('cursorBytes')
    expect(config.targets['win-x64']).toMatchObject({ status: 'fallback', budgetSource: 'fallbackBudgets' })
    expect(config.targets['linux-x64']).toMatchObject({ status: 'fallback', budgetSource: 'fallbackBudgets' })

    const report = {
      schema: 1,
      packages: targets.map((id) => ({
        id,
        platform: id.startsWith('mac') ? 'mac' : id.startsWith('win') ? 'win' : 'linux',
        arch: id.endsWith('arm64') ? 'arm64' : 'x64',
        leakage: [],
        unpackedAppBytes: 1,
        appAsarBytes: 1,
        appAsarUnpackedBytes: 1,
        frameworksBytes: 1,
        extraResourcesBytes: 1,
        mlAggregateBytes: 0,
      })),
      artifacts: [
        { path: 'Maestrly-arm64.dmg', bytes: 1 },
        { path: 'Maestrly-Setup.exe', bytes: 1 },
        { path: 'Maestrly.AppImage', bytes: 1 },
      ],
    }
    expect(checkBundleSizeReport(report, config)).toEqual({ failures: [], skipped: [] })

    for (const id of targets) {
      const oversized = structuredClone(report)
      const budget =
        config.targets[id].status === 'fallback'
          ? config.fallbackBudgets.appAsarBytes
          : config.targets[id].budgets.appAsarBytes
      const packageItem = oversized.packages.find((item) => item.id === id)
      expect(packageItem).toBeDefined()
      packageItem!.appAsarBytes = budget + 1
      expect(checkBundleSizeReport(oversized, config).failures.join('\n')).toMatch(`${id}: appAsarBytes`)
    }
  })

  it('fails closed when a reported target has no budget', () => {
    const report = {
      schema: 1,
      packages: [
        {
          id: 'linux-x64',
          platform: 'linux',
          arch: 'x64',
          leakage: [],
          unpackedAppBytes: 1,
          appAsarBytes: 1,
          appAsarUnpackedBytes: 1,
          frameworksBytes: 1,
          extraResourcesBytes: 1,
          mlAggregateBytes: 1,
        },
      ],
      artifacts: [{ path: 'Maestrly.AppImage', bytes: 1 }],
    }

    const result = checkBundleSizeReport(report, { schema: 1, targets: {} })
    expect(result.skipped).toEqual([])
    expect(result.failures).toEqual([
      'linux-x64: no size budget configured; add a fallback budget or run --update-baseline',
    ])
  })
})
