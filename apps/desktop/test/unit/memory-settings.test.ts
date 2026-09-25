import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseMemorySettings, readMemorySettings } from '../../src/main/memory/settings'
import { setMemorySettings } from '../../src/main/chat/service'
import { closeDb, freshDb } from '../helpers/db'
beforeEach(freshDb)
afterEach(closeDb)
it('rejects malformed settings', () => {
  for (const value of [
    null,
    {},
    { autoRecall: 'yes' },
    { autoRecall: true, extraction: { enabled: true, selection: {} } },
  ])
    expect(parseMemorySettings(value)).toBeNull()
})
it('defaults to automatic recall', () => expect(readMemorySettings().autoRecall).toBe(true))
it('requires an extraction model', async () => {
  expect(await setMemorySettings({ autoRecall: false, extraction: { enabled: true, selection: null } })).toEqual({
    ok: false,
    error: 'memory-model-required',
  })
})
it('persists disabled settings', async () => {
  const value = { autoRecall: false, extraction: { enabled: false, selection: null } }
  expect(await setMemorySettings(value)).toEqual({ ok: true })
  expect(readMemorySettings()).toEqual(value)
})
