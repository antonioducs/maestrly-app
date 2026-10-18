import {
  DICTATION_LIMITS,
  DictationFailure,
  checkDictationKey,
  dictationKeyHint,
  transcribeWithProvider,
  type DictationProvider,
  type FleetDictationKeyResponse,
  type FleetDictationStatus,
  type FleetDictationTranscribeRequest,
  type FleetDictationTranscribeResponse,
} from '@maestrly/bot-fleet-protocol'
import type { Store } from './store.js'

/**
 * Phone dictation through the server's own speech-to-text key: phones send the recording, the gateway sends it to the
 * provider and answers with the text. The key never leaves the gateway; reads say only its last four characters.
 */
export class DictationService {
  private running = 0

  constructor(
    private readonly store: Store,
    private readonly options: { fetch?: typeof fetch; log?: (message: string) => void } = {}
  ) {}

  status(): FleetDictationStatus {
    const settings = this.store.dictationSettings()
    return settings
      ? { configured: true, provider: settings.provider, keyHint: dictationKeyHint(settings.key) }
      : { configured: false, provider: null, keyHint: null }
  }

  async setKey(provider: DictationProvider, key: string, deviceName: string): Promise<FleetDictationKeyResponse> {
    const value = key.trim()
    const checked = await checkDictationKey({ provider, key: value, fetch: this.options.fetch })
    if (checked !== 'ok') return { error: checked }
    this.store.saveDictationSettings(provider, value, deviceName)
    this.log(`Dictation key for ${provider} set by ${deviceName}`)
    return { provider, keyHint: dictationKeyHint(value) }
  }

  removeKey(deviceName: string): void {
    if (this.store.clearDictationSettings()) this.log(`Dictation key removed by ${deviceName}`)
  }

  async transcribe(request: FleetDictationTranscribeRequest): Promise<FleetDictationTranscribeResponse> {
    const settings = this.store.dictationSettings()
    if (!settings) return { error: 'not-configured' }
    if (this.running >= DICTATION_LIMITS.gatewayConcurrency) return { error: 'busy' }
    const bytes = Buffer.from(request.audio, 'base64')
    if (bytes.length > DICTATION_LIMITS.fileBytesMax) return { error: 'too-long' }
    this.running++
    try {
      const text = await transcribeWithProvider({
        provider: settings.provider,
        key: settings.key,
        file: new Blob([bytes], { type: request.mediaType }),
        fileName: request.mediaType === 'audio/wav' ? 'dictation.wav' : 'dictation.m4a',
        language: request.language,
        fetch: this.options.fetch,
      })
      return { text }
    } catch (error) {
      if (error instanceof DictationFailure) return { error: error.code }
      throw error
    } finally {
      this.running--
    }
  }

  private log(message: string): void {
    if (this.options.log) this.options.log(message)
    else console.error(JSON.stringify({ component: 'dictation', level: 'info', message }))
  }
}
