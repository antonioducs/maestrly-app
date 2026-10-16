import { describe, expect, it } from 'vitest'
import { hookDigest } from '../../src/main/plugins/consent'
import { loadPluginPackage } from '../../src/main/plugins/formats/detect'
import { scanHooks } from '../../src/main/plugins/hooks-scan'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import { writeTree } from '../helpers/plugin-fixtures'

const hooksFile = (hooks: Record<string, unknown>) => JSON.stringify({ hooks })

async function load(files: Record<string, string>) {
  const result = await loadPluginPackage(await fsPackageTree(await writeTree(files)))
  if (!result.ok) throw new Error(result.detail)
  return result.pkg
}

describe('plugin hooks', () => {
  it('reads the command hooks of the events Maestrly runs and lists the others as not included', async () => {
    const pkg = await load({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'guard', version: '1.0.0' }),
      'skills/a/SKILL.md': '---\ndescription: A\n---\nA',
      'hooks/hooks.json': hooksFile({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/guard.sh' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo start', timeout: 9999 }] }],
        PermissionRequest: [{ hooks: [{ type: 'command', command: 'echo nope' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Are you done?' }] }],
      }),
    })
    expect(pkg.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: '${CLAUDE_PLUGIN_ROOT}/guard.sh',
        timeoutSec: 60,
        source: 'hooks/hooks.json',
      },
      { event: 'SessionStart', matcher: null, command: 'echo start', timeoutSec: 600, source: 'hooks/hooks.json' },
    ])
    expect(pkg.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'hooks', name: 'hooks/hooks.json', status: 'adapted' }),
        expect.objectContaining({
          kind: 'hooks',
          name: 'PermissionRequest',
          status: 'not-run',
          reason: 'hook-unsupported',
        }),
        expect.objectContaining({ kind: 'hooks', name: 'Stop: prompt', status: 'not-run', reason: 'hook-unsupported' }),
      ])
    )
  })

  it('reads inline hooks of a manifest, drops a hook whose matcher is not a valid pattern, and flags unknown files', async () => {
    const tree = await fsPackageTree(await writeTree({ 'other.json': JSON.stringify({ something: 'else' }) }))
    const result = await scanHooks(tree, [
      {
        inline: {
          hooks: {
            PostToolUse: [
              { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt' }] },
              { matcher: '(', hooks: [{ type: 'command', command: 'broken' }] },
            ],
          },
        },
        label: 'plugin.json#hooks',
      },
      { path: 'other.json' },
    ])
    expect(result.hooks.map((hook) => [hook.event, hook.matcher, hook.command])).toEqual([
      ['PostToolUse', 'Edit|Write', 'fmt'],
    ])
    expect(result.issues).toEqual([expect.objectContaining({ code: 'hook-invalid' })])
    expect(result.invalid).toEqual([{ source: 'other.json', detail: 'unrecognized hooks format' }])
  })

  it('digests hooks independently of their order', () => {
    const a = { event: 'Stop' as const, matcher: null, command: 'a', timeoutSec: 60, source: 'x' }
    const b = { event: 'PreToolUse' as const, matcher: 'Bash', command: 'b', timeoutSec: 60, source: 'x' }
    expect(hookDigest([a, b])).toBe(hookDigest([b, a]))
    expect(hookDigest([a])).not.toBe(hookDigest([{ ...a, command: 'c' }]))
  })
})
