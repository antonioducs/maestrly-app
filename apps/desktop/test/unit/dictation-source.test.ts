import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sourceFile = (name: string) => readFileSync(`src/renderer/components/${name}`, 'utf8')

describe('voice dictation wiring', () => {
  it('lets both composers send a dictation, joined to the current draft', () => {
    for (const name of ['chat/ChatView.tsx', 'fleet/BotComposer.tsx']) {
      const source = sourceFile(name)
      expect(source, name).toContain('onAutoSend=')
      expect(source, name).toContain('appendDictation(')
    }
    expect(sourceFile('chat/ChatView.tsx')).toContain('submitDraft({ text: appendDictation(')
  })

  it('checks support, warms the engine and offers the model card from the microphone', () => {
    const source = sourceFile('chat/ChatMicButton.tsx')
    for (const name of ['chatAsrSupport(', 'chatAsrWarm(', 'MIC_AUTO_SEND_KEY', 'DictationModelCard'])
      expect(source).toContain(name)
    expect(source).not.toMatch(/<select\b/)
  })

  it('manages only the voice model from the model card', () => {
    const source = sourceFile('chat/DictationModelCard.tsx')
    for (const call of [
      "runtimeAssetInstall('whisper-model')",
      "runtimeAssetCancel('whisper-model')",
      "runtimeAssetRepair('whisper-model')",
    ])
      expect(source).toContain(call)
    expect(source).not.toMatch(/<select\b/)
  })
})
