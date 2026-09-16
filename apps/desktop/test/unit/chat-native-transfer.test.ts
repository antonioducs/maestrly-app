import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/chat'
import { codexTransferCharacters, CODEX_TRANSFER_MAX_CHARACTERS } from '../../src/main/chat/native-transfer'
import { nativeSeedContextText, renderNativeSeedTranscript } from '../../src/main/chat/message'

describe('Codex transfer transport budget', () => {
  const history: ChatMessage[] = [
    {
      id: 'old',
      conversationId: 'conversation',
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', id: 'text', text: 'x'.repeat(900_000) }],
    },
  ]

  it('counts complete history, import wrapper and pending attachments together', () => {
    const body = 'y'.repeat(200_000)
    const pending = [
      {
        type: 'file' as const,
        id: 'file',
        kind: 'text' as const,
        name: 'notes.txt',
        mediaType: 'text/plain',
        data: body,
      },
    ]
    expect(codexTransferCharacters(history, pending)).toBe(
      `${nativeSeedContextText(renderNativeSeedTranscript(history))}\n\nAttached file notes.txt:\n\n${body}`.length
    )
    expect(codexTransferCharacters(history, pending)).toBeGreaterThan(CODEX_TRANSFER_MAX_CHARACTERS)
    expect(codexTransferCharacters(history, [])).toBeLessThan(CODEX_TRANSFER_MAX_CHARACTERS)
  })

  it('counts expanded pending skill instructions even without a history seed', () => {
    const body = 'x'.repeat(CODEX_TRANSFER_MAX_CHARACTERS + 1)
    expect(
      codexTransferCharacters(
        [],
        [
          {
            type: 'skill-invocation',
            id: 'skill',
            name: 'review',
            body,
          },
        ]
      )
    ).toBe(body.length)
  })
})
