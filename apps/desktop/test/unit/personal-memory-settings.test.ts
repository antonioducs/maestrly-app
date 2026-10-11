import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { setAppSetting } from '../../src/main/store/app-settings'
import { isMemorySpaceEnabled } from '../../src/main/memory/access'
import { PERSONAL_MEMORY_SPACE_ID } from '../../src/shared/memory'
import {
  DEFAULT_PERSONAL_MEMORY_SETTINGS,
  onPersonalMemorySettingsChanged,
  readPersonalMemorySettings,
  setPersonalMemorySettings,
} from '../../src/main/memory/personal-memory-settings'

beforeEach(freshDb)
afterEach(closeDb)
it('defaults only absent settings, persists changes independently, and emits the full settings', () => {
  expect(readPersonalMemorySettings()).toEqual(DEFAULT_PERSONAL_MEMORY_SETTINGS)
  setAppSetting('chat.memory', JSON.stringify({ autoRecall: false, extraction: { enabled: true, selection: null } }))
  expect(readPersonalMemorySettings().autoRecall).toBe(true)
  const settings = { ...DEFAULT_PERSONAL_MEMORY_SETTINGS, enabled: false }
  let received: unknown
  const dispose = onPersonalMemorySettingsChanged((value) => {
    received = value
  })
  setPersonalMemorySettings(settings)
  dispose()
  expect(received).toEqual(settings)
  restartDb()
  expect(readPersonalMemorySettings()).toEqual(settings)
  expect(isMemorySpaceEnabled(PERSONAL_MEMORY_SPACE_ID)).toBe(false)
})
it('fails closed for malformed, empty, invalid and unreadable settings', () => {
  for (const raw of ['{', '', '{}', 'null', '{"enabled":true}']) {
    setAppSetting('chat.personalMemory', raw)
    expect(readPersonalMemorySettings().enabled).toBe(false)
  }
  closeDb()
  expect(readPersonalMemorySettings().enabled).toBe(false)
})
