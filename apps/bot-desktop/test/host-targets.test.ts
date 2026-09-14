import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostTargets, parseTargets } from '../src/main/host-targets'
it('migrates phase-one alias arrays into typed SSH targets and drops invalid entries', () => {
  expect(parseTargets(['studio-mac', 'x;id', 42])).toEqual([{ kind: 'ssh', id: 'ssh:studio-mac', alias: 'studio-mac', displayName: 'studio-mac' }])
  expect(parseTargets([{ kind: 'local', displayName: 'Meu Mac', hostId: 'not-a-uuid' }])).toEqual([{ kind: 'local', id: 'local', displayName: 'Meu Mac', hostId: undefined, lastConnectedAt: undefined }])
  expect(parseTargets('nope')).toEqual([])
})
it('persists targets atomically with private permissions and never scans for hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-targets-'))
  try {
    await writeFile(join(dir, 'hosts.json'), JSON.stringify(['legacy-alias']))
    const targets = new HostTargets(join(dir, 'hosts.json'))
    expect((await targets.list()).map((t) => t.id)).toEqual(['ssh:legacy-alias'])
    await targets.upsert({ kind: 'local', id: 'local', displayName: 'Este Mac', hostId: '11111111-1111-4111-8111-111111111111' })
    await targets.upsert({ kind: 'ssh', id: 'ssh:legacy-alias', alias: 'legacy-alias', displayName: 'Mac mini', hostId: '22222222-2222-4222-8222-222222222222' })
    const saved = JSON.parse(await readFile(join(dir, 'hosts.json'), 'utf8'))
    expect(saved).toHaveLength(2)
    expect((await targets.get('ssh:legacy-alias'))?.displayName).toBe('Mac mini')
    await targets.remove('local')
    expect((await targets.list()).map((t) => t.id)).toEqual(['ssh:legacy-alias'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
