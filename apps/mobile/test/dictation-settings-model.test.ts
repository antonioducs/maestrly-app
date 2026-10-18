import { describe, expect, it } from 'vitest'
import { dictationSettingsView } from '../src/dictation/settings-model'

const key = { configured: true, provider: 'openai' as const, keyHint: '1234' }
const none = { configured: false, provider: null, keyHint: null }

describe('dictation settings', () => {
  it('offers the server only once it can transcribe', () => {
    expect(dictationSettingsView({ features: ['phones'], demo: false, status: null })).toEqual({
      serverOption: 'old-server',
      keyForm: false,
    })
    expect(dictationSettingsView({ features: ['dictation'], demo: true, status: key })).toEqual({
      serverOption: 'offline',
      keyForm: false,
    })
    expect(dictationSettingsView({ features: ['dictation'], demo: false, status: null })).toEqual({
      serverOption: 'offline',
      keyForm: true,
    })
    expect(dictationSettingsView({ features: ['dictation'], demo: false, status: none })).toEqual({
      serverOption: 'no-key',
      keyForm: true,
    })
    expect(dictationSettingsView({ features: ['dictation'], demo: false, status: key })).toEqual({
      serverOption: 'available',
      keyForm: true,
    })
    expect(dictationSettingsView({ features: [], demo: false, status: key })).toEqual({
      serverOption: 'old-server',
      keyForm: false,
    })
  })
})
