import { describe, expect, it, vi } from 'vitest'

// models.dev lists these Gemini media models with text in and text out, which alone would pass them as chat models.
const catalog = {
  google: {
    models: Object.fromEntries(
      [
        ['gemini-2.5-pro', ['text', 'image'], ['text']],
        ['gemini-2.5-flash-image', ['text', 'image'], ['text', 'image']],
        ['gemini-2.5-flash-native-audio-preview', ['text', 'audio', 'video'], ['text', 'audio']],
        ['gemini-live-2.5-flash', ['text', 'audio'], ['text', 'audio']],
        ['gemma-3-27b-it', ['text'], ['text']],
      ].map(([id, input, output]) => [
        id,
        { id, modalities: { input, output }, limit: { context: 1_000_000, output: 65_536 }, cost: { input: 1 } },
      ])
    ),
  },
}

vi.mock('electron', () => ({
  net: { fetch: vi.fn(async () => ({ ok: true, json: async () => catalog })) },
}))

import { filterChatModels } from '../../src/main/chat/model-meta'

describe('chat model filter for OpenAI-compatible Gemini', () => {
  it('keeps chat models and drops image, speech, Live and embedding models, models/ path included', async () => {
    await expect(
      filterChatModels([
        'models/gemini-2.5-pro',
        'models/gemini-2.5-flash-image',
        'models/gemini-2.0-flash-preview-image-generation',
        'models/gemini-2.5-flash-preview-tts',
        'models/gemini-2.5-flash-native-audio-preview',
        'models/gemini-live-2.5-flash',
        'models/imagen-4.0-generate-001',
        'models/veo-3.0-generate-preview',
        'models/lyria-realtime-exp',
        'models/gemini-embedding-001',
        'models/text-embedding-004',
        'models/gemma-3-27b-it',
        'models/gemini-2.5-flash-lite',
      ])
    ).resolves.toEqual(['models/gemini-2.5-pro', 'models/gemma-3-27b-it', 'models/gemini-2.5-flash-lite'])
  })

  it('does not mistake chat models whose names merely contain those words', async () => {
    const chat = ['gpt-4o', 'deepseek-v4-pro', 'claude-opus-4', 'olive-7b-chat', 'imagine-13b', 'deliverance-v2']
    await expect(filterChatModels(chat)).resolves.toEqual(chat)
  })
})
