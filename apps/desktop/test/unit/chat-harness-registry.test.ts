import { describe, expect, it } from 'vitest'
import { createHarnessRegistry, HarnessConfigError } from '../../src/main/chat/harness/registry'
import { resolveHarness } from '../../src/main/chat/harness/resolver'
import type { HarnessSources } from '../../src/main/chat/harness/types'

const DEFAULT_CONFIG = JSON.stringify({
  schemaVersion: 1,
  id: 'test-default',
  profileVersion: 1,
  bindings: [
    {
      providerKind: '*',
      overrides: {
        identity: { harnessProfileId: 'openai-default-v1', promptIdentity: 'maestrly-legacy' },
        prompts: { layout: 'maestrly-base', styleAndWork: 'style.md' },
        capabilities: { compaction: false, steering: false },
        runtime: { personality: 'pragmatic' },
      },
    },
  ],
})

const base = (): Record<string, string> => ({
  'profiles/default/config.json': DEFAULT_CONFIG,
  'profiles/default/style.md': 'DEFAULT STYLE\n',
})

const build = (sources: Record<string, string>) => createHarnessRegistry(sources as HarnessSources)

describe('harness registry', () => {
  it('requires the default profile', () => {
    const minimal = JSON.stringify({
      schemaVersion: 1,
      id: 'other',
      profileVersion: 1,
      bindings: [{ providerKind: '*', overrides: {} }],
    })
    expect(() => build({ 'profiles/other/config.json': minimal })).toThrow(/"default" profile folder is missing/)
  })

  it('requires config.json in every profile folder, even without Markdown', () => {
    expect(() => build({ ...base(), 'profiles/ghost/notes.md': 'x' })).toThrow(/must declare config.json/)
  })

  it('discovers a new profile from its folder alone', () => {
    const registry = build({
      ...base(),
      'profiles/test-model/config.json': JSON.stringify({
        schemaVersion: 1,
        id: 'test-model',
        profileVersion: 3,
        bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: 'prompt.md' } } }],
      }),
      'profiles/test-model/prompt.md': 'SENTINEL STYLE',
    })
    expect(registry.list().map((profile) => profile.folderId)).toEqual(['default', 'test-model'])
    const resolution = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'test-model' }, registry)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) return
    expect(resolution.harness.prompts.styleAndWork).toBe('SENTINEL STYLE')
    expect(resolution.harness.profileVersion).toBe(3)
  })

  it('inherits omitted fields from the default and preserves an explicit false', () => {
    const registry = build({
      ...base(),
      'profiles/quiet/config.json': JSON.stringify({
        schemaVersion: 1,
        id: 'quiet',
        profileVersion: 1,
        bindings: [{ providerKind: '*', overrides: { capabilities: { compaction: true } } }],
      }),
      'profiles/loud/config.json': JSON.stringify({
        schemaVersion: 1,
        id: 'loud',
        profileVersion: 1,
        bindings: [
          { providerKind: '*', overrides: { capabilities: { compaction: true } } },
          { providerKind: 'anthropic', overrides: { capabilities: { compaction: false } } },
        ],
      }),
    })
    const quiet = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'quiet' }, registry)
    const loud = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'loud' }, registry)
    expect(quiet.ok && quiet.harness.prompts.styleAndWork).toBe('DEFAULT STYLE')
    expect(quiet.ok && quiet.harness.modelCapabilities.compaction).toBe(true)
    expect(loud.ok && loud.harness.modelCapabilities.compaction).toBe(false)
  })

  it('replaces arrays instead of concatenating them', () => {
    const registry = build({
      ...base(),
      'profiles/efforts/config.json': JSON.stringify({
        schemaVersion: 1,
        id: 'efforts',
        profileVersion: 1,
        bindings: [
          { providerKind: '*', overrides: { reasoning: { manifestEfforts: ['low', 'high'] } } },
          { providerKind: 'anthropic', overrides: { reasoning: { manifestEfforts: ['max'] } } },
        ],
      }),
    })
    const resolution = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'efforts' }, registry)
    expect(resolution.ok && resolution.harness.reasoning.manifestEfforts).toEqual(['max'])
  })

  it('rejects unknown fields, bad JSON, unknown strategies and missing references', () => {
    const withConfig = (config: unknown) => ({
      ...base(),
      'profiles/broken/config.json': typeof config === 'string' ? config : JSON.stringify(config),
    })
    expect(() => build(withConfig('{'))).toThrow(/invalid JSON/)
    expect(() =>
      build(withConfig({ schemaVersion: 1, id: 'broken', profileVersion: 1, bindings: [], extra: true }))
    ).toThrow(HarnessConfigError)
    expect(() =>
      build(
        withConfig({
          schemaVersion: 2,
          id: 'broken',
          profileVersion: 1,
          bindings: [{ providerKind: '*', overrides: {} }],
        })
      )
    ).toThrow(/schemaVersion/)
    expect(() =>
      build(
        withConfig({
          schemaVersion: 1,
          id: 'broken',
          profileVersion: 1,
          bindings: [{ providerKind: '*', overrides: { hooks: [{ id: 'nope', text: 'x.md' }] } }],
        })
      )
    ).toThrow(/hooks/)
    expect(() =>
      build(
        withConfig({
          schemaVersion: 1,
          id: 'broken',
          profileVersion: 1,
          bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: 'missing.md' } } }],
        })
      )
    ).toThrow(/referenced text "missing.md" does not exist/)
  })

  it('rejects references outside the profile folder', () => {
    for (const ref of ['../default/style.md', '/etc/passwd', 'https://example.com/a.md', 'nested/a.md']) {
      expect(() =>
        build({
          ...base(),
          'profiles/broken/config.json': JSON.stringify({
            schemaVersion: 1,
            id: 'broken',
            profileVersion: 1,
            bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: ref } } }],
          }),
        })
      ).toThrow(/text references must be a plain .md file/)
    }
  })

  it('rejects source paths that escape the profile tree', () => {
    expect(() => build({ ...base(), '../secrets.json': '{}' })).toThrow(/must start with "profiles\/"/)
    expect(() => build({ ...base(), 'profiles/a/b/c.md': 'x' })).toThrow(/profiles\/<profile>\/<file>/)
  })

  it('rejects reserved keys and non-plain data', () => {
    expect(() =>
      build({
        ...base(),
        'profiles/broken/config.json':
          '{"schemaVersion":1,"id":"broken","profileVersion":1,"bindings":[],"__proto__":{"x":1}}',
      })
    ).toThrow(/reserved key/)
  })

  it('rejects duplicate bindings, colliding identities and duplicate definition ids', () => {
    expect(() =>
      build({
        ...base(),
        'profiles/dupe/config.json': JSON.stringify({
          schemaVersion: 1,
          id: 'dupe',
          profileVersion: 1,
          bindings: [
            { providerKind: 'anthropic', overrides: {} },
            { providerKind: 'anthropic', overrides: {} },
          ],
        }),
      })
    ).toThrow(/duplicate binding/)
    expect(() =>
      build({
        ...base(),
        'profiles/one/config.json': JSON.stringify({
          schemaVersion: 1,
          id: 'shared',
          profileVersion: 1,
          bindings: [{ providerKind: '*', overrides: {} }],
        }),
        'profiles/two/config.json': JSON.stringify({
          schemaVersion: 1,
          id: 'shared',
          profileVersion: 1,
          bindings: [{ providerKind: '*', overrides: {} }],
        }),
      })
    ).toThrow(/already declared by profile/)
    expect(() =>
      build({
        ...base(),
        'profiles/one/config.json': JSON.stringify({
          schemaVersion: 1,
          id: 'one',
          profileVersion: 1,
          match: { aliases: ['two'] },
          bindings: [{ providerKind: '*', overrides: {} }],
        }),
        'profiles/two/config.json': JSON.stringify({
          schemaVersion: 1,
          id: 'two',
          profileVersion: 1,
          bindings: [{ providerKind: '*', overrides: {} }],
        }),
      })
    ).toThrow(/already matched by profile|collides with profile/)
  })

  it('rejects an endpoint selector on an incompatible transport', () => {
    expect(() =>
      build({
        ...base(),
        'profiles/broken/config.json': JSON.stringify({
          schemaVersion: 1,
          id: 'broken',
          profileVersion: 1,
          bindings: [{ providerKind: 'codex-subscription', endpoint: 'official-openai', overrides: {} }],
        }),
      })
    ).toThrow(/only valid for openai-responses/)
  })

  it('does not expose mutation and is insensitive to source ordering', () => {
    const sources = {
      ...base(),
      'profiles/alpha/config.json': JSON.stringify({
        schemaVersion: 1,
        id: 'alpha',
        profileVersion: 1,
        bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: 'prompt.md' } } }],
      }),
      'profiles/alpha/prompt.md': 'ALPHA',
    }
    const forward = build(sources)
    const reversed = build(Object.fromEntries(Object.entries(sources).reverse()))
    expect(forward.list().map((p) => p.folderId)).toEqual(reversed.list().map((p) => p.folderId))
    expect(Object.isFrozen(forward.default)).toBe(true)
    expect((forward as unknown as Record<string, unknown>).set).toBeUndefined()
    expect(Object.isFrozen(forward.default.texts)).toBe(true)
    expect(() => {
      ;(forward.default.texts as Record<string, string>)['style.md'] = 'HACKED'
    }).toThrow()
    expect(forward.default.texts['style.md']).toBe('DEFAULT STYLE')
    expect(forward.get('alpha')?.texts['prompt.md']).toBe('ALPHA')
  })

  it('normalizes CRLF and the trailing newline of prompt bodies', () => {
    const registry = build({
      'profiles/default/config.json': DEFAULT_CONFIG,
      'profiles/default/style.md': 'LINE ONE\r\nLINE TWO\r\n\n',
    })
    expect(registry.default.texts['style.md']).toBe('LINE ONE\nLINE TWO')
  })
})
