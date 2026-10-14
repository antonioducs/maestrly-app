import { afterEach, beforeEach, expect, it } from 'vitest'
import { safeStorage } from 'electron'
import { closeDb, freshDb } from '../helpers/db'
import { setAppSetting } from '../../src/main/store'
import { getDb } from '../../src/main/store/db'
import { filterExportableSettings } from '../../src/main/local-data/data-export'
import {
  WEB_SEARCH_PROVIDER_SETTING,
  clearWebSearchKey,
  getWebSearchKey,
  getWebSearchProvider,
  setWebSearchKey,
  setWebSearchProvider,
  webSearchKeysPresent,
  webSearchToolEnabled,
} from '../../src/main/chat/web-search/settings'

const setEncryptionAvailable = (value: boolean): void =>
  (safeStorage as unknown as { __setEncryptionAvailable: (v: boolean) => void }).__setEncryptionAvailable(value)

beforeEach(freshDb)
afterEach(() => {
  clearWebSearchKey('tavily')
  clearWebSearchKey('brave')
  setEncryptionAvailable(true)
  closeDb()
})

it('defaults to automatic selection', () => {
  expect(getWebSearchProvider()).toBe('auto')
  expect(webSearchToolEnabled()).toBe(true)
})

it('ignores an invalid stored provider', () => {
  setAppSetting(WEB_SEARCH_PROVIDER_SETTING, 'bing')
  expect(getWebSearchProvider()).toBe('auto')
})

it('persists the provider and turns the tool off', () => {
  setWebSearchProvider('brave')
  expect(getWebSearchProvider()).toBe('brave')
  expect(webSearchToolEnabled()).toBe(true)
  setWebSearchProvider('off')
  expect(webSearchToolEnabled()).toBe(false)
})

it('stores trimmed keys in the secure store', () => {
  expect(setWebSearchKey('tavily', '  test-key ')).toBe('secure')
  expect(getWebSearchKey('tavily')).toBe('test-key')
  expect(webSearchKeysPresent()).toEqual({ tavily: true, brave: false })
})

it('keeps keys in memory when the keyring is unavailable', () => {
  setEncryptionAvailable(false)
  expect(setWebSearchKey('brave', 'test-key')).toBe('memory')
  expect(getWebSearchKey('brave')).toBe('test-key')
})

it('clears keys', () => {
  setWebSearchKey('tavily', 'test-key')
  setEncryptionAvailable(false)
  setWebSearchKey('brave', 'test-key')
  clearWebSearchKey('tavily')
  clearWebSearchKey('brave')
  expect(webSearchKeysPresent()).toEqual({ tavily: false, brave: false })
})

it('keeps stored keys out of data exports while exporting the provider choice', () => {
  setWebSearchProvider('tavily')
  setWebSearchKey('tavily', 'test-key')
  const rows = getDb().prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>
  expect(rows.some((row) => row.key.startsWith('chat.webSearch.apiKey.'))).toBe(true)
  const exported = filterExportableSettings(rows)
  expect(Object.keys(exported).filter((key) => key.startsWith('chat.webSearch.'))).toEqual([
    WEB_SEARCH_PROVIDER_SETTING,
  ])
})

it('rejects an empty key', () => {
  expect(() => setWebSearchKey('tavily', '   ')).toThrow(/Empty/)
})

it('falls back to automatic selection without a database', () => {
  closeDb()
  expect(getWebSearchProvider()).toBe('auto')
})
