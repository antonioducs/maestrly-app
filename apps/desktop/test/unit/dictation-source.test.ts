import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sourceFile = (name: string) => readFileSync(`src/renderer/components/${name}`, 'utf8')

describe('voice dictation wiring', () => {
  it('lets both composers send a dictation, joined to the current draft', () => {
    for (const name of ['chat/ChatView.tsx', 'fleet/BotComposer.tsx']) {
      const source = sourceFile(name)
      expect(source, name).toContain('onSendDictation=')
      expect(source, name).toContain('appendDictation(')
    }
    expect(sourceFile('chat/ChatView.tsx')).toContain('submitDraft({ text: appendDictation(')
  })

  it('checks support, warms the engine and offers the model card from the microphone', () => {
    const source = sourceFile('chat/ChatMicButton.tsx')
    for (const name of ['chatAsrSupport(', 'chatAsrWarm(', 'DictationModelCard']) expect(source).toContain(name)
    expect(source).not.toMatch(/<select\b/)
  })

  it('ends each recording by choice instead of a send-automatically preference', () => {
    const source = sourceFile('chat/ChatMicButton.tsx')
    for (const action of ["finishDictation('discard')", "finishDictation('insert')", "finishDictation('send')"])
      expect(source).toContain(action)
    expect(source).not.toContain('autoSend')
    expect(source).not.toContain('ChevronDown')
    expect(source).toContain('onContextMenu=')
  })

  it('gives the composer one main button and hands the action bar to a recording', () => {
    const source = sourceFile('chat/ChatComposer.tsx')
    expect(source).toContain('const stopMode = streaming && (!canSend || !!disabled)')
    expect(source).toContain('ComposerDictationContext.Provider')
    expect(source).toContain("dictating && 'hidden'")
    // Enter while dictating finishes the recording; it never sends the draft without it.
    expect(source).toContain("dictationControl.current.finish('send')")
    expect(source.match(/onClick=\{onStop\}/g)).toHaveLength(1)
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
