import { inspectTree } from '../../src/main/plugins/inspect'
import { type InstallerDeps, installPrepared } from '../../src/main/plugins/installer'
import type { PluginLayout } from '../../src/main/plugins/layout'
import type { MarketplaceEntry } from '../../src/main/plugins/marketplace'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import type { InstalledPluginRecord } from '../../src/main/plugins/store'
import type { PluginScope } from '../../src/shared/plugins'
import { type FixtureFiles, writeTree } from './plugin-fixtures'

/** A synthetic Codex plugin: one skill, one command, and optionally a stdio and an HTTP MCP server. */
export function codexDemoPlugin(
  name: string,
  extra: FixtureFiles = {},
  mcpServers?: Record<string, unknown>
): FixtureFiles {
  return {
    '.codex-plugin/plugin.json': JSON.stringify({
      name,
      version: '1.0.0',
      interface: { displayName: `${name} plugin` },
    }),
    'skills/hello/SKILL.md': `---\ndescription: Say hello from ${name}\n---\nHello from ${name}.`,
    'commands/review.md': '---\ndescription: Review a file\nargument-hint: [file]\n---\nReview $ARGUMENTS carefully.',
    ...(mcpServers ? { '.mcp.json': JSON.stringify({ mcpServers }) } : {}),
    ...extra,
  }
}

/** Installs a synthetic plugin from a temporary directory straight through the installer. */
export async function installFixturePlugin(
  layout: PluginLayout,
  opts: {
    name: string
    files: FixtureFiles
    marketplace?: string
    scope?: PluginScope
    stdio?: string[]
    inputs?: Record<string, string>
    deps?: Partial<InstallerDeps>
  }
): Promise<InstalledPluginRecord> {
  const dir = await writeTree(opts.files)
  const tree = await fsPackageTree(dir)
  const entry: MarketplaceEntry = {
    name: opts.name,
    source: { kind: 'path', path: '' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: [] },
    category: null,
    display: {},
  }
  const inspection = await inspectTree(tree, entry)
  const key = `${opts.name}@${opts.marketplace ?? 'fixtures'}`
  const result = await installPrepared(
    {
      key,
      name: opts.name,
      marketplaceId: 'mkt_fixture',
      source: { kind: 'marketplace', path: '' },
      commit: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      checkoutDir: dir,
      entries: [...tree.entries.values()],
      inspection,
    },
    {
      consent: { consentFingerprint: inspection.consentFingerprint, stdio: opts.stdio ?? [], executables: true },
      scope: opts.scope ?? { kind: 'global' },
      inputs: opts.inputs,
    },
    { layout, now: () => Date.now(), invalidateServer: () => {}, onSkillsRemoved: () => {}, ...opts.deps }
  )
  if (!result.ok) throw new Error(`install failed: ${result.error} ${result.detail ?? ''}`)
  return result.value
}
