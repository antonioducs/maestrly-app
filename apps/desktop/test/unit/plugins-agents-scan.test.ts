import { describe, expect, it } from 'vitest'
import { scanAgents } from '../../src/main/plugins/agents-scan'
import { classifyPlugin } from '../../src/main/plugins/compatibility'
import { loadPluginPackage } from '../../src/main/plugins/formats/detect'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import { writeTree } from '../helpers/plugin-fixtures'

const claudeManifest = (name: string) => ({ '.claude-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0' }) })

async function load(files: Record<string, string>) {
  const result = await loadPluginPackage(await fsPackageTree(await writeTree(files)))
  if (!result.ok) throw new Error(result.detail)
  return result.pkg
}

describe('plugin agents', () => {
  it('reads a Claude Code agent and maps its tools to the ones every model has', async () => {
    const pkg = await load({
      ...claudeManifest('demo'),
      'agents/reviewer.md':
        '---\nname: reviewer\ndescription: Reviews a change\ntools: Read, Grep, WebSearch, TodoWrite, mcp__plugin_demo_x__y\nmodel: sonnet\n---\nReview the change carefully.\n',
    })
    expect(pkg.agents).toEqual([
      {
        name: 'reviewer',
        filePath: 'agents/reviewer.md',
        description: 'Reviews a change',
        tools: ['read', 'grep', 'web_search', 'mcp_search', 'mcp_call'],
        droppedTools: ['TodoWrite'],
      },
    ])
    expect(pkg.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'agent', name: 'agents/reviewer.md', status: 'adapted' }),
        expect.objectContaining({
          kind: 'agent',
          name: 'reviewer: TodoWrite',
          status: 'not-run',
          reason: 'component-unsupported',
        }),
      ])
    )
  })

  it('accepts block descriptions and list-form tools, and leaves tools out when none are named', async () => {
    const tree = await fsPackageTree(
      await writeTree({
        'agents/a.md': '---\ndescription: |\n  Several\n  lines\ntools:\n  - Bash\n  - Edit\n---\nDo it.\n',
        'agents/b.md': '---\ndescription: Plain\n---\nRead only.\n',
        'agents/c.md': '---\ndescription: Inline list\ntools: [Write, LS]\n---\nWrite.\n',
      })
    )
    const { agents, issues } = await scanAgents(tree, ['agents'])
    expect(issues).toEqual([])
    expect(agents.map((agent) => [agent.name, agent.description, agent.tools])).toEqual([
      ['a', 'Several\nlines', ['bash', 'edit']],
      ['b', 'Plain', null],
      ['c', 'Inline list', ['write', 'glob']],
    ])
  })

  it('flags an agent without a description or a body, and counts agents as a portable part', async () => {
    const pkg = await load({
      ...claudeManifest('agents-only'),
      'agents/empty.md': '---\ndescription: No body\n---\n',
      'agents/ok.md': '---\ndescription: Works\n---\nHelp.\n',
    })
    expect(pkg.agents.map((agent) => agent.name)).toEqual(['ok'])
    expect(pkg.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'agent', name: 'agents/empty.md', status: 'invalid', reason: 'entry-invalid' }),
      ])
    )
    expect(classifyPlugin({ ok: true, pkg }, { sourceSupported: true }).level).toBe('portable')
  })

  it('reads no agent from a Codex agents folder without Markdown files', async () => {
    const pkg = await load({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'codex-agents' }),
      'skills/a/SKILL.md': '---\ndescription: A\n---\nA',
      'agents/openai.yaml': 'interface: {}\n',
    })
    expect(pkg.agents).toEqual([])
  })
})
