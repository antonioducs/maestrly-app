import { describe, expect, it } from 'vitest'
import { asrLanguage, asrSupport, dictationLanguage } from '../../src/shared/asr'

describe('shared speech contract', () => {
  it('accepts only known Whisper languages and falls back to detection', () => {
    expect(asrLanguage('pt')).toBe('pt')
    expect(asrLanguage('en')).toBe('en')
    expect(asrLanguage('auto')).toBe('auto')
    expect(asrLanguage('xx')).toBe('auto')
    expect(asrLanguage(undefined)).toBe('auto')
    expect(asrLanguage({ language: 'pt' })).toBe('auto')
  })

  it('maps the dictation mode and app locale to a Whisper language', () => {
    expect(dictationLanguage('app', 'pt-BR')).toBe('pt')
    expect(dictationLanguage('app', 'pt')).toBe('pt')
    expect(dictationLanguage('app', 'en')).toBe('en')
    expect(dictationLanguage('app', 'fr')).toBe('en')
    expect(dictationLanguage('auto', 'pt-BR')).toBe('auto')
  })

  it('reports support from the runtime target and the macOS version', () => {
    expect(asrSupport({ hasRuntimeTarget: false, platform: 'darwin', osRelease: '25.6.0' })).toEqual({
      supported: false,
      reason: 'platform',
    })
    expect(asrSupport({ hasRuntimeTarget: true, platform: 'darwin', osRelease: '23.6.0' })).toEqual({
      supported: false,
      reason: 'os-version',
    })
    expect(asrSupport({ hasRuntimeTarget: true, platform: 'darwin', osRelease: '24.0.0' })).toEqual({
      supported: true,
    })
    expect(asrSupport({ hasRuntimeTarget: true, platform: 'win32', osRelease: '10.0.26100' })).toEqual({
      supported: true,
    })
    expect(asrSupport({ hasRuntimeTarget: true, platform: 'linux', osRelease: '6.8.0-45-generic' })).toEqual({
      supported: true,
    })
  })
})
