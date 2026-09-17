import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ExtensionClient, skillDescriptionOf, skillNameFrom, validateExtensionCall } from '../src/main/extension-client'
import { FixtureExtensions } from '../src/main/fixture-extensions'
import { readSkillFolder } from '../src/main/skill-folder'

const BOT = '531d469d-1e84-434c-9831-bf16127464e5'
const SECRET = 'sk-never-shown-1234'
const b64 = (text: string) => Buffer.from(text).toString('base64')
/** The Host code travels on the error object, not in the message. */
const codeOf = (fn: () => unknown) => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('extension client', () => {
  it('refuses methods outside the namespace and malformed params before the wire', () => {
    expect(() => validateExtensionCall({ method: 'bot.archive', params: {} })).toThrow(/Invalid extension request/)
    expect(() => validateExtensionCall({ method: 'extension.mcp.upsert', params: { botId: BOT, expectedRevision: 0, server: { name: 'Bad Name', transport: 'stdio', command: 'x' } } })).toThrow()
    // A stdio server without a command, or with a url, is refused by the shared refinement.
    expect(() => validateExtensionCall({ method: 'extension.mcp.upsert', params: { botId: BOT, expectedRevision: 0, server: { name: 'echo', transport: 'stdio', url: 'https://x.test' } } })).toThrow()
    expect(validateExtensionCall({ method: 'extension.inspect', params: { botId: BOT } })).toEqual({ method: 'extension.inspect', params: { botId: BOT } })
  })
  it('validates the reply and requires a connection', async () => {
    const client = new ExtensionClient(async () => ({ botId: BOT, revision: 0, mcpServers: [], skills: [] }))
    await expect(client.call({ method: 'extension.inspect', params: { botId: BOT } })).rejects.toThrow(/Conecte-se/)
    client.connected('host-1')
    expect(await client.call({ method: 'extension.inspect', params: { botId: BOT } })).toMatchObject({ revision: 0 })
    const leaky = new ExtensionClient(async () => ({ botId: BOT, revision: 0, mcpServers: [{ id: BOT, name: 'x', transport: 'stdio', command: 'x', args: [], envKeys: [], enabled: true, env: { TOKEN: SECRET } }], skills: [] }))
    leaky.connected('host-1')
    // A reply that carries secret values is not a valid reply.
    await expect(leaky.call({ method: 'extension.inspect', params: { botId: BOT } })).rejects.toThrow()
  })
  it('derives skill names and descriptions the way the Host does', () => {
    expect(skillNameFrom('Minha Skill (v2)')).toBe('minha-skill-v2')
    expect(skillDescriptionOf('---\ndescription: "Faz X"\n---\n# X')).toBe('Faz X')
    expect(skillDescriptionOf('# sem cabeçalho')).toBeUndefined()
  })
})

describe('fixture extensions', () => {
  it('keeps env values out of every state and applies the same refusals as the Host', () => {
    const fixture = new FixtureExtensions()
    const first = fixture.request('extension.mcp.upsert', { botId: BOT, expectedRevision: 0, server: { name: 'echo', transport: 'stdio', command: 'node', args: [], env: { TOKEN: SECRET }, enabled: true } }) as { revision: number; mcpServers: { id: string; envKeys: string[] }[] }
    expect(first.revision).toBe(1)
    expect(first.mcpServers[0].envKeys).toEqual(['TOKEN'])
    expect(JSON.stringify(first)).not.toContain(SECRET)
    expect(codeOf(() => fixture.request('extension.mcp.upsert', { botId: BOT, expectedRevision: 0, server: { name: 'other', transport: 'stdio', command: 'x', args: [], env: {}, enabled: true } }))).toBe('REVISION_CONFLICT')
    expect(codeOf(() => fixture.request('extension.mcp.upsert', { botId: BOT, expectedRevision: 1, server: { name: 'echo', transport: 'stdio', command: 'x', args: [], env: {}, enabled: true } }))).toBe('MCP_NAME_TAKEN')
    // An empty value removes the stored key; an absent one keeps it.
    const kept = fixture.request('extension.mcp.upsert', { botId: BOT, expectedRevision: 1, server: { id: first.mcpServers[0].id, name: 'echo', transport: 'stdio', command: 'node', args: [], env: { OTHER: 'v' }, enabled: false } }) as { mcpServers: { envKeys: string[]; enabled: boolean }[] }
    expect(kept.mcpServers[0]).toMatchObject({ envKeys: ['OTHER', 'TOKEN'], enabled: false })
    const removed = fixture.request('extension.mcp.upsert', { botId: BOT, expectedRevision: 2, server: { id: first.mcpServers[0].id, name: 'echo', transport: 'stdio', command: 'node', args: [], env: { TOKEN: '' }, enabled: true } }) as { mcpServers: { envKeys: string[] }[] }
    expect(removed.mcpServers[0].envKeys).toEqual(['OTHER'])
    expect(codeOf(() => fixture.request('extension.skill.install', { botId: BOT, expectedRevision: 3, name: 'x', files: [{ path: 'README.md', dataBase64: b64('x') }] }))).toBe('SKILL_INVALID')
    const installed = fixture.request('extension.skill.install', { botId: BOT, expectedRevision: 3, name: 'verificacao', files: [{ path: 'SKILL.md', dataBase64: b64('---\ndescription: Verifica coisas\n---\n') }] }) as { skills: { description: string; enabled: boolean }[] }
    expect(installed.skills[0]).toMatchObject({ description: 'Verifica coisas', enabled: true })
  })
})

describe('skill folder', () => {
  it('reads plain files with relative paths, skips dotfiles and refuses links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-'))
    await writeFile(join(root, 'SKILL.md'), '---\ndescription: X\n---\n')
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts/run.sh'), 'echo')
    await writeFile(join(root, '.DS_Store'), '')
    expect((await readSkillFolder(root)).map((file) => file.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
    await symlink('/etc/hosts', join(root, 'hosts'))
    await expect(readSkillFolder(root)).rejects.toThrow(/link/)
    const empty = await mkdtemp(join(tmpdir(), 'skill-'))
    await expect(readSkillFolder(empty)).rejects.toThrow(/SKILL\.md/)
  })
})
