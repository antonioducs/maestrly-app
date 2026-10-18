import { afterEach, beforeEach, expect, it } from 'vitest'
import { safeStorage } from 'electron'
import { closeDb, freshDb } from '../helpers/db'
import { setAppSetting } from '../../src/main/store'
import { getDb } from '../../src/main/store/db'
import { filterExportableSettings } from '../../src/main/local-data/data-export'
import {
  DICTATION_ENGINE_SETTING,
  clearDictationKey,
  dictationConfig,
  getDictationEngine,
  getDictationKey,
  setDictationEngine,
  setDictationKey,
} from '../../src/main/dictation/settings'

const setEncryptionAvailable = (value: boolean): void =>
  (safeStorage as unknown as { __setEncryptionAvailable: (v: boolean) => void }).__setEncryptionAvailable(value)

beforeEach(freshDb)
afterEach(() => {
  clearDictationKey('openai')
  clearDictationKey('groq')
  setEncryptionAvailable(true)
  closeDb()
})

it('defaults to the local engine and ignores an unknown one', () => {
  expect(getDictationEngine()).toBe('local')
  setAppSetting(DICTATION_ENGINE_SETTING, 'whisper')
  expect(getDictationEngine()).toBe('local')
})

it('persists the chosen engine', () => {
  setDictationEngine('groq')
  expect(getDictationEngine()).toBe('groq')
  expect(dictationConfig().engine).toBe('groq')
})

it('stores trimmed keys in the secure store and reports only their presence', () => {
  expect(setDictationKey('openai', '  sk-test ')).toBe('secure')
  expect(getDictationKey('openai')).toBe('sk-test')
  expect(dictationConfig()).toEqual({ engine: 'local', keys: { openai: true, groq: false } })
  expect(JSON.stringify(dictationConfig())).not.toContain('sk-test')
  expect(() => setDictationKey('groq', '   ')).toThrow()
})

it('keeps a key in memory for the session when no keyring is available', () => {
  setEncryptionAvailable(false)
  expect(setDictationKey('groq', 'gsk-test')).toBe('memory')
  expect(getDictationKey('groq')).toBe('gsk-test')
  clearDictationKey('groq')
  expect(getDictationKey('groq')).toBeNull()
})

it('clears a key from disk and memory', () => {
  setDictationKey('openai', 'sk-test')
  setEncryptionAvailable(false)
  setDictationKey('groq', 'gsk-test')
  setEncryptionAvailable(true)
  clearDictationKey('openai')
  clearDictationKey('groq')
  expect(dictationConfig().keys).toEqual({ openai: false, groq: false })
})

it('keeps stored keys out of data exports while exporting the engine choice', () => {
  setDictationEngine('openai')
  setDictationKey('openai', 'sk-test')
  const rows = getDb().prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>
  expect(rows.some((row) => row.key.startsWith('chat.dictation.apiKey.'))).toBe(true)
  const exported = filterExportableSettings(rows)
  expect(Object.keys(exported).filter((key) => key.startsWith('chat.dictation.'))).toEqual([DICTATION_ENGINE_SETTING])
})
