import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const dockerfile = readFileSync(new URL('../../deploy/bot-fleet/bot-instance.Dockerfile', import.meta.url), 'utf8')
const notices = readFileSync(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')

const version = (name) => {
  const match = dockerfile.match(new RegExp(`^ARG ${name}=(\\d+\\.\\d+\\.\\d+)$`, 'm'))
  assert.ok(match, `${name} is pinned to a release`)
  return match[1]
}
const section = (title) => {
  const start = notices.indexOf(`\n## ${title}\n`)
  assert.notEqual(start, -1, `THIRD_PARTY_NOTICES.md has a ${title} section`)
  const end = notices.indexOf('\n## ', start + 1)
  return notices.slice(start, end === -1 ? undefined : end)
}

test('the bot image pins restic and rclone by version and hash for each architecture', () => {
  version('RESTIC_VERSION')
  version('RCLONE_VERSION')
  for (const tool of ['restic', 'rclone']) {
    const hashes = [...dockerfile.matchAll(new RegExp(`${tool}_sha=([0-9a-f]+)`, 'g'))].map((match) => match[1])
    assert.equal(hashes.length, 2, `${tool} has one hash per architecture`)
    for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/)
    assert.notEqual(hashes[0], hashes[1])
  }
  const arm = dockerfile.match(/^\s*arm64\)([^\n]*)$/gm) ?? []
  const amd = dockerfile.match(/^\s*amd64\)([^\n]*)$/gm) ?? []
  assert.ok(arm.some((line) => /restic_sha=[0-9a-f]{64}/.test(line) && /rclone_sha=[0-9a-f]{64}/.test(line)))
  assert.ok(amd.some((line) => /restic_sha=[0-9a-f]{64}/.test(line) && /rclone_sha=[0-9a-f]{64}/.test(line)))
  assert.match(dockerfile, /echo "\$\{restic_sha\} {2}\/tmp\/restic\.bz2" \| sha256sum -c -/)
  assert.match(dockerfile, /echo "\$\{rclone_sha\} {2}\/tmp\/rclone\.zip" \| sha256sum -c -/)
  assert.match(dockerfile, /^COPY --from=tools .*\/usr\/local\/bin\/restic .*\/usr\/local\/bin\/rclone /m)
})

test('the notices name the pinned restic and rclone with their licenses', () => {
  const restic = section('restic')
  assert.ok(restic.includes(version('RESTIC_VERSION')))
  assert.match(restic, /BSD 2-Clause License/)
  const rclone = section('rclone')
  assert.ok(rclone.includes(version('RCLONE_VERSION')))
  assert.match(rclone, /Permission is hereby granted, free of charge/)
})
