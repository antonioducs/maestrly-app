import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { signMacRuntimeEntries } from '../../scripts/sign-macos-runtime.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixtureFile(name, contents) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mac-runtime-signing-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, name)
  await writeFile(file, contents)
  return file
}

test('signs and verifies every Mach-O entry before it is archived', async () => {
  const binding = await fixtureFile('binding.node', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  const library = await fixtureFile('library.dylib', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0]))
  const manifest = await fixtureFile('package.json', '{"name":"fixture"}')
  const calls = []
  const entries = [
    { archive: 'node_modules/example/binding.node', source: binding },
    { archive: 'node_modules/example/library.dylib', source: library },
    { archive: 'node_modules/example/package.json', source: manifest },
  ]

  const signed = await signMacRuntimeEntries(entries, {
    cscName: 'Example Developer (TEAMID1234)',
    run: (command, args) => calls.push({ command, args }),
  })

  assert.deepEqual(signed, [entries[0].archive, entries[1].archive])
  const identity = 'Developer ID Application: Example Developer (TEAMID1234)'
  assert.deepEqual(calls, [
    {
      command: '/usr/bin/codesign',
      args: ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', binding],
    },
    { command: '/usr/bin/codesign', args: ['--verify', '--strict', '--verbose=2', binding] },
    {
      command: '/usr/bin/codesign',
      args: ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', library],
    },
    { command: '/usr/bin/codesign', args: ['--verify', '--strict', '--verbose=2', library] },
  ])
})

test('leaves unsigned development archives unchanged when CSC_NAME is absent', async () => {
  const binding = await fixtureFile('binding.node', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  const calls = []

  const signed = await signMacRuntimeEntries([{ archive: 'binding.node', source: binding }], {
    cscName: '',
    run: (...args) => calls.push(args),
  })

  assert.deepEqual(signed, [])
  assert.deepEqual(calls, [])
})

test('rejects an ambiguous Developer ID identity before invoking codesign', async () => {
  const binding = await fixtureFile('binding.node', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  const calls = []

  await assert.rejects(
    signMacRuntimeEntries([{ archive: 'binding.node', source: binding }], {
      cscName: 'Developer ID Application: Example Developer (TEAMID1234)',
      run: (...args) => calls.push(args),
    }),
    /must omit the Developer ID Application prefix/
  )
  assert.deepEqual(calls, [])
})
